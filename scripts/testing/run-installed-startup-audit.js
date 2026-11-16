const fs = require('fs');
const path = require('path');
const asar = require('@electron/asar');
const { writeReport, toMarkdownTable } = require('./_common');

const ROOT = path.resolve(__dirname, '..', '..');
const installedRoot = process.env.CENTRAL_PDF_INSTALL_ROOT || 'C:\\Program Files\\Central PDF';
const installedExe = path.join(installedRoot, 'Central PDF.exe');
const installedAsar = path.join(installedRoot, 'resources', 'app.asar');

function check(name, ok, details, skipped = false) { return { name, ok: Boolean(ok), details, skipped }; }

function matchesExpectedVersion(actualVersion, expectedVersion) {
  return typeof actualVersion === 'string' && typeof expectedVersion === 'string' && actualVersion === expectedVersion;
}

function readAsarTree(asarPath) {
  const bytes = fs.readFileSync(asarPath);
  const jsonSize = bytes.readUInt32LE(12);
  return JSON.parse(bytes.subarray(16, 16 + jsonSize).toString('utf8'));
}

function readNullTerminatedString(buffer, offset, unicode) {
  const step = unicode ? 2 : 1;
  let end = offset;
  while (end + step <= buffer.length && (unicode ? buffer.readUInt16LE(end) !== 0 : buffer[end] !== 0)) end += step;
  if (end + step > buffer.length) return '';
  return buffer.subarray(offset, end).toString(unicode ? 'utf16le' : 'ascii');
}

function parseShortcutBuffer(buffer) {
  try {
    if (buffer.length < 76 || buffer.readUInt32LE(0) !== 0x4c) return null;
    const flags = buffer.readUInt32LE(20);
    let offset = 76;
    if (flags & 0x1) {
      if (offset + 2 > buffer.length) return null;
      offset += 2 + buffer.readUInt16LE(offset);
    }
    if (flags & 0x2) {
      if (offset + 0x1c > buffer.length) return null;
      const infoSize = buffer.readUInt32LE(offset);
      const headerSize = buffer.readUInt32LE(offset + 4);
      if (infoSize < headerSize || offset + infoSize > buffer.length || headerSize < 0x1c) return null;
      const baseOffset = headerSize >= 0x24 ? buffer.readUInt32LE(offset + 28) : 0;
      const suffixOffset = headerSize >= 0x24 ? buffer.readUInt32LE(offset + 32) : 0;
      const baseOffsetAnsi = buffer.readUInt32LE(offset + 16);
      const suffixOffsetAnsi = buffer.readUInt32LE(offset + 24);
      const unicode = Boolean(baseOffset && suffixOffset);
      const base = readNullTerminatedString(buffer, offset + (unicode ? baseOffset : baseOffsetAnsi), unicode);
      const suffix = readNullTerminatedString(buffer, offset + (unicode ? suffixOffset : suffixOffsetAnsi), unicode);
      if (!base) return null;
      return { target: path.win32.normalize(path.win32.join(base, suffix)), arguments: '' };
    }
    return null;
  } catch { return null; }
}

function readShortcutTarget(shortcutPath) {
  try { return parseShortcutBuffer(fs.readFileSync(shortcutPath)); } catch { return null; }
}

