const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { PDFDocument } = require('pdf-lib');
const { renderPdfPage, releaseOcrCanvas, searchPdfDocument, findOcrRedactionCandidates } = require('../../src/main/services/ocr/ocr-service');
const { createTempDir } = require('./_common');

async function main() {
  const page = {
    getViewport: ({ scale }) => ({ width: 32 * scale, height: 24 * scale }),
    render: ({ canvasContext }) => {
      canvasContext.fillStyle = '#2357a5';
      canvasContext.fillRect(0, 0, 32, 24);
      return { promise: Promise.resolve() };
    }
  };

  const rendered = await renderPdfPage(page, 1);
  assert.equal(rendered.canvas, null, 'Renderização padrão não deve reter a superfície RGBA após gerar PNG.');
  const decoded = await loadImage(rendered.bytes);
  assert.equal(decoded.width, 32);
  assert.equal(decoded.height, 24);

  const retained = await renderPdfPage(page, 1, { retainCanvas: true });
  assert.equal(retained.canvas.width, 32, 'Recorte regional precisa manter a superfície até copiar a área selecionada.');
  releaseOcrCanvas(retained.canvas);
  assert.equal(retained.canvas.width, 0, 'A superfície explicitamente retida deve ser liberável.');
  assert.equal(retained.canvas.height, 0);

  const workspace = createTempDir('ocr-render-memory');
  try {
    const sourceCanvas = createCanvas(1800, 500);
    const context = sourceCanvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, sourceCanvas.width, sourceCanvas.height);
    context.fillStyle = '#111';
    context.font = '96px Arial';
    context.fillText('MEMORYSCAN 4829', 80, 260);
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([900, 250]);
    const image = await pdf.embedPng(sourceCanvas.toBuffer('image/png'));
    page.drawImage(image, { x: 0, y: 0, width: 900, height: 250 });
    const inputPath = path.join(workspace, 'scanned-page.pdf');
    fs.writeFileSync(inputPath, await pdf.save());

    const search = await searchPdfDocument(inputPath, 'MEMORYSCAN', { language: 'eng' });
    assert.ok(search.matches.some((match) => match.source === 'OCR'), 'Busca OCR deve continuar encontrando texto após liberar o canvas de renderização.');
    const redaction = await findOcrRedactionCandidates(inputPath, 'MEMORYSCAN', { language: 'eng' });
    assert.ok(redaction.candidates.length > 0, 'Busca OCR para ocultação deve manter as coordenadas após liberar o canvas.');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }

  console.log('OCR render memory checks passed: default RGBA canvas released; regional canvas retained only on request and explicitly releasable.');
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
