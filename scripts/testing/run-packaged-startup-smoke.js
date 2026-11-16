const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { writeReport } = require('./_common');

const installRoot = process.env.CENTRAL_PDF_INSTALL_ROOT || 'C:\\Program Files\\Central PDF';
const developmentMode = process.env.CENTRAL_PDF_STARTUP_SMOKE_DEV === '1';
const ROOT = path.resolve(__dirname, '..', '..');
const vitePort = Number(process.env.CENTRAL_PDF_STARTUP_SMOKE_PORT || (5400 + (process.pid % 500)));
const viteHost = '127.0.0.1';
const viteUrl = `http://${viteHost}:${vitePort}`;
const diagnosticPort = Number(process.env.CENTRAL_PDF_STARTUP_SMOKE_REMOTE_PORT || 0);
const executable = process.env.CENTRAL_PDF_PACKAGED_APP
  || (developmentMode ? path.join(__dirname, '..', '..', 'node_modules', 'electron', 'dist', 'electron.exe') : path.join(installRoot, 'Central PDF.exe'));
// Cold Windows startup may be slowed by antivirus scans. Keep the full
// allowance by default, with a bounded override for focused diagnostics.
const requestedTimeoutMs = Number(process.env.CENTRAL_PDF_STARTUP_SMOKE_TIMEOUT_MS);
const timeoutMs = Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0
  ? Math.min(90_000, Math.max(5_000, requestedTimeoutMs))
  : 90_000;
const startupPhases = new Set(['renderer-did-finish-load', 'renderer-bootstrap-complete']);
const failurePhases = new Set(['renderer-did-fail-load', 'renderer-process-gone', 'renderer-preload-error', 'renderer-bootstrap-failed']);

function readEvents(tracePath) {
  try {
    return fs.readFileSync(tracePath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function readRemoteTargets(port) {
  return new Promise((resolve) => {
    const request = http.get(`http://127.0.0.1:${port}/json/list`, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(body).map(({ type, title, url }) => ({ type, title, url }))); }
        catch { resolve([]); }
      });
    });
    request.once('error', () => resolve([]));
    request.setTimeout(1_000, () => { request.destroy(); resolve([]); });
  });
}

async function waitForHttp(url, timeoutMs = 45000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const reachable = await new Promise((resolve) => {
      const request = http.get(url, (response) => {
        response.resume();
        resolve(Boolean(response.statusCode && response.statusCode < 500));
      });
      request.once('error', () => resolve(false));
    });
    if (reachable) return;
    await delay(250);
  }
  throw new Error(`Timeout aguardando Vite do smoke em ${url}`);
}

async function stopProcessTree(child) {
  if (!child || child.exitCode !== null || !child.pid) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      const timeout = setTimeout(() => { killer.kill(); resolve(); }, 5_000);
      killer.once('close', () => { clearTimeout(timeout); resolve(); });
      killer.once('error', () => { clearTimeout(timeout); resolve(); });
    });
  } else {
    child.kill('SIGTERM');
  }
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 5_000);
    child.once('close', () => { clearTimeout(timeout); resolve(); });
  });
}

