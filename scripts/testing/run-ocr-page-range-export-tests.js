const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createCanvas } = require('@napi-rs/canvas');
const { PDFDocument } = require('pdf-lib');
const { getExactByteView, recognizePdf, writeOcrOutput } = require('../../src/main/services/ocr/ocr-service');

async function main() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'central-pdf-ocr-range-export-'));
  try {
    const jpegCanvas = createCanvas(80, 48);
    jpegCanvas.getContext('2d').fillRect(0, 0, 80, 48);
    const jpegBytes = jpegCanvas.toBuffer('image/jpeg');
    const pooledBacking = Buffer.allocUnsafeSlow(jpegBytes.length + 32);
    const pooledJpegView = pooledBacking.subarray(16, 16 + jpegBytes.length);
    jpegBytes.copy(pooledJpegView);
    assert.ok(pooledJpegView.byteOffset > 0, 'Fixture JPEG deve usar deliberadamente byteOffset diferente de zero.');
    const exactJpegBytes = getExactByteView(pooledJpegView);
    assert.equal(exactJpegBytes.byteOffset, 0);
    assert.equal(exactJpegBytes.byteLength, jpegBytes.length);
    assert.ok(Buffer.from(exactJpegBytes).equals(jpegBytes), 'Bytes copiados devem permanecer idênticos ao JPEG original.');
    const jpegPdf = await PDFDocument.create();
    const embeddedJpeg = await jpegPdf.embedJpg(exactJpegBytes);
    jpegPdf.addPage([embeddedJpeg.width, embeddedJpeg.height]).drawImage(embeddedJpeg, {
      x: 0, y: 0, width: embeddedJpeg.width, height: embeddedJpeg.height
    });
    assert.equal((await PDFDocument.load(await jpegPdf.save())).getPageCount(), 1);

    const sourcePath = path.join(tempDir, 'hibrido-intervalo.pdf');
    const pdf = await PDFDocument.create();
    pdf.addPage([600, 400]).drawText('TEXTO PRIVADO FORA DO INTERVALO', { x: 40, y: 320, size: 18 });
    const canvas = createCanvas(1600, 300);
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#111';
    context.font = '64px Arial';
    context.textBaseline = 'top';
    context.fillText('Texto autorizado da pagina selecionada', 35, 85);
    const image = await pdf.embedPng(canvas.toBuffer('image/png'));
    pdf.addPage([600, 400]).drawImage(image, { x: 20, y: 140, width: 560, height: 105 });
    await fs.writeFile(sourcePath, await pdf.save());
    const originalHash = crypto.createHash('sha256').update(await fs.readFile(sourcePath)).digest('hex');

    const result = await recognizePdf(sourcePath, {
      language: 'por+eng', mode: 'auto', format: 'text', pageRange: '2'
    });
    assert.equal(result.pageResults.filter((item) => item.status === 'out-of-range').length, 1);
    assert.equal(result.pageResults[0].status, 'out-of-range');
    assert.equal(result.pageResults[0].textLength, 0);
    assert.equal(result.pageResults[0].text, '');
    assert.equal(result.pageResults[1].status, 'recognized');

    const outputPath = await writeOcrOutput(result, sourcePath, tempDir, { format: 'text', outputName: 'intervalo.txt' });
    const exported = await fs.readFile(outputPath, 'utf8');
    assert.doesNotMatch(exported, /TEXTO PRIVADO FORA DO INTERVALO/i, 'Texto nativo não selecionado vazou para o TXT.');
    assert.match(exported, /Texto autorizado da pagina selecionada/i, 'O TXT perdeu o texto reconhecido dentro do intervalo.');
    assert.equal(crypto.createHash('sha256').update(await fs.readFile(sourcePath)).digest('hex'), originalHash, 'O original foi alterado.');
    console.log('OCR page-range TXT export passed: unselected native text excluded, selected scan recognized, original preserved.');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
