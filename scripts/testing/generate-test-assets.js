const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { PDFDocument, StandardFonts, rgb, degrees } = require('pdf-lib');
const { createCanvas } = require('@napi-rs/canvas');
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
    const pageSize = options.pageSize || [595, 842];
    const page = pdfDoc.addPage(pageSize);
    if (options.rotation) page.setRotation(degrees(options.rotation));
    const pageHeight = pageSize[1];
    page.drawText(options.title || 'Central PDF Test Asset', {
      x: 48,
      y: pageHeight - 52,
      size: 24,
      font,
      color: rgb(0.12, 0.18, 0.26)
    });
    page.drawText(`Page ${index + 1} of ${pageCount}`, {
      x: 48,
      y: pageHeight - 82,
      size: 14,
      font,
      color: rgb(0.3, 0.36, 0.42)
    });

    for (let line = 0; line < (options.linesPerPage || 18); line += 1) {
      page.drawText(`Validation line ${line + 1} - asset ${options.assetName || path.basename(targetPath)}`, {
        x: 48,
        y: pageHeight - 122 - (line * 28),
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

async function createPdfToWordHybridPdf(targetPath) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([600, 600]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText('NATIVE HEADER ACCOUNT 2026', { x: 48, y: 550, size: 18, font });

  const canvas = createCanvas(1500, 420);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#111111';
  context.font = 'bold 76px Arial';
  context.fillText('SCANNED CONTENT CONTRACT 2026', 38, 240);
  const image = await pdf.embedPng(canvas.toBuffer('image/png'));
  page.drawImage(image, { x: 35, y: 200, width: 530, height: 148 });
  fs.writeFileSync(targetPath, await pdf.save({ useObjectStreams: true }));
  return targetPath;
}

async function createScannedContentSplitPdf(targetPath) {
  const pdf = await PDFDocument.create();
  for (const [index, label] of ['SCANNED COVER PAGE', 'SCANNED PAGE TWO MARKER'].entries()) {
    const canvas = createCanvas(1500, 2000);
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#111111';
    context.font = 'bold 74px Arial';
    context.fillText(label, 100, 260);
    context.font = '42px Arial';
    context.fillText(`Scanned document page ${index + 1}`, 100, 350);
    const image = await pdf.embedPng(canvas.toBuffer('image/png'));
    const page = pdf.addPage([595, 842]);
    page.drawImage(image, { x: 0, y: 0, width: 595, height: 842 });
  }
  fs.writeFileSync(targetPath, await pdf.save({ useObjectStreams: true }));
  return targetPath;
}

async function createRecurringTitleSplitPdf(targetPath) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const pageSize = [595, 842];
  for (let index = 0; index < 2; index += 1) {
    const page = pdf.addPage(pageSize);
    page.drawText('ACME CORPORATION', { x: 48, y: 790, size: 18, font, color: rgb(0.05, 0.05, 0.05) });
    page.drawText('INVOICE BATCH 14', { x: 48, y: 730, size: 18, font, color: rgb(0.05, 0.05, 0.05) });
    page.drawText(`Native page ${index + 1}`, { x: 48, y: 675, size: 12, font, color: rgb(0.05, 0.05, 0.05) });
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
    context.fillText(`Scanned page ${index + 1}`, 100, 380);
    const image = await pdf.embedPng(canvas.toBuffer('image/png'));
    pdf.addPage(pageSize).drawImage(image, { x: 0, y: 0, width: pageSize[0], height: pageSize[1] });
  }
  fs.writeFileSync(targetPath, await pdf.save({ useObjectStreams: true }));
  return targetPath;
}

function createOrientationPng(targetPath, width, height, label) {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.fillStyle = '#f8fafc';
  context.fillRect(0, 0, width, height);
  context.fillStyle = '#dc2626';
  context.fillRect(0, 0, Math.round(width * 0.22), Math.round(height * 0.24));
  context.fillStyle = '#2563eb';
  context.fillRect(Math.round(width * 0.72), Math.round(height * 0.68), Math.round(width * 0.28), Math.round(height * 0.32));
  context.fillStyle = '#111827';
  context.font = `bold ${Math.max(24, Math.round(Math.min(width, height) * 0.1))}px sans-serif`;
  context.fillText(label, Math.round(width * 0.28), Math.round(height * 0.52));
  fs.writeFileSync(targetPath, canvas.toBuffer('image/png'));
}

function addExifOrientation(jpegBytes, orientation) {
  const tiff = Buffer.from([
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08,
    0x00, 0x01,
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01,
    (orientation >> 8) & 0xff, orientation & 0xff, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00
  ]);
  const exif = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiff]);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(exif.length + 2, 0);
  return Buffer.concat([jpegBytes.subarray(0, 2), Buffer.from([0xff, 0xe1]), length, exif, jpegBytes.subarray(2)]);
}

