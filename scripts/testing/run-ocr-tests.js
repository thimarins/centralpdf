const fs = require('fs');
const path = require('path');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { PDFDocument, PDFName, PDFString, PDFBool, StandardFonts, rgb } = require('pdf-lib');
const UTIF = require('utif');
const { createPdfWorkerExecution } = require('../../src/main/worker-runtime');
const pdfService = require('../../src/main/pdf-service');
const crypto = require('crypto');
const { extractStructuredText } = require('../../src/main/services/conversion/text-extractor');
const { convertPdfToWord } = require('../../src/main/services/conversion/pdf-to-word');
const { normalizeOcrMode, normalizeOcrDocumentError, pageNeedsOcr, parsePageRange, recognizeImage, recognizeWithAdaptiveOrientation, validateTiffPages, createRedactionSearchPattern, scoreOcrResult, createContrastEnhancedImage, createAdaptiveBinarizedImage, createIsolatedNoiseReducedImage, estimateSmallSkewCorrection, estimateBaselineSkewCorrection, getSafeOcrRenderDimensions, OCR_MAX_RENDER_PIXELS, findOcrRedactionCandidates, writeOcrOutput } = require('../../src/main/services/ocr/ocr-service');
const { IMAGE_LIMITS } = require('../../src/main/utils');
const { createOcrTelemetryMetrics, createOcrFailureMetrics } = require('../../src/main/services/ocr/ocr-telemetry');
const { getOcrRuntimeStatus, getOcrTessdataDirectory } = require('../../src/main/services/ocr/ocr-runtime');
const { OCR_LOW_CONFIDENCE_THRESHOLD, createLowConfidenceWarnings } = require('../../src/main/services/ocr/ocr-result-summary');
const { normalizeOcrProgressPercent, getOcrStageLabel, createOcrProgressUpdate } = require('../../src/main/services/ocr/ocr-progress');
const { createTempDir, writeReport, execCommand, assert } = require('./_common');

async function createSyntheticImage(filePath, text) {
  const canvas = createCanvas(1200, 300);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#111111';
  context.font = '64px Arial';
  context.fillText(text, 50, 150);
  fs.writeFileSync(filePath, canvas.toBuffer('image/png'));
}

function createOcrQualityFixture(filePath, { width, height, fontSize, lines, background = '#ffffff', textColor = '#111111', shadow = false }) {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  if (shadow) {
    const gradient = context.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, '#ffffff');
    gradient.addColorStop(0.58, '#eeeeee');
    gradient.addColorStop(1, '#c8c8c8');
    context.fillStyle = gradient;
  } else {
    context.fillStyle = background;
  }
  context.fillRect(0, 0, width, height);
  context.fillStyle = textColor;
  context.font = `${fontSize}px Arial`;
  context.textBaseline = 'top';
  const lineHeight = Math.round(fontSize * 1.65);
  lines.forEach((line, index) => context.fillText(line, 24, 24 + index * lineHeight));
  fs.writeFileSync(filePath, canvas.toBuffer('image/png'));
}

function createOcrLayoutFixture(filePath, { rows, width = 1800, height = 720, fontSize = 32, grid = false }) {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  const marginX = 80;
  const top = 90;
  const rowHeight = 110;
  const columnWidth = (width - marginX * 2) / rows[0].length;
  context.font = `${fontSize}px Arial`;
  context.textBaseline = 'middle';
  context.fillStyle = '#111111';

  if (grid) {
    context.strokeStyle = '#b8b8b8';
    context.lineWidth = 1;
    for (let row = 0; row <= rows.length; row += 1) {
      const y = top + row * rowHeight;
      context.beginPath();
      context.moveTo(marginX, y);
      context.lineTo(width - marginX, y);
      context.stroke();
    }
  }

  rows.forEach((row, rowIndex) => {
    row.forEach((cell, columnIndex) => {
      const x = marginX + columnIndex * columnWidth + 18;
      const y = top + rowIndex * rowHeight + rowHeight / 2;
      context.fillText(cell, x, y, columnWidth - 36);
    });
  });
  fs.writeFileSync(filePath, canvas.toBuffer('image/png'));
}

async function createRotatedImageFile(sourcePath, targetPath, angleDegrees) {
  const image = await loadImage(fs.readFileSync(sourcePath));
  const angle = angleDegrees * Math.PI / 180;
  const width = Math.ceil(image.width * Math.abs(Math.cos(angle)) + image.height * Math.abs(Math.sin(angle)));
  const height = Math.ceil(image.width * Math.abs(Math.sin(angle)) + image.height * Math.abs(Math.cos(angle)));
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, width, height);
  context.translate(width / 2, height / 2);
  context.rotate(angle);
  context.drawImage(image, -image.width / 2, -image.height / 2);
  fs.writeFileSync(targetPath, canvas.toBuffer('image/png'));
}

function createMultipageTiff(pages) {
  const ifds = pages.map(({ width, height }) => ({
    t256: [width], t257: [height], t258: [8, 8, 8, 8], t259: [1], t262: [2], t273: [0],
    t277: [4], t278: [height], t279: [width * height * 4], t284: [1], t338: [1]
  }));
  const directorySize = new Uint8Array(UTIF.encode(ifds)).length;
  let pixelOffset = directorySize;
  ifds.forEach((ifd) => {
    ifd.t273[0] = pixelOffset;
    pixelOffset += ifd.t279[0];
  });
  const directory = new Uint8Array(UTIF.encode(ifds));
  const result = new Uint8Array(pixelOffset);
  result.set(directory);
  let offset = directorySize;
  for (const page of pages) {
    result.set(page.rgba, offset);
    offset += page.rgba.length;
  }
  return result;
}

function encodePackBits(input) {
  const data = Buffer.from(input);
  const encoded = [];
  let index = 0;
  while (index < data.length) {
    let runLength = 1;
    while (runLength < 128 && index + runLength < data.length
      && data[index + runLength] === data[index]) runLength += 1;
    if (runLength >= 3) {
      encoded.push(1 - runLength, data[index]);
      index += runLength;
      continue;
    }

    const literalStart = index;
    index += runLength;
    while (index < data.length && index - literalStart < 128) {
      let nextRunLength = 1;
      while (nextRunLength < 128 && index + nextRunLength < data.length
        && data[index + nextRunLength] === data[index]) nextRunLength += 1;
      if (nextRunLength >= 3) break;
      index += Math.min(nextRunLength, 128 - (index - literalStart));
    }
    const literalLength = index - literalStart;
    encoded.push(literalLength - 1, ...data.subarray(literalStart, index));
  }
  return Buffer.from(encoded);
}

function createPackBitsTiff(page) {
  const compressedPixels = encodePackBits(page.rgba);
  const ifd = {
    t256: [page.width], t257: [page.height], t258: [8, 8, 8, 8], t259: [32773], t262: [2], t273: [0],
    t277: [4], t278: [page.height], t279: [compressedPixels.length], t284: [1], t338: [1]
  };
  const directorySize = new Uint8Array(UTIF.encode([ifd])).length;
  ifd.t273[0] = directorySize;
  const directory = new Uint8Array(UTIF.encode([ifd]));
  const result = Buffer.alloc(directorySize + compressedPixels.length);
  result.set(directory);
  result.set(compressedPixels, directorySize);
  return result;
}

async function runOperation(payload) {
  const progress = [];
  const execution = createPdfWorkerExecution(payload, (item) => progress.push(item));
  try {
    const result = await execution.promise;
    return { result, progress };
  } catch (error) {
    const files = (payload.files || []).map((filePath) => path.basename(filePath)).join(', ');
    throw new Error(`Falha no teste da operação ${payload.type}${payload.options?.mode ? ` (${payload.options.mode})` : ''}, arquivo(s) ${files}: ${error.message}`, { cause: error });
  }
}

