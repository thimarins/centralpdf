const assert = require('node:assert/strict');
const nativeFs = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createCanvas } = require('@napi-rs/canvas');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { recognizePdf, analyzePdfOcrNeed, findOcrRedactionCandidates, searchPdfDocument, writeOcrOutput } = require('../../src/main/services/ocr/ocr-service');
const { openPdfJsDocumentFromFile } = require('../../src/main/services/ocr/pdf-range-transport');
const { writeReport } = require('./_common');

async function main() {
  const checks = [];
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'central-pdf-ocr-lazy-'));
  const inputPath = path.join(tempDir, 'native-text.pdf');
  const outputDir = path.join(tempDir, 'output');
  let workerCreations = 0;
  const workerFactory = async () => {
    workerCreations += 1;
    throw new Error('O worker OCR não deveria ser iniciado para páginas nativas.');
  };

  try {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([612, 792]);
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    page.drawText('Documento nativo com texto pesquisavel suficiente para dispensar reconhecimento OCR.', {
      x: 50, y: 700, size: 14, font
    });
    const originalBytes = Buffer.from(await pdf.save());
    await fs.writeFile(inputPath, originalBytes);

    const originalReadFile = nativeFs.promises.readFile;
    let fullFileReads = 0;
    nativeFs.promises.readFile = function guardedReadFile(filePath, ...args) {
      if (typeof filePath === 'string' && path.resolve(filePath) === path.resolve(inputPath)) {
        fullFileReads += 1;
        return Promise.reject(new Error('O teste detectou leitura integral desnecessária do PDF.'));
      }
      return originalReadFile.call(this, filePath, ...args);
    };
    let recognized;
    let candidates;
    let search;
    try {
      recognized = await recognizePdf(inputPath, { language: 'eng', mode: 'auto' }, () => {}, () => false, workerFactory);
      candidates = await findOcrRedactionCandidates(inputPath, 'seguranca', { language: 'eng' }, () => {}, () => false, workerFactory);
      search = await searchPdfDocument(inputPath, 'pesquisavel');
    } finally {
      nativeFs.promises.readFile = originalReadFile;
    }
    assert.equal(workerCreations, 0, 'modo automático não deve iniciar Tesseract em PDF nativo');
    assert.equal(recognized.skippedPages, 1);
    assert.equal(recognized.recognizedPages, 0);
    assert.equal(recognized.copyOriginal, true, 'sem alterações, o serviço deve evitar manter os bytes completos ou reserializar o PDF original');
    assert.equal(recognized.pdfBytes, undefined);
    const outputPath = await writeOcrOutput(recognized, inputPath, outputDir, { format: 'pdf' });
    assert.deepEqual(await fs.readFile(outputPath), originalBytes, 'a saída sem mudanças deve preservar o PDF original byte a byte');
    assert.ok((await fs.stat(outputPath)).size > 0, 'a saída PDF deve continuar válida e gravada');
    checks.push({ name: 'OCR automático evita iniciar o worker para texto nativo', ok: true });

    assert.equal(workerCreations, 0, 'busca de tarja não deve iniciar Tesseract se não há páginas escaneadas');
    assert.equal(candidates.scannedPages, 0);
    assert.equal(candidates.skippedPages, 1);
    assert.ok(search.matches.length > 0, 'Pesquisa textual por arquivo deve funcionar no runtime do app.');
    assert.equal(fullFileReads, 0, 'PDF nativo deve ser analisado por faixas sem leitura integral nem inicialização do Tesseract.');
    checks.push({ name: 'OCR automático, pesquisa e busca de tarjas analisam por faixas sem iniciar Tesseract para PDF nativo', ok: true });

    const rangeInputPath = path.join(tempDir, 'native-text-range.pdf');
    const largeRangePdf = await PDFDocument.create();
    const rangeFont = await largeRangePdf.embedFont(StandardFonts.Helvetica);
    for (let index = 0; index < 800; index += 1) {
      const rangePage = largeRangePdf.addPage([612, 792]);
      rangePage.drawText(`Página de teste ${index + 1}: conteúdo nativo para validação de leitura parcial.`, { x: 40, y: 740, size: 10, font: rangeFont });
    }
    const largeRangeBytes = Buffer.from(await largeRangePdf.save());
    assert.ok(largeRangeBytes.length > 2 * 64 * 1024, 'A fixture precisa exceder duas faixas do PDF.js.');
    await fs.writeFile(rangeInputPath, largeRangeBytes);
    let analysisFullFileReads = 0;
    const readFileForAnalysis = nativeFs.promises.readFile;
    nativeFs.promises.readFile = function forbidAnalysisBufferRead(filePath, ...args) {
      if (typeof filePath === 'string' && path.resolve(filePath) === path.resolve(rangeInputPath)) {
        analysisFullFileReads += 1;
        return Promise.reject(new Error('A triagem do PDF não deve ler o arquivo inteiro.'));
      }
      return readFileForAnalysis.call(this, filePath, ...args);
    };
    let analysis;
    try {
      analysis = await analyzePdfOcrNeed(rangeInputPath);
    } finally {
      nativeFs.promises.readFile = readFileForAnalysis;
    }
    assert.equal(analysis.status, 'native', 'A triagem do PDF grande deve continuar reconhecendo páginas com texto nativo.');
    assert.equal(analysis.totalPages, 800);
    assert.equal(analysis.sampledPages, 16, 'A triagem deve manter o limite de amostragem de páginas.');
    assert.equal(analysisFullFileReads, 0, 'A triagem automática para Word não pode carregar o PDF inteiro em memória.');
    let accessDeniedError;
    const originalOpen = nativeFs.promises.open;
    nativeFs.promises.open = function denyAnalysisRead(filePath, ...args) {
      if (typeof filePath === 'string' && path.resolve(filePath) === path.resolve(rangeInputPath)) {
        return Promise.reject(Object.assign(new Error(`EACCES: acesso negado a ${rangeInputPath}`), { code: 'EACCES' }));
      }
      return originalOpen.call(this, filePath, ...args);
    };
    try {
      await assert.rejects(analyzePdfOcrNeed(rangeInputPath), (error) => {
        accessDeniedError = error;
        return /verifique se o arquivo ainda existe e se você tem permissão/i.test(error.message);
      });
    } finally {
      nativeFs.promises.open = originalOpen;
    }
    assert.ok(accessDeniedError.cause, 'A causa técnica deve permanecer disponível para diagnóstico interno.');
    assert.ok(!accessDeniedError.message.includes(rangeInputPath), 'A mensagem exibida ao usuário não deve expor caminho nem erro bruto do sistema.');
    assert.equal(accessDeniedError.safeUserMessage, accessDeniedError.message);
    checks.push({ name: 'Triagem PDF→Word usa faixas e normaliza erro de acesso sem expor caminho', ok: true });

    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const standardFontDataUrl = `${path.resolve(path.dirname(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')), '../../standard_fonts').replace(/\\/g, '/')}/`;
    const rangeDocument = await openPdfJsDocumentFromFile(pdfjs, rangeInputPath, { standardFontDataUrl });
    try {
      const rangePdf = await rangeDocument.loadingTask.promise;
      const rangePage = await rangePdf.getPage(1);
      const rangeText = (await rangePage.getTextContent()).items.map((item) => item.str || '').join(' ');
      assert.match(rangeText, /Página de teste 1/);
      rangePage.cleanup();
      assert.ok(rangeDocument.getBytesRead() < largeRangeBytes.length, `O parser de faixas deve ler menos que o arquivo inteiro (${rangeDocument.getBytesRead()}/${largeRangeBytes.length} bytes, faixas ${JSON.stringify(rangeDocument.getRequestedRanges())}).`);
    } finally {
      await rangeDocument.loadingTask.destroy();
      await rangeDocument.close();
    }
    checks.push({ name: 'PDF.js lê PDF local grande por faixas sem XMLHttpRequest nem buffer integral', ok: true });

    const scannedCanvas = createCanvas(1200, 300);
    const scannedContext = scannedCanvas.getContext('2d');
    scannedContext.fillStyle = '#fff';
    scannedContext.fillRect(0, 0, 1200, 300);
    scannedContext.fillStyle = '#111';
    scannedContext.font = '64px Arial';
    scannedContext.fillText('CPF: 123.456.789-09', 40, 170);
    const scannedPdf = await PDFDocument.create();
    const scannedPage = scannedPdf.addPage([1200, 300]);
    const scannedImage = await scannedPdf.embedPng(scannedCanvas.toBuffer('image/png'));
    scannedPage.drawImage(scannedImage, { x: 0, y: 0, width: 1200, height: 300 });
    const scannedPath = path.join(tempDir, 'scanned.pdf');
    await fs.writeFile(scannedPath, await scannedPdf.save());
    let scanBufferReads = 0;
    const readFileForScan = nativeFs.promises.readFile;
    nativeFs.promises.readFile = function countScannedPdfRead(filePath, ...args) {
      if (typeof filePath === 'string' && path.resolve(filePath) === path.resolve(scannedPath)) scanBufferReads += 1;
      return readFileForScan.call(this, filePath, ...args);
    };
    let scannedCandidates;
    try {
      scannedCandidates = await findOcrRedactionCandidates(scannedPath, 'CPF', { language: 'por+eng' });
    } finally {
      nativeFs.promises.readFile = readFileForScan;
    }
    assert.equal(scannedCandidates.scannedPages, 1, 'A página escaneada deve acionar o OCR de candidatos.');
    assert.ok(scannedCandidates.candidates.length > 0, 'O OCR deve encontrar o CPF sintético na página escaneada.');
    assert.equal(scanBufferReads, 1, 'PDF deve ser lido uma vez para o parser e a busca OCR deve reutilizar esses bytes.');
    checks.push({ name: 'Busca de tarjas carrega bytes integrais somente quando precisa do pdf-lib e retorna candidatos OCR', ok: true });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }

  const reportPath = writeReport('ocr-lazy-worker-report.md', [
    '# OCR Lazy Worker Test Report',
    '',
    `Gerado em ${new Date().toISOString()}.`,
    '',
    ...checks.map((item) => `- ${item.ok ? 'ok' : 'falha'} — ${item.name}`),
    '',
    `Resultado: ${checks.filter((item) => item.ok).length}/${checks.length} verificações passaram.`
  ]);
  console.log(`OCR lazy-worker checks: ${checks.filter((item) => item.ok).length}/${checks.length}; relatório: ${reportPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