function runInstalledStartupAudit() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const expectedVersion = process.env.CENTRAL_PDF_EXPECTED_VERSION || packageJson.version;
  const builder = JSON.parse(fs.readFileSync(path.join(ROOT, 'electron-builder.json'), 'utf8'));
  const mainJs = fs.readFileSync(path.join(ROOT, 'src/main/index.js'), 'utf8');
  const checks = [];
  const shortcutPaths = [
    path.join('C:', 'Users', 'Public', 'Desktop', 'Central PDF.lnk'),
    path.join('C:', 'ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Central PDF.lnk')
  ];
  checks.push(check('Configuração do main', packageJson.main === 'src/main/index.js', `main=${packageJson.main || '(ausente)'}`));
  checks.push(check('Configuração do MSI', builder.win?.target?.some((item) => item.target === 'msi'), 'target MSI presente'));
  checks.push(check('Segurança do renderer', /contextIsolation:\s*true/.test(mainJs) && /nodeIntegration:\s*false/.test(mainJs) && /sandbox:\s*true/.test(mainJs), 'contextIsolation, nodeIntegration desativado e sandbox ativos'));
  const packagedOcrDir = path.join(installedRoot, 'resources', 'ocr', 'tessdata');
  const ocrModelsPresent = ['por.traineddata', 'eng.traineddata'].every((name) => {
    const modelPath = path.join(packagedOcrDir, name);
    return fs.existsSync(modelPath) && fs.statSync(modelPath).size >= 100_000;
  });
  checks.push(check('Modelos OCR instalados', ocrModelsPresent, `${packagedOcrDir}: português e inglês`));
  checks.push(check('Executável instalado', fs.existsSync(installedExe), installedExe));
  checks.push(check('Pacote app.asar instalado', fs.existsSync(installedAsar), installedAsar));
  if (fs.existsSync(installedAsar)) {
    try {
      const tree = readAsarTree(installedAsar);
      const files = tree.files || {};
      const hasMain = Boolean(files.src?.files?.main?.files?.['index.js']);
      const hasPreload = Boolean(files.src?.files?.preload?.files?.['index.js']);
      const hasIndex = Boolean(files.dist?.files?.['index.html']);
      checks.push(check('main dentro do app.asar', hasMain, 'src/main/index.js encontrado'));
      checks.push(check('preload dentro do app.asar', hasPreload, 'src/preload/index.js encontrado'));
      checks.push(check('interface dentro do app.asar', hasIndex, 'dist/index.html encontrado'));
      if (hasIndex) {
        const html = asar.extractFile(installedAsar, 'dist/index.html').toString('utf8');
        const entries = new Set(asar.listPackage(installedAsar).map((entry) => String(entry).replace(/^[/\\]+/, '').replace(/\\/g, '/').toLowerCase()));
        const localReferences = [...html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)]
          .map((match) => match[1].trim())
          .filter((reference) => reference && !/^(?:[a-z]+:|\/\/|#|data:)/i.test(reference));
        const missingAssets = localReferences
          .map((reference) => `dist/${reference.replace(/^\.\//, '').replace(/^\//, '')}`.toLowerCase())
          .filter((reference) => !entries.has(reference));
        checks.push(check('Recursos da interface dentro do app.asar', missingAssets.length === 0, missingAssets.length ? `ausentes: ${missingAssets.join(', ')}` : `${localReferences.length} referências locais conferidas`));
      }
      checks.push(check('package main empacotado', Boolean(files['package.json']), 'package.json encontrado'));
      if (files['package.json']) {
        const installedPackage = JSON.parse(asar.extractFile(installedAsar, 'package.json').toString('utf8'));
        checks.push(check(
          'Versão do pacote instalado',
          matchesExpectedVersion(installedPackage.version, expectedVersion),
          `instalado=${installedPackage.version || '(ausente)'}; esperado=${expectedVersion}`
        ));
      }
    } catch (error) { checks.push(check('Leitura do app.asar', false, error.message || String(error))); }
  }
  const defaultInstallRoot = path.win32.normalize('C:\\Program Files\\Central PDF').toLowerCase();
  const inspectInstalledShortcuts = process.env.CENTRAL_PDF_VERIFY_SHORTCUTS === '1'
    || path.win32.normalize(installedRoot).toLowerCase() === defaultInstallRoot;
  if (inspectInstalledShortcuts) {
    for (const shortcutPath of shortcutPaths) {
      if (!fs.existsSync(shortcutPath)) continue;
      const shortcut = readShortcutTarget(shortcutPath);
      const valid = shortcut && path.win32.normalize(shortcut.target).toLowerCase() === path.win32.normalize(installedExe).toLowerCase() && !/electron\.exe$/i.test(shortcut.target);
      checks.push(check(`Atalho correto: ${path.basename(path.dirname(shortcutPath))}`, valid, shortcut ? `${shortcut.target}${shortcut.arguments ? ` ${shortcut.arguments}` : ''}` : 'não foi possível ler'));
    }
  } else {
    checks.push(check('Atalhos instalados', false, 'não se aplicam à extração administrativa; o MSI não foi instalado nesta pasta', true));
  }
  const reportPath = writeReport('installed-startup-audit.md', [
    '# Installed Startup Audit', '', `Gerado em ${new Date().toISOString()}.`, '',
    ...toMarkdownTable(['Verificação', 'Status', 'Detalhes'], checks.map((item) => [item.name, item.skipped ? 'não aplicável' : item.ok ? 'ok' : 'falha', item.details]))
  ]);
  return { ok: checks.every((item) => item.ok || item.skipped), reportPath, checks };
}

if (require.main === module) {
  const result = runInstalledStartupAudit();
  console.log(`Installed startup audit completed: ${result.checks.length} checks`);
  process.exit(result.ok ? 0 : 1);
}

module.exports = { runInstalledStartupAudit, readShortcutTarget, parseShortcutBuffer, matchesExpectedVersion };