function normalizedForMetrics(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function editDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    let diagonal = previous[0];
    previous[0] = row;
    for (let column = 1; column <= right.length; column += 1) {
      const above = previous[column];
      previous[column] = Math.min(previous[column] + 1, previous[column - 1] + 1, diagonal + (left[row - 1] === right[column - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return previous[right.length];
}

async function runOcrTests() {
  const workspace = createTempDir('ocr-suite');
  const bundledOcrRuntime = getOcrRuntimeStatus();
  assert.deepStrictEqual(bundledOcrRuntime.availableLanguages, ['por', 'eng'], 'Os modelos OCR locais do projeto não foram detectados.');
  const partialResourcesRoot = path.join(workspace, 'resources-parciais');
  const partialTessdata = path.join(partialResourcesRoot, 'ocr', 'tessdata');
  fs.mkdirSync(partialTessdata, { recursive: true });
  fs.copyFileSync(path.join(getOcrTessdataDirectory(), 'por.traineddata'), path.join(partialTessdata, 'por.traineddata'));
  const partialOcrRuntime = getOcrRuntimeStatus(['por', 'eng'], { resourcesPath: partialResourcesRoot });
  assert.strictEqual(partialOcrRuntime.available, false);
  assert.deepStrictEqual(partialOcrRuntime.availableLanguages, ['por']);
  assert.deepStrictEqual(partialOcrRuntime.missingLanguages, ['eng']);
  assert.deepStrictEqual(partialOcrRuntime.invalidLanguages, []);
  assert.match(partialOcrRuntime.message, /inglês/);
  const corruptedResourcesRoot = path.join(workspace, 'resources-corrompidos');
  const corruptedTessdata = path.join(corruptedResourcesRoot, 'ocr', 'tessdata');
  fs.mkdirSync(corruptedTessdata, { recursive: true });
  const corruptedModel = path.join(corruptedTessdata, 'por.traineddata');
  fs.copyFileSync(path.join(getOcrTessdataDirectory(), 'por.traineddata'), corruptedModel);
  const corruptedBytes = fs.readFileSync(corruptedModel);
  corruptedBytes[corruptedBytes.length - 1] ^= 0xff;
  fs.writeFileSync(corruptedModel, corruptedBytes);
  const corruptedOcrRuntime = getOcrRuntimeStatus(['por'], { resourcesPath: corruptedResourcesRoot });
  assert.strictEqual(corruptedOcrRuntime.available, false, 'Um modelo adulterado foi aceito pelo preflight do OCR.');
  assert.deepStrictEqual(corruptedOcrRuntime.invalidLanguages, ['por']);
  assert.deepStrictEqual(corruptedOcrRuntime.missingLanguages, []);
  assert.match(corruptedOcrRuntime.message, /danificado ou foi alterado/);
  const missingResourcesRoot = path.join(workspace, 'resources-ausentes');
  fs.mkdirSync(path.join(missingResourcesRoot, 'ocr'), { recursive: true });
  const missingOcrRuntime = getOcrRuntimeStatus(['por', 'eng'], { resourcesPath: missingResourcesRoot });
  assert.deepStrictEqual(missingOcrRuntime.availableLanguages, []);
  assert.strictEqual(missingOcrRuntime.message.includes('português') && missingOcrRuntime.message.includes('inglês'), true);
  const ocrTelemetry = createOcrTelemetryMetrics({
    taskId: 'ocr-test-123', durationMs: 420, files: 2,
    result: {
      outputCount: 1, pageCount: 5, recognizedPages: 2, skippedPages: 1, unselectedPages: 1, noTextPages: 1,
      orientationCorrections: 1, preprocessingPages: 1, failures: [{ fileName: 'confidencial.pdf' }],
      warnings: ['revisar qualidade'],
      pageResults: [
        { status: 'recognized', confidence: 80, text: 'CONTEÚDO PRIVADO 123456' },
        { status: 'recognized', confidence: 60, text: 'OUTRO TEXTO PRIVADO' },
        { status: 'skipped', fileName: 'caminho\\privado.pdf' },
        { status: 'no-text' },
        { status: 'out-of-range' }
      ]
    },
    options: { language: 'por+eng', mode: 'complete', format: 'pdf', query: 'não deve ser registrado' }
  });
  assert.strictEqual(ocrTelemetry.schemaVersion, 3, 'O status normalizado deve versionar o esquema da telemetria.');
  assert.strictEqual(ocrTelemetry.status, 'partial');
  assert.strictEqual(ocrTelemetry.engine, 'Tesseract.js');
  assert.match(ocrTelemetry.engineVersion, /^\d+\.\d+\.\d+/);
  assert.strictEqual(ocrTelemetry.totalPages, 5);
  assert.strictEqual(ocrTelemetry.averageConfidence, 70);
  assert.strictEqual(ocrTelemetry.noTextPages, 1);
  assert.strictEqual(ocrTelemetry.unselectedPages, 1);
  assert.strictEqual(ocrTelemetry.failedFiles, 1);
  assert.strictEqual(createOcrTelemetryMetrics({ result: { pageCount: 1, recognizedPages: 1 } }).status, 'success');
  assert.strictEqual(createOcrTelemetryMetrics({ result: { warnings: ['aviso'] } }).status, 'partial');
  assert.ok(!JSON.stringify(ocrTelemetry).includes('PRIVADO'));
  assert.ok(!JSON.stringify(ocrTelemetry).includes('confidencial.pdf'));
  assert.ok(!JSON.stringify(ocrTelemetry).includes('caminho'));
  assert.ok(!JSON.stringify(ocrTelemetry).includes('não deve ser registrado'));
  const ocrFailureTelemetry = createOcrFailureMetrics({
    taskId: 'ocr-failure-test', durationMs: 55, attempt: 2, maxAttempts: 3,
    error: Object.assign(new Error('CPF 123.456.789-09 em cliente-confidencial.pdf C:\\Users\\Pessoa\\segredo.pdf'), { code: 'EACCES' })
  });
  assert.strictEqual(ocrFailureTelemetry.failureCode, 'EACCES');
  assert.strictEqual(ocrFailureTelemetry.status, 'failed');
  assert.strictEqual(ocrFailureTelemetry.attempt, 2);
  assert.strictEqual(createOcrFailureMetrics({ error: new Error('OPERATION_CANCELLED') }).status, 'cancelled');
  assert.strictEqual(createOcrFailureMetrics({ error: new Error('OPERATION_TIMEOUT') }).status, 'timeout');
  assert.ok(!JSON.stringify(ocrFailureTelemetry).includes('123.456.789-09'));
  assert.ok(!JSON.stringify(ocrFailureTelemetry).includes('cliente-confidencial.pdf'));
  assert.ok(!JSON.stringify(ocrFailureTelemetry).includes('segredo.pdf'));
  assert.strictEqual(createOcrFailureMetrics({ error: Object.assign(new Error('segredo'), { code: 'CPF-LEAK' }) }).failureCode, 'OCR_FAILED');
  const passwordPdfError = normalizeOcrDocumentError(Object.assign(new Error('Password required'), { name: 'PasswordException', code: 1 }));
  assert.match(passwordPdfError.message, /protegido por senha.*Desbloquear PDF/i);
  assert.match(normalizeOcrDocumentError(Object.assign(new Error('Invalid PDF'), { name: 'InvalidPDFException' })).message, /inválido ou danificado/i);
  const lowConfidenceWarnings = createLowConfidenceWarnings([
    { fileName: 'relatorio.pdf', pageNumber: 2, status: 'recognized', confidence: OCR_LOW_CONFIDENCE_THRESHOLD - 1 },
    { fileName: 'relatorio.pdf', pageNumber: 4, status: 'recognized', confidence: 10 },
    { fileName: 'relatorio.pdf', pageNumber: 5, status: 'recognized', confidence: OCR_LOW_CONFIDENCE_THRESHOLD },
    { fileName: 'relatorio.pdf', pageNumber: 6, status: 'no-text', confidence: 0 },
    { fileName: 'outro.pdf', pageNumber: 1, status: 'recognized', confidence: 80 }
  ]);
  assert.strictEqual(lowConfidenceWarnings.length, 1, 'Avisos de baixa confiança devem ser agrupados por arquivo.');
  assert.match(lowConfidenceWarnings[0], /relatorio\.pdf.*2 página\(s\).*2, 4/);
  assert.match(lowConfidenceWarnings[0], /confiança estimada baixa/);
  assert.ok(!lowConfidenceWarnings[0].includes('outro.pdf'));
  assert.strictEqual(createOcrTelemetryMetrics({ options: { mode: 'anything', format: 'html', language: 'fra' } }).mode, 'auto');
  assert.strictEqual(createOcrTelemetryMetrics({ options: { mode: 'anything', format: 'html', language: 'fra' } }).language, 'por+eng');
  assert.strictEqual(normalizeOcrProgressPercent(0.35, true), 35, 'Progresso fracionário do motor deve ser convertido para porcentagem.');
  assert.strictEqual(normalizeOcrProgressPercent(35, false), 35, 'Progresso de página já expresso em percentual não deve ser alterado.');
  assert.strictEqual(getOcrStageLabel('recognizing text'), 'Reconhecendo texto', 'A etapa técnica do Tesseract deve ser apresentada em português simples.');
  const progressUpdate = createOcrProgressUpdate({ stage: 'motor', status: 'recognizing text', progress: 0.35 }, {
    fileIndex: 1, fileCount: 4, fileName: 'arquivo.pdf'
  });
  assert.strictEqual(progressUpdate.itemProgress, 35);
  assert.strictEqual(progressUpdate.progress, 34, 'O progresso do arquivo atual deve contribuir proporcionalmente para o lote.');
  assert.strictEqual(progressUpdate.currentItemName, 'arquivo.pdf — Reconhecendo texto');
  const failedWriteSource = path.join(workspace, 'original-preservado.pdf');
  const failedWriteSourceBytes = Buffer.from('PDF original do teste');
  fs.writeFileSync(failedWriteSource, failedWriteSourceBytes);
  const validOutputFixture = await PDFDocument.create();
  validOutputFixture.addPage([100, 100]);
  const validOutputBytes = Buffer.from(await validOutputFixture.save());
  const failedWriteOutput = path.join(workspace, 'falha-de-gravacao');
  await fs.promises.mkdir(failedWriteOutput, { recursive: true });
  const noSpaceFileSystem = {
    ...fs.promises,
    writeFile: async (filePath, data, options) => {
      await fs.promises.writeFile(filePath, Buffer.from(data).subarray(0, 12), options);
      const error = new Error('simulated disk full');
      error.code = 'ENOSPC';
      throw error;
    }
  };
  await assert.rejects(
    writeOcrOutput({ pdfBytes: validOutputBytes, pageCount: 1, pageResults: [] }, failedWriteSource, failedWriteOutput, {}, noSpaceFileSystem),
    (error) => error.code === 'ENOSPC'
  );
  assert.deepStrictEqual(fs.readdirSync(failedWriteOutput), [], 'Falha de espaço deixou arquivo parcial/temporário no destino.');
  assert.deepStrictEqual(fs.readFileSync(failedWriteSource), failedWriteSourceBytes, 'Falha de espaço alterou o arquivo original.');
  const failedRenameFileSystem = {
    ...fs.promises,
    rename: async () => {
      const error = new Error('simulated access denied');
      error.code = 'EACCES';
      throw error;
    }
  };
  await assert.rejects(
    writeOcrOutput({ pdfBytes: validOutputBytes, pageCount: 1, pageResults: [] }, failedWriteSource, failedWriteOutput, {}, failedRenameFileSystem),
    (error) => error.code === 'EACCES'
  );
  assert.deepStrictEqual(fs.readdirSync(failedWriteOutput), [], 'Falha ao finalizar o arquivo deixou um temporário no destino.');
  assert.deepStrictEqual(fs.readFileSync(failedWriteSource), failedWriteSourceBytes, 'Falha ao finalizar o arquivo alterou o original.');
  for (const code of ['EPERM', 'EBUSY']) {
    const lockedFileSystem = {
      ...fs.promises,
      rename: async () => {
        const error = new Error(code === 'EBUSY' ? 'simulated file is busy' : 'simulated operation not permitted');
        error.code = code;
        throw error;
      }
    };
    await assert.rejects(
      writeOcrOutput({ pdfBytes: validOutputBytes, pageCount: 1, pageResults: [] }, failedWriteSource, failedWriteOutput, {}, lockedFileSystem),
      (error) => error.code === code
    );
    assert.deepStrictEqual(fs.readdirSync(failedWriteOutput), [], `Falha ${code} deixou arquivos temporários ou reserva vazia.`);
    assert.deepStrictEqual(fs.readFileSync(failedWriteSource), failedWriteSourceBytes, `Falha ${code} alterou o original.`);
  }
  await assert.rejects(
    writeOcrOutput({ pdfBytes: Buffer.from('%PDF-corrompido'), pageCount: 1, pageResults: [] }, failedWriteSource, failedWriteOutput, {}),
    /não passou na verificação de integridade/
  );
  assert.deepStrictEqual(fs.readdirSync(failedWriteOutput), [], 'Payload de PDF inválido deixou arquivo publicado ou temporário.');
  assert.deepStrictEqual(fs.readFileSync(failedWriteSource), failedWriteSourceBytes, 'A rejeição de saída inválida alterou o original.');
  assert.ok(scoreOcrResult({ text: 'OK', confidence: 99 }) < 65, 'Confiança alta não deve mascarar uma leitura quase vazia.');
  assert.ok(scoreOcrResult({ text: '■■■■■■■■■■■■', confidence: 99 }) < 65, 'Texto predominantemente simbólico deve acionar a revisão adaptativa.');
  const lowContrastCanvas = createCanvas(800, 180);
  const lowContrastContext = lowContrastCanvas.getContext('2d');
  lowContrastContext.fillStyle = '#eeeeee';
  lowContrastContext.fillRect(0, 0, lowContrastCanvas.width, lowContrastCanvas.height);
  lowContrastContext.fillStyle = '#d5d5d5';
  lowContrastContext.font = '54px Arial';
  lowContrastContext.fillText('Contraste OCR', 30, 110);
  const enhancedContrastBytes = await createContrastEnhancedImage(lowContrastCanvas.toBuffer('image/png'));
  assert.ok(enhancedContrastBytes, 'Uma imagem sintética de baixo contraste deve gerar uma alternativa aprimorada.');
  const enhancedContrastImage = await loadImage(enhancedContrastBytes);
  assert.deepStrictEqual([enhancedContrastImage.width, enhancedContrastImage.height], [lowContrastCanvas.width, lowContrastCanvas.height], 'O realce de contraste não deve alterar as dimensões visuais.');
  const adaptiveThresholdBytes = await createAdaptiveBinarizedImage(lowContrastCanvas.toBuffer('image/png'));
  assert.ok(adaptiveThresholdBytes, 'O pré-processamento adaptativo deve gerar uma alternativa dentro do limite de pixels.');
  const adaptiveThresholdImage = await loadImage(adaptiveThresholdBytes);
  assert.deepStrictEqual([adaptiveThresholdImage.width, adaptiveThresholdImage.height], [lowContrastCanvas.width, lowContrastCanvas.height], 'A binarização adaptativa não deve alterar as dimensões.');
  const adaptiveThresholdCanvas = createCanvas(adaptiveThresholdImage.width, adaptiveThresholdImage.height);
  const adaptiveThresholdContext = adaptiveThresholdCanvas.getContext('2d', { willReadFrequently: true });
  adaptiveThresholdContext.drawImage(adaptiveThresholdImage, 0, 0);
  const adaptivePixels = adaptiveThresholdContext.getImageData(0, 0, adaptiveThresholdImage.width, adaptiveThresholdImage.height).data;
  assert.ok(adaptivePixels.some((value, index) => index % 4 === 0 && value === 0));
  assert.ok(adaptivePixels.some((value, index) => index % 4 === 0 && value === 255));
  assert.strictEqual(await createAdaptiveBinarizedImage(lowContrastCanvas.toBuffer('image/png'), { maxPixels: 1 }), null, 'O pré-processamento deve respeitar o limite de pixels solicitado.');
  const noisyCanvas = createCanvas(60, 30);
  const noisyContext = noisyCanvas.getContext('2d');
  noisyContext.fillStyle = '#ffffff';
  noisyContext.fillRect(0, 0, noisyCanvas.width, noisyCanvas.height);
  noisyContext.fillStyle = '#000000';
  noisyContext.fillRect(10, 8, 20, 14);
  noisyContext.fillRect(45, 15, 1, 1);
  noisyContext.fillStyle = '#ffffff';
  noisyContext.fillRect(20, 15, 1, 1);
  const noisyBytes = noisyCanvas.toBuffer('image/png');
  const denoisedBytes = await createIsolatedNoiseReducedImage(noisyBytes);
  assert.ok(denoisedBytes, 'Ruído isolado em fundo uniforme deve gerar uma alternativa.');
  const denoisedImage = await loadImage(denoisedBytes);
  assert.deepStrictEqual([denoisedImage.width, denoisedImage.height], [60, 30], 'A remoção de ruído não deve alterar as dimensões.');
  const denoisedCanvas = createCanvas(60, 30);
  const denoisedContext = denoisedCanvas.getContext('2d', { willReadFrequently: true });
  denoisedContext.drawImage(denoisedImage, 0, 0);
  const denoisedPixels = denoisedContext.getImageData(0, 0, 60, 30).data;
  const isolatedBlackOffset = (15 * 60 + 45) * 4;
  const isolatedWhiteOffset = (15 * 60 + 20) * 4;
  assert.ok(denoisedPixels[isolatedBlackOffset] > 220, 'Pixel preto isolado no fundo claro deveria ser removido.');
  assert.ok(denoisedPixels[isolatedWhiteOffset] < 35, 'Pixel branco isolado dentro da região escura deveria ser removido.');
  assert.strictEqual(await createIsolatedNoiseReducedImage(noisyBytes, { maxPixels: 100 }), null, 'A remoção de ruído deve respeitar o limite de pixels.');
  let denoiseCancellationChecks = 0;
  await assert.rejects(
    createIsolatedNoiseReducedImage(noisyBytes, {
      isCancelled: () => { denoiseCancellationChecks += 1; return denoiseCancellationChecks > 1; }
    }),
    (error) => error.message === 'OPERATION_CANCELLED',
    'A remoção de ruído deve ceder e respeitar cancelamento entre blocos.'
  );
  assert.ok(denoiseCancellationChecks > 1, 'O cancelamento da remoção de ruído não foi consultado durante o processamento.');
  let adaptiveCancellationChecks = 0;
  await assert.rejects(
    createAdaptiveBinarizedImage(lowContrastCanvas.toBuffer('image/png'), {
      isCancelled: () => { adaptiveCancellationChecks += 1; return adaptiveCancellationChecks > 2; }
    }),
    (error) => error.message === 'OPERATION_CANCELLED',
    'O pré-processamento adaptativo deve permitir cancelamento entre blocos de linhas.'
  );
  assert.ok(adaptiveCancellationChecks > 2, 'O cancelamento do pré-processamento não foi consultado durante o processamento.');
  const datePattern = createRedactionSearchPattern('DATA');
  assert.deepStrictEqual('Vencimento 31/12/2025 e emissão 2026-01-09'.match(datePattern), ['31/12/2025', '2026-01-09']);
  assert.strictEqual('texto 2025 sem data'.match(createRedactionSearchPattern('DATA')), null);
  const input = path.join(workspace, 'documento-teste.png');
  const outputDir = path.join(workspace, 'output');
  await createSyntheticImage(input, 'Central PDF teste OCR validado');

  const imageRun = await runOperation({
    type: 'ocr',
    files: [input],
    options: { language: 'por+eng', mode: 'auto', format: 'pdf' },
    outputDir
  });
  assert.strictEqual(imageRun.result.outputCount, 1);
  assert.strictEqual(imageRun.result.recognizedPages, 1);
  assert.ok(imageRun.result.pageResults.every((page) => !Object.hasOwn(page, 'text')), 'Texto reconhecido não deve ser exposto no resultado público da fila.');
  assert.ok(imageRun.progress.some((item) => item.progress >= 100));
  assert.ok(fs.existsSync(imageRun.result.firstOutputPath));

  const orientationMetrics = [];
  const skewMetrics = [];
  for (const sourceAngle of [1.25, -1.5]) {
    const skewedImagePath = path.join(workspace, `documento-inclinado-${String(sourceAngle).replace('.', '_')}.png`);
    await createRotatedImageFile(input, skewedImagePath, sourceAngle);
    const estimatedCorrection = await estimateSmallSkewCorrection(fs.readFileSync(skewedImagePath));
    assert.ok(Math.abs(estimatedCorrection + sourceAngle) <= 0.75, `A estimativa deve aproximar a correção necessária para inclinação de ${sourceAngle}°; obtido ${estimatedCorrection}°.`);
    skewMetrics.push({ sourceAngle, estimatedCorrection });
  }
  const baselineSkewData = {
    blocks: [{ paragraphs: [{ lines: [3.9, 4.1, 4.0, 4.2, 3.8, 25].map((angle) => ({ baseline: {
      x0: 50, y0: 120, x1: 450, y1: 120 + (400 * Math.tan(angle * Math.PI / 180))
    } })) }] }]
  };
  const baselineSkewCorrection = estimateBaselineSkewCorrection(baselineSkewData);
  assert.ok(Math.abs(baselineSkewCorrection + 4.05) <= 0.2, `A inclinação estimada nas linhas reconhecidas deve corrigir aproximadamente 4°; obtido ${baselineSkewCorrection}°.`);
  assert.strictEqual(estimateBaselineSkewCorrection({ blocks: [] }), 0, 'Sem linhas OCR suficientes, a correção pela linha de base não deve inventar rotação.');
  const baselineSkewPath = path.join(workspace, 'documento-inclinado-linhas-ocr.png');
  await createRotatedImageFile(input, baselineSkewPath, 4);
  let baselineSkewRecognitionCount = 0;
  const baselineSkewResult = await recognizeWithAdaptiveOrientation(
    fs.readFileSync(baselineSkewPath),
    { recognize: async () => {
      baselineSkewRecognitionCount += 1;
      return { data: baselineSkewRecognitionCount === 1
        ? { ...baselineSkewData, text: 'texto inicial', confidence: 40 }
        : { text: 'texto corrigido com linha de base e conteúdo suficiente', confidence: 95 } };
    } },
    { autoRotate: true, imageEnhancement: false },
    () => false
  );
  assert.ok(baselineSkewResult.angle < -3.5 && baselineSkewResult.angle > -4.5,
    `A inclinação indicada pelas linhas deve ser corrigida antes de decidir pelas rotações de 90°; obtido ${baselineSkewResult.angle}°.`);
  assert.ok(baselineSkewRecognitionCount >= 2, 'A hipótese de deskew baseada no resultado OCR deve ser verificada com uma nova leitura.');
  let rotated90OutputPath = '';
  let rotated180OutputPath = '';
  for (const inputAngle of [90, 180, 270]) {
    const rotatedImagePath = path.join(workspace, `documento-rotacionado-${inputAngle}.png`);
    await createRotatedImageFile(input, rotatedImagePath, inputAngle);
    const rotatedImageRun = await runOperation({
      type: 'ocr', files: [rotatedImagePath], options: { language: 'por+eng', mode: 'auto', format: 'pdf' }, outputDir
    });
    const rotatedPage = rotatedImageRun.result.pageResults.find((page) => page.fileName === path.basename(rotatedImagePath));
    assert.ok(rotatedPage && Math.abs(rotatedPage.orientationCorrectionDegrees) >= (inputAngle === 180 ? 178 : 88),
      `O modo adaptativo deve corrigir a imagem girada em ${inputAngle} graus (correção=${rotatedPage?.orientationCorrectionDegrees}, confiança=${rotatedPage?.confidence}).`);
    const rotatedOutputText = await extractStructuredText(rotatedImageRun.result.createdFiles[0]);
    const normalizedRotatedText = normalizedForMetrics(rotatedOutputText.pages[0].text);
    assert.ok(['central', 'pdf', 'teste', 'ocr', 'validado'].every((token) => normalizedRotatedText.includes(token)), `A camada pesquisável deve preservar as palavras reconhecidas após a correção de ${inputAngle} graus (correção ${rotatedPage.orientationCorrectionDegrees}°, confiança ${rotatedPage.confidence}): ${JSON.stringify(rotatedOutputText.pages[0].text)}`);
    assert.ok(rotatedPage.confidence >= 60, `A orientação alternativa de ${inputAngle} graus deve superar a confiança mínima do fixture.`);
    orientationMetrics.push({ inputAngle, correction: rotatedPage.orientationCorrectionDegrees, confidence: rotatedPage.confidence });
    if (inputAngle === 90) rotated90OutputPath = rotatedImageRun.result.createdFiles[0];
    if (inputAngle === 180) rotated180OutputPath = rotatedImageRun.result.createdFiles[0];
  }
  const rotatedSearch = await runOperation({
    type: 'ocr-search-document', files: [rotated90OutputPath], options: { query: 'Central PDF', language: 'por+eng' }, outputDir
  });
  assert.ok(rotatedSearch.result.matches.length > 0, 'A página corrigida deve poder ser localizada pela pesquisa textual.');
  assert.ok(rotatedSearch.result.matches.every((match) => match.xRatio >= 0 && match.yRatio >= 0 && match.xRatio + match.widthRatio <= 1.001 && match.yRatio + match.heightRatio <= 1.001));
  assert.ok(rotatedSearch.result.matches.some((match) => match.heightRatio > match.widthRatio), 'As caixas de pesquisa devem permanecer alinhadas à orientação original, sem girar a imagem visual.');
  const rotated180Search = await runOperation({
    type: 'ocr-search-document', files: [rotated180OutputPath], options: { query: 'Central PDF', language: 'por+eng' }, outputDir
  });
  assert.ok(rotated180Search.result.matches.length > 0, 'O texto do documento corrigido em 180° deve continuar pesquisável.');
  assert.ok(rotated180Search.result.matches.every((match) => match.xRatio >= 0 && match.yRatio >= 0 && match.xRatio + match.widthRatio <= 1.001 && match.yRatio + match.heightRatio <= 1.001), 'A busca em página corrigida em 180° deve retornar caixas dentro da página.');
  assert.ok(rotated180Search.result.matches.some((match) => match.xRatio + match.widthRatio / 2 > 0.5), 'A busca em página corrigida em 180° deve acompanhar a posição espelhada do texto no raster original.');
  const orientationDisabled = await runOperation({
    type: 'ocr', files: [path.join(workspace, 'documento-rotacionado-90.png')], options: { language: 'por+eng', mode: 'auto', format: 'pdf', autoRotate: false }, outputDir
  });
  assert.strictEqual(orientationDisabled.result.orientationCorrections, 0, 'Desativar a correção automática deve ser respeitado.');
  const lowContrastPath = path.join(workspace, 'contraste-baixo-sem-rotacao.png');
  createOcrQualityFixture(lowContrastPath, { width: 800, height: 320, fontSize: 38, lines: ['Texto legível após melhoria'], background: '#b8b8b8', textColor: '#c5c5c5' });
  let lowContrastRecognitions = 0;
  const lowContrastProgress = [];
  const lowContrastResult = await recognizeWithAdaptiveOrientation(
    fs.readFileSync(lowContrastPath),
    { recognize: async () => {
      lowContrastRecognitions += 1;
      return { data: { text: 'Texto reconhecido em documento pesquisavel', confidence: lowContrastRecognitions === 1 ? 10 : 95 } };
    } },
    { autoRotate: false },
    () => false,
    (item) => lowContrastProgress.push(item)
  );
  assert.strictEqual(lowContrastRecognitions, 2, 'Desativar rotação também bloqueou a tentativa separada de melhoria de imagem.');
  assert.strictEqual(lowContrastResult.preprocessingApplied, true, 'A melhoria de baixo contraste não foi aplicada mesmo com rotação desativada.');
  assert.ok(!lowContrastProgress.some((item) => item.stage === 'orientation-check'), 'A opção desativada ainda tentou girar a imagem.');
  let enhancementDisabledRecognitions = 0;
  const enhancementDisabledResult = await recognizeWithAdaptiveOrientation(
    fs.readFileSync(lowContrastPath),
    { recognize: async () => {
      enhancementDisabledRecognitions += 1;
      return { data: { text: 'Texto reconhecido em documento pesquisavel', confidence: 10 } };
    } },
    { autoRotate: false, imageEnhancement: false },
    () => false
  );
  assert.strictEqual(enhancementDisabledRecognitions, 1, 'A opção de melhoria desativada ainda fez novas tentativas de processamento.');
  assert.strictEqual(enhancementDisabledResult.preprocessingApplied, false, 'A opção de melhoria de imagem não foi respeitada.');

  const tiffPages = ['Pagina TIFF um', 'Pagina TIFF dois'].map((label) => {
    const canvasForTiff = createCanvas(1200, 300);
    const tiffContext = canvasForTiff.getContext('2d');
    tiffContext.fillStyle = '#fff';
    tiffContext.fillRect(0, 0, 1200, 300);
    tiffContext.fillStyle = '#111';
    tiffContext.font = '64px Arial';
    tiffContext.fillText(label, 50, 150);
    return { width: 1200, height: 300, rgba: tiffContext.getImageData(0, 0, 1200, 300).data };
  });
  const tiffBytes = createMultipageTiff(tiffPages);
  assert.strictEqual(UTIF.decode(tiffBytes.buffer).length, 2);
  const tiffPath = path.join(workspace, 'documento-teste.tiff');
  fs.writeFileSync(tiffPath, Buffer.from(tiffBytes));
  const tiffRun = await runOperation({ type: 'ocr', files: [tiffPath], options: { language: 'por+eng', mode: 'auto', format: 'pdf' }, outputDir });
  assert.strictEqual(tiffRun.result.outputCount, 1);
  assert.strictEqual(tiffRun.result.pageResults.length, 2);
  const tiffText = await extractStructuredText(tiffRun.result.firstOutputPath);
  const tiffRecognized = tiffText.pages.map((page) => page.text).join('\n');
  assert.match(tiffRecognized, /Pagina/i);
  assert.match(tiffRecognized, /TIFF um/i);
  assert.match(tiffRecognized, /TIFF dois/i);
  const packBitsTiffPath = path.join(workspace, 'documento-packbits.tiff');
  const packBitsBytes = createPackBitsTiff(tiffPages[0]);
  fs.writeFileSync(packBitsTiffPath, packBitsBytes);
  const packBitsIfds = UTIF.decode(packBitsBytes.buffer.slice(
    packBitsBytes.byteOffset, packBitsBytes.byteOffset + packBitsBytes.byteLength
  ));
  assert.strictEqual(packBitsIfds.length, 1, 'O TIFF PackBits sintético precisa ter uma página.');
  UTIF.decodeImage(packBitsBytes.buffer.slice(
    packBitsBytes.byteOffset, packBitsBytes.byteOffset + packBitsBytes.byteLength
  ), packBitsIfds[0]);
  assert.ok(packBitsIfds[0].data?.length >= tiffPages[0].width * tiffPages[0].height * 4,
    'O decodificador não expandiu a imagem TIFF PackBits até o tamanho esperado.');
  const packBitsRun = await runOperation({
    type: 'ocr', files: [packBitsTiffPath], options: { language: 'por+eng', mode: 'auto', format: 'pdf' }, outputDir
  });
  const packBitsText = await extractStructuredText(packBitsRun.result.firstOutputPath);
  assert.match(packBitsText.pages[0].text, /Pagina/i, 'OCR não reconheceu texto da imagem TIFF PackBits.');
  assert.match(packBitsText.pages[0].text, /TIFF um/i, 'OCR perdeu o conteúdo do TIFF PackBits comprimido.');
  const tiffSourceHash = crypto.createHash('sha256').update(fs.readFileSync(tiffPath)).digest('hex');
  const tiffSelectedRun = await runOperation({
    type: 'ocr', files: [tiffPath], options: { language: 'por+eng', mode: 'auto', format: 'pdf', pageRange: '2' }, outputDir
  });
  assert.strictEqual(tiffSelectedRun.result.pageResults.length, 2);
  assert.deepStrictEqual(tiffSelectedRun.result.pageResults.map((page) => page.status), ['out-of-range', 'recognized']);
  assert.strictEqual(tiffSelectedRun.result.recognizedPages, 1);
  const tiffSelectedPdf = await PDFDocument.load(fs.readFileSync(tiffSelectedRun.result.firstOutputPath));
  assert.strictEqual(tiffSelectedPdf.getPageCount(), 2, 'Selecionar páginas do TIFF deve manter todas as páginas visuais no PDF final.');
  const tiffSelectedText = await extractStructuredText(tiffSelectedRun.result.firstOutputPath);
  assert.doesNotMatch(tiffSelectedText.pages[0].text, /TIFF um/i, 'A página fora do intervalo não deve receber camada OCR.');
  assert.match(tiffSelectedText.pages[1].text, /TIFF dois/i, 'A página escolhida deve receber camada pesquisável.');
  assert.strictEqual(crypto.createHash('sha256').update(fs.readFileSync(tiffPath)).digest('hex'), tiffSourceHash, 'O TIFF original deve permanecer intacto.');
  assert.throws(() => validateTiffPages([
    { width: 32_000_000, height: 1 }, { width: 32_000_000, height: 1 }, { width: 32_000_000, height: 1 }
  ]), /resolução total alta demais/i, 'O conjunto de páginas TIFF não deve exceder o limite agregado de pixels.');
  await assert.rejects(
    recognizeImage(tiffPath, { language: 'por+eng', mode: 'auto', format: 'pdf', pageRange: '1-3' }),
    /intervalo deve estar entre as páginas 1 e 2/i,
    'Intervalo que excede a quantidade de páginas TIFF deve ser explicado antes de publicar saída.'
  );
  await assert.rejects(
    recognizeImage(input, { language: 'por+eng', mode: 'auto', format: 'pdf', pageRange: '2' }),
    /intervalo deve estar entre as páginas 1 e 1/i,
    'A faixa deve ser validada para imagem PNG/JPG de página única, em vez de ignorada.'
  );
  const oversizedImagePath = path.join(workspace, 'imagem-acima-do-limite.png');
  const oversizedImageFd = fs.openSync(oversizedImagePath, 'w');
  try {
    fs.ftruncateSync(oversizedImageFd, IMAGE_LIMITS.maxImageBytes + 1);
  } finally {
    fs.closeSync(oversizedImageFd);
  }
  await assert.rejects(
    recognizeImage(oversizedImagePath, { language: 'por+eng', mode: 'auto', format: 'pdf' }),
    /limite de 25 MB/i,
    'Imagens acima do limite devem ser recusadas antes de ler o conteúdo inteiro ou iniciar OCR.'
  );

  const extraction = await extractStructuredText(imageRun.result.firstOutputPath);
  const recognizedSample = normalizedForMetrics(extraction.pages.map((page) => page.text).join('\n'));
  const expectedSample = normalizedForMetrics('Central PDF teste OCR validado');
  assert.ok(recognizedSample.includes(expectedSample));
  const nativeSearch = await runOperation({
    type: 'ocr-search-document', files: [imageRun.result.firstOutputPath],
    options: { query: 'CÊNTRAL pdf téste OCR VALIDADO', language: 'por+eng' }, outputDir
  });
  assert.ok(nativeSearch.result.matches.length > 0, 'Pesquisa não encontrou texto nativo sem diferenciar maiúsculas ou acentos.');
  assert.strictEqual(nativeSearch.result.matches[0].source, 'texto');
  assert.ok(nativeSearch.result.matches.every((match) => !Object.hasOwn(match, 'text')), 'A pesquisa não deve enviar trechos de texto do documento à interface.');
  assert.ok(nativeSearch.result.matches.every((match) => match.xRatio >= 0 && match.yRatio >= 0 && match.xRatio + match.widthRatio <= 1.001 && match.yRatio + match.heightRatio <= 1.001));
  const repeatedSearchPdf = await PDFDocument.create();
  const repeatedSearchFont = await repeatedSearchPdf.embedFont(StandardFonts.Helvetica);
  repeatedSearchPdf.addPage([600, 400]).drawText('Central | Central', { x: 50, y: 300, size: 18, font: repeatedSearchFont });
  repeatedSearchPdf.addPage([600, 400]).drawText('Central', { x: 50, y: 300, size: 18, font: repeatedSearchFont });
  const repeatedSearchPath = path.join(workspace, 'busca-multiplas-ocorrencias.pdf');
  fs.writeFileSync(repeatedSearchPath, Buffer.from(await repeatedSearchPdf.save()));
  const repeatedSearch = await runOperation({
    type: 'ocr-search-document', files: [repeatedSearchPath], options: { query: 'central', language: 'por+eng' }, outputDir
  });
  assert.strictEqual(repeatedSearch.result.matches.length, 3, 'A busca deve contar cada ocorrência, inclusive mais de uma na mesma página.');
  assert.deepStrictEqual(repeatedSearch.result.matches.map((match) => match.pageNumber), [1, 1, 2], 'Cada ocorrência deve informar a página correta, na ordem do documento.');
  assert.ok(repeatedSearch.result.matches.every((match) => Number.isFinite(match.xRatio) && Number.isFinite(match.yRatio)), 'Cada ocorrência deve retornar uma caixa destacável.');
  const cappedSearchPdf = await PDFDocument.create();
  const cappedSearchFont = await cappedSearchPdf.embedFont(StandardFonts.Helvetica);
  const cappedSearchPage = cappedSearchPdf.addPage([600, 400]);
  for (let index = 0; index < 205; index += 1) {
    cappedSearchPage.drawText('Central', {
      x: 10 + (index % 10) * 55,
      y: 370 - Math.floor(index / 10) * 15,
      size: 8,
      font: cappedSearchFont
    });
  }
  const cappedSearchPath = path.join(workspace, 'busca-limite-ultima-pagina.pdf');
  fs.writeFileSync(cappedSearchPath, Buffer.from(await cappedSearchPdf.save()));
  const cappedSearch = await runOperation({
    type: 'ocr-search-document', files: [cappedSearchPath], options: { query: 'central', language: 'por+eng' }, outputDir
  });
  assert.strictEqual(cappedSearch.result.matches.length, 200, 'A busca deve respeitar o limite de resultados configurado.');
  assert.strictEqual(cappedSearch.result.truncated, true, 'Ao atingir o limite na última página, a interface deve informar que a lista foi limitada.');
  await assert.rejects(runOperation({
    type: 'ocr-search-document', files: [imageRun.result.firstOutputPath], options: { query: '   ', language: 'por+eng' }, outputDir
  }), /termo ou uma frase/);
  assert.strictEqual(normalizeOcrMode('auto'), 'auto');
  assert.strictEqual(normalizeOcrMode('complete'), 'complete');
  assert.deepStrictEqual(getSafeOcrRenderDimensions(100.1, 80.1), { width: 101, height: 81 });
  assert.throws(() => getSafeOcrRenderDimensions(OCR_MAX_RENDER_PIXELS, 2), /grande demais para o OCR/);
  assert.strictEqual(normalizeOcrMode('redo'), 'redo');
  assert.throws(() => normalizeOcrMode('unsupported'), /Modo de reconhecimento inválido/);
  const alreadySearchable = await runOperation({
    type: 'ocr', files: [imageRun.result.firstOutputPath], options: { language: 'por+eng', mode: 'auto', format: 'pdf' }, outputDir
  });
  assert.strictEqual(alreadySearchable.result.recognizedPages, 0);
  assert.strictEqual(alreadySearchable.result.skippedPages, 1);

  const redoImageRun = await runOperation({
    type: 'ocr', files: [imageRun.result.firstOutputPath], options: { language: 'por+eng', mode: 'redo', format: 'pdf' }, outputDir
  });
  const redoImageText = await extractStructuredText(redoImageRun.result.firstOutputPath);
  const redoImageNormalized = normalizedForMetrics(redoImageText.pages.map((page) => page.text).join(' '));
  assert.ok(redoImageNormalized.includes(expectedSample), 'Refazer OCR removeu a camada antiga, mas não criou texto pesquisável novamente.');
  assert.strictEqual((redoImageNormalized.match(/central pdf teste ocr validado/g) || []).length, 1, 'Refazer OCR duplicou a camada em vez de substituí-la.');
  const redoImageSecondRun = await runOperation({
    type: 'ocr', files: [redoImageRun.result.firstOutputPath], options: { language: 'por+eng', mode: 'redo', format: 'pdf' }, outputDir
  });
  const redoImageSecondText = await extractStructuredText(redoImageSecondRun.result.firstOutputPath);
  const redoImageSecondNormalized = normalizedForMetrics(redoImageSecondText.pages.map((page) => page.text).join(' '));
  assert.strictEqual((redoImageSecondNormalized.match(/central pdf teste ocr validado/g) || []).length, 1, 'Refazer OCR repetido acumulou camadas de texto.');

  const legacyOcrPdf = await PDFDocument.load(fs.readFileSync(imageRun.result.firstOutputPath));
  legacyOcrPdf.getPage(0).node.delete(PDFName.of('CentralPDFOCRLayerContents'));
  legacyOcrPdf.getPage(0).node.delete(PDFName.of('CentralPDFOCRLayerAbsent'));
  legacyOcrPdf.getPage(0).node.delete(PDFName.of('CentralPDFOCRNativeBoxes'));
  legacyOcrPdf.getPage(0).node.set(PDFName.of('CentralPDFOCRProcessed'), PDFBool.True);
  const legacyOcrPath = path.join(workspace, 'ocr-legado-sem-referencia.pdf');
  fs.writeFileSync(legacyOcrPath, await legacyOcrPdf.save());
  const legacyOcrHash = crypto.createHash('sha256').update(fs.readFileSync(legacyOcrPath)).digest('hex');
  await assert.rejects(runOperation({
    type: 'ocr', files: [legacyOcrPath], options: { language: 'por+eng', mode: 'redo', format: 'pdf' }, outputDir
  }), (error) => {
    assert.match(error.message, /Nenhum arquivo do lote pôde ser reconhecido/);
    assert.match(error.message, /ocr-legado-sem-referencia\.pdf: Não é possível refazer o OCR da página 1: a camada anterior não pode ser identificada com segurança/);
    return true;
  });
  assert.strictEqual(crypto.createHash('sha256').update(fs.readFileSync(legacyOcrPath)).digest('hex'), legacyOcrHash, 'A tentativa de refazer OCR em um arquivo legado alterou o original.');

  const shortTextImage = path.join(workspace, 'documento-texto-curto.png');
  await createSyntheticImage(shortTextImage, 'Aprovado');
  const shortTextOcr = await runOperation({
    type: 'ocr', files: [shortTextImage], options: { language: 'por+eng', mode: 'auto', format: 'pdf' }, outputDir
  });
  const shortTextContent = await extractStructuredText(shortTextOcr.result.firstOutputPath);
  const shortRecognized = shortTextContent.pages.map((page) => page.text).join(' ');
  assert.ok(shortRecognized.length > 0);
  assert.ok(pageNeedsOcr(shortRecognized), 'Fixture curto precisa exercitar a exceção ao limite heurístico de texto.');
  const shortTextSecondPass = await runOperation({
    type: 'ocr', files: [shortTextOcr.result.firstOutputPath], options: { language: 'por+eng', mode: 'auto', format: 'pdf' }, outputDir
  });
  assert.strictEqual(shortTextSecondPass.result.recognizedPages, 0, 'O OCR repetido duplicou texto em página curta reconhecida anteriormente.');
  assert.strictEqual(shortTextSecondPass.result.skippedPages, 1);
  const compressedShortRun = await runOperation({
    type: 'compress', files: [shortTextOcr.result.firstOutputPath], options: { outputName: 'texto-curto-comprimido.pdf' }, outputDir
  });
  const compressedShortSecondPass = await runOperation({
    type: 'ocr', files: [compressedShortRun.result.outputPath], options: { language: 'por+eng', mode: 'auto', format: 'pdf' }, outputDir
  });
  assert.strictEqual(compressedShortSecondPass.result.recognizedPages, 0, 'A compressão perdeu o marcador que impede OCR duplicado em páginas curtas.');
  const compressedShortRedo = await runOperation({
    type: 'ocr', files: [compressedShortRun.result.outputPath], options: { language: 'por+eng', mode: 'redo', format: 'pdf' }, outputDir
  });
  assert.strictEqual(compressedShortRedo.result.recognizedPages, 1, 'Refazer OCR não reconheceu a camada identificada após compressão.');
  const organizedShortRun = await runOperation({
    type: 'organize',
    files: [shortTextOcr.result.firstOutputPath],
    options: { outputName: 'texto-curto-organizado.pdf', pageActions: [{ fileIndex: 0, sourceIndex: 0, rotation: 0 }] },
    outputDir
  });
  const organizedShortSecondPass = await runOperation({
    type: 'ocr', files: [organizedShortRun.result.outputPath], options: { language: 'por+eng', mode: 'auto', format: 'pdf' }, outputDir
  });
  assert.strictEqual(organizedShortSecondPass.result.recognizedPages, 0, 'A organização perdeu a marcação por página e duplicou o OCR curto.');
  const organizedShortRedo = await runOperation({
    type: 'ocr', files: [organizedShortRun.result.outputPath], options: { language: 'por+eng', mode: 'redo', format: 'pdf' }, outputDir
  });
  assert.strictEqual(organizedShortRedo.result.recognizedPages, 1, 'Refazer OCR não reconheceu a camada identificada após organizar páginas.');
  const compressedRun = await runOperation({
    type: 'compress',
    files: [imageRun.result.firstOutputPath],
    options: { outputName: 'ocr-comprimido.pdf' },
    outputDir
  });
  assert.ok(fs.existsSync(compressedRun.result.outputPath));
  const compressedText = await extractStructuredText(compressedRun.result.outputPath);
  const compressedRecognized = normalizedForMetrics(compressedText.pages.map((page) => page.text).join('\n'));
  assert.ok(compressedRecognized.includes(expectedSample), 'A compressão removeu ou alterou o texto OCR pesquisável.');
  const cer = editDistance(expectedSample, recognizedSample) / Math.max(1, expectedSample.length);
  const expectedWords = expectedSample.split(' ');
  const recognizedWords = recognizedSample.split(' ');
  const wer = editDistance(expectedWords, recognizedWords) / Math.max(1, expectedWords.length);
  assert.ok(cer <= 0.25, `CER excedeu o limite do fixture: ${cer.toFixed(3)}`);
  assert.ok(wer <= 0.25, `WER excedeu o limite do fixture: ${wer.toFixed(3)}`);

  const qualityScenarios = [
    {
      name: 'acentuação pt-BR', width: 1400, height: 220, fontSize: 38,
      lines: ['Ação, revisão e proteção de informações.', 'São Paulo — aprovação válida em 31/10/2026.']
    },
    {
      name: 'impressão pequena', width: 1000, height: 150, fontSize: 20,
      lines: ['Rua das Flores 123 - CEP 01310-100', 'Vencimento 31/10/2026 - Valor R$ 1.234,56']
    },
    {
      name: 'sombra e baixo contraste', width: 1200, height: 220, fontSize: 34, textColor: '#454545', shadow: true,
      lines: ['Relatório financeiro aprovado.', 'Conferir dados antes de compartilhar.']
    },
    {
      name: 'documento em duas colunas',
      layout: {
        rows: [
          ['Empresa: Central PDF', 'CNPJ: 22.755.266/0001-87'],
          ['Período: 2025', 'Status: APROVADO'],
          ['Valor: R$ 1.234,56', 'Data: 31/10/2026']
        ]
      }
    },
    {
      name: 'tabela financeira',
      layout: {
        grid: true,
        width: 1500,
        height: 760,
        fontSize: 36,
        rows: [
          ['Descrição', 'Valor'],
          ['Receita líquida — 2025', 'R$ 25.400,00'],
          ['Despesas — 2025', 'R$ 8.100,00'],
          ['Resultado operacional — 2025', 'R$ 17.300,00']
        ]
      }
    }
  ];
  const qualityMetrics = [];
  for (let index = 0; index < qualityScenarios.length; index += 1) {
    const scenario = qualityScenarios[index];
    const fixturePath = path.join(workspace, `qualidade-ocr-${index + 1}.png`);
    if (scenario.layout) createOcrLayoutFixture(fixturePath, scenario.layout);
    else createOcrQualityFixture(fixturePath, scenario);
    const fixtureRun = await runOperation({
      type: 'ocr', files: [fixturePath], options: { language: 'por+eng', mode: 'auto', format: 'pdf' }, outputDir
    });
    const fixtureText = await extractStructuredText(fixtureRun.result.firstOutputPath);
    const expectedText = normalizedForMetrics((scenario.lines || scenario.layout.rows.flat()).join(' '));
    const actualText = normalizedForMetrics(fixtureText.pages.map((page) => page.text).join(' '));
    const scenarioCer = editDistance(expectedText, actualText) / Math.max(1, expectedText.length);
    const scenarioWer = editDistance(expectedText.split(' '), actualText.split(' ')) / Math.max(1, expectedText.split(' ').length);
    const actualTokens = new Set(actualText.split(' '));
    const tokenRecall = expectedText.split(' ').filter((token) => actualTokens.has(token)).length / Math.max(1, expectedText.split(' ').length);
    assert.ok(actualText.length > 0, `O cenário ${scenario.name} não produziu texto reconhecível.`);
    assert.ok(tokenRecall >= 0.75 && scenarioCer <= 0.25 && scenarioWer <= 0.25, `${scenario.name}: CER=${scenarioCer.toFixed(3)}, WER=${scenarioWer.toFixed(3)}, cobertura=${tokenRecall.toFixed(3)}; esperado="${expectedText}"; obtido="${actualText}".`);
    qualityMetrics.push({ name: scenario.name, cer: scenarioCer, wer: scenarioWer, tokenRecall });
  }

  const pdf = await PDFDocument.create();
  pdf.addPage([600, 400]);
  const sourcePdf = path.join(workspace, 'documento-vazio.pdf');
  fs.writeFileSync(sourcePdf, await pdf.save());
  const pdfRun = await runOperation({
    type: 'ocr',
    files: [sourcePdf],
    options: { language: 'por+eng', mode: 'auto', format: 'text' },
    outputDir
  });
  assert.strictEqual(pdfRun.result.outputCount, 1);
  assert.ok(fs.existsSync(pdfRun.result.firstOutputPath));
  assert.strictEqual(pdfRun.result.recognizedPages, 0);
  assert.strictEqual(pdfRun.result.pageResults[0].status, 'no-text');
  assert.ok(pdfRun.result.warnings.some((warning) => /não foi possível reconhecer texto/i.test(warning)), 'O OCR vazio foi reportado como sucesso sem aviso de qualidade.');

  const hybrid = await PDFDocument.create();
  hybrid.addPage([600, 400]).drawText('TEXTO NATIVO CENTRAL PDF', { x: 50, y: 300, size: 20 });
  const imageBytes = fs.readFileSync(input);
  const scannedPage = hybrid.addPage([600, 400]);
  const embeddedImage = await hybrid.embedPng(imageBytes);
  scannedPage.drawImage(embeddedImage, { x: 40, y: 120, width: 520, height: 130 });
  const hybridPath = path.join(workspace, 'documento-hibrido.pdf');
  fs.writeFileSync(hybridPath, await hybrid.save());
  const completeHybridRun = await runOperation({
    type: 'ocr', files: [hybridPath], options: { language: 'por+eng', mode: 'complete', format: 'pdf' }, outputDir
  });
  assert.strictEqual(completeHybridRun.result.recognizedPages, 2, 'O modo completo deve processar inclusive a página com texto nativo.');
  const completeHybridText = await extractStructuredText(completeHybridRun.result.firstOutputPath);
  const completeFirstPageText = normalizedForMetrics(completeHybridText.pages[0].text);
  assert.strictEqual((completeFirstPageText.match(/texto nativo central pdf/g) || []).length, 1, 'O modo completo duplicou palavras que já estavam na camada nativa.');
  assert.ok(normalizedForMetrics(completeHybridText.pages[1].text).includes(expectedSample), 'O modo completo não preservou o OCR da página digitalizada.');
  const completeHybridRedo = await runOperation({
    type: 'ocr', files: [completeHybridRun.result.firstOutputPath], options: { language: 'por+eng', mode: 'redo', format: 'pdf' }, outputDir
  });
  const completeHybridRedoText = await extractStructuredText(completeHybridRedo.result.firstOutputPath);
  assert.strictEqual((normalizedForMetrics(completeHybridRedoText.pages[0].text).match(/texto nativo central pdf/g) || []).length, 1,
    'Refazer OCR alterou/duplicou conteúdo de página já pesquisável sem uma camada OCR própria.');
  assert.strictEqual((normalizedForMetrics(completeHybridRedoText.pages[1].text).match(/central pdf teste ocr validado/g) || []).length, 1,
    'Refazer OCR de documento híbrido duplicou a camada OCR da página digitalizada.');
  assert.deepStrictEqual([...parsePageRange('2', 2)], [2]);
  assert.throws(() => parsePageRange('1-3', 2), /entre as páginas/);
  const selectiveRun = await runOperation({
    type: 'ocr', files: [hybridPath], options: { language: 'por+eng', mode: 'auto', format: 'text', pageRange: '2' }, outputDir
  });
  assert.strictEqual(selectiveRun.result.unselectedPages, 1, 'O resumo deve identificar páginas fora do intervalo solicitado.');
  assert.strictEqual(selectiveRun.result.pageResults[0].status, 'out-of-range');
  assert.strictEqual(selectiveRun.result.pageResults[0].textLength, 0, 'A contagem da página fora do intervalo deve refletir que nenhum texto foi exportado.');
  assert.equal(Object.hasOwn(selectiveRun.result.pageResults[0], 'text'), false, 'O resultado sanitizado da fila não deve expor texto documental por página.');
  assert.strictEqual(selectiveRun.result.pageResults[1].status, 'recognized');
  const selectiveText = fs.readFileSync(selectiveRun.result.firstOutputPath, 'utf8');
  assert.doesNotMatch(selectiveText, /TEXTO NATIVO CENTRAL PDF/i, 'A exportação TXT incluiu o conteúdo da página não selecionada.');
  assert.match(selectiveText, /Central PDF teste OCR validado/i, 'A exportação TXT perdeu o conteúdo da página selecionada por OCR.');
  const hybridConversion = await convertPdfToWord(hybridPath, outputDir, {
    format: 'text', outputName: 'hibrido.txt', useOcr: true, ocrLanguage: 'por+eng'
  });
  const hybridText = fs.readFileSync(hybridConversion.outputPath, 'utf8');
  assert.strictEqual(hybridConversion.usedOcr, true);
  assert.strictEqual((hybridText.match(/TEXTO NATIVO CENTRAL PDF/g) || []).length, 1);
  assert.match(hybridText, /Central PDF teste OCR validado/i);

  const mixedHybrid = await PDFDocument.create();
  const mixedHybridPage = mixedHybrid.addPage([600, 400]);
  const nativeHeader = 'NATIVE HYBRID REPORT HEADER 2026';
  mixedHybridPage.drawText(nativeHeader, { x: 48, y: 350, size: 15 });
  const mixedImage = await mixedHybrid.embedPng(imageBytes);
  mixedHybridPage.drawImage(mixedImage, { x: 40, y: 100, width: 520, height: 130 });
  const mixedHybridPath = path.join(workspace, 'documento-hibrido-na-mesma-pagina.pdf');
  fs.writeFileSync(mixedHybridPath, await mixedHybrid.save());
  assert.ok(!pageNeedsOcr(nativeHeader), 'Texto nativo suficiente não deve disparar OCR quando não há imagem relevante.');
  assert.ok(!pageNeedsOcr(nativeHeader, 0.08), 'Uma imagem pequena, como logotipo, não deve disparar OCR em uma página textual.');
  assert.ok(pageNeedsOcr(nativeHeader, 0.28), 'Texto de cabeçalho não deve fazer uma página híbrida parecer totalmente pesquisável.');
  const mixedHybridOcr = await runOperation({
    type: 'ocr', files: [mixedHybridPath], options: { language: 'por+eng', mode: 'auto', format: 'pdf' }, outputDir
  });
  assert.strictEqual(mixedHybridOcr.result.recognizedPages, 1, 'O modo automático não reconheceu a parte escaneada da página híbrida.');
  const mixedHybridText = await extractStructuredText(mixedHybridOcr.result.firstOutputPath);
  const mixedHybridExtracted = mixedHybridText.pages.map((page) => page.text).join('\n');
  assert.match(mixedHybridExtracted, /Central PDF teste OCR validado/i);
  assert.strictEqual((mixedHybridExtracted.match(/NATIVE HYBRID REPORT HEADER 2026/g) || []).length, 1, 'A camada OCR duplicou o cabeçalho nativo da página híbrida.');
  const mixedHybridRedo = await runOperation({
    type: 'ocr', files: [mixedHybridOcr.result.firstOutputPath], options: { language: 'por+eng', mode: 'redo', format: 'pdf' }, outputDir
  });
  const mixedHybridRedoText = await extractStructuredText(mixedHybridRedo.result.firstOutputPath);
  const mixedHybridRedoExtracted = mixedHybridRedoText.pages.map((page) => page.text).join('\n');
  assert.strictEqual((mixedHybridRedoExtracted.match(/NATIVE HYBRID REPORT HEADER 2026/g) || []).length, 1, 'Refazer OCR duplicou texto nativo da página híbrida.');
  assert.strictEqual((normalizedForMetrics(mixedHybridRedoExtracted).match(/central pdf teste ocr validado/g) || []).length, 1, 'Refazer OCR acumulou texto reconhecido na parte escaneada.');
  const mixedHybridSearch = await runOperation({
    type: 'ocr-search-document', files: [mixedHybridPath],
    options: { query: 'Central PDF teste OCR validado', language: 'por+eng' }, outputDir
  });
  assert.ok(mixedHybridSearch.result.matches.some((match) => match.source === 'OCR'), 'A pesquisa não examinou por OCR o conteúdo escaneado da página híbrida.');

  const imagePdfRun = await runOperation({
    type: 'files-to-pdf',
    files: [input],
    options: { searchableOcr: true, language: 'por+eng', optimizeImages: false, outputName: 'imagem-pesquisavel.pdf' },
    outputDir
  });
  assert.ok(fs.existsSync(imagePdfRun.result.outputPath));
  const imagePdfText = await extractStructuredText(imagePdfRun.result.outputPath);
  assert.match(imagePdfText.pages.map((page) => page.text).join('\n'), /Central PDF teste OCR validado/i);

  const sensitiveImage = path.join(workspace, 'cpf-digitalizado.png');
  await createSyntheticImage(sensitiveImage, 'CPF: 123.456.789-09');
  const sensitiveScanPdf = await PDFDocument.create();
  const sensitivePage = sensitiveScanPdf.addPage([600, 150]);
  const sensitiveEmbeddedImage = await sensitiveScanPdf.embedPng(fs.readFileSync(sensitiveImage));
  sensitivePage.drawImage(sensitiveEmbeddedImage, { x: 0, y: 0, width: 600, height: 150 });
  sensitivePage.drawText('CPF: 123.456.789-09', { x: 12, y: 8, size: 8, color: rgb(1, 1, 1) });
  const preservedPage = sensitiveScanPdf.addPage([600, 150]);
  for (let line = 0; line < 5; line += 1) {
    preservedPage.drawText('CONTEUDO NATIVO DA PAGINA PRESERVADO SEM ALTERACOES', {
      x: 30, y: 120 - line * 22, size: 9
    });
  }
  sensitiveScanPdf.setTitle('Documento reservado CPF 123.456.789-09');
  sensitiveScanPdf.setAuthor('Titular 123.456.789-09');
  sensitiveScanPdf.setSubject('Assunto reservado 123.456.789-09');
  sensitiveScanPdf.setKeywords(['CPF 123.456.789-09', 'confidencial']);
  sensitiveScanPdf.setCreator('Central PDF - 123.456.789-09');
  sensitiveScanPdf.setProducer('Produtor - 123.456.789-09');
  const sensitiveOutlineRef = sensitiveScanPdf.context.nextRef();
  const sensitiveOutlineItemRef = sensitiveScanPdf.context.nextRef();
  const sensitiveOutlineItem = sensitiveScanPdf.context.obj({
    Title: PDFString.of('CPF 123.456.789-09'),
    Parent: sensitiveOutlineRef,
    Dest: sensitiveScanPdf.context.obj([sensitivePage.ref, PDFName.of('XYZ'), null, null, null])
  });
  sensitiveScanPdf.context.assign(sensitiveOutlineItemRef, sensitiveOutlineItem);
  sensitiveScanPdf.context.assign(sensitiveOutlineRef, sensitiveScanPdf.context.obj({
    Type: PDFName.of('Outlines'), First: sensitiveOutlineItemRef, Last: sensitiveOutlineItemRef, Count: 1
  }));
  sensitiveScanPdf.catalog.set(PDFName.of('Outlines'), sensitiveOutlineRef);
  await sensitiveScanPdf.attach(Buffer.from('Anexo reservado: 123.456.789-09'), 'registro-reservado.txt', {
    mimeType: 'text/plain', description: 'Anexo com dado sensível'
  });
  const sensitiveFormField = sensitiveScanPdf.getForm().createTextField('dados.cpf');
  sensitiveFormField.setText('123.456.789-09');
  sensitiveFormField.addToPage(sensitivePage, { x: 20, y: 20, width: 180, height: 24 });
  const sensitiveScanPath = path.join(workspace, 'documento-com-cpf-escaneado.pdf');
  fs.writeFileSync(sensitiveScanPath, await sensitiveScanPdf.save());
  const sensitiveSourceHash = crypto.createHash('sha256').update(fs.readFileSync(sensitiveScanPath)).digest('hex');
  const sensitiveSourceText = await extractStructuredText(sensitiveScanPath);
  assert.match(sensitiveSourceText.pages.map((page) => page.text).join('\n'), /123\.456\.789-09/, 'A fixture deve conter a camada nativa invisível antes da ocultação.');
  const scannedSearch = await runOperation({
    type: 'ocr-search-document', files: [sensitiveScanPath],
    options: { query: '123.456.789-09', language: 'por+eng' }, outputDir
  });
  assert.ok(scannedSearch.result.matches.length > 0, 'Pesquisa não encontrou texto do PDF escaneado via OCR.');
  assert.ok(scannedSearch.result.matches.some((match) => match.source === 'OCR'), 'A pesquisa híbrida deve incluir a ocorrência reconhecida na imagem, mesmo quando também há uma camada nativa invisível.');
  assert.ok(scannedSearch.result.matches.every((match) => match.pageNumber === 1 && match.xRatio >= 0 && match.yRatio >= 0 && match.widthRatio > 0 && match.heightRatio > 0));
  const redactOcrSearch = await runOperation({
    type: 'redact-ocr-search',
    files: [sensitiveScanPath],
    options: { query: 'CPF', language: 'por+eng' },
    outputDir
  });
  assert.strictEqual(redactOcrSearch.result.scannedPages, 1);
  assert.ok(redactOcrSearch.result.candidates.length >= 1, 'OCR não encontrou candidato de CPF no documento escaneado.');
  assert.ok(redactOcrSearch.result.candidates.every((candidate) => candidate.confidence >= 75));
  assert.ok(redactOcrSearch.result.candidates.every((candidate) => candidate.xRatio >= 0 && candidate.yRatio >= 0 && candidate.widthRatio > 0 && candidate.heightRatio > 0));
  assert.ok(!Object.hasOwn(redactOcrSearch.result, 'text') && redactOcrSearch.result.candidates.every((candidate) => !Object.hasOwn(candidate, 'text')));
  let lowConfidenceWorkerTerminated = false;
  const lowConfidenceRedaction = await findOcrRedactionCandidates(
    sensitiveScanPath,
    '123.456.789-09',
    { language: 'por+eng', autoRotate: false },
    () => {},
    () => false,
    async () => ({
      recognize: async () => ({
        data: {
          text: 'CPF 123.456.789-09', confidence: 95,
          words: [
            { text: 'CPF', confidence: 95, bbox: { x0: 50, y0: 40, x1: 120, y1: 75 } },
            { text: '123.456.789-09', confidence: 60, bbox: { x0: 125, y0: 40, x1: 380, y1: 75 } }
          ]
        }
      }),
      terminate: async () => { lowConfidenceWorkerTerminated = true; }
    })
  );
  assert.strictEqual(lowConfidenceRedaction.totalMatches, 1, 'O teste deve simular uma correspondência sensível reconhecida pelo motor.');
  assert.strictEqual(lowConfidenceRedaction.lowConfidenceMatches, 1, 'O resultado de baixa confiança deve ser contabilizado para explicar a omissão.');
  assert.strictEqual(lowConfidenceRedaction.candidates.length, 0, 'Uma correspondência abaixo do limite não pode virar sugestão de tarja.');
  assert.strictEqual(lowConfidenceRedaction.minimumConfidence, 75);
  assert.strictEqual(lowConfidenceWorkerTerminated, true, 'O worker de análise de ocultação deve ser encerrado mesmo ao omitir o candidato.');

  const sensitiveValueSearch = await runOperation({
    type: 'redact-ocr-search', files: [sensitiveScanPath],
    options: { query: '123.456.789-09', language: 'por+eng' }, outputDir
  });
  assert.ok(sensitiveValueSearch.result.candidates.length > 0, 'OCR não localizou o valor sensível sintético para ocultação.');
  const sensitiveMatch = sensitiveValueSearch.result.candidates[0];
  const redactedStamp = createCanvas(1200, 300);
  const redactedStampContext = redactedStamp.getContext('2d');
  const sensitiveRaster = await loadImage(sensitiveImage);
  redactedStampContext.drawImage(sensitiveRaster, 0, 0, redactedStamp.width, redactedStamp.height);
  const paddingX = redactedStamp.width * 0.015;
  const paddingY = redactedStamp.height * 0.06;
  redactedStampContext.fillStyle = '#000000';
  redactedStampContext.fillRect(
    Math.max(0, sensitiveMatch.xRatio * redactedStamp.width - paddingX),
    Math.max(0, sensitiveMatch.yRatio * redactedStamp.height - paddingY),
    Math.min(redactedStamp.width, sensitiveMatch.widthRatio * redactedStamp.width + paddingX * 2),
    Math.min(redactedStamp.height, sensitiveMatch.heightRatio * redactedStamp.height + paddingY * 2)
  );
  const redactedStampPath = path.join(workspace, 'pagina-com-tarja.png');
  fs.writeFileSync(redactedStampPath, redactedStamp.toBuffer('image/png'));
  await assert.rejects(
    pdfService.redactPdf(sensitiveScanPath, path.join(outputDir, 'pagina-inexistente.pdf'), {
      outputName: 'pagina-inexistente.pdf',
      redactedPages: [{ pageIndex: 2, imagePath: redactedStampPath }]
    }),
    /páginas selecionadas para ocultação não existe/
  );
  await assert.rejects(
    pdfService.redactPdf(sensitiveScanPath, path.join(outputDir, 'pagina-duplicada.pdf'), {
      outputName: 'pagina-duplicada.pdf',
      redactedPages: [
        { pageIndex: 0, imagePath: redactedStampPath },
        { pageIndex: 0, imagePath: redactedStampPath }
      ]
    }),
    /mesma página foi preparada mais de uma vez/
  );
  const qpdfPath = path.join(__dirname, '..', '..', 'vendor', 'qpdf', 'bin', 'qpdf.exe');
  assert.ok(fs.existsSync(qpdfPath), 'O qpdf distribuído pelo projeto é necessário para auditar anexos na regressão de ocultação.');
  const sourceAttachmentsBeforeRedaction = execCommand(qpdfPath, ['--list-attachments', sensitiveScanPath]);
  assert.match(sourceAttachmentsBeforeRedaction, /registro-reservado\.txt/i,
    `O fixture precisa conter o anexo antes da ocultação. Saída qpdf: ${JSON.stringify(sourceAttachmentsBeforeRedaction)}`);
  const redactedOutput = await runOperation({
    type: 'redact', files: [sensitiveScanPath],
    options: { outputName: 'cpf-oculto.pdf', redactedPages: [{ pageIndex: 0, imagePath: redactedStampPath }] }, outputDir
  });
  assert.ok(fs.existsSync(redactedOutput.result.outputPath), 'A ocultação não produziu PDF final.');
  const redactedText = await extractStructuredText(redactedOutput.result.outputPath);
  assert.strictEqual(redactedText.pageCount, 2, 'A ocultação removeu páginas não relacionadas ao dado sensível.');
  assert.doesNotMatch(redactedText.pages.map((page) => page.text).join('\n'), /123\s*456\s*789\s*09/, 'O texto sensível continuou extraível após a ocultação.');
  assert.match(redactedText.pages[1].text, /CONTEUDO NATIVO DA PAGINA PRESERVADO/, 'A página sem tarjas não preservou sua camada textual nativa.');
  assert.strictEqual(crypto.createHash('sha256').update(fs.readFileSync(sensitiveScanPath)).digest('hex'), sensitiveSourceHash, 'A ocultação alterou os bytes do arquivo original.');
  const redactedDocument = await PDFDocument.load(fs.readFileSync(redactedOutput.result.outputPath));
  assert.strictEqual(redactedDocument.catalog.get(PDFName.of('Outlines')), undefined,
    'A estrutura de marcadores original não pode reter texto sensível após a ocultação.');
  const redactedMetadata = [
    redactedDocument.getTitle(), redactedDocument.getAuthor(), redactedDocument.getSubject(),
    redactedDocument.getKeywords(), redactedDocument.getCreator(), redactedDocument.getProducer()
  ].filter(Boolean).join(' ');
  assert.doesNotMatch(redactedMetadata, /123\s*456\s*789\s*09/, 'Metadados sensíveis do documento original foram preservados após a ocultação.');
  assert.strictEqual(redactedDocument.getForm().getFields().length, 0, 'O formulário original, potencialmente com dados sensíveis, continuou no PDF de saída.');
  const redactedPdfBytes = fs.readFileSync(redactedOutput.result.outputPath);
  assert.ok(!redactedPdfBytes.includes(Buffer.from('registro-reservado.txt')), 'O PDF de saída ainda contém o nome de um anexo original.');
  assert.ok(!redactedPdfBytes.includes(Buffer.from('Anexo reservado: 123.456.789-09')), 'O conteúdo do anexo original continuou recuperável no PDF de saída.');
  const independentPdfCheck = execCommand(qpdfPath, ['--check', redactedOutput.result.outputPath]);
  assert.match(independentPdfCheck, /No syntax or stream encoding errors found/i,
    'O qpdf independente encontrou problema estrutural no PDF após a ocultação.');
  const expandedRedactedPdfPath = path.join(workspace, 'cpf-oculto-expandido.qdf.pdf');
  execCommand(qpdfPath, [
    '--qdf', '--object-streams=disable', '--stream-data=uncompress',
    redactedOutput.result.outputPath, expandedRedactedPdfPath
  ]);
  const expandedRedactedPdf = fs.readFileSync(expandedRedactedPdfPath).toString('latin1');
  assert.doesNotMatch(expandedRedactedPdf, /123[.\s]?456[.\s]?789[.\s]?09/,
    'O valor sensível reapareceu nos objetos ou streams expandidos do PDF ocultado.');
  assert.doesNotMatch(expandedRedactedPdf, /registro-reservado\.txt|Anexo reservado: 123\.456\.789-09/i,
    'O nome ou conteúdo do anexo sensível reapareceu após expandir os objetos e streams do PDF.');
  const sourceAttachments = execCommand(qpdfPath, ['--list-attachments', sensitiveScanPath]);
  const redactedAttachments = execCommand(qpdfPath, ['--list-attachments', redactedOutput.result.outputPath]);
  assert.match(sourceAttachments, /registro-reservado\.txt/i,
    `O anexo presente antes da ocultação desapareceu da origem. Saída qpdf: ${JSON.stringify(sourceAttachments)}`);
  assert.match(redactedAttachments, /no embedded files/i,
    `O PDF ocultado ainda possui arquivos incorporados segundo o qpdf. Saída recebida: ${JSON.stringify(redactedAttachments)}`);
  const redactedOcr = await runOperation({
    type: 'ocr-extract-area', files: [redactedOutput.result.outputPath],
    options: { pageNumber: 1, selection: { x: 0, y: 0, width: 1, height: 1 }, language: 'por+eng' }, outputDir
  });
  assert.doesNotMatch(redactedOcr.result.text, /123\s*456\s*789\s*09/, 'O valor sensível ainda pode ser recuperado visualmente por OCR após a ocultação.');

  const areaExtraction = await runOperation({
    type: 'ocr-extract-area',
    files: [sensitiveScanPath],
    options: { pageNumber: 1, selection: { x: 0.02, y: 0.3, width: 0.85, height: 0.55 }, language: 'por+eng' },
    outputDir
  });
  assert.strictEqual(areaExtraction.result.recognized, true);
  assert.match(areaExtraction.result.text, /123[.\s]456[.\s]789/);
  assert.strictEqual(areaExtraction.result.pageNumber, 1);
  assert.strictEqual(areaExtraction.result.truncated, false);
  await assert.rejects(runOperation({
    type: 'ocr-extract-area',
    files: [sensitiveScanPath],
    options: { pageNumber: 1, selection: { x: 0.9, y: 0.9, width: 0.5, height: 0.5 }, language: 'por+eng' },
    outputDir
  }), /área válida/);

  const mergeSearchableRun = await runOperation({
    type: 'merge',
    files: [input, input],
    options: { searchableOcr: true, language: 'por+eng', outputName: 'mesclado-pesquisavel.pdf' },
    outputDir
  });
  const mergeSearchableText = await extractStructuredText(mergeSearchableRun.result.outputPath);
  assert.strictEqual(mergeSearchableText.pages.length, 2);
  assert.match(mergeSearchableText.pages.map((page) => page.text).join('\n'), /Central PDF teste OCR validado/i);
  const searchableChainCompressed = await runOperation({
    type: 'compress',
    files: [mergeSearchableRun.result.outputPath],
    options: { outputName: 'ocr-mesclado-comprimido.pdf' },
    outputDir
  });
  const searchableChainSplit = await runOperation({
    type: 'split-pages',
    files: [searchableChainCompressed.result.outputPath],
    options: { prefix: 'ocr-mesclado-parte' },
    outputDir
  });
  assert.strictEqual(searchableChainSplit.result.outputCount, 2, 'A cadeia OCR → mesclagem → compressão → separação deve manter ambas as páginas.');
  for (const [index, splitPath] of searchableChainSplit.result.createdFiles.entries()) {
    const splitText = await extractStructuredText(splitPath);
    assert.strictEqual(splitText.pageCount, 1, `A parte ${index + 1} deve conter exatamente uma página.`);
    assert.match(splitText.pages[0].text, /Central PDF teste OCR validado/i, `A camada OCR não sobreviveu à cadeia na parte ${index + 1}.`);
  }

  const nativeSearchablePdf = await PDFDocument.create();
  const nativeSearchableFont = await nativeSearchablePdf.embedFont(StandardFonts.Helvetica);
  nativeSearchablePdf.addPage([600, 400]).drawText('MESCLAGEM NATIVA PESQUISAVEL', {
    x: 48, y: 300, size: 18, font: nativeSearchableFont
  });
  const nativeSearchablePath = path.join(workspace, 'documento-nativo-pesquisavel.pdf');
  fs.writeFileSync(nativeSearchablePath, await nativeSearchablePdf.save());
  const protectedOcrPath = path.join(workspace, 'documento-protegido-ocr.pdf');
  await pdfService.encryptPdf(nativeSearchablePath, protectedOcrPath, 'senha-ocr-teste-2026');
  const protectedOcrHash = crypto.createHash('sha256').update(fs.readFileSync(protectedOcrPath)).digest('hex');
  await assert.rejects(runOperation({
    type: 'ocr', files: [protectedOcrPath],
    options: { language: 'por+eng', mode: 'auto', format: 'pdf', outputName: 'nao-deve-ser-gerado.pdf' }, outputDir
  }), /protegido por senha.*Desbloquear PDF/i);
  assert.strictEqual(crypto.createHash('sha256').update(fs.readFileSync(protectedOcrPath)).digest('hex'), protectedOcrHash,
    'Tentativa de OCR em PDF com senha não deve modificar a origem.');
  assert.ok(!fs.existsSync(path.join(outputDir, 'nao-deve-ser-gerado.pdf')), 'OCR em PDF protegido não deve publicar saída parcial.');
  const nativeMergeSearchableRun = await runOperation({
    type: 'merge',
    files: [nativeSearchablePath, nativeSearchablePath],
    options: { searchableOcr: true, language: 'por+eng', outputName: 'mesclado-nativo-pesquisavel.pdf' },
    outputDir
  });
  assert.ok(fs.existsSync(nativeMergeSearchableRun.result.outputPath), 'Mesclagem pesquisável de PDFs nativos deve concluir sem serialização OCR desnecessária.');
  assert.strictEqual(nativeMergeSearchableRun.result.ocr.copyOriginal, true, 'A operação deve informar que o OCR reconheceu a camada nativa e manteve o PDF mesclado original.');
  assert.strictEqual(nativeMergeSearchableRun.result.ocr.recognizedPages, 0);
  assert.strictEqual(nativeMergeSearchableRun.result.ocr.skippedPages, 2);
  const nativeMergeSearchableText = await extractStructuredText(nativeMergeSearchableRun.result.outputPath);
  assert.strictEqual(nativeMergeSearchableText.pages.length, 2);
  assert.strictEqual((nativeMergeSearchableText.pages.map((page) => page.text).join('\n').match(/MESCLAGEM NATIVA PESQUISAVEL/g) || []).length, 2,
    'As duas páginas mescladas devem manter o texto nativo sem duplicação ou perda.');
  assert.deepStrictEqual(
    fs.readdirSync(outputDir).filter((name) => name.startsWith('mesclado-nativo-pesquisavel') && name.endsWith('.ocr.tmp')),
    [],
    'A mesclagem nativa não deve criar temporário OCR abandonado.'
  );

  const cancelOutputDir = path.join(workspace, 'cancelled-output');
  fs.mkdirSync(cancelOutputDir, { recursive: true });
  const cancellationPdf = await PDFDocument.create();
  const cancellationImage = await cancellationPdf.embedPng(fs.readFileSync(input));
  for (let pageIndex = 0; pageIndex < 4; pageIndex += 1) {
    cancellationPdf.addPage([600, 400]).drawImage(cancellationImage, { x: 25, y: 125, width: 550, height: 138 });
  }
  const cancellationInput = path.join(workspace, 'documento-cancelado.pdf');
  fs.writeFileSync(cancellationInput, await cancellationPdf.save());
  const originalHash = crypto.createHash('sha256').update(fs.readFileSync(cancellationInput)).digest('hex');
  let cancellationRequested = false;
  const cancellationExecution = createPdfWorkerExecution({
    type: 'ocr', files: [cancellationInput], options: { language: 'por+eng', mode: 'auto', format: 'pdf' }, outputDir: cancelOutputDir
  }, (item) => {
    if (!cancellationRequested && item.status === 'recognized') {
      cancellationRequested = true;
      cancellationExecution.cancel('test-cancel');
    }
  });
  await assert.rejects(cancellationExecution.promise, /OPERATION_CANCELLED|test-cancel/i);
  assert.ok(cancellationRequested, 'O teste não chegou a solicitar cancelamento durante o OCR.');
  assert.deepStrictEqual(fs.readdirSync(cancelOutputDir), [], 'O cancelamento deixou uma saída OCR parcial no destino.');
  assert.strictEqual(crypto.createHash('sha256').update(fs.readFileSync(cancellationInput)).digest('hex'), originalHash, 'O cancelamento alterou o arquivo original.');

  const nativePagesPdf = await PDFDocument.create();
  for (let pageIndex = 0; pageIndex < 1000; pageIndex += 1) {
    nativePagesPdf.addPage([600, 800]).drawText(`Documento corporativo pagina ${pageIndex + 1} com texto nativo`, { x: 40, y: 720, size: 16 });
  }
  const nativePagesPath = path.join(workspace, 'documento-nativo-1000-paginas.pdf');
  fs.writeFileSync(nativePagesPath, await nativePagesPdf.save());
  const nativePagesStartedAt = Date.now();
  let nativePagesPeakRssMb = 0;
  const nativePageMilestones = new Set();
  const requiredPageMilestones = [1, 10, 50, 100, 500, 1000];
  const nativePagesExecution = createPdfWorkerExecution({
    type: 'ocr', files: [nativePagesPath], options: { language: 'por+eng', mode: 'auto', format: 'pdf' }, outputDir
  }, (item) => {
    nativePagesPeakRssMb = Math.max(nativePagesPeakRssMb, Number(item.memoryMb) || 0);
    if (requiredPageMilestones.includes(Number(item.page))) nativePageMilestones.add(Number(item.page));
  });
  const nativePagesResult = await nativePagesExecution.promise;
  const nativePagesElapsedMs = Date.now() - nativePagesStartedAt;
  assert.strictEqual(nativePagesResult.pageResults.length, 1000);
  assert.strictEqual(nativePagesResult.recognizedPages, 0, 'O modo automático executou OCR em páginas com texto nativo suficiente.');
  assert.strictEqual(nativePagesResult.skippedPages, 1000);
  assert.deepStrictEqual([...nativePageMilestones].sort((a, b) => a - b), requiredPageMilestones, 'O processamento incremental não registrou todos os marcos de tamanho de lote.');
  assert.ok(fs.existsSync(nativePagesResult.firstOutputPath));
  assert.strictEqual(
    crypto.createHash('sha256').update(fs.readFileSync(nativePagesResult.firstOutputPath)).digest('hex'),
    crypto.createHash('sha256').update(fs.readFileSync(nativePagesPath)).digest('hex'),
    'O modo automático reserializou um PDF nativo que não precisava de alterações.'
  );

  const invalidImage = path.join(workspace, 'imagem-invalida.png');
  fs.writeFileSync(invalidImage, Buffer.from('não é uma imagem'));
  const partialBatch = await runOperation({
    type: 'ocr', files: [input, invalidImage], options: { language: 'por+eng', mode: 'auto', format: 'pdf' }, outputDir
  });
  assert.strictEqual(partialBatch.result.outputCount, 1);
  assert.strictEqual(partialBatch.result.failures.length, 1);
  assert.strictEqual(partialBatch.result.failures[0].fileName, 'imagem-invalida.png');

  const batchSourcePdf = await PDFDocument.create();
  const batchSourcePage = batchSourcePdf.addPage([300, 300]);
  const batchFont = await batchSourcePdf.embedFont(StandardFonts.Helvetica);
  batchSourcePage.drawText('Native text document for OCR batch regression.', { x: 25, y: 250, size: 12, font: batchFont });
  const batchSourcePath = path.join(workspace, 'lote-origem.pdf');
  fs.writeFileSync(batchSourcePath, await batchSourcePdf.save());
  const protectedBatchPath = path.join(workspace, 'lote protegido por senha.pdf');
  await pdfService.encryptPdf(batchSourcePath, protectedBatchPath, 'senha-ocr-lote-2026');
  const protectedBatchHash = crypto.createHash('sha256').update(fs.readFileSync(protectedBatchPath)).digest('hex');
  const batchInputPaths = [];
  // Put a protected file first to prove the production batch worker reports it
  // and continues processing later valid PDFs instead of failing at final run.
  batchInputPaths.push(protectedBatchPath);
  for (let index = 0; index < 40; index += 1) {
    const batchPath = path.join(workspace, `lote OCR ${String(index + 1).padStart(2, '0')} ação.pdf`);
    fs.copyFileSync(batchSourcePath, batchPath);
    batchInputPaths.push(batchPath);
  }
  for (let index = 0; index < 9; index += 1) {
    const invalidBatchPath = path.join(workspace, `lote inválido ${String(index + 1).padStart(2, '0')}.pdf`);
    fs.writeFileSync(invalidBatchPath, Buffer.from('não é um documento PDF'));
    batchInputPaths.push(invalidBatchPath);
  }
  const batchSourceHash = crypto.createHash('sha256').update(fs.readFileSync(batchSourcePath)).digest('hex');
  const batchStartedAt = Date.now();
  let batchPeakRssMb = 0;
  const batchExecution = createPdfWorkerExecution({
    type: 'ocr', files: batchInputPaths, options: { language: 'por+eng', mode: 'auto', format: 'pdf', zipResults: false }, outputDir
  }, (item) => {
    batchPeakRssMb = Math.max(batchPeakRssMb, Number(item.memoryMb) || 0);
  });
  const ocrBatchResult = await batchExecution.promise;
  const batchElapsedMs = Date.now() - batchStartedAt;
  assert.strictEqual(ocrBatchResult.outputCount, 40, 'O lote OCR deve preservar todos os arquivos válidos mesmo com entradas inválidas.');
  assert.strictEqual(ocrBatchResult.failures.length, 10, 'Cada entrada inválida ou protegida deve ser identificada sem abortar o lote.');
  const protectedBatchFailure = ocrBatchResult.failures.find((failure) => failure.fileName === path.basename(protectedBatchPath));
  assert.match(protectedBatchFailure?.message || '', /protegido por senha.*Desbloquear PDF/i,
    'O lote deve explicar como resolver o PDF protegido, sem mensagem técnica genérica.');
  assert.strictEqual(ocrBatchResult.failures.filter((failure) => failure.fileName.startsWith('lote inválido ')).length, 9);
  assert.strictEqual(ocrBatchResult.warnings.length, 9, 'A interface deve limitar a lista e resumir os avisos excedentes.');
  assert.match(ocrBatchResult.warnings.at(-1), /mais 2 aviso\(s\)/);
  assert.strictEqual(ocrBatchResult.createdFiles.length, 40);
  assert.ok(ocrBatchResult.createdFiles.every((outputPath) => fs.existsSync(outputPath)));
  assert.strictEqual(crypto.createHash('sha256').update(fs.readFileSync(batchSourcePath)).digest('hex'), batchSourceHash);
  assert.strictEqual(crypto.createHash('sha256').update(fs.readFileSync(protectedBatchPath)).digest('hex'), protectedBatchHash,
    'O processamento em lote não deve alterar o PDF protegido.');

  const reportPath = writeReport('ocr-report.md', [
    '# OCR Test Report', '',
    `Gerado em ${new Date().toISOString()}.`, '',
    '| Teste | Status | Detalhes |', '| --- | --- | --- |',
    '| OCR de imagem | ok | texto sintético reconhecido e PDF pesquisável gerado |',
    `| Correção adaptativa de orientação | ok | correções 90°/180°/270°: ${orientationMetrics.map((item) => `${item.inputAngle}→${item.correction}° (${item.confidence}%)`).join('; ')}; caixas pesquisáveis alinhadas ao original e opção de desativar respeitada |`,
    `| Estimativa de pequena inclinação | ok | origem/correção: ${skewMetrics.map((item) => `${item.sourceAngle}°/${item.estimatedCorrection}°`).join('; ')} (tolerância 0,75° no fixture sintético) |`,
    '| Pré-processamento para baixa qualidade | ok | realce de contraste e binarização local geram alternativas sem alterar dimensões; binarização respeita limite de 4 MP e só é mantida se a pontuação OCR melhorar |',
    '| Remoção conservadora de ruído isolado | ok | pixels claros/escuros isolados removidos em fixture; dimensões preservadas, limite de 1 MP e cancelamento entre blocos verificados; alternativa só é adotada se a pontuação OCR melhorar |',
    '| Privacidade do resultado da fila | ok | conclusão pública inclui métricas por página, sem texto extraído |',
    '| Privacidade da telemetria OCR | ok | esquema versionado com motor/versão e métricas agregadas; sentinelas confirmam ausência de texto reconhecido, consulta, nome e caminho |',
    '| Avisos de confiança OCR baixa | ok | páginas reconhecidas abaixo do limiar estimado são agrupadas por arquivo; páginas exatamente no limiar e páginas sem texto não são classificadas como baixa confiança |',
    '| Diagnóstico dos modelos no upload OCR | ok | recursos completos, idioma parcial e ausência dos modelos são identificados antes de iniciar; mensagem informa idiomas ausentes |',
    '| Integridade dos modelos OCR | ok | SHA-256 e tamanho exato validados; modelo truncado/alterado é identificado e bloqueado antes do uso |',
    '| Falha de gravação por falta de espaço (ENOSPC) | ok | temporário e reserva vazia removidos; arquivo original preservado |',
    '| Falha ao finalizar saída (EACCES) | ok | temporário e reserva vazia removidos; arquivo original preservado |',
    '| Arquivo bloqueado ou operação negada (EBUSY/EPERM) | ok | falha simulada ao finalizar não deixa temporários e preserva os bytes da origem |',
    '| OCR automático em PDF já pesquisável | ok | página existente ignorada, sem adicionar uma segunda camada OCR |',
    '| PDF híbrido com texto e imagem na mesma página | ok | cobertura de imagem aciona OCR apenas quando a camada nativa é curta; busca encontra imagem e não duplica cabeçalho nativo |',
    '| Pesquisa no PDF | ok | termo sem distinção de caixa encontrado em texto nativo e em imagem com OCR, com regiões de destaque válidas |',
    '| Limite de renderização OCR | ok | dimensões são arredondadas e páginas acima de 32 milhões de pixels recusadas antes de alocar canvas |',
    '| OCR repetido em página curta | ok | marcador privado por página impede duplicação mesmo abaixo do limite heurístico |',
    '| Marcador OCR após compressão | ok | compressão preserva a indicação por página e não duplica uma camada curta |',
    '| Marcador OCR após organização | ok | reordenação preserva a indicação na própria página para impedir duplicidade |',
    '| Modos automático e completo | ok | automático ignora páginas pesquisáveis; completo analisa todas e evita duplicação da camada nativa |',
    '| Refazer OCR com camada rastreável | ok | substitui apenas stream OCR marcado, preserva texto nativo em PDF híbrido, suporta repetição/compressão/organização e recusa camada legada sem modificar a entrada |',
    '| OCR seguido de compressão | ok | texto reconhecido continua pesquisável após o fluxo de compressão |',
    '| OCR → mesclagem → compressão → separação | ok | ambas as páginas mantêm texto pesquisável em cada PDF individual depois da cadeia de operações |',
    '| OCR TIFF multipágina | ok | duas páginas TIFF reconhecidas e exportadas na ordem original |',
    '| OCR seletivo em TIFF multipágina | ok | intervalo respeitado, páginas fora do intervalo preservadas visualmente sem OCR, intervalo inválido rejeitado e original intacto |',
    '| Limites de segurança para imagens | ok | arquivo acima de 25 MB recusado antes da leitura integral; dimensão total TIFF acima de 64 MP recusada antes da decodificação de pixels |',
    `| Precisão — fixture sintético | ok | CER ${(cer * 100).toFixed(1)}%; WER ${(wer * 100).toFixed(1)}% (texto simples, não representa documentos reais) |`,
    `| Precisão e ordem da camada pesquisável — cenários sintéticos | ok | ${qualityMetrics.map((item) => `${item.name}: CER ${(item.cer * 100).toFixed(1)}%, WER ${(item.wer * 100).toFixed(1)}%, cobertura ${(item.tokenRecall * 100).toFixed(1)}%`).join('; ')}; as palavras são alinhadas pela linha reconhecida para manter a ordem na extração (não substitui corpus corporativo real) |`,
    '| OCR de PDF | ok | PDF processado em modo automático e saída textual gerada |',
    '| OCR sem texto reconhecível | ok | página em branco marcada como não reconhecida e operação concluída com aviso claro |',
    '| PDF para Word híbrido | ok | OCR aplicado à página escaneada e texto nativo preservado uma única vez |',
    '| Intervalo de páginas | ok | intervalo validado em PDF, TIFF multipágina e PNG/JPG de página única; páginas fora da seleção não recebem OCR |',
    '| Imagens para PDF pesquisável | ok | opção do fluxo de conversão gera PDF com texto OCR local |',
    '| Validação do PDF OCR antes de publicar | ok | payload inválido rejeitado antes da gravação; sem temporário, saída parcial ou alteração do original |',
    '| Mesclagem para PDF pesquisável | ok | PDFs digitalizados recebem camada OCR; PDFs nativos mantêm texto e saída sem reserialização, com contagens de páginas coerentes |',
    '| Ocultação — busca OCR em scan | ok | candidato de CPF retorna coordenadas e confiança mínima, sem texto reconhecido |',
    '| Ocultação — baixa confiança | ok | ocorrência sensível simulada abaixo de 75% é contabilizada, mas não gera sugestão de tarja; worker encerrado |',
    '| Ocultação — preset de datas | ok | datas em DD/MM/AAAA e AAAA-MM-DD localizadas sem tratar qualquer ano isolado como data |',
    '| Ocultação — irrecuperabilidade | ok | sem recuperação por extração/OCR; metadados, formulário e anexo sensíveis ausentes no PDF reconstruído |',
    '| Extração OCR de região | ok | recorte selecionado de PDF reconhecido no worker, com página/confiança, sem gerar arquivo |',
    '| Cancelamento seguro | ok | cancelado após a primeira página; nenhuma saída parcial e original preservado por SHA-256 |',
    `| PDF nativo de 1.000 páginas | ok | PDF.js leu por faixas sem buffer integral, OCR evitado em todas e saída copiada byte a byte sem reserialização; marcos 1, 10, 50, 100, 500 e 1.000 registrados; ${nativePagesElapsedMs} ms e pico reportado de ${nativePagesPeakRssMb} MB (medição local, sem meta artificial) |`,
    `| Lote OCR de 50 arquivos, um protegido e nove inválidos | ok | ${ocrBatchResult.outputCount} saídas válidas preservadas após a falha protegida; ${ocrBatchResult.failures.length} falhas individuais; avisos limitados a ${ocrBatchResult.warnings.length}; ${batchElapsedMs} ms e pico reportado de ${batchPeakRssMb} MB |`,
    '| Lote com falha parcial | ok | saída válida preservada e falha individual associada ao nome do arquivo |',
    '| Progresso | ok | eventos de progresso emitidos pela fila |',
    '| Originais | ok | entradas permaneceram intactas no diretório de origem |'
  ]);
  return { ok: true, reportPath, imageOutput: imageRun.result.firstOutputPath, compressedOutput: compressedRun.result.outputPath, pdfOutput: pdfRun.result.firstOutputPath, hybridOutput: hybridConversion.outputPath };
}

if (require.main === module) {
  runOcrTests().then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => {
    console.error(error.stack || String(error));
    process.exit(1);
  });
}

module.exports = { runOcrTests, createPackBitsTiff };
