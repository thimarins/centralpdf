const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPdfWorkerExecution } = require('../../src/main/worker-runtime');
const { extractStructuredText } = require('../../src/main/services/conversion/text-extractor');
const { writeReport } = require('./_common');

function parseCsvLine(line) {
  const values = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (character === ',' && !quoted) {
      values.push(value);
      value = '';
    } else value += character;
  }
  values.push(value);
  return values;
}

function parseCsvRecords(text) {
  const records = [];
  let record = [];
  let value = '';
  let quoted = false;
  const source = String(text).replace(/^\uFEFF/, '');
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '"') {
      if (quoted && source[index + 1] === '"') {
        value += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (character === ',' && !quoted) {
      record.push(value);
      value = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      record.push(value);
      value = '';
      if (record.some((field) => field.length > 0)) records.push(record);
      record = [];
      if (character === '\r' && source[index + 1] === '\n') index += 1;
    } else value += character;
  }
  if (quoted) throw new Error('O manifesto CSV contém um campo de texto sem aspas de fechamento.');
  if (record.length || value.length) {
    record.push(value);
    if (record.some((field) => field.length > 0)) records.push(record);
  }
  return records;
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function normalizeReferenceText(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase('pt-BR').replace(/\s+/g, ' ').trim();
}

function editDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    let diagonal = previous[0];
    previous[0] = row;
    for (let column = 1; column <= right.length; column += 1) {
      const above = previous[column];
      previous[column] = Math.min(
        previous[column] + 1,
        previous[column - 1] + 1,
        diagonal + (left[row - 1] === right[column - 1] ? 0 : 1)
      );
      diagonal = above;
    }
  }
  return previous[right.length];
}

function calculateAccuracyTotals(samples) {
  let characterErrors = 0;
  let referenceCharacters = 0;
  let wordErrors = 0;
  let referenceWords = 0;
  let tokenMatches = 0;
  let tokenReferences = 0;
  let tokenSamples = 0;
  let sequenceSamples = 0;
  for (const { expected, actual, metricMode } of samples) {
    const normalizedExpected = normalizeReferenceText(expected);
    const normalizedActual = normalizeReferenceText(actual);
    const expectedWords = normalizedExpected ? normalizedExpected.split(' ') : [];
    const actualWords = normalizedActual ? normalizedActual.split(' ') : [];
    if (metricMode === 'tokens') {
      tokenSamples += 1;
      tokenReferences += expectedWords.length;
      const available = new Map();
      for (const word of actualWords) available.set(word, (available.get(word) || 0) + 1);
      for (const word of expectedWords) {
        const count = available.get(word) || 0;
        if (count > 0) {
          tokenMatches += 1;
          available.set(word, count - 1);
        }
      }
      continue;
    }
    sequenceSamples += 1;
    characterErrors += editDistance(Array.from(normalizedExpected), Array.from(normalizedActual));
    referenceCharacters += Array.from(normalizedExpected).length;
    wordErrors += editDistance(expectedWords, actualWords);
    referenceWords += expectedWords.length;
  }
  if (!samples.length) return null;
  const accuracy = {
    samples: sequenceSamples,
    cer: sequenceSamples ? characterErrors / Math.max(1, referenceCharacters) : null,
    wer: sequenceSamples ? wordErrors / Math.max(1, referenceWords) : null
  };
  if (tokenSamples) {
    accuracy.tokenSamples = tokenSamples;
    accuracy.tokenRecall = tokenMatches / Math.max(1, tokenReferences);
  }
  return accuracy;
}

function addOutcome(groups, category, outcome) {
  const current = groups.get(category) || { inputs: 0, recognized: 0, noText: 0, skipped: 0, failed: 0 };
  current.inputs += 1;
  current[outcome] += 1;
  groups.set(category, current);
}

function formatGroupTable(title, groups) {
  return [
    `### ${title}`,
    '',
    '| Categoria | Itens | Reconhecidos | Sem texto | Ignorados | Falhas |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...[...groups.entries()].sort(([left], [right]) => left.localeCompare(right, 'pt-BR')).map(([name, item]) =>
      `| ${name} | ${item.inputs} | ${item.recognized} | ${item.noText} | ${item.skipped} | ${item.failed} |`),
    ''
  ];
}

