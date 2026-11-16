const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const { spawn } = require('child_process');
const electronPath = require('electron');

// Keep generated fixtures and their manifest private to this E2E invocation.
// Other test processes may generate a different signature fixture concurrently.
const e2eTestAssetsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'central-pdf-ui-e2e-assets-'));
process.env.CENTRAL_PDF_TEST_ASSETS_DIR = path.join(e2eTestAssetsRoot, 'test-assets');
const { TEST_ASSETS_DIR, writeReport } = require('./_common');
const { generateTestAssets } = require('./generate-test-assets');

const ROOT = path.resolve(__dirname, '..', '..');
const packagedAppPath = String(process.env.CENTRAL_PDF_E2E_PACKAGED_APP || '').trim();
const keepUserDataOnFailure = process.env.CENTRAL_PDF_E2E_KEEP_USER_DATA === '1';
const VITE_PORT = Number(process.env.CENTRAL_PDF_E2E_PORT || (5200 + (process.pid % 500)));
const VITE_HOST = '127.0.0.1';
const VITE_URL = `http://${VITE_HOST}:${VITE_PORT}`;
// Packaged OCR can take several minutes on slower corporate laptops; keep the
// full-suite watchdog above the worst-case OCR and page-analysis combination.
const maximumTimeoutMs = 30 * 60 * 1000;
const requestedTimeoutMs = Number(process.env.CENTRAL_PDF_E2E_TIMEOUT_MS);
const timeoutMs = Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0
  ? Math.min(maximumTimeoutMs, Math.max(10000, requestedTimeoutMs))
  : maximumTimeoutMs;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function killProcessTree(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || !child.pid) {
      resolve();
      return;
    }
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    const timeout = setTimeout(() => {
      killer.kill();
      resolve();
    }, 5000);
    killer.once('close', () => {
      clearTimeout(timeout);
      resolve();
    });
    killer.once('error', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
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

function readLastE2EStep(startupTracePath) {
  try {
    const lines = fs.readFileSync(startupTracePath, 'utf8').trim().split(/\r?\n/).slice(-100);
    const events = lines.map((line) => JSON.parse(line)).filter((entry) => entry.phase === 'e2e-step-start' || entry.phase === 'e2e-step-finish');
    const lastStart = [...events].reverse().find((entry) => entry.phase === 'e2e-step-start');
    const lastFinish = [...events].reverse().find((entry) => entry.phase === 'e2e-step-finish');
    const lastFailure = [...events].reverse().find((entry) => entry.phase === 'e2e-step-finish' && !entry.ok);
    if (!lastStart) return '';
    const failureSummary = lastFailure ? ` Última falha: ${lastFailure.step}${lastFailure.detail ? ` — ${lastFailure.detail}` : ''}.` : '';
    if (lastFinish?.step === lastStart.step) return `Última etapa E2E: ${lastFinish.step} (${lastFinish.ok ? 'concluída' : 'falhou'}).${failureSummary}`;
    return `Última etapa E2E iniciada: ${lastStart.step}.${failureSummary}`;
  } catch {
    return '';
  }
}

async function waitForReport(reportPath, child, startupTracePath) {
  const startedAt = Date.now();
  let exitInfo = null;
  child.once('exit', (code, signal) => {
    exitInfo = { code, signal };
  });
  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(reportPath)) {
      return JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    }
    if (child.exitCode !== null) {
      break;
    }
    await sleep(300);
  }
  const lastStep = readLastE2EStep(startupTracePath);
  throw new Error(`Timeout aguardando relatório do teste E2E do app.${exitInfo ? ` Processo encerrou (code=${exitInfo.code}, signal=${exitInfo.signal || 'none'}).` : ''}${lastStep ? ` ${lastStep}` : ''}`);
}

function waitForChildExit(child, timeoutMs = 5000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child?.exitCode ?? null, signal: child?.signalCode ?? null });
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(null);
    }, timeoutMs);
    const onExit = (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    };
    // `close` waits for every stdio stream to close; a descendant can inherit
    // those handles after Electron itself has already exited successfully.
    child.once('exit', onExit);
  });
}

