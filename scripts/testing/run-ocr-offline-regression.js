const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

async function runOfflineOcr() {
  const packagedAppRoot = String(process.env.CENTRAL_PDF_OCR_PACKAGE_DIR || '').trim();
  let packagedResourcesPath = '';
  if (packagedAppRoot) {
    packagedResourcesPath = path.join(packagedAppRoot, 'resources');
    assert.ok(fs.existsSync(path.join(packagedResourcesPath, 'app.asar')), 'O pacote informado não contém resources/app.asar.');
    // Match Electron's runtime lookup before requiring ocr-service, which resolves
    // the language-data path once at module initialization.
    Object.defineProperty(process, 'resourcesPath', { configurable: true, value: packagedResourcesPath });
  }

  const { createCanvas } = require('@napi-rs/canvas');
  const { PDFDocument } = require('pdf-lib');
  const { extractStructuredText } = require('../../src/main/services/conversion/text-extractor');
  const { getOcrRuntimeStatus } = require('../../src/main/services/ocr/ocr-runtime');
  const { recognizeImage, writeOcrOutput } = require('../../src/main/services/ocr/ocr-service');

  if (packagedResourcesPath) {
    assert.deepEqual(getOcrRuntimeStatus(['eng']), {
      available: true,
      availableLanguages: ['eng'],
      missingLanguages: [],
      invalidLanguages: [],
      message: ''
    }, 'O modelo de inglês extraído do MSI deve passar a validação de integridade.');
  }

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'central-pdf-ocr-offline-'));
  try {
    const inputPath = path.join(workspace, 'offline-fixture.png');
    const outputDir = path.join(workspace, 'output');
    const canvas = createCanvas(1500, 360);
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#111';
    context.font = '72px Arial';
    context.fillText('OFFLINE OCR 4827', 50, 210);
    fs.writeFileSync(inputPath, canvas.toBuffer('image/png'));

    const result = await recognizeImage(inputPath, { language: 'eng', mode: 'auto', format: 'pdf' });
    assert.equal(result.recognizedPages, 1, 'O OCR local deveria reconhecer a página mesmo sem rede.');
    assert.ok(result.pdfBytes?.length > 0, 'O OCR deveria retornar os bytes do PDF pesquisável.');
    const validatedPdf = await PDFDocument.load(result.pdfBytes);
    assert.equal(validatedPdf.getPageCount(), 1, 'A saída OCR local precisa ser um PDF íntegro.');

    const outputPath = await writeOcrOutput(result, inputPath, outputDir, { format: 'pdf' });
    const searchableText = await extractStructuredText(outputPath);
    assert.match(searchableText.pages[0].text, /OFFLINE OCR 4827/i, 'A saída local deve continuar pesquisável.');

    return {
      ok: true,
      recognizedPages: result.recognizedPages,
      outputPages: validatedPdf.getPageCount(),
      searchable: true,
      packagedModels: Boolean(packagedResourcesPath)
    };
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

function runInNetworkBlockedChild() {
  const preloadPath = path.join(__dirname, 'deny-network-preload.js');
  const markerDirectory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'central-pdf-network-block-'));
  const markerPath = path.join(markerDirectory, 'loaded-threads.txt');
  try {
    const child = spawnSync(process.execPath, ['--require', preloadPath, __filename, '--execute'], {
      cwd: path.resolve(__dirname, '..', '..'),
      env: { ...process.env, CENTRAL_PDF_NETWORK_BLOCK_MARKER: markerPath },
      encoding: 'utf8',
      timeout: 120_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024
    });
    if (child.error) throw child.error;
    if (child.status !== 0) {
      throw new Error(`OCR offline regression failed (${child.status ?? child.signal}): ${child.stderr || child.stdout}`);
    }
    const loadedThreadIds = fs.readFileSync(markerPath, 'utf8').trim().split(/\r?\n/).map(Number);
    assert.ok(loadedThreadIds.some((threadId) => threadId > 0), 'O bloqueio de rede não foi carregado em um worker thread do Tesseract.');
    const result = JSON.parse(child.stdout.trim().split(/\r?\n/).at(-1));
    return { ...result, networkBlockedInWorker: true };
  } finally {
    fs.rmSync(markerDirectory, { recursive: true, force: true });
  }
}

if (require.main === module) {
  if (process.argv.includes('--execute')) {
    runOfflineOcr().then((result) => console.log(JSON.stringify(result))).catch((error) => {
      console.error(error.stack || String(error));
      process.exitCode = 1;
    });
  } else {
    try {
      const result = runInNetworkBlockedChild();
      console.log(`OCR offline regression passed with HTTP(S), sockets, and fetch blocked: ${JSON.stringify(result)}`);
    } catch (error) {
      console.error(error.stack || String(error));
      process.exitCode = 1;
    }
  }
}

module.exports = { runOfflineOcr, runInNetworkBlockedChild };
