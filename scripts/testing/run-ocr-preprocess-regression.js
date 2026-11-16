const assert = require('assert');
const fs = require('fs');
const path = require('path');
const UTIF = require('utif');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { createTempDir } = require('./_common');
const { OCR_MAX_RENDER_PIXELS, decodeTiffPageToPng, getTiffArrayBuffer, recognizePdf, recognizeWithAdaptiveOrientation, searchPdfDocument, validateTiffPages, writeOcrOutput } = require('../../src/main/services/ocr/ocr-service');

function createNoisyFixture() {
  const canvas = createCanvas(60, 30);
  const context = canvas.getContext('2d');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, 60, 30);
  context.fillStyle = '#000';
  context.fillRect(45, 15, 1, 1);
  return canvas.toBuffer('image/png');
}

function createTinyTiff() {
  const width = 8;
  const height = 8;
  const rgba = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    rgba[pixel * 4] = 255;
    rgba[pixel * 4 + 1] = 255;
    rgba[pixel * 4 + 2] = 255;
    rgba[pixel * 4 + 3] = 255;
  }
  const ifd = { t256: [width], t257: [height], t258: [8, 8, 8, 8], t259: [1], t262: [2], t273: [0], t277: [4], t278: [height], t279: [rgba.length], t284: [1], t338: [1] };
  const directoryLength = new Uint8Array(UTIF.encode([ifd])).length;
  ifd.t273[0] = directoryLength;
  const directory = new Uint8Array(UTIF.encode([ifd]));
  const bytes = new Uint8Array(directory.length + rgba.length);
  bytes.set(directory);
  bytes.set(rgba, directory.length);
  return bytes;
}

