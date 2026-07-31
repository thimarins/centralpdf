const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const {
  ensureDir,
  writeJson,
  writeText,
  GENERATED_ASSETS_DIR,
  TEST_ASSETS_DIR,
  tinyPngBuffer,
  tinyJpgBuffer,
  sampleSvgText
} = require('./_common');
const { PDF_LIMITS } = require('../../src/main/utils');

async function createPdf(targetPath, options = {}) {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const pageCount = options.pageCount || 1;
  const imageEveryPage = options.imageEveryPage || false;
  const pngBuffer = options.pngBuffer || tinyPngBuffer();
  const embeddedPng = imageEveryPage ? await pdfDoc.embedPng(pngBuffer) : null;

  for (let index = 0; index < pageCount; index += 1) {
    const page = pdfDoc.addPage([595, 842]);
    page.drawText(options.title || 'Central PDF Test Asset', {
      x: 48,
      y: 790,
      size: 24,
      font,
      color: rgb(0.12, 0.18, 0.26)
    });
    page.drawText(`Page ${index + 1} of ${pageCount}`, {
      x: 48,
      y: 760,
      size: 14,
      font,
      color: rgb(0.3, 0.36, 0.42)
    });

    for (let line = 0; line < (options.linesPerPage || 18); line += 1) {
      page.drawText(`Validation line ${line + 1} - asset ${options.assetName || path.basename(targetPath)}`, {
        x: 48,
        y: 720 - (line * 28),
        size: 11,
        font,
        color: rgb(0.4, 0.42, 0.45)
      });
    }

    if (imageEveryPage && embeddedPng) {
      page.drawImage(embeddedPng, {
        x: 320,
        y: 260,
        width: 210,
        height: 210,
        opacity: 0.92
      });
    }
  }

  const bytes = await pdfDoc.save({ useObjectStreams: true });
  fs.writeFileSync(targetPath, bytes);
  return targetPath;
}

function createCorruptPdf(sourcePath, targetPath) {
  const bytes = fs.readFileSync(sourcePath);
  const truncated = bytes.subarray(0, Math.max(32, bytes.length - 48));
  fs.writeFileSync(targetPath, truncated);
  return targetPath;
}

function createFakePdf(targetPath) {
  fs.writeFileSync(targetPath, 'this is not a real pdf');
  return targetPath;
}

function createSignedIndicatorPdf(sourcePath, targetPath) {
  fs.writeFileSync(targetPath, '%PDF-1.7\n% simulated signature\n1 0 obj\n<< /Type /Sig >>\nendobj\n%%EOF');
  return targetPath;
}

function createVirtualLargePdf(targetPath, sizeBytes) {
  const fd = fs.openSync(targetPath, 'w');
  try {
    fs.ftruncateSync(fd, sizeBytes);
    const header = Buffer.from('%PDF-1.7\n% virtual test asset\n');
    fs.writeSync(fd, header, 0, header.length, 0);
    const tail = Buffer.from('\ntrailer\n<< /Size 1 >>\nstartxref\n0\n%%EOF');
    fs.writeSync(fd, tail, 0, tail.length, Math.max(0, sizeBytes - tail.length));
  } finally {
    fs.closeSync(fd);
  }
  return targetPath;
}

