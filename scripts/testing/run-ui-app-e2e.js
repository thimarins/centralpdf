const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const { spawn } = require('child_process');
const electronPath = require('electron');

const { writeReport } = require('./_common');
const { generateTestAssets } = require('./generate-test-assets');

const ROOT = path.resolve(__dirname, '..', '..');
const VITE_PORT = Number(process.env.CENTRAL_PDF_E2E_PORT || (5200 + (process.pid % 500)));
const VITE_HOST = '127.0.0.1';
const VITE_URL = `http://${VITE_HOST}:${VITE_PORT}`;
const timeoutMs = 300000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForHttp(url, timeout = 45000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const request = http.get(url, (response) => {
        response.resume();
        if (response.statusCode && response.statusCode < 500) {
          resolve();
          return;
        }
        retry();
      });
      request.on('error', retry);
    };

    const retry = () => {
      if (Date.now() - startedAt > timeout) {
        reject(new Error(`Timeout aguardando servidor Vite em ${url}`));
        return;
      }
      setTimeout(attempt, 350);
    };

    attempt();
  });
}

async function waitForReport(reportPath, child) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(reportPath)) {
      return JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    }
    if (child.exitCode !== null) {
      break;
    }
    await sleep(300);
  }
  throw new Error('Timeout aguardando relatório do teste E2E do app.');
}

async function main() {
  const manifest = await generateTestAssets();
  const reportPath = path.join(os.tmpdir(), `central-pdf-ui-app-e2e-${process.pid}.json`);
  const e2eUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'central-pdf-ui-app-e2e-data-'));
  const startupTracePath = path.join(os.tmpdir(), `central-pdf-ui-app-e2e-startup-${process.pid}.jsonl`);
  try {
    fs.rmSync(reportPath, { force: true });
    fs.rmSync(startupTracePath, { force: true });
  } catch (_) {}

  const vite = spawn(process.execPath, [
    path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
    '--host',
    VITE_HOST,
    '--port',
    String(VITE_PORT)
  ], {
    cwd: ROOT,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env
    }
  });

  let electronApp = null;
  try {
    await waitForHttp(VITE_URL);

    electronApp = spawn(electronPath, ['--disable-gpu', '--no-sandbox', '--user-data-dir', e2eUserDataDir, '.'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        CENTRAL_PDF_E2E_REPORT_FILE: reportPath,
        CENTRAL_PDF_E2E_ASSETS_MANIFEST: path.join(ROOT, 'test-assets', 'manifest.json'),
        CENTRAL_PDF_E2E: '1',
        CENTRAL_PDF_DEV_SERVER_URL: VITE_URL,
        CENTRAL_PDF_STARTUP_TRACE_FILE: startupTracePath
      }
    });
    electronApp.stdout?.on('data', (chunk) => process.stdout.write(`[electron] ${chunk}`));
    electronApp.stderr?.on('data', (chunk) => process.stderr.write(`[electron] ${chunk}`));

    const result = await waitForReport(reportPath, electronApp);
    const reportLines = [
      '# UI App E2E Report',
      '',
      `Gerado em ${new Date().toISOString()}.`,
      '',
      `Status geral: ${result.ok ? 'ok' : 'erro'}`,
      '',
      '| Etapa | Status | Duração (ms) | Detalhe |',
      '| --- | --- | --- | --- |',
      ...(Array.isArray(result.results)
        ? result.results.map((item) => `| ${String(item.name || '').replace(/\|/g, '\\|')} | ${item.ok ? 'ok' : 'erro'} | ${item.durationMs ?? '-'} | ${String(item.detail || '').replace(/\|/g, '\\|')} |`)
        : [`| execução | erro | - | ${String(result.error || 'Sem detalhes').replace(/\|/g, '\\|')} |`])
    ];
    const markdownReport = writeReport('ui-app-e2e-report.md', reportLines);

    console.log(JSON.stringify({
      ok: Boolean(result.ok),
      reportPath: markdownReport,
      details: result
    }, null, 2));

    process.exit(result.ok ? 0 : 1);
  } finally {
    if (electronApp && electronApp.exitCode === null) {
      electronApp.kill();
    }
    if (vite && vite.exitCode === null) {
      vite.kill();
    }
    try {
      fs.rmSync(e2eUserDataDir, { recursive: true, force: true });
    } catch (_) {}
  }
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