async function run() {
  assert.deepStrictEqual(validateTiffPages([{ t256: [1200], t257: [300] }, { t256: [800], t257: [600] }]), [
    { width: 1200, height: 300 },
    { width: 800, height: 600 }
  ]);
  assert.throws(
    () => validateTiffPages([{ t256: [OCR_MAX_RENDER_PIXELS], t257: [2] }]),
    /grande demais para o OCR/
  );
  assert.throws(() => validateTiffPages([{ t256: [0], t257: [100] }]), /dimensões inválidas/);
  assert.throws(() => validateTiffPages(Array.from({ length: 1001 }, () => ({ t256: [1], t257: [1] }))), /1\.000 páginas/);
  const tiffBytes = createTinyTiff();
  const exactBackingStore = getTiffArrayBuffer(tiffBytes);
  assert.strictEqual(exactBackingStore, tiffBytes.buffer, 'Um buffer TIFF com extensão exata deve ser reutilizado sem cópia.');
  const paddedBacking = Uint8Array.from([91, ...tiffBytes, 92]);
  const tiffView = paddedBacking.subarray(1, paddedBacking.length - 1);
  const isolatedTiffBuffer = getTiffArrayBuffer(tiffView);
  assert.notStrictEqual(isolatedTiffBuffer, paddedBacking.buffer, 'Uma view parcial não deve expor o buffer externo completo ao decodificador.');
  assert.strictEqual(isolatedTiffBuffer.byteLength, tiffBytes.byteLength);
  assert.deepStrictEqual(new Uint8Array(isolatedTiffBuffer), tiffBytes);
  const [tiffIfd] = UTIF.decode(exactBackingStore);
  const [tiffDimensions] = validateTiffPages([tiffIfd]);
  const decodedTiffPng = await decodeTiffPageToPng(exactBackingStore, tiffIfd, tiffDimensions);
  assert.strictEqual(tiffIfd.data, null, 'Os pixels brutos decodificados devem ser liberados da página TIFF.');
  const decodedTiffImage = await loadImage(decodedTiffPng);
  assert.deepStrictEqual([decodedTiffImage.width, decodedTiffImage.height], [8, 8]);

  const workspace = createTempDir('ocr-lazy-native-pdf');
  try {
    const nativePdf = await PDFDocument.create();
    const page = nativePdf.addPage([612, 792]);
    const font = await nativePdf.embedFont(StandardFonts.Helvetica);
    page.drawText('This document already has enough native searchable text for OCR to skip safely.', {
      x: 40, y: 740, size: 14, font, color: rgb(0, 0, 0)
    });
    const inputPath = path.join(workspace, 'native.pdf');
    const originalBytes = Buffer.from(await nativePdf.save());
    fs.writeFileSync(inputPath, originalBytes);
    const workerFactory = async () => { throw new Error('Native text should not start the OCR engine.'); };

    const pdfResult = await recognizePdf(inputPath, { mode: 'auto', format: 'pdf' }, () => {}, () => false, workerFactory);
    assert.strictEqual(pdfResult.copyOriginal, true, 'PDF nativo em modo automático deve evitar carregar bytes para reserialização.');
    assert.strictEqual(pdfResult.pdfBytes, undefined, 'Caminho sem mudanças não deve manter uma cópia completa do PDF na memória.');
    assert.ok(pdfResult.pageResults.every((page) => !Object.hasOwn(page, 'text')), 'Saída PDF não deve duplicar o texto de cada página na memória.');
    const copiedPath = await writeOcrOutput(pdfResult, inputPath, path.join(workspace, 'pdf-output'), { format: 'pdf' });
    assert.deepStrictEqual(fs.readFileSync(copiedPath), originalBytes, 'Cópia de saída deve preservar o PDF original byte a byte.');

    let renameAttempts = 0;
    const retryFileSystem = {
      mkdir: (...args) => fs.promises.mkdir(...args),
      writeFile: (...args) => fs.promises.writeFile(...args),
      rename: async (...args) => {
        renameAttempts += 1;
        if (renameAttempts < 3) {
          const error = new Error('Arquivo temporariamente bloqueado pelo Windows.');
          error.code = 'EPERM';
          throw error;
        }
        return fs.promises.rename(...args);
      },
      unlink: (...args) => fs.promises.unlink(...args),
      stat: (...args) => fs.promises.stat(...args)
    };
    const retryPath = await writeOcrOutput({ pdfBytes: originalBytes, pageResults: [] }, inputPath, path.join(workspace, 'retry-output'), { format: 'pdf' }, retryFileSystem);
    assert.strictEqual(renameAttempts, 3, 'Bloqueios transitórios EPERM devem ser repetidos de forma limitada.');
    assert.deepStrictEqual(fs.readFileSync(retryPath), originalBytes);

    const pageMismatchOutput = path.join(workspace, 'page-mismatch-output');
    await assert.rejects(
      writeOcrOutput({ pdfBytes: originalBytes, pageCount: 2, pageResults: [] }, inputPath, pageMismatchOutput, { format: 'pdf' }),
      /não passou na verificação de páginas/
    );
    assert.deepStrictEqual(fs.readdirSync(pageMismatchOutput), [], 'PDF com contagem de páginas divergente não pode deixar saída parcial.');

    const textResult = await recognizePdf(inputPath, { mode: 'auto', format: 'text' }, () => {}, () => false, workerFactory);
    assert.strictEqual(textResult.copyOriginal, undefined, 'Saída TXT deve extrair o texto em vez de copiar o PDF.');
    assert.ok(textResult.pageResults.some((page) => page.text?.includes('native searchable text')), 'Exportação TXT deve manter o texto nativo até a gravação do arquivo.');
    const textPath = await writeOcrOutput(textResult, inputPath, path.join(workspace, 'text-output'), { format: 'text' });
    assert.match(fs.readFileSync(textPath, 'utf8'), /native searchable text/);

    const matches = await searchPdfDocument(inputPath, 'searchable text');
    assert.ok(matches.matches.length > 0, 'Busca em PDF nativo deve funcionar pelo leitor local sem carregar o arquivo como buffer completo.');
    assert.strictEqual(matches.matches[0].source, 'texto');

    let changedDuringRead = false;
    const guardedInputPath = path.join(workspace, 'native-alterado.pdf');
    fs.writeFileSync(guardedInputPath, originalBytes);
    await assert.rejects(
      recognizePdf(guardedInputPath, { mode: 'auto', format: 'pdf' }, (item) => {
        if (!changedDuringRead && item.status === 'skipped') {
          changedDuringRead = true;
          fs.appendFileSync(guardedInputPath, Buffer.from(' '));
        }
      }, () => false, workerFactory),
      /alterado durante a análise/
    );
    assert.strictEqual(changedDuringRead, true, 'A fixture deve alterar o arquivo durante o processamento.');
    fs.writeFileSync(guardedInputPath, originalBytes);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }

  const originalBytes = createNoisyFixture();
  const progress = [];
  let calls = 0;
  const improvingWorker = {
    async recognize() {
      calls += 1;
      const clearText = calls >= 5;
      return { data: {
        text: clearText ? 'A sufficiently clear sentence recognized correctly by OCR.' : 'unclear symbols',
        confidence: clearText ? 92 : 20
      } };
    }
  };
  const improved = await recognizeWithAdaptiveOrientation(
    originalBytes,
    improvingWorker,
    {},
    () => false,
    (item) => progress.push(item)
  );
  assert.strictEqual(improved.preprocessingApplied, true, 'O OCR deve aceitar o filtro quando a qualidade melhora.');
  assert.ok(improved.qualityScore > 65, 'A alternativa melhor deve elevar a pontuação de qualidade.');
  assert.ok(progress.some((item) => item.method === 'isolated-noise-reduction'), 'O progresso deve identificar a etapa adotada.');

  let flatCalls = 0;
  const nonImprovingWorker = {
    async recognize() {
      flatCalls += 1;
      return { data: { text: 'unclear symbols', confidence: 20 } };
    }
  };
  const unchanged = await recognizeWithAdaptiveOrientation(originalBytes, nonImprovingWorker);
  assert.strictEqual(unchanged.preprocessingApplied, false, 'O filtro não deve ser marcado como aplicado sem ganho de qualidade.');
  assert.strictEqual(unchanged.bytes, originalBytes, 'Sem melhora, o OCR deve manter os bytes originais.');
  assert.ok(flatCalls >= 5, 'O caso sem melhora precisa percorrer e rejeitar a alternativa filtrada.');
  console.log('OCR fast regressions passed: lazy native-PDF path, bounded TIFF allocation, byte-identical copy, text export, and quality-gated denoising.');
}

run().catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
