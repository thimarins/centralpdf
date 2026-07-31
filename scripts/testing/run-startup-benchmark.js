const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { writeReport } = require('./_common');

const repoRoot = path.resolve(__dirname, '..', '..');
const defaultExe = path.join(repoRoot, 'releases', 'latest', 'Central-PDF-win-x64-unpacked', 'Central PDF.exe');
const exePath = process.argv[2] ? path.resolve(process.argv[2]) : defaultExe;
const runs = Number.parseInt(process.argv[3] || '5', 10);
const timeoutMs = 45000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function listRunningAppProcesses() {
  const processList = spawn('powershell.exe', [
    '-NoProfile',
    '-Command',
    `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'Central PDF.exe' } | Select-Object ProcessId, ExecutablePath | ConvertTo-Json -Compress`
  ], {
    windowsHide: true
  });

  return new Promise((resolve) => {
    let output = '';
    processList.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    processList.on('exit', () => {
      try {
        const parsed = output.trim() ? JSON.parse(output.trim()) : [];
        resolve(Array.isArray(parsed) ? parsed : [parsed]);
      } catch {
        resolve([]);
      }
    });
    processList.on('error', () => resolve([]));
  });
}

function killProcessTree(pid) {
  return new Promise((resolve) => {
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    killer.on('exit', () => resolve());
    killer.on('error', () => resolve());
  });
}

async function clearLingeringProcesses() {
  const running = await listRunningAppProcesses();
  for (const item of running) {
    if (item?.ProcessId) {
      await killProcessTree(item.ProcessId);
    }
  }
}

async function waitForTrace(tracePath, child) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(tracePath)) {
      const lines = fs.readFileSync(tracePath, 'utf8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

      const entries = lines.map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      }).filter(Boolean);

      const completed = entries.find((entry) => entry.phase === 'renderer-bootstrap-complete');
      if (completed) {
        return entries;
      }
    }

    if (child.exitCode !== null) {
      break;
    }

    await sleep(150);
  }

  return null;
}

async function runOnce(index, attempt = 1) {
  await clearLingeringProcesses();
  await sleep(1200);

  const tracePath = path.join(os.tmpdir(), `central-pdf-startup-${process.pid}-${index}.jsonl`);
  try {
    fs.rmSync(tracePath, { force: true });
  } catch {}

  const child = spawn(exePath, [], {
    detached: false,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      CENTRAL_PDF_STARTUP_TRACE_FILE: tracePath
    }
  });

  const entries = await waitForTrace(tracePath, child);
  await killProcessTree(child.pid);
  await clearLingeringProcesses();
  await sleep(1000);

  if (!entries && attempt < 2) {
    await sleep(1500);
    return runOnce(index, attempt + 1);
  }

  if (!entries) {
    return {
      run: index,
      ok: false,
      error: `startup timeout (tentativas: ${attempt})`
    };
  }

  const byPhase = Object.fromEntries(entries.map((entry) => [entry.phase, entry.ms]));
  return {
    run: index,
    attempt,
    ok: true,
    totalMs: byPhase['renderer-bootstrap-complete'] ?? null,
    appReadyMs: byPhase['app-ready'] ?? null,
    windowCreatedMs: byPhase['window-created'] ?? null,
    didFinishLoadMs: byPhase['renderer-did-finish-load'] ?? null,
    readyToShowMs: byPhase['window-ready-to-show'] ?? null
  };
}

async function main() {
  if (!fs.existsSync(exePath)) {
    throw new Error(`Execut\u00E1vel n\u00E3o encontrado: ${exePath}`);
  }

  const runningProcesses = await listRunningAppProcesses();
  const conflictingProcesses = runningProcesses.filter((item) => item.ExecutablePath && path.resolve(item.ExecutablePath) === exePath);
  if (conflictingProcesses.length) {
    throw new Error('Feche o Central PDF antes de rodar o benchmark de abertura para evitar medi\u00E7\u00F5es inv\u00E1lidas.');
  }

  const results = [];
  for (let index = 1; index <= runs; index += 1) {
    results.push(await runOnce(index));
  }

  const validRuns = results.filter((item) => item.ok && Number.isFinite(item.totalMs));
  const averageMs = validRuns.length
    ? Math.round(validRuns.reduce((sum, item) => sum + item.totalMs, 0) / validRuns.length)
    : null;

  const reportPath = writeReport('startup-benchmark.md', [
    '# Startup Benchmark',
    '',
    `Gerado em ${new Date().toISOString()}.`,
    '',
    `Execut\u00E1vel avaliado: ${exePath}`,
    '',
    `Rodadas v\u00E1lidas: ${validRuns.length}/${results.length}`,
    averageMs !== null ? `M\u00E9dia at\u00E9 renderer-bootstrap-complete: ${averageMs} ms` : 'M\u00E9dia indispon\u00EDvel.',
    '',
    '| Rodada | Status | Total | App ready | Janela criada | HTML carregado | Pronta p/ mostrar |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...results.map((item) => `| ${item.run} | ${item.ok ? 'ok' : item.error} | ${item.totalMs ?? '-'} ms | ${item.appReadyMs ?? '-'} ms | ${item.windowCreatedMs ?? '-'} ms | ${item.didFinishLoadMs ?? '-'} ms | ${item.readyToShowMs ?? '-'} ms |`)
  ]);

  console.log(JSON.stringify({
    ok: true,
    exePath,
    averageMs,
    results,
    reportPath
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
