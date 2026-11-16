const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createCanvas } = require('@napi-rs/canvas');
const UTIF = require('utif');
const { createPdfWorkerExecution } = require('../../src/main/worker-runtime');
const { extractStructuredText } = require('../../src/main/services/conversion/text-extractor');
const { createTempDir } = require('./_common');
const { createPackBitsTiff } = require('./run-ocr-tests');

async function runTiffCodecTest() {
  const workspace = createTempDir('ocr-tiff-codec');
  try {
    const canvas = createCanvas(1200, 300);
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#111';
    context.font = '64px Arial';
    context.fillText('Pagina TIFF PackBits', 50, 150);
    const page = { width: canvas.width, height: canvas.height, rgba: context.getImageData(0, 0, canvas.width, canvas.height).data };
    const sourcePath = path.join(workspace, 'tiff-packbits.tif');
    const sourceBytes = createPackBitsTiff(page);
    fs.writeFileSync(sourcePath, sourceBytes);

    const tiffBuffer = sourceBytes.buffer.slice(sourceBytes.byteOffset, sourceBytes.byteOffset + sourceBytes.byteLength);
    const directories = UTIF.decode(tiffBuffer);
    assert.equal(directories.length, 1, 'O fixture PackBits deve conter exatamente uma página.');
    assert.equal(directories[0].t259?.[0], 32773, 'A tag TIFF deve identificar compressão PackBits.');
    UTIF.decodeImage(tiffBuffer, directories[0]);
    assert.ok(directories[0].data?.length >= page.width * page.height * 4, 'A imagem PackBits não foi expandida corretamente.');

    const outputDir = path.join(workspace, 'saida');
    fs.mkdirSync(outputDir, { recursive: true });
    const execution = createPdfWorkerExecution({
      type: 'ocr',
      files: [sourcePath],
      options: { language: 'por+eng', mode: 'auto', format: 'pdf' },
      outputDir
    }, () => {});
    const result = await execution.promise;
    assert.equal(result.outputCount, 1, 'OCR do TIFF PackBits não produziu um PDF.');
    const output = await extractStructuredText(result.firstOutputPath);
    assert.match(output.pages[0].text, /Pagina/i, 'O texto do TIFF PackBits não ficou pesquisável.');
    assert.match(output.pages[0].text, /PackBits/i, 'A extração do PDF perdeu o texto da página TIFF comprimida.');
    console.log('OCR TIFF codec tests passed: PackBits decodificado, reconhecido e pesquisável.');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

runTiffCodecTest().catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