async function main() {
  if (packagedAppPath && (!packagedAppPath.toLowerCase().endsWith('.exe') || !fs.existsSync(packagedAppPath) || !fs.statSync(packagedAppPath).isFile())) {
    throw new Error(`O executável empacotado informado não existe ou não é um .exe: ${packagedAppPath}`);
  }
  await generateTestAssets();
  const reportPath = path.join(os.tmpdir(), `central-pdf-ui-app-e2e-${process.pid}.json`);
  const e2eUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'central-pdf-ui-app-e2e-data-'));
  const startupTracePath = path.join(os.tmpdir(), `central-pdf-ui-app-e2e-startup-${process.pid}.jsonl`);
  const e2eRunsDir = path.join(ROOT, '.tmp-test-runs');
  fs.mkdirSync(e2eRunsDir, { recursive: true });
  const e2eOutputDir = fs.mkdtempSync(path.join(e2eRunsDir, 'ui-app-e2e-output-'));
  try {
    fs.rmSync(reportPath, { force: true });
    fs.rmSync(startupTracePath, { force: true });
  } catch {}

  const vite = packagedAppPath ? null : spawn(process.execPath, [
    path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', VITE_HOST, '--port', String(VITE_PORT)
  ], { cwd: ROOT, stdio: 'ignore', windowsHide: true, env: { ...process.env } });

  let electronApp = null;
  let electronStderr = '';
  try {
    if (!packagedAppPath) await waitForHttp(VITE_URL);

    const appExecutable = packagedAppPath || electronPath;
    const appArguments = [`--user-data-dir=${e2eUserDataDir}`, '--disable-gpu'];
    if (!packagedAppPath) appArguments.push('.');
    electronApp = spawn(appExecutable, appArguments, {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        ELECTRON_ENABLE_LOGGING: '1',
        ELECTRON_ENABLE_STACK_DUMPING: '1',
        CENTRAL_PDF_E2E_REPORT_FILE: reportPath,
        CENTRAL_PDF_E2E_ASSETS_MANIFEST: path.join(TEST_ASSETS_DIR, 'manifest.json'),
        CENTRAL_PDF_E2E_OUTPUT_DIR: e2eOutputDir,
        CENTRAL_PDF_E2E: '1',
        CENTRAL_PDF_DEV_SERVER_URL: packagedAppPath ? '' : VITE_URL,
        CENTRAL_PDF_STARTUP_TRACE_FILE: startupTracePath
      }
    });
    electronApp.stdout?.on('data', (chunk) => process.stdout.write(`[electron] ${chunk}`));
    electronApp.stderr?.on('data', (chunk) => {
      electronStderr += String(chunk);
      process.stderr.write(`[electron] ${chunk}`);
    });

    const result = await waitForReport(reportPath, electronApp, startupTracePath);
    const appExit = await waitForChildExit(electronApp);
    const unexpectedMainCrash = /\[(?:uncaughtException|unhandledRejection)\]/i.test(electronStderr);
    if (result.ok && (!appExit || appExit.code !== 0 || unexpectedMainCrash)) {
      result.ok = false;
      result.results = Array.isArray(result.results) ? result.results : [];
      result.results.push({
        name: 'encerramento limpo do aplicativo',
        ok: false,
        durationMs: 0,
        detail: !appExit
          ? 'O processo não encerrou após concluir o teste.'
          : unexpectedMainCrash
            ? 'O processo emitiu uma exceção não tratada ao encerrar.'
            : `O processo encerrou com código ${appExit.code}.`
      });
    }
    const reportLines = [
      '# UI App E2E Report',
      '',
      `Gerado em ${new Date().toISOString()}.`,
      '',
      `Status geral: ${result.ok ? 'ok' : 'erro'}`,
      `Aplicativo: ${packagedAppPath ? 'empacotado' : 'ambiente de desenvolvimento'}`,
      '',
      '| Etapa | Status | Duração (ms) | Detalhe |',
      '| --- | --- | --- | --- |',
      ...(Array.isArray(result.results)
        ? result.results.map((item) => `| ${String(item.name || '').replace(/\|/g, '\\|')} | ${item.skipped ? 'ignorado' : item.ok ? 'ok' : 'erro'} | ${item.durationMs ?? '-'} | ${String(item.detail || '').replace(/\|/g, '\\|')} |`)
        : [`| execução | erro | - | ${String(result.error || 'Sem detalhes').replace(/\|/g, '\\|')} |`])
    ];
    const markdownReport = writeReport('ui-app-e2e-report.md', reportLines);

    console.log(JSON.stringify({
      ok: Boolean(result.ok),
      reportPath: markdownReport,
      details: result
    }, null, 2));

    process.exitCode = result.ok ? 0 : 1;
  } finally {
    await killProcessTree(electronApp);
    await killProcessTree(vite);
    let preserveUserData = false;
    if (keepUserDataOnFailure && fs.existsSync(reportPath)) {
      try { preserveUserData = !JSON.parse(fs.readFileSync(reportPath, 'utf8')).ok; } catch {}
    }
    if (!preserveUserData) {
      try {
        fs.rmSync(e2eUserDataDir, { recursive: true, force: true });
      } catch {}
      try {
        fs.rmSync(e2eTestAssetsRoot, { recursive: true, force: true });
      } catch {}
    } else {
      console.error(`[e2e] Perfil temporário preservado para diagnóstico: ${e2eUserDataDir}`);
      console.error(`[e2e] Fixtures isoladas preservadas para diagnóstico: ${e2eTestAssetsRoot}`);
    }
    if (electronStderr.trim()) {
      console.error(`[electron stderr]\n${electronStderr.trim()}`);
    }
  }
}

main().catch((error) => {
  if (keepUserDataOnFailure) {
    console.error(`[e2e] Fixtures isoladas preservadas para diagnóstico: ${e2eTestAssetsRoot}`);
  } else {
    try { fs.rmSync(e2eTestAssetsRoot, { recursive: true, force: true }); } catch {}
  }
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
