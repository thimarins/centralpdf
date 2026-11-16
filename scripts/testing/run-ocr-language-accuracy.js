const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createCanvas } = require('@napi-rs/canvas');
const { PDFDocument } = require('pdf-lib');
const { extractStructuredText } = require('../../src/main/services/conversion/text-extractor');
const { createOcrWorkerSession, recognizeImage, recognizePdf, searchPdfDocument } = require('../../src/main/services/ocr/ocr-service');
const { createPdfWorkerExecution } = require('../../src/main/worker-runtime');
const { writeReport } = require('./_common');

function normalizeForAccuracy(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('pt-BR')
    .replace(/\s+/g, ' ')
    .trim();
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

async function createFixture(filePath, lines, format = 'png', visual = {}) {
  const targetWidth = visual.width || 1800;
  const targetHeight = visual.height || 360;
  const pageRotationDegrees = Number(visual.pageRotationDegrees) || 0;
  const sideways = Math.abs(pageRotationDegrees) % 180 === 90;
  let canvas = createCanvas(sideways ? targetHeight : targetWidth, sideways ? targetWidth : targetHeight);
  const context = canvas.getContext('2d');
  context.fillStyle = visual.backgroundColor || '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = visual.textColor || '#111';
  context.font = `${visual.fontSize || 64}px Arial`;
  context.textBaseline = 'top';
  if (visual.rotationDegrees) {
    context.translate(canvas.width / 2, canvas.height / 2);
    context.rotate(visual.rotationDegrees * Math.PI / 180);
    context.translate(-canvas.width / 2, -canvas.height / 2);
  }
  if (visual.columns) {
    const columnWidth = canvas.width / visual.columns.length;
    visual.columns.forEach((column, columnIndex) => {
      column.forEach((line, rowIndex) => context.fillText(line, 36 + columnIndex * columnWidth, 38 + rowIndex * (visual.lineHeight || 88), columnWidth - 60));
    });
  } else {
    lines.forEach((line, index) => context.fillText(line, 48, 38 + index * (visual.lineHeight || 96), canvas.width - 96));
  }
  if (pageRotationDegrees) {
    const orientedCanvas = createCanvas(targetWidth, targetHeight);
    const orientedContext = orientedCanvas.getContext('2d');
    orientedContext.translate(targetWidth / 2, targetHeight / 2);
    orientedContext.rotate(pageRotationDegrees * Math.PI / 180);
    orientedContext.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
    canvas = orientedCanvas;
  }
  await fs.writeFile(filePath, canvas.toBuffer(format === 'jpeg' ? 'image/jpeg' : 'image/png'));
}

async function main() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'central-pdf-ocr-language-'));
  const cases = [
    { name: 'Português brasileiro com acentos', language: 'por', lines: ['Ação rápida: revisão, proteção e informações.', 'São Paulo — aprovação válida.'] },
    { name: 'Inglês', language: 'eng', lines: ['Quarterly financial report approved.', 'Review the attached document before sharing.'] },
    { name: 'Português e inglês combinados', language: 'por+eng', lines: ['Revisão concluída — approved for release.', 'Informações protegidas.'] },
    {
      name: 'Português com baixo contraste e inclinação de 1,25°', language: 'por',
      lines: ['Ação rápida: revisão e proteção.', 'Informações válidas para São Paulo.'],
      visual: { backgroundColor: '#f1f1f1', textColor: '#666666', fontSize: 52, rotationDegrees: 1.25 },
      autoRotate: true
    },
    {
      name: 'Recibo estreito com texto pequeno', language: 'por',
      lines: ['Recibo número 24681', 'Total R$ 128,50', 'Pagamento confirmado.'],
      exactTokens: ['Recibo número 24681', 'Total R$ 128,50'],
      visual: { width: 700, height: 320, backgroundColor: '#fbfbf8', textColor: '#333333', fontSize: 30, lineHeight: 74 }
    },
    {
      name: 'JPEG com compressão e texto em inglês', language: 'eng', format: 'jpeg',
      lines: ['Document number 04821', 'Invoice total: 725.40', 'Payment approved.'],
      exactTokens: ['Document number 04821', 'Invoice total: 725.40'],
      visual: { width: 1400, height: 420, backgroundColor: '#ffffff', fontSize: 48, lineHeight: 100 }
    },
    {
      name: 'Documento português em duas colunas', language: 'por',
      lines: ['Cadastro de fornecedor', 'Data de revisão: 02/11/2026', 'CNPJ 12.345.678/0001-90', 'Aprovado pela área fiscal', 'Situação: ativo', 'Documento arquivado'],
      exactTokens: ['Data de revisão: 02/11/2026', 'CNPJ 12.345.678/0001-90'],
      visual: {
        width: 1600, height: 500, fontSize: 42, lineHeight: 96,
        columns: [
          ['Cadastro de fornecedor', 'CNPJ 12.345.678/0001-90', 'Situação: ativo'],
          ['Data de revisão: 02/11/2026', 'Aprovado pela área fiscal', 'Documento arquivado']
        ]
      }
    },
    {
      name: 'Página invertida em 180 graus com correção automática', language: 'por',
      lines: ['Relatório 41728 aprovado', 'Total R$ 128,50'],
      orderIndependentTokens: ['Relatório', '41728', 'aprovado', 'Total', 'R$', '128,50'],
      visual: { width: 1600, height: 500, fontSize: 48, lineHeight: 110, pageRotationDegrees: 180 },
      autoRotate: true,
      spatialOrderVaries: true,
      expectedOrientationCorrectionDegrees: 180
    },
    {
      name: 'Digitalização girada em 90 graus com correção automática', language: 'eng',
      lines: ['Invoice 41728 approved', 'Total 128.50', 'Payment confirmed'],
      orderIndependentTokens: ['Invoice', '41728', 'approved', 'Total', '128.50', 'Payment', 'confirmed'],
      visual: { width: 1600, height: 500, fontSize: 34, lineHeight: 100, pageRotationDegrees: 90 },
      autoRotate: true,
      spatialOrderVaries: true,
      expectedOrientationCorrectionDegrees: -90
    },
    {
      name: 'Digitalização girada em 270 graus com correção automática', language: 'eng',
      lines: ['Invoice 41728 approved', 'Total 128.50', 'Payment confirmed'],
      orderIndependentTokens: ['Invoice', '41728', 'approved', 'Total', '128.50', 'Payment', 'confirmed'],
      visual: { width: 1600, height: 500, fontSize: 34, lineHeight: 100, pageRotationDegrees: 270 },
      autoRotate: true,
      spatialOrderVaries: true,
      expectedOrientationCorrectionDegrees: 90
    }
  ];
  const results = [];
  assert.equal(normalizeForAccuracy('ＡＢＣ'), 'abc', 'A normalização de compatibilidade Unicode deve ser aplicada antes da comparação.');
  assert.notEqual(
    normalizeForAccuracy('CNPJ 12.345.678/0001-90'),
    normalizeForAccuracy('CNPJ 12345678000190'),
    'A métrica não pode descartar pontuação que altera identificadores e valores.'
  );
  results.push({ name: 'Métricas: normalização Unicode sem apagar pontuação significativa', language: 'n/a', cer: null, wer: null, confidence: null });

  try {
    let workerCreations = 0;
    let workerTerminations = 0;
    const workerSession = createOcrWorkerSession('eng', async (_language, logger) => {
      workerCreations += 1;
      return { report: logger, terminate: async () => { workerTerminations += 1; } };
    });
    const firstProgress = [];
    const secondProgress = [];
    const firstWorker = await workerSession.getWorker((message) => firstProgress.push(message));
    const reusedWorker = await workerSession.getWorker((message) => secondProgress.push(message));
    assert.strictEqual(reusedWorker, firstWorker, 'O lote deve reutilizar a mesma instância do Tesseract entre arquivos.');
    assert.equal(workerCreations, 1, 'O modelo OCR deve ser inicializado uma única vez por lote.');
    firstWorker.report({ progress: 0.5 });
    assert.equal(firstProgress.length, 0, 'O progresso de um arquivo anterior não deve receber eventos do seguinte.');
    assert.equal(secondProgress.length, 1, 'O callback de progresso deve acompanhar o arquivo atual do lote.');
    await workerSession.reset();
    assert.equal(workerTerminations, 1, 'Reset deve encerrar o worker que falhou antes de tentar o próximo arquivo.');
    const replacementWorker = await workerSession.getWorker(() => {});
    assert.notStrictEqual(replacementWorker, firstWorker, 'Após falha, o próximo arquivo precisa de uma instância limpa.');
    assert.equal(workerCreations, 2);
    await workerSession.terminate();
    assert.equal(workerTerminations, 2, 'Encerrar o lote deve finalizar o worker compartilhado.');
    await assert.rejects(workerSession.getWorker(), /sessão de OCR.*encerrada/);
    results.push({ name: 'Ciclo de vida: reutilização, progresso atual, reinício e encerramento', language: 'eng', cer: null, wer: null, confidence: null });

    for (let index = 0; index < cases.length; index += 1) {
      const scenario = cases[index];
      const imageExtension = scenario.format === 'jpeg' ? 'jpg' : 'png';
      const imagePath = path.join(tempDir, `idioma-${index + 1}.${imageExtension}`);
      await createFixture(imagePath, scenario.lines, scenario.format || 'png', scenario.visual);
      let recognized;
      try {
        recognized = await recognizeImage(imagePath, { language: scenario.language, autoRotate: scenario.autoRotate === true, format: 'pdf' });
      } catch (error) {
        throw new Error(`Falha no cenário "${scenario.name}" (${imagePath}): ${error.message}`, { cause: error });
      }
      assert.equal(recognized.recognizedPages, 1, `${scenario.name}: página não foi reconhecida.`);
      assert.ok(recognized.pageResults[0].confidence > 0, `${scenario.name}: confiança não foi informada.`);
      assert.ok(!Object.hasOwn(recognized.pageResults[0], 'text'), `${scenario.name}: saída PDF reteve texto duplicado em memória.`);

      const searchablePath = path.join(tempDir, `pesquisavel-${index + 1}.pdf`);
      await fs.writeFile(searchablePath, Buffer.from(recognized.pdfBytes));
      const extracted = await extractStructuredText(searchablePath);
      const expected = normalizeForAccuracy(scenario.lines.join(' '));
      const actual = normalizeForAccuracy(extracted.pages.map((page) => page.text).join(' '));
      const cer = scenario.spatialOrderVaries ? null : editDistance(expected, actual) / Math.max(1, expected.length);
      const wer = scenario.spatialOrderVaries ? null : editDistance(expected.split(' '), actual.split(' ')) / Math.max(1, expected.split(' ').length);
      assert.ok(actual.length > 0, `${scenario.name}: PDF final não tem camada de texto extraível.`);
      for (const token of scenario.exactTokens || []) {
        assert.ok(actual.includes(normalizeForAccuracy(token)), `${scenario.name}: identificador ou valor perdeu texto/pontuação: "${token}". Reconhecido: "${actual}"; ângulo escolhido: ${recognized.pageResults[0].angle ?? 'n/a'}°.`);
      }
      if (scenario.spatialOrderVaries) {
        assert.equal(
          recognized.pageResults[0].orientationCorrectionDegrees,
          scenario.expectedOrientationCorrectionDegrees,
          `${scenario.name}: o motor não registrou o ângulo esperado de correção.`
        );
        const actualTokens = actual.split(/\s+/).filter(Boolean);
        const expectedTokens = scenario.orderIndependentTokens.map(normalizeForAccuracy);
        const missingTokens = expectedTokens.filter((token) => !actualTokens.includes(token));
        assert.deepStrictEqual(missingTokens, [], `${scenario.name}: OCR perdeu tokens de conteúdo: ${missingTokens.join(', ')}. Obtido: "${actual}".`);
        const search = await searchPdfDocument(searchablePath, scenario.lines[0], { language: scenario.language });
        const match = search.matches.find((item) => item.pageNumber === 1);
        assert.ok(match, `${scenario.name}: a pesquisa não encontrou a frase reconhecida na camada OCR. Texto extraído: "${actual}".`);
        assert.ok(
          ['xRatio', 'yRatio', 'widthRatio', 'heightRatio'].every((key) => Number.isFinite(match[key]) && match[key] >= 0 && match[key] <= 1)
            && match.widthRatio > 0 && match.heightRatio > 0,
          `${scenario.name}: a pesquisa encontrou texto, mas a região de destaque é inválida.`
        );
      } else {
        assert.ok(cer <= 0.12, `${scenario.name}: CER ${cer.toFixed(3)} excedeu 0.12; esperado="${expected}"; obtido="${actual}".`);
        assert.ok(wer <= 0.15, `${scenario.name}: WER ${wer.toFixed(3)} excedeu 0.15; esperado="${expected}"; obtido="${actual}".`);
      }
      if (scenario.language !== 'eng') {
        for (const accentedToken of ['ação', 'revisão', 'informações']) {
          if (expected.includes(accentedToken)) assert.ok(actual.includes(accentedToken), `${scenario.name}: acentuação ausente em “${accentedToken}”.`);
        }
      }
      results.push({
        name: scenario.name,
        language: scenario.language,
        cer,
        wer,
        confidence: recognized.pageResults[0].confidence,
        note: scenario.spatialOrderVaries ? 'tokens e busca/destaque verificados; ordem espacial pode variar, CER/WER sequencial não aplicável' : ''
      });
    }

    const scannedImagePath = path.join(tempDir, 'pagina-digitalizada.png');
    await createFixture(scannedImagePath, ['Documento escaneado aprovado.', 'Texto pesquisável gerado localmente.']);
    const scannedImage = await fs.readFile(scannedImagePath);
    const scannedPdf = await PDFDocument.create();
    const page = scannedPdf.addPage([1800, 360]);
    const embedded = await scannedPdf.embedPng(scannedImage);
    page.drawImage(embedded, { x: 0, y: 0, width: 1800, height: 360 });
    const scannedPdfPath = path.join(tempDir, 'pdf-digitalizado.pdf');
    await fs.writeFile(scannedPdfPath, await scannedPdf.save());
    const recognizedPdf = await recognizePdf(scannedPdfPath, { language: 'por+eng', mode: 'auto', format: 'pdf' });
    assert.equal(recognizedPdf.recognizedPages, 1, 'PDF digitalizado: a página não foi reconhecida.');
    assert.ok(!Object.hasOwn(recognizedPdf.pageResults[0], 'text'), 'PDF digitalizado: a saída PDF reteve uma cópia redundante do texto OCR.');
    const searchablePdfPath = path.join(tempDir, 'pdf-digitalizado-pesquisavel.pdf');
    await fs.writeFile(searchablePdfPath, Buffer.from(recognizedPdf.pdfBytes));
    const searchablePdf = await extractStructuredText(searchablePdfPath);
    assert.match(searchablePdf.pages[0].text, /Documento escaneado aprovado/i, 'A camada OCR precisa continuar pesquisável no PDF salvo.');
    results.push({ name: 'PDF digitalizado sem texto redundante em memória', language: 'por+eng', cer: null, wer: null, confidence: recognizedPdf.pageResults[0].confidence });

    const batchInputs = [];
    for (const [index, phrase] of ['Primeiro arquivo reconhecido.', 'Segundo arquivo reconhecido.'].entries()) {
      const imageFormat = index === 1 ? 'jpeg' : 'png';
      const imagePath = path.join(tempDir, `lote-${index + 1}.${imageFormat}`);
      await createFixture(imagePath, [phrase], imageFormat);
      batchInputs.push(imagePath);
      if (index === 0) {
        const invalidImagePath = path.join(tempDir, 'lote-invalido.png');
        await fs.writeFile(invalidImagePath, Buffer.from('arquivo não é uma imagem'));
        batchInputs.push(invalidImagePath);
      }
    }
    batchInputs.push(scannedPdfPath);
    const batchOutputDir = path.join(tempDir, 'saida-lote');
    const batchStartedAt = Date.now();
    const batch = createPdfWorkerExecution({
      type: 'ocr', files: batchInputs, outputDir: batchOutputDir,
      options: { language: 'por+eng', mode: 'auto', format: 'pdf' }
    });
    const batchResult = await batch.promise;
    const batchDurationMs = Date.now() - batchStartedAt;
    assert.equal(batchResult.outputCount, 3, 'O lote com OCR real deve preservar as três saídas válidas apesar de um item corrompido.');
    assert.equal(batchResult.failures.length, 1, 'O item corrompido deve ser relatado sem interromper o lote.');
    assert.equal(batchResult.recognizedPages, 3, 'O worker compartilhado deve reconhecer imagens e PDF digitalizado no lote.');
    for (let index = 0; index < batchResult.createdFiles.length; index += 1) {
      const outputText = await extractStructuredText(batchResult.createdFiles[index]);
      const expectedBatchPatterns = [/Primeiro arquivo reconhecido/i, /Segundo arquivo reconhecido/i, /Documento escaneado aprovado/i];
      assert.match(outputText.pages[0].text, expectedBatchPatterns[index]);
    }
    results.push({ name: 'Lote real: PNG, JPEG e PDF; falha isolada e saídas pesquisáveis', language: 'por+eng', cer: null, wer: null, confidence: batchResult.averageOcrConfidence, durationMs: batchDurationMs });

    const cancelOutputDir = path.join(tempDir, 'saida-cancelada');
    let cancelExecution;
    let cancelRequested = false;
    cancelExecution = createPdfWorkerExecution({
      type: 'ocr', files: [batchInputs[0], scannedPdfPath], outputDir: cancelOutputDir,
      options: { language: 'por+eng', mode: 'auto', format: 'pdf' }
    }, (progress) => {
      if (!cancelRequested && progress.currentItem === 1 && progress.itemProgress === 100) {
        cancelRequested = true;
        cancelExecution.cancel('test-cancel-shared-worker');
      }
    });
    await assert.rejects(cancelExecution.promise, /OPERATION_CANCELLED|test-cancel-shared-worker/i);
    assert.ok(cancelRequested, 'O cancelamento deveria ocorrer depois do primeiro arquivo do lote.');
    const completedBeforeCancel = await fs.readdir(cancelOutputDir);
    assert.ok(completedBeforeCancel.length <= 1, 'O cancelamento não deve iniciar nem deixar saída parcial para arquivos posteriores.');
    for (const fileName of completedBeforeCancel) {
      assert.match(fileName, /\.pdf$/i);
      const completedPdf = await PDFDocument.load(await fs.readFile(path.join(cancelOutputDir, fileName)));
      assert.equal(completedPdf.getPageCount(), 1, 'O arquivo concluído antes do cancelamento precisa continuar íntegro.');
    }
    results.push({ name: 'Cancelamento de lote: saída concluída íntegra e sessão liberada', language: 'por+eng', cer: null, wer: null, confidence: null });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }

  const reportPath = writeReport('ocr-language-accuracy-report.md', [
    '# Regressão de precisão por idioma e lote OCR',
    '',
    `Gerado em ${new Date().toISOString()}.`,
    '',
    '| Cenário | Idioma | CER | WER | Confiança do motor | Duração | Resultado / observação |',
    '| --- | --- | ---: | ---: | ---: | ---: | --- |',
    ...results.map((item) => `| ${item.name} | ${item.language} | ${item.cer === null ? 'n/a' : `${(item.cer * 100).toFixed(2)}%`} | ${item.wer === null ? 'n/a' : `${(item.wer * 100).toFixed(2)}%`} | ${item.confidence === null ? 'n/a' : item.confidence.toFixed(1)} | ${item.durationMs === undefined ? 'n/a' : `${item.durationMs} ms`} | ${item.note || 'passou'} |`),
    '',
    'As métricas preservam acentos e pontuação e comparam texto recuperado do PDF de saída. Para páginas giradas, a ordem espacial extraída pode diferir da leitura convencional; nesses casos o teste exige todos os tokens de referência e não declara CER/WER sequencial. O tempo é uma medição local, sem comparação controlada. Fixtures sintéticas não substituem corpus corporativo real.'
  ]);
  console.log(`OCR language, format, batch, and cancellation regressions: ${results.length}/${cases.length + 5}; relatório: ${reportPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
