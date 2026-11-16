const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('node:assert/strict');
const { ROOT } = require('./_common');

const packageInfo = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const builderInfo = JSON.parse(fs.readFileSync(path.join(ROOT, 'electron-builder.json'), 'utf8'));
const corePackage = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'tesseract.js-core', 'package.json'), 'utf8'));
const enginePackage = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'tesseract.js', 'package.json'), 'utf8'));
const licenseResources = [
  { from: 'node_modules/tesseract.js/LICENSE.md', to: 'ocr/licenses/tesseract.js-LICENSE.md' },
  { from: 'node_modules/tesseract.js-core/LICENSE', to: 'ocr/licenses/tesseract.js-core-LICENSE' },
  { from: 'node_modules/tesseract.js-core/LICENSE', to: 'ocr/licenses/Apache-2.0.txt' }
];
const wasmThirdPartyLicenseFiles = [
  'giflib-COPYING.txt', 'leptonica-license.txt', 'libjpeg-README.txt', 'libpng-LICENSE.txt',
  'libtiff-COPYRIGHT.txt', 'libwebp-COPYING.txt', 'openlibm-LICENSE.md',
  'tesseract-LICENSE.txt', 'zlib-README.txt', 'THIRD-PARTY-NOTICES.txt'
];

assert.match(packageInfo.dependencies?.['tesseract.js'] || '', /^\^?7\./, 'Tesseract.js deve continuar declarado como dependência do app.');
assert.equal(enginePackage.version, '7.0.0');
assert.equal(corePackage.version, '7.0.0');
assert.equal(enginePackage.license, 'Apache-2.0');
assert.equal(corePackage.license, 'Apache-2.0');
for (const item of licenseResources) {
  const sourcePath = path.join(ROOT, item.from);
  assert.ok(fs.existsSync(sourcePath) && fs.statSync(sourcePath).size > 1000, `Licença de origem ausente/incompleta: ${item.from}`);
  assert.ok(builderInfo.extraResources.some((resource) => resource.from === item.from && resource.to === item.to), `Licença não configurada para distribuição: ${item.to}`);
}

const ocrReadme = fs.readFileSync(path.join(ROOT, 'vendor', 'ocr', 'README.txt'), 'utf8');
assert.match(ocrReadme, /tessdata_fast/i);
assert.match(ocrReadme, /Apache-2\.0/);
assert.match(ocrReadme, /avisos dos componentes incorporados/i);
assert.ok(builderInfo.extraResources.some((resource) => resource.from === 'vendor/ocr' && resource.to === 'ocr'));
const wasmLicenseDir = path.join(ROOT, 'vendor', 'ocr', 'licenses', 'wasm-third-party');
for (const fileName of wasmThirdPartyLicenseFiles) {
  const sourcePath = path.join(wasmLicenseDir, fileName);
  assert.ok(fs.existsSync(sourcePath) && fs.statSync(sourcePath).size > 100, `Aviso de licença WASM ausente: ${fileName}`);
}
const wasmNotices = fs.readFileSync(path.join(wasmLicenseDir, 'THIRD-PARTY-NOTICES.txt'), 'utf8');
assert.match(wasmNotices, /acffef2b66eb44a31df297e11d905f4b39001068/);
assert.match(wasmNotices, /Independent JPEG Group/);

const packagedRoot = process.env.CENTRAL_PDF_OCR_PACKAGE_DIR;
if (packagedRoot) {
  for (const artifact of ['Central PDF.exe', path.join('resources', 'app.asar'), path.join('resources', 'qpdf', 'bin', 'qpdf.exe')]) {
    assert.ok(fs.existsSync(path.join(packagedRoot, artifact)), `Componente obrigatório ausente no pacote: ${artifact}`);
  }
  for (const modelName of ['por.traineddata', 'eng.traineddata']) {
    const sourceModel = path.join(ROOT, 'vendor', 'ocr', 'tessdata', modelName);
    const packagedModel = path.join(packagedRoot, 'resources', 'ocr', 'tessdata', modelName);
    assert.ok(fs.existsSync(packagedModel), `Modelo OCR ausente no pacote: ${modelName}`);
    const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(sourceModel)).digest('hex');
    const packagedHash = crypto.createHash('sha256').update(fs.readFileSync(packagedModel)).digest('hex');
    assert.equal(packagedHash, sourceHash, `Modelo OCR foi alterado durante o empacotamento: ${modelName}`);
  }
  const packagedLicenseDir = path.join(packagedRoot, 'resources', 'ocr', 'licenses');
  for (const item of licenseResources) {
    const packagedPath = path.join(packagedLicenseDir, path.basename(item.to));
    assert.ok(fs.existsSync(packagedPath), `Licença ausente no pacote: ${packagedPath}`);
    assert.deepEqual(fs.readFileSync(packagedPath), fs.readFileSync(path.join(ROOT, item.from)), `Licença divergente no pacote: ${item.to}`);
  }
  const packagedWasmLicenseDir = path.join(packagedRoot, 'resources', 'ocr', 'licenses', 'wasm-third-party');
  for (const fileName of wasmThirdPartyLicenseFiles) {
    const packagedPath = path.join(packagedWasmLicenseDir, fileName);
    assert.ok(fs.existsSync(packagedPath), `Aviso WASM ausente no pacote: ${fileName}`);
    assert.deepEqual(fs.readFileSync(packagedPath), fs.readFileSync(path.join(wasmLicenseDir, fileName)), `Aviso WASM divergente no pacote: ${fileName}`);
  }
}

console.log(`OCR license checks passed: ${licenseResources.length} top-level mappings and ${wasmThirdPartyLicenseFiles.length - 1} WASM third-party notices; package verification ${packagedRoot ? 'enabled' : 'available via CENTRAL_PDF_OCR_PACKAGE_DIR'}.`);