async function generateTestAssets() {
  ensureDir(TEST_ASSETS_DIR);
  ensureDir(GENERATED_ASSETS_DIR);

  const files = {
    smallPdf: path.join(GENERATED_ASSETS_DIR, 'small.pdf'),
    mediumPdf: path.join(GENERATED_ASSETS_DIR, 'medium.pdf'),
    manyPagesPdf: path.join(GENERATED_ASSETS_DIR, 'many-pages.pdf'),
    imageHeavyPdf: path.join(GENERATED_ASSETS_DIR, 'image-heavy.pdf'),
    corruptPdf: path.join(GENERATED_ASSETS_DIR, 'corrupt.pdf'),
    fakePdf: path.join(GENERATED_ASSETS_DIR, 'fake-renamed.pdf'),
    signedIndicatorPdf: path.join(GENERATED_ASSETS_DIR, 'signed-indicator.pdf'),
    watermarkPng: path.join(GENERATED_ASSETS_DIR, 'watermark.png'),
    watermarkJpg: path.join(GENERATED_ASSETS_DIR, 'watermark.jpg'),
    watermarkSvg: path.join(GENERATED_ASSETS_DIR, 'watermark.svg'),
    protectedPlaceholderPdf: path.join(GENERATED_ASSETS_DIR, 'protected-placeholder.pdf'),
    largeVirtualPdf: path.join(GENERATED_ASSETS_DIR, 'large-virtual.pdf'),
    hugeVirtualPdf: path.join(GENERATED_ASSETS_DIR, 'huge-virtual.pdf'),
    nearLimitVirtualPdf: path.join(GENERATED_ASSETS_DIR, 'near-limit-virtual.pdf'),
    oversizeVirtualPdf: path.join(GENERATED_ASSETS_DIR, 'oversize-virtual.pdf')
  };

  const manifestPath = path.join(TEST_ASSETS_DIR, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const existingManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      let allExist = true;
      for (const k of Object.keys(files)) {
        if (!fs.existsSync(files[k])) {
          allExist = false;
          break;
        }
      }
      if (allExist) {
        return existingManifest;
      }
    } catch (e) {}
  }

  await createPdf(files.smallPdf, { assetName: 'small', pageCount: 2, linesPerPage: 8, title: 'Small Test PDF' });
  await createPdf(files.mediumPdf, { assetName: 'medium', pageCount: 8, linesPerPage: 18, title: 'Medium Test PDF' });
  await createPdf(files.manyPagesPdf, { assetName: 'many-pages', pageCount: 120, linesPerPage: 6, title: 'Many Pages Test PDF' });
  await createPdf(files.imageHeavyPdf, { assetName: 'image-heavy', pageCount: 12, linesPerPage: 8, imageEveryPage: true, title: 'Image Heavy Test PDF' });

  createCorruptPdf(files.smallPdf, files.corruptPdf);
  createFakePdf(files.fakePdf);
  createSignedIndicatorPdf(files.smallPdf, files.signedIndicatorPdf);
  fs.writeFileSync(files.watermarkPng, tinyPngBuffer());
  fs.writeFileSync(files.watermarkJpg, tinyJpgBuffer());
  fs.writeFileSync(files.watermarkSvg, sampleSvgText('CONFIDENTIAL'), 'utf8');
  fs.writeFileSync(files.protectedPlaceholderPdf, '%PDF-1.7\n1 0 obj\n<< /Encrypt true >>\nendobj\n%%EOF');

  createVirtualLargePdf(files.largeVirtualPdf, 350 * 1024 * 1024);
  createVirtualLargePdf(files.hugeVirtualPdf, Math.floor(1.2 * 1024 * 1024 * 1024));
  createVirtualLargePdf(files.nearLimitVirtualPdf, PDF_LIMITS.maxSupportedBytes - (256 * 1024));
  createVirtualLargePdf(files.oversizeVirtualPdf, PDF_LIMITS.maxSupportedBytes + (256 * 1024));

  const manifest = {
    generatedAt: new Date().toISOString(),
    notes: [
      'Large virtual PDFs are sparse files used for limit and warning validation.',
      'protected-placeholder.pdf simulates a protected indicator but is not full encryption.',
      'fake-renamed.pdf is a non-PDF file saved with a .pdf extension to validate rejection.'
    ],
    files
  };

  writeJson(manifestPath, manifest);
  writeText(
    path.join(TEST_ASSETS_DIR, 'README.md'),
    [
      '# Test Assets',
      '',
      'Assets generated locally for the Central PDF validation suite.',
      '',
      '- `generated/`: synthetic PDFs and images used by automated tests.',
      '- `manifest.json`: list of files and important notes.',
      '',
      'Notes:',
      '- Very large files are sparse to avoid wasting disk space.',
      '- The goal is to simulate validation scenarios without versioning heavy binaries.'
    ].join('\n')
  );

  return manifest;
}

if (require.main === module) {
  generateTestAssets()
    .then((manifest) => {
      console.log(`Test assets ready: ${manifest.generatedAt}`);
    })
    .catch((error) => {
      console.error(error.stack || String(error));
      process.exit(1);
    });
}

module.exports = {
  generateTestAssets
};