async function main() {
  if (process.platform !== 'win32') throw new Error('Este smoke test valida o executável empacotado para Windows.');
  if (!fs.existsSync(executable) || !fs.statSync(executable).isFile()) {
    throw new Error('Executável empacotado não encontrado. Defina CENTRAL_PDF_PACKAGED_APP com o caminho do Central PDF.exe.');
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'central-pdf-startup-smoke-'));
  const tracePath = path.join(workDir, 'startup.jsonl');
  const profilePath = path.join(workDir, 'profile');
  const vite = developmentMode
    ? spawn(process.execPath, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', viteHost, '--port', String(vitePort), '--strictPort'], {
      cwd: ROOT,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env }
    })
    : null;
  const child = spawn(executable, [
    `--user-data-dir=${profilePath}`,
    '--disable-gpu',
    ...(diagnosticPort ? [`--remote-debugging-port=${diagnosticPort}`] : []),
    ...(developmentMode ? ['.'] : [])
  ], {
    cwd: developmentMode ? ROOT : path.dirname(executable),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CENTRAL_PDF_STARTUP_TRACE_FILE: tracePath,
      ...(developmentMode ? { CENTRAL_PDF_DEV_SERVER_URL: viteUrl } : {})
    }
  });
  let processOutput = '';
  const captureOutput = (chunk) => {
    // Keep only a bounded tail: Electron/Chromium can emit substantial diagnostics.
    processOutput = `${processOutput}${chunk.toString()}`.slice(-12_000);
  };
  child.stdout?.on('data', captureOutput);
  child.stderr?.on('data', captureOutput);
  let launchError = null;
  child.once('error', () => { launchError = true; });
  let events = [];
  let failure = null;
  let remoteTargets = [];
  const startedAt = Date.now();
  try {
    if (developmentMode) await waitForHttp(viteUrl);
    while (Date.now() - startedAt < timeoutMs) {
      await delay(250);
      events = readEvents(tracePath);
      failure = events.find((event) => failurePhases.has(event.phase)) || null;
      if (launchError) {
        failure = { phase: 'process-start-failed', errorCode: 'SPAWN' };
        break;
      }
      if (failure || child.exitCode !== null) break;
      if ([...startupPhases].every((phase) => events.some((event) => event.phase === phase))) break;
    }
    if (!developmentMode && diagnosticPort && ![...startupPhases].every((phase) => events.some((event) => event.phase === phase))) {
      remoteTargets = await readRemoteTargets(diagnosticPort);
    }
    const loaded = [...startupPhases].every((phase) => events.some((event) => event.phase === phase));
    const readyAt = Date.now();
    const durationMs = readyAt - startedAt;
    // Keep the window alive briefly after bootstrap to catch delayed renderer
    // failures. Older packaged builds do not know the smoke-only auto-quit flag;
    // the harness owns process-tree cleanup and must not call that a boot failure.
    if (loaded && !failure) {
      await delay(1_000);
      events = readEvents(tracePath);
      failure = events.find((event) => failurePhases.has(event.phase)) || null;
    }
    const ok = loaded && !failure;
    const reportPath = writeReport(developmentMode ? 'development-startup-smoke.md' : 'packaged-startup-smoke.md', [
      '# Startup Smoke Test', '', `Gerado em ${new Date().toISOString()}.`, '',
      `Status: ${ok ? 'ok' : 'falha'}.`,
      `Aplicativo: ${developmentMode ? 'Electron de desenvolvimento com servidor Vite' : path.basename(executable)}.`,
      `Tempo até a interface pronta: ${loaded ? `${durationMs} ms` : 'não atingido'}.`,
      `Última fase: ${events.at(-1)?.phase || 'sem evento'}.`,
      `Processo de teste: ${child.exitCode === null ? 'encerrado pelo harness após a verificação' : `encerrou com código ${child.exitCode}`}.`,
      ...(diagnosticPort ? [`Alvos Chromium de diagnóstico: ${JSON.stringify(remoteTargets)}.`] : []),
      ...(!ok && processOutput.trim() ? ['', '## Saída diagnóstica (trecho final)', '```text', processOutput.trim(), '```'] : []),
      failure ? `Falha reportada: ${failure.phase} (${failure.errorCode ?? 'sem código'}).` : ''
    ].filter(Boolean));
    console.log(JSON.stringify({ ok, durationMs, phases: events.map(({ phase }) => phase), reportPath }, null, 2));
    if (!ok) process.exitCode = 1;
  } finally {
    await stopProcessTree(child);
    if (vite) await stopProcessTree(vite);
    // The path is a unique child created directly under the OS temp directory.
    const tempRoot = path.resolve(os.tmpdir());
    if (path.dirname(path.resolve(workDir)) === tempRoot) {
      try {
        fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
      } catch {
        console.warn('O teste passou, mas o Windows manteve arquivos temporários em uso; eles serão removidos pelo sistema mais tarde.');
      }
    }
  }
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exitCode = 1;
});
