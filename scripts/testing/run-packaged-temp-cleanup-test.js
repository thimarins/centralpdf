const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ROOT } = require('./_common');

function run() {
  const appExecutable = process.env.CENTRAL_PDF_PACKAGED_APP
    || path.join(ROOT, 'releases', 'latest', 'Central-PDF-win-x64-unpacked', 'Central PDF.exe');
  assert.ok(fs.existsSync(appExecutable), 'Executável empacotado não encontrado. Defina CENTRAL_PDF_PACKAGED_APP.');

  const originalTemp = os.tmpdir();
  const isolatedTemp = fs.mkdtempSync(path.join(originalTemp, 'central-pdf-startup-cleanup-e2e-'));
  const managedDirectory = path.join(isolatedTemp, 'central-pdf-temp');
  fs.mkdirSync(managedDirectory);
  const staleTemp = path.join(managedDirectory, 'temp-redact-image-stale-1234.png');
  const freshTemp = path.join(managedDirectory, 'temp-redact-image-fresh-5678.png');
  const unrelatedFile = path.join(managedDirectory, 'user-note.txt');
  fs.writeFileSync(staleTemp, 'synthetic stale temp file');
  fs.writeFileSync(freshTemp, 'synthetic current temp file');
  fs.writeFileSync(unrelatedFile, 'must not be removed');
  const now = Date.now();
  const staleDate = new Date(now - 48 * 60 * 60 * 1000);
  fs.utimesSync(staleTemp, staleDate, staleDate);

  try {
    const smoke = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'testing', 'run-packaged-startup-smoke.js')], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      timeout: 120_000,
      windowsHide: true,
      env: {
        ...process.env,
        TEMP: isolatedTemp,
        TMP: isolatedTemp,
        CENTRAL_PDF_PACKAGED_APP: appExecutable
      }
    });
    assert.equal(smoke.status, 0, `O smoke empacotado falhou: ${smoke.stdout || ''}\n${smoke.stderr || ''}`);
    const startupResult = JSON.parse(smoke.stdout);
    assert.equal(startupResult.ok, true, 'O renderer do executável empacotado não concluiu o bootstrap.');
    assert.equal(fs.existsSync(staleTemp), false, 'O app empacotado não removeu o temporário órfão antigo ao iniciar.');
    assert.equal(fs.readFileSync(freshTemp, 'utf8'), 'synthetic current temp file', 'O temporário recente foi removido indevidamente.');
    assert.equal(fs.readFileSync(unrelatedFile, 'utf8'), 'must not be removed', 'Um arquivo não temporário foi alterado.');
    console.log(`Packaged startup temp cleanup passed: stale temp removed; fresh and unrelated files preserved (${startupResult.durationMs} ms).`);
  } finally {
    const root = path.resolve(isolatedTemp);
    const tempRoot = path.resolve(originalTemp);
    const relative = path.relative(tempRoot, root);
    if (relative && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
}

try {
  run();
} catch (error) {
  console.error(error.stack || String(error));
  process.exitCode = 1;
}