function createExifMirrorJpeg(targetPath, orientation) {
  const canvas = createCanvas(160, 100);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ef2020';
  context.fillRect(0, 0, 80, 50);
  context.fillStyle = '#14a44d';
  context.fillRect(80, 0, 80, 50);
  context.fillStyle = '#2255d8';
  context.fillRect(0, 50, 80, 50);
  context.fillStyle = '#f0c419';
  context.fillRect(80, 50, 80, 50);
  fs.writeFileSync(targetPath, addExifOrientation(canvas.toBuffer('image/jpeg', 92), orientation));
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
  // Marker-only fixture for conservative detection; it is not cryptographically signed.
  fs.writeFileSync(targetPath, '%PDF-1.7\n% simulated signature\n1 0 obj\n<< /Type /Sig >>\nendobj\n%%EOF');
  return targetPath;
}

function findPowerShellCore() {
  if (process.env.CENTRAL_PDF_TEST_PWSH && fs.existsSync(process.env.CENTRAL_PDF_TEST_PWSH)) return process.env.CENTRAL_PDF_TEST_PWSH;
  try {
    return execFileSync('where.exe', ['pwsh.exe'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
  } catch {
    return '';
  }
}

async function createCryptographicallySignedPdf(targetPath, powershellExecutable) {
  const cmsPlaceholderLength = 16384;
  const byteRangePlaceholder = '[0 0000000000 0000000000 0000000000]';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R /AcroForm 6 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R /Annots [5 0 R] >>',
    '<< /Length 0 >>\nstream\n\nendstream',
    '<< /Type /Annot /Subtype /Widget /FT /Sig /T (CentralPdfTestSignature) /V 7 0 R /F 4 /Rect [0 0 0 0] /P 3 0 R >>',
    '<< /SigFlags 3 /Fields [5 0 R] >>',
    `<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached /ByteRange ${byteRangePlaceholder} /Contents <${'0'.repeat(cmsPlaceholderLength)}> /M (D:20261102120000Z) >>`
  ];

  let pdf = '%PDF-1.7\n%CentralPdfAutomatedSignatureFixture\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    if (index === 6) pdf += `%${' '.repeat(300 * 1024)}\n`;
    offsets.push(Buffer.byteLength(pdf, 'ascii'));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'ascii');
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  const contentsMarker = '/Contents <';
  const contentStart = pdf.indexOf(contentsMarker) + '/Contents '.length;
  const contentEnd = contentStart + cmsPlaceholderLength + 2;
  if (contentStart < '/Contents '.length || contentEnd > pdf.length) throw new Error('Não foi possível montar o campo de assinatura PDF do fixture.');
  const byteRange = `[0 ${String(contentStart).padStart(10, '0')} ${String(contentEnd).padStart(10, '0')} ${String(pdf.length - contentEnd).padStart(10, '0')}]`;
  if (byteRange.length !== byteRangePlaceholder.length) throw new Error('O intervalo ByteRange do fixture excedeu o tamanho reservado.');
  pdf = pdf.replace(byteRangePlaceholder, byteRange);

  const pdfBytes = Buffer.from(pdf, 'ascii');
  const signedContent = Buffer.concat([pdfBytes.subarray(0, contentStart), pdfBytes.subarray(contentEnd)]);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'central-pdf-signature-fixture-'));
  const contentPath = path.join(tempRoot, 'byte-range.bin');
  const cmsPath = path.join(tempRoot, 'signature.der');
  const scriptPath = path.join(__dirname, 'sign-pdf-test-bytes.ps1');
  try {
    fs.writeFileSync(contentPath, signedContent);
    try {
      execFileSync(powershellExecutable, [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
        '-InputPath', contentPath, '-OutputPath', cmsPath
      ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      const diagnostic = Buffer.isBuffer(error.stderr) ? error.stderr.toString('utf8').trim() : String(error.stderr || '').trim();
      throw new Error(`Não foi possível gerar a assinatura CMS criptográfica do fixture.${diagnostic ? ` ${diagnostic}` : ''}`, { cause: error });
    }
    const cmsHex = fs.readFileSync(cmsPath).toString('hex');
    if (cmsHex.length > cmsPlaceholderLength) throw new Error('A assinatura CMS excedeu o espaço reservado no PDF de teste.');
    pdfBytes.write(cmsHex.padEnd(cmsPlaceholderLength, '0'), contentStart + 1, cmsPlaceholderLength, 'ascii');
    fs.writeFileSync(targetPath, pdfBytes);
    return targetPath;
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function createVirtualLargePdf(targetPath, sizeBytes) {
  fs.writeFileSync(targetPath, Buffer.alloc(0));
  if (process.platform === 'win32') {
    // SetEndOfFile followed by a write near EOF can allocate the entire gap on
    // NTFS unless the file is explicitly sparse. These fixtures are only for
    // validation, so keep their logical size without consuming gigabytes.
    execFileSync('fsutil.exe', ['sparse', 'setflag', targetPath], {
      stdio: 'ignore',
      windowsHide: true
    });
  }
  const fd = fs.openSync(targetPath, 'r+');
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
    signedValidPdf: path.join(GENERATED_ASSETS_DIR, 'signed-cryptographic-late.pdf'),
    pdfToWordHybridPdf: path.join(GENERATED_ASSETS_DIR, 'pdf-to-word-hybrid.pdf'),
    scannedContentSplitPdf: path.join(GENERATED_ASSETS_DIR, 'scanned-content-split.pdf'),
    recurringTitleSplitPdf: path.join(GENERATED_ASSETS_DIR, 'recurring-title-split.pdf'),
    watermarkPng: path.join(GENERATED_ASSETS_DIR, 'watermark.png'),
    watermarkJpg: path.join(GENERATED_ASSETS_DIR, 'watermark.jpg'),
    watermarkSvg: path.join(GENERATED_ASSETS_DIR, 'watermark.svg'),
    landscapePng: path.join(GENERATED_ASSETS_DIR, 'landscape.png'),
    portraitPng: path.join(GENERATED_ASSETS_DIR, 'portrait.png'),
    landscapePdf: path.join(GENERATED_ASSETS_DIR, 'landscape.pdf'),
    rotatedPdf: path.join(GENERATED_ASSETS_DIR, 'rotated-90.pdf'),
    exifMirror2Jpg: path.join(GENERATED_ASSETS_DIR, 'exif-mirror-2.jpg'),
    exifMirror4Jpg: path.join(GENERATED_ASSETS_DIR, 'exif-mirror-4.jpg'),
    exifMirror5Jpg: path.join(GENERATED_ASSETS_DIR, 'exif-mirror-5.jpg'),
    exifMirror7Jpg: path.join(GENERATED_ASSETS_DIR, 'exif-mirror-7.jpg'),
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
      const expectedSignatureFixtureType = process.platform === 'win32' && findPowerShellCore()
        ? 'cms-detached-self-signed-v1'
        : 'marker-only-fallback';
      let allExist = existingManifest.signedFixtureType === expectedSignatureFixtureType;
      for (const k of Object.keys(files)) {
        if (!fs.existsSync(files[k])) {
          allExist = false;
          break;
        }
      }
      if (allExist && process.platform === 'win32') {
        for (const key of ['largeVirtualPdf', 'hugeVirtualPdf', 'nearLimitVirtualPdf', 'oversizeVirtualPdf']) {
          try {
            const status = execFileSync('fsutil.exe', ['sparse', 'queryflag', files[key]], {
              encoding: 'utf8',
              windowsHide: true
            });
            if (!/is set as sparse/i.test(status)) {
              allExist = false;
              break;
            }
          } catch {
            allExist = false;
            break;
          }
        }
      }
      if (allExist && existingManifest.signedFixtureSha256 !== crypto.createHash('sha256').update(fs.readFileSync(files.signedValidPdf)).digest('hex')) {
        allExist = false;
      }
      if (allExist) {
        return existingManifest;
      }
    } catch {}
  }

  await createPdf(files.smallPdf, { assetName: 'small', pageCount: 2, linesPerPage: 8, title: 'Small Test PDF' });
  await createPdf(files.mediumPdf, { assetName: 'medium', pageCount: 8, linesPerPage: 18, title: 'Medium Test PDF' });
  await createPdf(files.manyPagesPdf, { assetName: 'many-pages', pageCount: 120, linesPerPage: 6, title: 'Many Pages Test PDF' });
  await createPdf(files.imageHeavyPdf, { assetName: 'image-heavy', pageCount: 12, linesPerPage: 8, imageEveryPage: true, title: 'Image Heavy Test PDF' });
  await createPdf(files.landscapePdf, { assetName: 'landscape', pageCount: 1, linesPerPage: 8, title: 'Landscape Test PDF', pageSize: [842, 595] });
  await createPdf(files.rotatedPdf, { assetName: 'rotated-90', pageCount: 1, linesPerPage: 8, title: 'Rotated Test PDF', rotation: 90 });
  await createPdfToWordHybridPdf(files.pdfToWordHybridPdf);
  await createScannedContentSplitPdf(files.scannedContentSplitPdf);
  await createRecurringTitleSplitPdf(files.recurringTitleSplitPdf);

  createCorruptPdf(files.smallPdf, files.corruptPdf);
  createFakePdf(files.fakePdf);
  createSignedIndicatorPdf(files.smallPdf, files.signedIndicatorPdf);
  const powershellCore = process.platform === 'win32' ? findPowerShellCore() : '';
  const signedFixtureType = powershellCore ? 'cms-detached-self-signed-v1' : 'marker-only-fallback';
  if (powershellCore) {
    await createCryptographicallySignedPdf(files.signedValidPdf, powershellCore);
  } else {
    // Portable fallback: conservative marker detection only, not a cryptographic signature test.
    const smallPdfBytes = fs.readFileSync(files.smallPdf);
    const eofMarker = smallPdfBytes.lastIndexOf(Buffer.from('%%EOF'));
    if (eofMarker < 0) throw new Error('Fixture PDF não possui marcador EOF.');
    fs.writeFileSync(files.signedValidPdf, Buffer.concat([
      smallPdfBytes.subarray(0, eofMarker),
      Buffer.from('\n%'),
      Buffer.alloc(300 * 1024, 0x20),
      Buffer.from('\n% /Type /Sig /ByteRange [0 1 2 3]\n%%EOF')
    ]));
  }
  fs.writeFileSync(files.watermarkPng, tinyPngBuffer());
  fs.writeFileSync(files.watermarkJpg, tinyJpgBuffer());
  fs.writeFileSync(files.watermarkSvg, sampleSvgText('CONFIDENTIAL'), 'utf8');
  createOrientationPng(files.landscapePng, 960, 540, 'LANDSCAPE');
  createOrientationPng(files.portraitPng, 540, 960, 'PORTRAIT');
  [2, 4, 5, 7].forEach((orientation) => createExifMirrorJpeg(files[`exifMirror${orientation}Jpg`], orientation));
  fs.writeFileSync(files.protectedPlaceholderPdf, '%PDF-1.7\n1 0 obj\n<< /Encrypt true >>\nendobj\n%%EOF');

  createVirtualLargePdf(files.largeVirtualPdf, 350 * 1024 * 1024);
  createVirtualLargePdf(files.hugeVirtualPdf, Math.floor(1.2 * 1024 * 1024 * 1024));
  createVirtualLargePdf(files.nearLimitVirtualPdf, PDF_LIMITS.maxSupportedBytes - (256 * 1024));
  createVirtualLargePdf(files.oversizeVirtualPdf, PDF_LIMITS.maxSupportedBytes + (256 * 1024));

  const manifest = {
    generatedAt: new Date().toISOString(),
    signedFixtureType,
    signedFixtureSha256: crypto.createHash('sha256').update(fs.readFileSync(files.signedValidPdf)).digest('hex'),
    notes: [
      'Large virtual PDFs are sparse files used for limit and warning validation.',
      'protected-placeholder.pdf simulates a protected indicator but is not full encryption.',
      'When PowerShell 7 is available, signed-cryptographic-late.pdf uses an ephemeral self-signed certificate and a verified detached CMS signature; it does not test public certificate trust. Without PowerShell 7, only marker detection is tested.',
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
