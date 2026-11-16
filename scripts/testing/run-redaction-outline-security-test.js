const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { PDFDocument, PDFName, PDFString } = require('pdf-lib');
const { createCanvas } = require('@napi-rs/canvas');
const { redactPdf } = require('../../src/main/pdf-service');

async function run() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'central-pdf-redaction-outline-'));
  const sourcePath = path.join(directory, 'source.pdf');
  const stampPath = path.join(directory, 'redacted-page.png');
  const outputPath = path.join(directory, 'redacted.pdf');

  try {
    const source = await PDFDocument.create();
    const page = source.addPage([300, 120]);
    page.drawText('CPF 123.456.789-09', { x: 12, y: 60 });
    const outlineRef = source.context.nextRef();
    const outlineItemRef = source.context.nextRef();
    source.context.assign(outlineItemRef, source.context.obj({
      Title: PDFString.of('CPF 123.456.789-09'),
      Parent: outlineRef,
      Dest: source.context.obj([page.ref, PDFName.of('XYZ'), null, null, null])
    }));
    source.context.assign(outlineRef, source.context.obj({
      Type: PDFName.of('Outlines'), First: outlineItemRef, Last: outlineItemRef, Count: 1
    }));
    source.catalog.set(PDFName.of('Outlines'), outlineRef);
    fs.writeFileSync(sourcePath, await source.save());
    const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex');

    const stamp = createCanvas(600, 240);
    const context = stamp.getContext('2d');
    context.fillStyle = '#000000';
    context.fillRect(0, 0, stamp.width, stamp.height);
    fs.writeFileSync(stampPath, stamp.toBuffer('image/png'));

    await redactPdf(sourcePath, outputPath, {
      redactedPages: [{ pageIndex: 0, imagePath: stampPath }]
    });

    const outputBytes = fs.readFileSync(outputPath);
    const redacted = await PDFDocument.load(outputBytes);
    assert.equal(redacted.catalog.get(PDFName.of('Outlines')), undefined,
      'A ocultação não deve copiar marcadores que possam reter texto sensível.');
    assert.equal(outputBytes.includes(Buffer.from('CPF 123.456.789-09')), false,
      'O título sensível do marcador continua recuperável nos bytes do PDF final.');
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex'), sourceHash,
      'A origem deve permanecer intacta.');
    console.log('Redaction outline security passed: bookmark removed, sensitive title absent, source unchanged.');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
