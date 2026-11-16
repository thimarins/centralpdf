const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { createCanvas } = require('@napi-rs/canvas');
const { suggestPdfSplitStarts } = require('../../src/main/services/ocr/ocr-service');

async function createFixture(filePath) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const pageSize = [595, 842];
  for (let index = 0; index < 2; index += 1) {
    const page = pdf.addPage(pageSize);
    page.drawText('ACME CORPORATION', { x: 48, y: 780, size: 20, font, color: rgb(0, 0, 0) });
    page.drawText('INVOICE BATCH 14', { x: 48, y: 720, size: 17, font, color: rgb(0, 0, 0) });
    page.drawText(`Account details ${index + 1}`, { x: 48, y: 660, size: 12, font, color: rgb(0, 0, 0) });
  }

  for (let index = 0; index < 2; index += 1) {
    const canvas = createCanvas(1190, 1684);
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#111111';
    context.font = 'bold 48px Arial';
    context.fillText('ACME CORPORATION', 100, 130);
    context.font = 'bold 44px Arial';
    context.fillText('SERVICE ORDER 2026', 100, 255);
    context.font = '32px Arial';
    context.fillText(`Service details ${index + 1}`, 100, 380);
    const image = await pdf.embedPng(canvas.toBuffer('image/png'));
    const page = pdf.addPage(pageSize);
    page.drawImage(image, { x: 0, y: 0, width: pageSize[0], height: pageSize[1] });
  }
  await fs.writeFile(filePath, await pdf.save({ useObjectStreams: true }));
}

async function run() {
  const filePath = path.join(os.tmpdir(), `central-pdf-split-title-${crypto.randomUUID()}.pdf`);
  try {
    await createFixture(filePath);
    const progressPages = [];
    const result = await suggestPdfSplitStarts(filePath, { language: 'eng' }, (progress) => {
      if (Number.isSafeInteger(progress.page)) progressPages.push(progress.page);
    }, () => false);
    assert.equal(result.totalPages, 4);
    assert.equal(result.scannedPages, 4);
    assert.deepEqual(result.suggestions.map(({ pageNumber }) => pageNumber), [3]);
    assert.match(result.suggestions[0].heading, /SERVICE ORDER 2026/i);
    assert.equal(result.suggestions[0].source, 'OCR');
    assert.ok(progressPages.includes(1) && progressPages.includes(4), 'O progresso deve abranger a primeira e a última página.');
    let cancelAfterFirstPage = false;
    await assert.rejects(
      suggestPdfSplitStarts(filePath, { language: 'eng' }, (progress) => {
        if (progress.page === 1) cancelAfterFirstPage = true;
      }, () => cancelAfterFirstPage),
      (error) => error.message === 'OPERATION_CANCELLED'
    );
    console.log('Split title PDF checks passed: native text + scanned OCR, repeated-header suppression, reviewed suggestion, progress and cancellation.');
  } finally {
    await fs.unlink(filePath).catch(() => {});
  }
}

run().catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