function summarizeBlankPageDetection(records) {
  const summary = {
    explicitBlank: { total: 0, detectedBlank: 0, detectedText: 0, unresolved: 0 },
    explicitText: { total: 0, detectedBlank: 0, detectedText: 0, unresolved: 0 },
    ambiguousDuplicate: { total: 0, detectedBlank: 0, detectedText: 0, unresolved: 0 }
  };

  for (const record of records) {
    const defect = String(record.defect || '').trim().toLocaleLowerCase('pt-BR');
    const group = defect === 'branco' ? summary.explicitBlank
      : defect === 'duplicada_do_arquivo_anterior' ? summary.ambiguousDuplicate
        : summary.explicitText;
    group.total += 1;
    if (record.status === 'failed' || record.status === 'unavailable') group.unresolved += 1;
    else if (record.status === 'noText' || record.status === 'skipped') group.detectedBlank += 1;
    else if (record.status === 'recognized') group.detectedText += 1;
    else throw new Error(`Status inesperado na avaliação de página em branco: ${record.status}`);
  }

  return summary;
}

async function runCorpusAssessment(inputRootOverride, reportOutputPath, options = {}) {
  const inputRoot = inputRootOverride || process.argv[2] || process.env.CENTRAL_PDF_OCR_CORPUS_DIR;
  assert.ok(inputRoot, 'Informe o diretório em CENTRAL_PDF_OCR_CORPUS_DIR ou como primeiro argumento.');
  const corpusRoot = fs.realpathSync(path.resolve(inputRoot));
  assert.ok(fs.statSync(corpusRoot).isDirectory(), 'O caminho informado precisa ser uma pasta.');

  const manifestPath = path.join(corpusRoot, 'manifesto.csv');
  assert.ok(fs.existsSync(manifestPath), 'Não foi encontrado manifesto.csv na pasta do corpus.');
  const csvRecords = parseCsvRecords(fs.readFileSync(manifestPath, 'utf8'));
  const headers = csvRecords.shift() || [];
  const rows = csvRecords.map((record) => Object.fromEntries(record.map((value, index) => [headers[index], value])));
  assert.ok(rows.length > 0 && headers.includes('arquivo'), 'O manifesto precisa listar os nomes dos arquivos na coluna arquivo.');

  const referenceColumn = headers.find((name) => /^(texto|transcricao|transcrição|ground.?truth|referencia|referência)$/i.test(name));
  const files = rows.map((row) => {
    const fileName = String(row.arquivo || '').trim();
    assert.ok(fileName && path.basename(fileName) === fileName, 'O manifesto contém um nome de arquivo inválido.');
    const filePath = path.join(corpusRoot, fileName);
    const stat = fs.lstatSync(filePath);
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'O corpus só pode conter arquivos regulares, sem links simbólicos.');
    assert.ok(/\.(png|jpe?g|tiff?)$/i.test(fileName), 'O corpus contém um formato de imagem não suportado.');
    return { row, fileName, filePath };
  });
  assert.equal(new Set(files.map((file) => file.fileName.toLowerCase())).size, files.length, 'O manifesto contém nomes de arquivo duplicados.');

  const diskImages = fs.readdirSync(corpusRoot).filter((name) => /\.(png|jpe?g|tiff?)$/i.test(name));
  assert.equal(diskImages.length, files.length, 'A quantidade de imagens não corresponde ao manifesto; o lote foi interrompido antes do OCR.');

  const sourceHashes = new Map(files.map(({ fileName, filePath }) => [fileName, sha256(filePath)]));
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'central-pdf-ocr-corpus-'));
  const outputDir = path.join(tempRoot, 'output');
  const startedAt = Date.now();
  const progressCheckpoints = new Set();
  let peakWorkerMemoryMb = 0;
  let result;
  let integrityOk;
  let accuracy = null;
  const accuracyByDefect = new Map();
  const reversedLineAccuracyByDefect = new Map();

  try {
    const execution = createPdfWorkerExecution({
      type: 'ocr',
      files: files.map((file) => file.filePath),
      options: { language: 'por+eng', mode: 'auto', format: 'pdf', zipResults: false },
      outputDir
    }, (progress) => {
      peakWorkerMemoryMb = Math.max(peakWorkerMemoryMb, Number(progress.memoryMb) || 0);
      const completed = Number(progress.currentItem) || 0;
      if (Number(progress.itemProgress) >= 100 && completed > 0 && completed % 30 === 0 && !progressCheckpoints.has(completed)) {
        progressCheckpoints.add(completed);
        console.log(`Progresso do lote: ${completed}/${files.length} arquivos concluídos.`);
      }
    });
    result = await execution.promise;
    if (referenceColumn) {
      const failedNames = new Set((result.failures || []).map((failure) => failure.fileName));
      const successfulFiles = files.filter((file) => !failedNames.has(file.fileName));
      const outputFiles = Array.isArray(result.createdFiles) ? result.createdFiles : [];
      assert.equal(outputFiles.length, successfulFiles.length, 'Não foi possível relacionar com segurança as saídas OCR às referências do corpus.');
      const samples = [];
      for (let index = 0; index < successfulFiles.length; index += 1) {
        const file = successfulFiles[index];
        const extracted = await extractStructuredText(outputFiles[index]);
        const sample = {
          expected: file.row[referenceColumn],
          actual: (extracted.pages || []).map((page) => page.text || '').join('\n'),
          metricMode: String(file.row.metric_mode || '').trim().toLowerCase() === 'tokens' ? 'tokens' : 'sequence'
        };
        samples.push(sample);
        if (options.includeAccuracyByDefect === true) {
          const defect = String(file.row.defeito || 'não informado').trim() || 'não informado';
          if (!accuracyByDefect.has(defect)) accuracyByDefect.set(defect, []);
          accuracyByDefect.get(defect).push(sample);
          if (defect === 'rotacao_180' && sample.metricMode === 'tokens') {
            const reversedExpected = String(sample.expected).split(/\r?\n/).reverse().join(' ');
            if (!reversedLineAccuracyByDefect.has(defect)) reversedLineAccuracyByDefect.set(defect, []);
            reversedLineAccuracyByDefect.get(defect).push({ expected: reversedExpected, actual: sample.actual });
          }
        }
      }
      accuracy = calculateAccuracyTotals(samples);
    }
  } finally {
    integrityOk = files.every(({ fileName, filePath }) => sourceHashes.get(fileName) === sha256(filePath));
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  }

  const pageByFile = new Map();
  for (const page of result.pageResults || []) pageByFile.set(page.fileName, page);
  const failedNames = new Set((result.failures || []).map((failure) => failure.fileName));
  const byPaper = new Map();
  const byDefect = new Map();
  const classificationRecords = [];
  const orientationCorrectionsByDefect = new Map();
  for (const { row, fileName } of files) {
    const page = pageByFile.get(fileName);
    if (options.includeAccuracyByDefect === true && Number.isFinite(Number(page?.orientationCorrectionDegrees)) && Number(page.orientationCorrectionDegrees) !== 0) {
      const defect = String(row.defeito || 'não informado').trim() || 'não informado';
      if (!orientationCorrectionsByDefect.has(defect)) orientationCorrectionsByDefect.set(defect, []);
      orientationCorrectionsByDefect.get(defect).push(Number(page.orientationCorrectionDegrees));
    }
    const outcome = failedNames.has(fileName) ? 'failed'
      : page?.status === 'recognized' ? 'recognized'
        : page?.status === 'skipped' ? 'skipped' : 'noText';
    addOutcome(byPaper, row.paper_type || 'não informado', outcome);
    addOutcome(byDefect, row.defeito || 'não informado', outcome);
    classificationRecords.push({ defect: row.defeito, status: outcome });
  }
  const blankDetection = summarizeBlankPageDetection(classificationRecords);

  const outcomeCounts = {
    inputs: files.length,
    outputs: result.outputCount || 0,
    recognized: result.recognizedPages || 0,
    noText: result.noTextPages || 0,
    skipped: result.skippedPages || 0,
    failures: (result.failures || []).length,
    averageConfidence: Number.isFinite(result.averageOcrConfidence) ? result.averageOcrConfidence : null,
    orientationCorrections: result.orientationCorrections || 0,
    preprocessingPages: result.preprocessingPages || 0,
    peakWorkerMemoryMb: Math.round(peakWorkerMemoryMb)
  };
  const reportLines = [
    '# Avaliação local do corpus OCR',
    '',
    `Gerado em ${new Date().toISOString()}.`,
    '',
    `- Imagens no lote: ${outcomeCounts.inputs}; saídas criadas: ${outcomeCounts.outputs}.`,
    `- Reconhecidas: ${outcomeCounts.recognized}; sem texto detectado: ${outcomeCounts.noText}; ignoradas: ${outcomeCounts.skipped}; falhas: ${outcomeCounts.failures}.`,
    `- Confiança média estimada pelo motor: ${outcomeCounts.averageConfidence === null ? 'indisponível' : `${outcomeCounts.averageConfidence}%`}. Não é uma medida de exatidão textual.`,
    `- Correções de orientação: ${outcomeCounts.orientationCorrections}; páginas com pré-processamento: ${outcomeCounts.preprocessingPages}.`,
    `- Tempo total: ${Date.now() - startedAt} ms; pico de memória reportado pelo worker: ${outcomeCounts.peakWorkerMemoryMb} MB.`,
    `- Integridade SHA-256 das imagens originais: ${integrityOk ? 'inalteradas' : 'FALHA'}. Saídas temporárias foram removidas.`,
    `- Transcrição de referência no manifesto: ${referenceColumn ? 'disponível' : 'não fornecida'}; amostras sequenciais: ${accuracy?.samples || 0}; CER: ${accuracy?.samples ? `${(accuracy.cer * 100).toFixed(2)}%` : 'n/a'}; WER: ${accuracy?.samples ? `${(accuracy.wer * 100).toFixed(2)}%` : 'n/a'}; amostras sem ordem: ${accuracy?.tokenSamples || 0}; cobertura de tokens: ${accuracy?.tokenSamples ? `${(accuracy.tokenRecall * 100).toFixed(2)}%` : 'n/a'}. Métricas agregadas; texto reconhecido não é gravado neste relatório.`,
    `- Páginas explicitamente em branco: ${blankDetection.explicitBlank.detectedBlank}/${blankDetection.explicitBlank.total} identificadas; falsos positivos entre categorias com conteúdo: ${blankDetection.explicitText.detectedBlank}/${blankDetection.explicitText.total}; duplicatas ambíguas excluídas da métrica: ${blankDetection.ambiguousDuplicate.total} itens.`,
    '',
    'O relatório contém apenas métricas agregadas; não registra nomes de arquivo, conteúdo reconhecido ou caminhos de origem.',
    '',
    ...formatGroupTable('Resultado por tipo de papel', byPaper),
    ...formatGroupTable('Resultado por defeito do fixture', byDefect)
  ];
  const reportPath = reportOutputPath
    ? path.resolve(reportOutputPath)
    : writeReport('ocr-corpus-assessment.md', reportLines);

  const accuracySummary = accuracy ? {
    samples: accuracy.samples,
    cer: accuracy.cer,
    wer: accuracy.wer,
    ...(accuracy.tokenSamples ? { tokenSamples: accuracy.tokenSamples, tokenRecall: accuracy.tokenRecall } : {})
  } : null;
  const defectAccuracySummary = options.includeAccuracyByDefect === true
    ? Object.fromEntries([...accuracyByDefect.entries()].sort(([left], [right]) => left.localeCompare(right, 'pt-BR')).map(([defect, samples]) => [defect, calculateAccuracyTotals(samples)]))
    : null;
  const defectTokenSummary = options.includeAccuracyByDefect === true
    ? Object.fromEntries([...accuracyByDefect.entries()].sort(([left], [right]) => left.localeCompare(right, 'pt-BR')).map(([defect, samples]) => [
      defect,
      calculateAccuracyTotals(samples.map((sample) => ({ ...sample, metricMode: 'tokens' })) ).tokenRecall
    ]))
    : null;
  const defectOrientationSummary = options.includeAccuracyByDefect === true
    ? Object.fromEntries([...orientationCorrectionsByDefect.entries()].sort(([left], [right]) => left.localeCompare(right, 'pt-BR')))
    : null;
  const reversedLineAccuracySummary = options.includeAccuracyByDefect === true
    ? Object.fromEntries([...reversedLineAccuracyByDefect.entries()].map(([defect, samples]) => [defect, calculateAccuracyTotals(samples)]))
    : null;
  if (defectAccuracySummary) {
    const accuracyReport = [
      '### CER/WER por categoria do fixture', '',
      '| Categoria | Amostras | CER | WER | Cobertura de palavras |',
      '| --- | ---: | ---: | ---: | ---: |',
      ...Object.entries(defectAccuracySummary).map(([defect, metrics]) =>
        `| ${defect} | ${metrics.samples} | ${metrics.samples ? `${(metrics.cer * 100).toFixed(2)}%` : 'n/a'} | ${metrics.samples ? `${(metrics.wer * 100).toFixed(2)}%` : 'n/a'} | ${defectTokenSummary[defect] === null ? 'n/a' : `${(defectTokenSummary[defect] * 100).toFixed(2)}%`} |`),
      ''
    ];
    if (reversedLineAccuracySummary) {
      accuracyReport.push(
        '### Comparação auxiliar da página girada 180°', '',
        '| Categoria | Interpretação | Amostras | CER | WER |',
        '| --- | --- | ---: | ---: | ---: |',
        ...Object.entries(reversedLineAccuracySummary).map(([defect, metrics]) =>
          `| ${defect} | ordem lógica após normalizar a inversão espacial das linhas | ${metrics.samples} | ${metrics.samples ? `${(metrics.cer * 100).toFixed(2)}%` : 'n/a'} | ${metrics.samples ? `${(metrics.wer * 100).toFixed(2)}%` : 'n/a'} |`),
        ''
      );
    }
    const reportInsertionIndex = reportLines.indexOf('O relatório contém apenas métricas agregadas');
    reportLines.splice(reportInsertionIndex, 0, ...accuracyReport);
  }
  if (reportOutputPath) {
    await fs.promises.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.promises.writeFile(reportPath, `${reportLines.join(os.EOL)}${os.EOL}`, 'utf8');
  }
  console.log(JSON.stringify({ ...outcomeCounts, accuracy: accuracySummary, ...(defectAccuracySummary ? { accuracyByDefect: defectAccuracySummary, tokenRecallByDefect: defectTokenSummary } : {}), ...(defectOrientationSummary ? { orientationCorrectionsByDefect: defectOrientationSummary } : {}), ...(reversedLineAccuracySummary ? { reversedLineAccuracyByDefect: reversedLineAccuracySummary } : {}), blankDetection, sourceIntegrity: integrityOk, referenceColumn: Boolean(referenceColumn), elapsedMs: Date.now() - startedAt, reportPath }));
  assert.ok(integrityOk, 'O SHA-256 de uma ou mais imagens originais mudou durante a avaliação.');
  return { ...outcomeCounts, accuracy: accuracySummary, ...(defectAccuracySummary ? { accuracyByDefect: defectAccuracySummary, tokenRecallByDefect: defectTokenSummary } : {}), ...(defectOrientationSummary ? { orientationCorrectionsByDefect: defectOrientationSummary } : {}), ...(reversedLineAccuracySummary ? { reversedLineAccuracyByDefect: reversedLineAccuracySummary } : {}), sourceIntegrity: integrityOk, reportPath };
}

if (require.main === module) {
  runCorpusAssessment().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { parseCsvLine, parseCsvRecords, summarizeBlankPageDetection, normalizeReferenceText, editDistance, calculateAccuracyTotals, runCorpusAssessment };
