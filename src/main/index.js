const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const cp = require('child_process');
const { performance } = require('perf_hooks');

const configService = require('./config-service');
const pdfService = require('./pdf-service');
const queue = require('./queue');
const logger = require('./logger');
const { createPdfWorkerExecution } = require('./worker-runtime');
const { APP_META } = require('./app-meta');
const {
  isValidPdfPath,
  inspectPdfFile,
  inspectPdfFileAsync,
  inspectImageFile,
  hasPdfEncryptionDictionaryAsync,
  PDF_LIMITS
} = require('./utils');
const {
  validateImageFiles,
  getImageBatchWarnings
} = require('./services/image-conversion/image-validation');
const { normalizeSignatureOptions } = require('./services/signature/signature-service');

let mainWindow = null;
let isForceClosingApp = false;
const announcedOperationEvents = new Set();
const appIcon = nativeImage.createFromPath(path.join(__dirname, 'icon.ico'));
const singleInstanceLock = process.env.CENTRAL_PDF_E2E === '1'
  ? true
  : app.requestSingleInstanceLock();
const startupTraceFile = process.env.CENTRAL_PDF_STARTUP_TRACE_FILE || '';
const startupTraceStartedAt = performance.now();
const e2eReportFile = process.env.CENTRAL_PDF_E2E_REPORT_FILE || '';
const e2eAssetsManifestFile = process.env.CENTRAL_PDF_E2E_ASSETS_MANIFEST || '';
const developmentServerUrl = process.env.CENTRAL_PDF_DEV_SERVER_URL || 'http://localhost:5173';
let rendererE2eStarted = false;
let pendingLaunchRequest = null;

if (!singleInstanceLock) {
  app.quit();
  process.exit(0);
}

const SECOND_INSTANCE_FILE_EXTENSIONS = new Set([
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.bmp',
  '.gif',
  '.tif',
  '.tiff'
]);

const OPERATION_TYPES = new Set([
  'merge',
  'split-pages',
  'split-range',
  'split-size',
  'organize',
  'compress',
  'watermark',
  'images-to-pdf',
  'files-to-pdf',
  'sign',
  'pdf-to-word',
  'protect',
  'unlock',
  'redact'
]);

const WINDOWS_CONTEXT_ACTIONS = [
  { id: 'organize', label: 'Organizar com Central PDF', multi: true },
  { id: 'merge', label: 'Mesclar no Central PDF', multi: true },
  { id: 'protect', label: 'Proteger com Central PDF', multi: false },
  { id: 'unlock', label: 'Desbloquear no Central PDF', multi: false },
  { id: 'compress', label: 'Reduzir tamanho com Central PDF', multi: false },
  { id: 'watermark', label: 'Marca d\'água com Central PDF', multi: true },
  { id: 'redact', label: 'Ocultar dados com Central PDF', multi: false }
];

function isMultiLaunchAction(action) {
  const normalized = normalizeLaunchAction(action);
  return WINDOWS_CONTEXT_ACTIONS.some((item) => item.id === normalized && item.multi);
}

function mergeLaunchRequests(currentRequest, nextRequest) {
  if (!currentRequest) return nextRequest || null;
  if (!nextRequest) return currentRequest;

  const currentAction = normalizeLaunchAction(currentRequest.action || '') || 'organize';
  const nextAction = normalizeLaunchAction(nextRequest.action || '') || currentAction;

  if (currentAction !== nextAction) {
    return nextRequest;
  }

  if (!isMultiLaunchAction(currentAction)) {
    return nextRequest;
  }

  const mergedFiles = [];
  const seen = new Set();
  for (const file of [...(currentRequest.files || []), ...(nextRequest.files || [])]) {
    const filePath = String(file.path || '').trim();
    const key = filePath.toLowerCase();
    if (!filePath || seen.has(key)) continue;
    seen.add(key);
    mergedFiles.push(file);
  }

  return {
    action: currentAction,
    files: mergedFiles
  };
}

function sanitizeQueueTaskForRenderer(task) {
  if (!task || typeof task !== 'object') return task;
  const result = task.result && typeof task.result === 'object'
    ? {
        outputPath: typeof task.result.outputPath === 'string' ? task.result.outputPath : '',
        firstOutputPath: typeof task.result.firstOutputPath === 'string' ? task.result.firstOutputPath : '',
        outputDir: typeof task.result.outputDir === 'string' ? task.result.outputDir : '',
        outputCount: Number(task.result.outputCount || 0),
        reduction: task.result.reduction ?? null,
        format: typeof task.result.format === 'string' ? task.result.format : '',
        pageCount: Number(task.result.pageCount || 0),
        extractedCharacters: Number(task.result.extractedCharacters || 0)
      }
    : null;

  return {
    ...task,
    result
  };
}

function sanitizeQueueStatusForRenderer(queueStatus = []) {
  return Array.isArray(queueStatus)
    ? queueStatus.map((task) => sanitizeQueueTaskForRenderer(task))
    : [];
}

function reportStartupPhase(phase, details = {}) {
  if (!startupTraceFile) {
    return;
  }
  try {
    fs.appendFileSync(startupTraceFile, `${JSON.stringify({
      phase,
      ms: Math.round(performance.now() - startupTraceStartedAt),
      ts: new Date().toISOString(),
      ...details
    })}\n`, 'utf8');
  } catch (error) {
    logger.logOperation('STARTUP_TRACE_ERROR', error.message || String(error));
  }
}

function hasExplicitOpenTarget(commandLine = []) {
  if (!Array.isArray(commandLine)) return false;
  return commandLine.some((rawArg) => {
    if (typeof rawArg !== 'string') return false;
    const arg = rawArg.trim().replace(/^"+|"+$/g, '');
    if (!arg || arg.startsWith('--')) return false;
    try {
      if (!fs.existsSync(arg)) return false;
      const stats = fs.statSync(arg);
      if (!stats.isFile()) return false;
      return SECOND_INSTANCE_FILE_EXTENSIONS.has(path.extname(arg).toLowerCase());
    } catch {
      return false;
    }
  });
}

function normalizeLaunchAction(action) {
  const normalized = String(action || '').trim().toLowerCase();
  const aliases = {
    organize: 'organize',
    organizar: 'organize',
    merge: 'merge',
    mesclar: 'merge',
    protect: 'protect',
    proteger: 'protect',
    unlock: 'unlock',
    desbloquear: 'unlock',
    compress: 'compress',
    reduzir: 'compress',
    compactar: 'compress',
    watermark: 'watermark',
    redact: 'redact',
    ocultar: 'redact'
  };
  return aliases[normalized] || '';
}

function collectLaunchFileArgs(commandLine = []) {
  if (!Array.isArray(commandLine)) return [];
  const rawCandidates = [];
  for (let index = 0; index < commandLine.length; index += 1) {
    const rawArg = commandLine[index];
    if (typeof rawArg !== 'string') continue;
    const trimmed = rawArg.trim();
    if (!trimmed) continue;
    if (trimmed === '--action' || trimmed === '--module' || trimmed === '--files') {
      index += 1;
      continue;
    }
    if (trimmed.startsWith('--action=') || trimmed.startsWith('--module=')) {
      continue;
    }
    const candidate = trimmed.replace(/^"+|"+$/g, '');
    if (!candidate || candidate.startsWith('--')) continue;
    rawCandidates.push(candidate);
  }

  const files = [];
  for (let index = 0; index < rawCandidates.length; index += 1) {
    let mergedCandidate = rawCandidates[index];
    let matchedPath = '';
    let matchedStats = null;
    let matchedEndIndex = index;

    for (let endIndex = index; endIndex < rawCandidates.length; endIndex += 1) {
      if (endIndex > index) {
        mergedCandidate += ` ${rawCandidates[endIndex]}`;
      }
      try {
        if (!fs.existsSync(mergedCandidate)) continue;
        const stats = fs.statSync(mergedCandidate);
        if (!stats.isFile()) continue;
        const ext = path.extname(mergedCandidate).toLowerCase();
        if (!SECOND_INSTANCE_FILE_EXTENSIONS.has(ext)) continue;
        matchedPath = mergedCandidate;
        matchedStats = stats;
        matchedEndIndex = endIndex;
      } catch {
        continue;
      }
    }

    if (!matchedPath || !matchedStats) continue;
    files.push({
      path: matchedPath,
      name: path.basename(matchedPath),
      size: matchedStats.size,
      ext: path.extname(matchedPath).toLowerCase()
    });

    if (matchedEndIndex > index) {
      index = matchedEndIndex;
    }
  }

  const seen = new Set();
  return files.filter((file) => {
    const key = String(file.path || '').toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseLaunchRequest(commandLine = []) {
  if (!Array.isArray(commandLine)) return null;
  let action = '';
  for (let index = 0; index < commandLine.length; index += 1) {
    const rawArg = commandLine[index];
    if (typeof rawArg !== 'string') continue;
    const trimmed = rawArg.trim();
    if (!trimmed) continue;
    if (trimmed === '--action' || trimmed === '--module') {
      action = normalizeLaunchAction(commandLine[index + 1]);
      index += 1;
      continue;
    }
    if (trimmed.startsWith('--action=')) {
      action = normalizeLaunchAction(trimmed.split('=').slice(1).join('='));
      continue;
    }
    if (trimmed.startsWith('--module=')) {
      action = normalizeLaunchAction(trimmed.split('=').slice(1).join('='));
      continue;
    }
  }
  const files = collectLaunchFileArgs(commandLine);
  if (!action && files.length === 0) return null;
  const parsedRequest = {
    action: action || 'organize',
    files
  };
  try {
    logger.logOperation(
      'LAUNCH_REQUEST_PARSED',
      `action=${parsedRequest.action}; files=${parsedRequest.files.map((file) => path.basename(file.path || file.name || '')).join(',') || 'none'}`
    );
  } catch {}
  return parsedRequest;
}

function canSyncWindowsContextMenus() {
  return process.platform === 'win32' && app.isPackaged && !!process.execPath;
}

function runRegCommandAsync(args = []) {
  return new Promise((resolve, reject) => {
    const child = cp.spawn('reg', args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error((stderr || stdout).trim() || `reg exited with code ${code}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function buildContextMenuCommand(actionId, { multi = false } = {}) {
  const exePath = process.execPath;
  return multi
    ? `"${exePath}" --action=${actionId} %*`
    : `"${exePath}" --action=${actionId} \"%1\"`;
}

async function syncWindowsPdfContextMenus() {
  if (!canSyncWindowsContextMenus()) return;
  const baseKey = 'HKCU\\Software\\Classes\\SystemFileAssociations\\.pdf\\shell';
  const syncVersion = String(APP_META.buildLabel || APP_META.releaseVersion || '1');
  const versionValue = 'CentralPDF.ContextMenuVersion';
  try {
    const currentVersion = await runRegCommandAsync(['query', baseKey, '/v', versionValue]);
    if (currentVersion.stdout.includes(syncVersion)) return;

    for (const action of WINDOWS_CONTEXT_ACTIONS) {
      const actionKey = `${baseKey}\\CentralPDF.${action.id}`;
      await runRegCommandAsync(['add', actionKey, '/ve', '/d', action.label, '/f']);
      await runRegCommandAsync(['add', actionKey, '/v', 'Icon', '/d', `"${process.execPath}",0`, '/f']);
      await runRegCommandAsync(['add', actionKey, '/v', 'MultiSelectModel', '/d', action.multi ? 'Player' : 'Single', '/f']);
      await runRegCommandAsync(['add', `${actionKey}\\command`, '/ve', '/d', buildContextMenuCommand(action.id, { multi: action.multi }), '/f']);
    }
    await runRegCommandAsync(['add', baseKey, '/v', versionValue, '/d', syncVersion, '/f']);
    logger.logOperation('WINDOWS_CONTEXT_MENU_SYNCED', `Synced ${WINDOWS_CONTEXT_ACTIONS.length} Explorer shortcuts.`);
  } catch (error) {
    logger.logError('WINDOWS_CONTEXT_MENU_SYNC_FAILED', error);
  }
}

function emitLaunchRequestToRenderer(request) {
  if (!request || !mainWindow || mainWindow.isDestroyed()) return false;
  if (mainWindow.webContents.isLoadingMainFrame()) {
    pendingLaunchRequest = mergeLaunchRequests(pendingLaunchRequest, request);
    return false;
  }
  try {
    logger.logOperation(
      'LAUNCH_REQUEST_EMIT',
      `action=${request.action || 'unknown'}; files=${(request.files || []).map((file) => path.basename(file.path || file.name || '')).join(',') || 'none'}`
    );
  } catch {}
  mainWindow.webContents.send('launch-request', request);
  return true;
}

function buildRendererE2EScript({ manifest }) {
  const manifestJson = JSON.stringify(manifest || {});
  return `
    (async () => {
      const manifest = ${manifestJson};

      function sleep(ms) {
        return new Promise((resolve) => window.setTimeout(resolve, ms));
      }

      async function waitFor(predicate, timeoutMs = 30000, label = 'condição') {
        const startedAt = Date.now();
        while (Date.now() - startedAt < timeoutMs) {
          const value = await predicate();
          if (value) return value;
          await sleep(100);
        }
        const diagnostics = {
          href: window.location?.href || '',
          readyState: document.readyState,
          hasApi: Boolean(window.api),
          bodyText: String(document.body?.innerText || '').slice(0, 500)
        };
        throw new Error('Timeout aguardando ' + label + ' | ' + JSON.stringify(diagnostics));
      }

      function toArrayBuffer(bytes) {
        if (bytes instanceof ArrayBuffer) return bytes;
        if (bytes instanceof Uint8Array) {
          return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        }
        if (ArrayBuffer.isView(bytes)) {
          return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        }
        return bytes;
      }

      async function makeFileLike(filePath) {
        const fileName = String(filePath || '').split(/[\\\\/]/).pop();
        const fileBytes = await window.api.readFileBytes(filePath);
        return {
          name: fileName,
          path: filePath,
          size: fileBytes.byteLength || fileBytes.length || 0,
          arrayBuffer: async () => toArrayBuffer(await window.api.readFileBytes(filePath))
        };
      }

      await waitFor(() => window.__CENTRAL_PDF_TEST_API__, 30000, 'API de teste do renderer');
      const api = window.__CENTRAL_PDF_TEST_API__;
      const state = api.state;
      const dom = api.dom;
      const files = manifest.files || {};
      const capturedTasks = [];
      const finishedTasks = [];
      const results = [];
      const originalQueueOperation = window.api.queueOperation.bind(window.api);
      const unsubscribeFinished = window.api.onOperationFinished((task) => {
        finishedTasks.push(task);
      });

      async function queuePayload(payload) {
        const result = await originalQueueOperation(payload);
        capturedTasks.push({
          type: payload.type || '',
          taskId: result.taskId || '',
          success: Boolean(result.success),
          error: result.error || ''
        });
        if (!result.success) {
          throw new Error(result.error || ('Falha ao enfileirar ' + (payload.type || 'operação')));
        }
        return result;
      }

      async function waitForTask(type, timeoutMs = 120000) {
        const captured = [...capturedTasks].reverse().find((item) => item.type === type);
        const baselineCount = finishedTasks.length;

        if (captured.taskId) {
          return waitFor(async () => {
            const queue = await window.api.getQueueStatus();
            const task = (queue || []).find((item) => item.id === captured.taskId);
            if (task && ['completed', 'failed', 'timeout', 'cancelled', 'interrupted'].includes(task.status)) {
              return task;
            }
            const terminalTask = finishedTasks.find((item) => item.id === captured.taskId);
            return terminalTask || null;
          }, timeoutMs, 'tarefa ' + type);
        }

        return waitFor(() => {
          const newFinished = finishedTasks.slice(baselineCount);
          return newFinished.find((item) => item.id && item.status && ['completed', 'failed', 'timeout', 'cancelled', 'interrupted'].includes(item.status)) || null;
        }, timeoutMs, 'evento final de ' + type);
      }

      async function runStep(name, fn, timeoutMs = 15000) {
        const startedAt = Date.now();
        try {
          const detail = await Promise.race([
            fn(),
            new Promise((_, reject) => window.setTimeout(() => reject(new Error('Timeout interno da etapa')), timeoutMs))
          ]);
          results.push({
            name,
            ok: true,
            durationMs: Date.now() - startedAt,
            detail: detail || ''
          });
        } catch (error) {
          results.push({
            name,
            ok: false,
            durationMs: Date.now() - startedAt,
            detail: error.message || String(error)
          });
        }
      }

      function setValue(id, value) {
        const element = document.getElementById(id);
        if (!element) throw new Error('Elemento não encontrado: ' + id);
        element.value = value;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      }

      function setChecked(id, value) {
        const element = document.getElementById(id);
        if (!element) throw new Error('Elemento não encontrado: ' + id);
        element.checked = Boolean(value);
        element.dispatchEvent(new Event('change', { bubbles: true }));
      }

      async function ensureCompleted(type) {
        const task = await waitForTask(type);
        if (task.status !== 'completed') {
          throw new Error(task.error || ('Tarefa terminou com status ' + task.status));
        }
        return task;
      }

      const password = process.env.CENTRAL_PDF_E2E_TEST_PASSWORD || 'SenhaForte123!';

      await runStep('startup renderer', async () => {
        await waitFor(() => document.body && api.dom && api.switchTab, 10000, 'renderer pronto');
        return 'Renderer inicializado';
      });

      await runStep('images-to-pdf', async () => {
        await queuePayload({
          type: 'images-to-pdf',
          files: [files.watermarkPng, files.watermarkJpg],
          options: {
            outputName: 'e2e_imagens.pdf',
            zipResults: false
          }
        });
        const task = await ensureCompleted('images-to-pdf');
        return task.result.outputPath || task.result.firstOutputPath || '';
      });

      await runStep('merge', async () => {
        await queuePayload({
          type: 'merge',
          files: [files.smallPdf, files.mediumPdf],
          options: {
            outputName: 'e2e_mesclado.pdf',
            zipResults: false,
            cleanupPaths: []
          }
        });
        const task = await ensureCompleted('merge');
        return task.result.outputPath || '';
      });

      await runStep('split-pages', async () => {
        api.switchTab('split', { skipGuard: true });
        api.handleSplitFile(await makeFileLike(files.mediumPdf));
        await queuePayload({
          type: 'split-pages',
          files: [files.mediumPdf],
          options: {
            prefix: 'e2e_split',
            zipResults: false
          }
        });
        const task = await ensureCompleted('split-pages');
        return task.result.outputDir || task.result.firstOutputPath || '';
      });

      await runStep('compress', async () => {
        api.switchTab('compress', { skipGuard: true });
        api.handleCompressFile(await makeFileLike(files.imageHeavyPdf));
        await queuePayload({
          type: 'compress',
          files: [files.imageHeavyPdf],
          options: {
            outputName: 'e2e_comprimido.pdf',
            zipResults: false
          }
        });
        const task = await ensureCompleted('compress');
        return task.result.reduction != null ? String(task.result.reduction) : (task.result.outputPath || '');
      });

      let protectedOutputPath = '';
      await runStep('protect', async () => {
        api.switchTab('protect', { skipGuard: true });
        api.protectWorkspace.handleProtectFile(await makeFileLike(files.smallPdf));
        setValue('protect-password', password);
        setValue('protect-output-name', 'e2e_protegido.pdf');
        setChecked('protect-zip', false);
        await queuePayload(api.protectWorkspace.getQueuePayload());
        const task = await ensureCompleted('protect');
        protectedOutputPath = task.result.outputPath || task.result.firstOutputPath || '';
        if (!protectedOutputPath) throw new Error('Sa?da protegida ausente');
        return protectedOutputPath;
      });

      await runStep('unlock', async () => {
        api.switchTab('unlock', { skipGuard: true });
        api.unlockWorkspace.handleUnlockFile(await makeFileLike(protectedOutputPath));
        setValue('unlock-password', password);
        setValue('unlock-output-name', 'e2e_desbloqueado.pdf');
        await queuePayload(api.unlockWorkspace.getQueuePayload());
        const task = await ensureCompleted('unlock');
        return task.result.outputPath || task.result.firstOutputPath || '';
      });

      await runStep('pdf-to-word', async () => {
        api.switchTab('pdf-to-word', { skipGuard: true });
        api.pdfToWordWorkspace.handleFile(await makeFileLike(files.smallPdf));
        setValue('pdf-to-word-output-name', 'e2e_convertido.docx');
        await queuePayload(api.pdfToWordWorkspace.getQueuePayload());
        const task = await ensureCompleted('pdf-to-word');
        return task.result.outputPath || task.result.firstOutputPath || '';
      }, 30000);

      await runStep('watermark', async () => {
        api.switchTab('watermark', { skipGuard: true });
        api.watermarkWorkspace.handleFiles([await makeFileLike(files.mediumPdf)]);
        setValue('watermark-text-value', 'CONFIDENCIAL');
        setValue('watermark-output-suffix', '_wm');
        setChecked('watermark-zip', false);
        const watermarkPayload = api.watermarkWorkspace.getQueuePayload();
        watermarkPayload.files = [files.mediumPdf];
        await queuePayload(watermarkPayload);
        const task = await ensureCompleted('watermark');
        return task.result.outputPath || task.result.firstOutputPath || '';
      });

      await runStep('organize', async () => {
        api.switchTab('organize', { skipGuard: true });
        await queuePayload({
          type: 'organize',
          files: [files.smallPdf],
          options: {
            outputName: 'e2e_organizado.pdf',
            pageActions: [
              { fileIndex: 0, sourceIndex: 1, rotation: 0 },
              { fileIndex: 0, sourceIndex: 0, rotation: 0 }
            ],
            bookmarks: [],
            zipResults: false,
            numberPages: false
          }
        });
        const task = await ensureCompleted('organize');
        return task.result.outputPath || task.result.firstOutputPath || '';
      });

      await runStep('signature', async () => {
        api.switchTab('signature', { skipGuard: true });
        await queuePayload({
          type: 'sign',
          files: [files.smallPdf],
          options: {
            outputName: 'e2e_assinado.pdf',
            outputSuffix: '_assinado',
            zipResults: false,
            fields: [{
              id: 'e2e_signature_field',
              type: 'text',
              pageIndex: 0,
              xRatio: 0.18,
              yRatio: 0.82,
              widthRatio: 0.28,
              heightRatio: 0.08,
              rotation: 0,
              opacity: 100,
              color: '#000000',
              value: 'Aprovado internamente',
              fontFamily: 'CorporateSans',
              imagePath: '',
              imageDataUrl: ''
            }]
          }
        });
        const task = await ensureCompleted('sign');
        return task.result.outputPath || task.result.firstOutputPath || '';
      }, 30000);

      await runStep('redact', async () => {
        api.switchTab('redact', { skipGuard: true });
        await queuePayload({
          type: 'redact',
          files: [files.smallPdf],
          options: {
            outputName: 'e2e_ocultado.pdf',
            redactedPages: [{
              pageIndex: 0,
              imagePath: files.watermarkJpg
            }],
            zipResults: false
          }
        });
        const task = await ensureCompleted('redact');
        return task.result.outputPath || task.result.firstOutputPath || '';
      }, 30000);

      const ok = results.every((item) => item.ok);
      unsubscribeFinished();
      return {
        ok,
        testedAt: new Date().toISOString(),
        results
      };
    })();
  `;
}

async function runRendererE2EIfRequested() {
  if (rendererE2eStarted || !e2eReportFile || !e2eAssetsManifestFile || !mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  rendererE2eStarted = true;
  try {
    const manifest = JSON.parse(fs.readFileSync(e2eAssetsManifestFile, 'utf8'));
    const result = await mainWindow.webContents.executeJavaScript(buildRendererE2EScript({ manifest }), true);
    fs.writeFileSync(e2eReportFile, JSON.stringify(result, null, 2), 'utf8');
    reportStartupPhase('renderer-e2e-complete', { ok: Boolean(result.ok) });
    setTimeout(() => app.exit(result.ok ? 0 : 2), 250);
  } catch (error) {
    const failure = {
      ok: false,
      testedAt: new Date().toISOString(),
      error: error.stack || error.message || String(error)
    };
    try {
      fs.writeFileSync(e2eReportFile, JSON.stringify(failure, null, 2), 'utf8');
    } catch (_) {}
    reportStartupPhase('renderer-e2e-failed', {
      message: error.message || String(error)
    });
    setTimeout(() => app.exit(2), 250);
  }
}

function getFriendlyName(type) {
  return {
    merge: 'Mesclar',
    'split-pages': 'Separar Páginas',
    'split-range': 'Dividir por Intervalo',
    'split-size': 'Dividir por Tamanho',
    organize: 'Organizar Páginas',
    compress: 'Reduzir tamanho',
    watermark: 'Marca d\'água em Lote',
    'images-to-pdf': 'Converter arquivos para PDF',
    'files-to-pdf': 'Converter arquivos para PDF',
    sign: 'Assinar PDF',
    'pdf-to-word': 'Converter para Word',
    protect: 'Proteger PDF',
    unlock: 'Desbloquear PDF',
    redact: 'Ocultar Dados'
  }[type];
}

function formatMemoryMb(bytes) {
  return Math.round(bytes / (1024 * 1024));
}

function getAboutInfo() {
  const config = configService.getConfig();
  const isPortable = configService.isPortableMode();

  return {
    app: {
      name: APP_META.productName,
      version: APP_META.packageVersion,
      releaseVersion: APP_META.releaseVersion,
      versionLabel: APP_META.versionLabel,
      buildLabel: APP_META.buildLabel,
      modeLabel: isPortable ? 'Portable Mode' : 'Installed Mode',
      architectureLabel: `Electron ${process.versions.electron} + Node.js ${process.versions.node}`,
      environmentLabel: `Windows ${process.arch}`
    },
    system: {
      platformLabel: `${os.type()} ${os.release()}`,
      arch: process.arch,
      memory: {
        totalMb: formatMemoryMb(os.totalmem()),
        freeMb: formatMemoryMb(os.freemem())
      }
    },
    paths: {
      logs: configService.getLogsPath(),
      config: configService.getConfigPath(),
      configDirectory: path.dirname(configService.getConfigPath()),
      temp: configService.getTempPath(),
      policy: configService.getPolicyPath(),
      policyDirectory: path.dirname(configService.getPolicyPath())
    },
    technologies: [
      { name: 'Electron', description: 'Framework principal desktop.' },
      { name: 'Node.js', description: 'Runtime local para operações e automação.' },
      { name: 'Vite', description: 'Build rápido da interface.' },
      { name: 'pdf-lib', description: 'Manipulação local de PDFs.' },
      { name: 'pdfjs-dist', description: 'Renderização e previews de documentos.' },
      { name: 'QPDF WASM', description: 'Motor WebAssembly para descriptografia local rápida de PDFs.' },
      { name: '@pdfsmaller/pdf-encrypt', description: 'Biblioteca para criptografia e proteção local de PDFs.' },
      { name: 'docx', description: 'Geração local de arquivos Word para exportação textual.' },
      { name: 'Fluent UI Icons', description: 'Sistema visual de ícones do aplicativo.' },
      { name: 'Vanilla CSS', description: 'Camada visual leve e direta.' },
      { name: 'electron-builder', description: 'Empacotamento MSI, portable e unpacked.' },
      { name: 'Logging interno', description: 'Logs rotativos e diagnóstico local sanitizado.' }
    ],
    safeguards: {
      offlineMessage: 'Central PDF foi desenvolvido para processamento seguro e local de documentos PDF em ambientes corporativos. Nenhum arquivo ? enviado para internet. Convers?es para Word priorizam PDFs digitais e n?o incluem OCR.',
      maxFileSizeBytes: config.maxFileSizeLimit
    }
  };
}

function createTaskExecutor(type, files, options, outputDir) {
  return {
    totalItems: type === 'watermark' || type === 'images-to-pdf' ? files.length : 1,
    createExecution: (updateProgress) => createPdfWorkerExecution({
      type,
      files,
      options,
      outputDir
    }, updateProgress)
  };
}

function assertDirectory(dirPath, errorMessage = 'Directory does not exist.') {
  if (typeof dirPath !== 'string' || !path.isAbsolute(dirPath)) {
    throw new Error(errorMessage);
  }
  const stats = fs.existsSync(dirPath) ? fs.statSync(dirPath) : null;
  if (!stats.isDirectory()) {
    throw new Error(errorMessage);
  }
}

function buildTaskId(type) {
  return `${type}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

function resolveOutputDirectory(files, options = {}) {
  // A pasta de origem é a regra padrão. Uma pasta personalizada só vence
  // quando foi escolhida explicitamente na operação ou nas configurações.
  const candidate = typeof options.outputDir === 'string' && options.outputDir.trim()
    ? options.outputDir.trim()
    : (configService.getConfig().defaultOutputDir || '').trim();

  const tempDir = path.resolve(configService.getTempPath());
  const isInsideTemp = (target) => {
    if (!target || !path.isAbsolute(target)) return false;
    const relative = path.relative(tempDir, path.resolve(target));
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  };

  if (candidate && !isInsideTemp(candidate)) {
    assertDirectory(candidate, 'Pasta de saída inválida.');
    return candidate;
  }

  const firstFile = Array.isArray(files) ? files.find((item) => typeof item === 'string' && path.isAbsolute(item)) : '';
  if (firstFile) {
    const originDir = path.dirname(firstFile);
    if (fs.existsSync(originDir) && !isInsideTemp(originDir)) {
      return originDir;
    }
  }

  return app.getPath('downloads');
}

async function validatePdfFile(filePath) {
  const inspection = await inspectPdfFileAsync(filePath, configService.getConfig().maxFileSizeLimit || PDF_LIMITS.maxSupportedBytes);
  if (!inspection.ok) {
    throw new Error(`PDF inválido ou ausente: ${path.basename(filePath || 'arquivo.pdf')}`);
  }
  return inspection;
}

function validateImageFile(filePath) {
  const inspection = inspectImageFile(filePath);
  if (!inspection.ok) {
    throw new Error(`Imagem inválida ou não suportada: ${path.basename(filePath || 'imagem')}`);
  }
  return inspection;
}

async function validateFiles(type, files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('Selecione pelo menos um arquivo.');
  }

  const uniqueFiles = [...new Set(files.filter((item) => typeof item === 'string' && item.trim()))];
  if (uniqueFiles.length === 0) {
    throw new Error('Nenhum arquivo válido foi informado.');
  }

  const warnings = [];
  const filteredFiles = [];
  const skippedProtectedFiles = [];
  const supportsImageInputs = type === 'merge' || type === 'files-to-pdf' || type === 'watermark';
  const canSkipProtectedInBatch = type === 'merge' || type === 'files-to-pdf' || type === 'watermark';

  if (type === 'images-to-pdf') {
    uniqueFiles.forEach(validateImageFile);
    return { files: uniqueFiles, warnings };
  }

  if (type === 'merge') {
    if (uniqueFiles.length < 2) {
      throw new Error('Selecione pelo menos 2 arquivos para mesclar.');
    }
  }

  for (const filePath of uniqueFiles) {
    if (supportsImageInputs && /\.(png|jpe?g)$/i.test(filePath)) {
      validateImageFile(filePath);
      filteredFiles.push(filePath);
      continue;
    }

    await validatePdfFile(filePath);

    if (/\.pdf$/i.test(filePath) && await hasPdfEncryptionDictionaryAsync(filePath)) {
      if (canSkipProtectedInBatch && uniqueFiles.length > 1) {
        skippedProtectedFiles.push(filePath);
        continue;
      }
      throw new Error('Arquivo protegido. Remova a senha para continuar.');
    }

    filteredFiles.push(filePath);
  }

  if (filteredFiles.length === 0 && skippedProtectedFiles.length > 0) {
    throw new Error(
      skippedProtectedFiles.length === 1
        ? 'Arquivo protegido. Remova a senha para continuar.'
        : 'Todos os arquivos deste lote estão protegidos.'
    );
  }

  if (skippedProtectedFiles.length > 0) {
    warnings.push(
      skippedProtectedFiles.length === 1
        ? '1 arquivo protegido foi ignorado.'
        : `${skippedProtectedFiles.length} arquivos protegidos foram ignorados.`
    );
  }

  return {
    files: filteredFiles,
    warnings
  };
}

function validateOrganizeOptions(options = {}) {
  if (!Array.isArray(options.pageActions) || options.pageActions.length === 0) {
    throw new Error('A organiza??o precisa de pelo menos uma p?gina.');
  }
  if (typeof options.outputName !== 'string' || !options.outputName.trim()) {
    throw new Error('Informe o nome do arquivo final.');
  }
}

function validateWatermarkOptions(options = {}) {
  if (typeof options.outputSuffix !== 'string' || !options.outputSuffix.trim()) {
    throw new Error('Informe o sufixo do arquivo.');
  }
  if (options.watermarkKind === 'image') {
    if (!options.imagePath || !inspectImageFile(options.imagePath).ok) {
      throw new Error('Imagem da marca d\'água inválida ou ausente.');
    }
    return;
  }
  if (!String(options.text || '').trim()) {
    throw new Error('Informe o texto da marca d\'água.');
  }
}

function validateSignatureOptions(options = {}) {
  if (typeof options.outputName !== 'string' || !options.outputName.trim()) {
    throw new Error('Informe o nome do arquivo assinado.');
  }
  if (!Array.isArray(options.fields) || options.fields.length === 0) {
    throw new Error('Adicione pelo menos um campo de assinatura.');
  }
}

function validateProtectOptions(options = {}) {
  if (typeof options.password !== 'string' || !options.password.trim()) {
    throw new Error('Informe uma senha para proteger o PDF.');
  }
  if (typeof options.outputName !== 'string' || !options.outputName.trim()) {
    throw new Error('Informe o nome do arquivo protegido.');
  }
}

function validateRedactOptions(options = {}) {
  if (typeof options.outputName !== 'string' || !options.outputName.trim()) {
    throw new Error('Informe o nome do arquivo ocultado.');
  }
  if (!Array.isArray(options.redactedPages) || options.redactedPages.length === 0) {
    throw new Error('Adicione pelo menos uma tarja antes de ocultar dados.');
  }
}

function getOperationalWarnings(type, files) {
  const warnings = [];
  if (!Array.isArray(files)) {
    return warnings;
  }

  const pdfInspections = files
    .filter((filePath) => typeof filePath === 'string' && /\.pdf$/i.test(filePath))
    .map((filePath) => inspectPdfFile(filePath, configService.getConfig().maxFileSizeLimit || PDF_LIMITS.maxSupportedBytes));

  if (pdfInspections.some((item) => item.warnings.includes('large'))) {
    warnings.push('Documento grande detectado. O processamento pode levar mais tempo.');
  }
  if (type === 'images-to-pdf' && files.length >= 10) {
    warnings.push('Muitas imagens detectadas. O app pode usar modo otimizado.');
  }

  return warnings;
}

async function cleanUpTempFiles(files, options = {}) {
  const cleanupPaths = Array.isArray(options.cleanupPaths) ? options.cleanupPaths : [];
  for (const filePath of cleanupPaths) {
    if (typeof filePath !== 'string' || !filePath.trim()) continue;
    try {
      await fs.promises.rm(filePath, { force: true });
    } catch (_) {}
  }
}

reportStartupPhase('main-module-loaded');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1416,
    height: 820,
    minWidth: 1152,
    minHeight: 640,
    title: 'Central PDF',
    icon: appIcon,
    autoHideMenuBar: true,
    backgroundColor: '#eef2f7',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: !app.isPackaged
    }
  });

  reportStartupPhase('window-created');

  mainWindow.webContents.setZoomFactor(0.9);
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.setZoomFactor(0.9);
    reportStartupPhase('renderer-did-finish-load');
    if (pendingLaunchRequest) {
      emitLaunchRequestToRenderer(pendingLaunchRequest);
    }
    runRendererE2EIfRequested().catch((error) => {
      logger.logError('RENDERER_E2E_FAILED', error);
    });
  });
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    reportStartupPhase('renderer-did-fail-load', {
      errorCode,
      errorDescription,
      validatedURL
    });
    logger.logError('RENDERER_DID_FAIL_LOAD', `${errorCode} | ${errorDescription} | ${validatedURL}`);
  });
  mainWindow.webContents.on('render-process-gone', (event, details) => {
    reportStartupPhase('renderer-process-gone', details || {});
    logger.logError('RENDERER_PROCESS_GONE', JSON.stringify(details || {}));
  });
  mainWindow.webContents.on('preload-error', (event, preloadPath, error) => {
    reportStartupPhase('renderer-preload-error', {
      preloadPath,
      message: error.message || String(error || '')
    });
    logger.logError('RENDERER_PRELOAD_ERROR', `${preloadPath} | ${error.stack || error.message || String(error || '')}`);
  });
  mainWindow.once('ready-to-show', () => {
    reportStartupPhase('window-ready-to-show');
  });

  mainWindow.webContents.setWindowOpenHandler(() => {
    logger.logOperation('SECURITY_BLOCK', 'Blocked external window creation attempt');
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const isBundledFile = url.startsWith('file://');
    const isDevelopmentServer = !app.isPackaged && url.startsWith(developmentServerUrl);
    if (isBundledFile || isDevelopmentServer) return;
    event.preventDefault();
    logger.logOperation('SECURITY_BLOCK', `Blocked main-frame navigation: ${url}`);
  });

  const bundledIndexPath = path.join(__dirname, '../../dist/index.html');
  if (app.isPackaged) {
    mainWindow.loadFile(bundledIndexPath).catch((error) => {
      reportStartupPhase('renderer-load-file-error', {
        message: error.message || String(error),
        bundledHtml: bundledIndexPath
      });
      throw error;
    });
  } else {
    mainWindow.loadURL(developmentServerUrl);
  }

  mainWindow.on('close', (event) => {
    if (isForceClosingApp) {
      return;
    }

    event.preventDefault();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('app-close-requested');
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  reportStartupPhase('app-ready');
  configService.init();
  logger.init(configService.getLogsPath(), configService.getConfig().logRetentionDays);
  logger.logOperation('APP_STARTUP', `Application started. Version: ${APP_META.releaseVersion}. Mode: ${configService.isPortableMode() ? 'Portable' : 'Installed'}`);
  queue.configure({
    concurrency: configService.getConfig().queueConcurrency,
    retryCount: configService.getConfig().queueRetryCount,
    operationTimeoutMs: configService.getConfig().operationTimeoutMs,
    persistenceEnabled: configService.getConfig().queuePersistenceEnabled,
    persistencePath: configService.getQueueStatePath()
  });
  pendingLaunchRequest = mergeLaunchRequests(pendingLaunchRequest, parseLaunchRequest(process.argv));

  createWindow();
  // A sincronização dos atalhos é manutenção e não pode atrasar a primeira janela.
  setTimeout(() => {
    syncWindowsPdfContextMenus().catch((error) => {
      logger.logError('WINDOWS_CONTEXT_MENU_SYNC_FAILED', error);
    });
  }, 0);

  queue.on('update', (queueStatus) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const sanitized = sanitizeQueueStatusForRenderer(queueStatus);
      mainWindow.webContents.send('queue-status-updated', sanitized);

      const liveIds = new Set(sanitized.map((task) => task.id));
      [...announcedOperationEvents].forEach((eventId) => {
        const taskId = eventId.replace(/:(completed|failed|timeout|cancelled|interrupted)$/, '');
        if (!liveIds.has(taskId)) {
          announcedOperationEvents.delete(eventId);
        }
      });

      sanitized.forEach((task) => {
        if (!['completed', 'failed', 'timeout', 'cancelled', 'interrupted'].includes(task.status)) return;
        const eventId = `${task.id}:${task.status}`;
        if (announcedOperationEvents.has(eventId)) return;
        announcedOperationEvents.add(eventId);
        mainWindow.webContents.send('operation-finished', task);
      });
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

ipcMain.on('startup-phase', (event, payload) => {
  reportStartupPhase(payload.phase || 'renderer-phase', payload.details || {});
});

app.on('second-instance', (event, commandLine = []) => {
  try {
    logger.logOperation('SECOND_INSTANCE_RECEIVED', `argv=${commandLine.join(' | ')}`);
  } catch {}
  if (!mainWindow || mainWindow.isDestroyed()) {
    pendingLaunchRequest = mergeLaunchRequests(pendingLaunchRequest, parseLaunchRequest(commandLine));
    createWindow();
    return;
  }

  const launchRequest = parseLaunchRequest(commandLine);
  const shouldBringToFront = mainWindow.isMinimized()
    || !mainWindow.isVisible()
    || hasExplicitOpenTarget(commandLine)
    || !!launchRequest;

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  if (!shouldBringToFront) {
    logger.logOperation('SECOND_INSTANCE_BACKGROUND_IGNORED', 'Ignored second-instance request without explicit open target.');
    return;
  }

  mainWindow.show();
  mainWindow.focus();
  if (launchRequest) {
    if (!emitLaunchRequestToRenderer(launchRequest)) {
      pendingLaunchRequest = mergeLaunchRequests(pendingLaunchRequest, launchRequest);
    }
  }
});

app.on('window-all-closed', () => {
  logger.logOperation('APP_SHUTDOWN', 'Application exiting');
  if (process.platform !== 'darwin') app.quit();
});

process.on('uncaughtException', (err) => {
  logger.logCrash(err);
  app.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.logError('UNHANDLED_REJECTION', reason instanceof Error ? reason : String(reason));
});

ipcMain.handle('get-app-meta', () => APP_META);
ipcMain.handle('consume-launch-request', () => {
  const request = pendingLaunchRequest;
  pendingLaunchRequest = null;
  return request;
});

ipcMain.handle('get-config', () => configService.getConfig());

ipcMain.handle('get-about-info', () => getAboutInfo());

ipcMain.handle('record-history-entry', (event, entry) => {
  if (!entry || typeof entry !== 'object') {
    throw new Error('Invalid history entry.');
  }
  const action = typeof entry.action === 'string' ? entry.action.trim() : '';
  const fileName = typeof entry.fileName === 'string' ? entry.fileName.trim() : '';
  const status = typeof entry.status === 'string' ? entry.status.trim() : '';
  if (!action || !fileName || !['sucesso', 'falha'].includes(status)) {
    throw new Error('Invalid history entry.');
  }

  configService.addHistoryEntry(action, fileName, status, {
    errorMessage: typeof entry.errorMessage === 'string' ? entry.errorMessage : '',
    outputPath: typeof entry.outputPath === 'string' ? entry.outputPath : '',
    outputDir: typeof entry.outputDir === 'string' ? entry.outputDir : ''
  });

  return { success: true };
});

ipcMain.handle('clear-recent-history', () => {
  configService.clearRecentHistory();
  logger.logOperation('SETTINGS_CHANGED', 'Recent history cleared.');
  return { success: true };
});

ipcMain.handle('log-renderer-error', (event, payload) => {
  const safePayload = payload && typeof payload === 'object' ? payload : {};
  const scope = typeof safePayload.scope === 'string' && safePayload.scope.trim()
    ? safePayload.scope.trim()
    : 'renderer';
  const message = typeof safePayload.message === 'string' && safePayload.message.trim()
    ? safePayload.message.trim()
    : 'Unknown renderer error';
  const stack = typeof safePayload.stack === 'string' ? safePayload.stack : '';
  const context = typeof safePayload.context === 'string' ? safePayload.context : '';
  const detail = [message, context, stack].filter(Boolean).join(' | ');
  logger.logError(`RENDERER_${scope.toUpperCase()}`, detail);
  return { success: true };
});

ipcMain.handle('copy-text', (event, value) => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('Invalid text content.');
  }
  clipboard.writeText(value);
  return { success: true };
});

ipcMain.handle('close-app', () => {
  logger.logOperation('APP_CLOSE_REQUEST', 'Graceful close requested from renderer.');
  isForceClosingApp = true;

  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.removeAllListeners('close');
      mainWindow.close();
    } catch (error) {
      logger.logOperation('APP_CLOSE_ERROR', `Failed to close main window gracefully: ${error.message}`);
    }
  }

  app.quit();
  return { success: true };
});

ipcMain.handle('force-close-app', () => {
  logger.logOperation('APP_FORCE_CLOSE_REQUEST', 'Force close requested from renderer.');
  isForceClosingApp = true;

  setTimeout(() => {
    try {
      app.exit(0);
    } catch (error) {
      logger.logOperation('APP_FORCE_CLOSE_ERROR', `Failed to force app exit: ${error.message}`);
    }
  }, 1200);

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.removeAllListeners('close');
    mainWindow.removeAllListeners('closed');
  }

  app.quit();
  return { success: true };
});

ipcMain.handle('update-theme', (event, theme) => {
  if (!['light', 'dark', 'system'].includes(theme)) {
    throw new Error('Invalid theme option.');
  }
  configService.updateTheme(theme);
  logger.logOperation('SETTINGS_CHANGED', `Theme set to ${theme}`);
  return true;
});

ipcMain.handle('update-color-theme', (event, color) => {
  if (!['random', 'blue', 'red', 'olive', 'violet'].includes(color)) {
    throw new Error('Invalid color theme option.');
  }
  configService.updateColorTheme(color);
  logger.logOperation('SETTINGS_CHANGED', `Color theme set to ${color}`);
  return true;
});

ipcMain.handle('update-output-dir', (event, dir) => {
  if (typeof dir !== 'string') {
    throw new Error('Invalid directory path format.');
  }
  if (dir) {
    assertDirectory(dir, 'Target directory does not exist.');
  }
  configService.updateOutputDir(dir);
  logger.logOperation('SETTINGS_CHANGED', `Default output directory updated (${dir ? 'custom' : 'origin-folder'})`);
  return true;
});

ipcMain.handle('select-directory', async () => {
  if (!mainWindow) return '';
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  return result.canceled ? '' : result.filePaths[0];
});

ipcMain.handle('convert-image-to-temp-pdf', async (event, imagePath) => {
  const { inspectConvertibleImage } = require('./services/image-conversion/image-validation');
  const inspection = inspectConvertibleImage(imagePath);
  if (!inspection.ok) {
    throw new Error('Imagem inválida ou não suportada.');
  }

  const tempDir = configService.getTempPath();
  const { convertImagesToPdf } = require('./services/image-conversion/image-to-pdf');
  const tempPdfName = `temp-redact-image-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.pdf`;
  const tempPdfPath = path.join(tempDir, tempPdfName);

  await fs.promises.mkdir(tempDir, { recursive: true });
  await convertImagesToPdf([imagePath], tempPdfPath);
  return tempPdfPath;
});

ipcMain.handle('convert-document-to-temp-pdf', async (event, documentPath) => {
  const { getDocumentExtension, convertDocumentToPdf } = require('./services/document-conversion/document-to-pdf');
  const extension = getDocumentExtension(documentPath);
  if (!['.docx', '.xlsx'].includes(extension)) {
    throw new Error('Selecione um documento DOCX ou XLSX válido.');
  }

  const tempDir = configService.getTempPath();
  const tempPdfName = `temp-document-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.pdf`;
  const tempPdfPath = path.join(tempDir, tempPdfName);
  await fs.promises.mkdir(tempDir, { recursive: true });
  return (await convertDocumentToPdf(documentPath, tempPdfPath)).outputPath;
});

ipcMain.handle('save-temp-file', async (event, { base64Data, extension }) => {
  if (typeof base64Data !== 'string' || base64Data.trim() === '') {
    throw new Error('Dados inválidos para arquivo temporário.');
  }
  const ext = String(extension || 'jpg').replace(/[^a-z0-9]/gi, '');
  const buffer = Buffer.from(base64Data, 'base64');
  
  const tempDir = configService.getTempPath();
  await fs.promises.mkdir(tempDir, { recursive: true });
  
  const tempFileName = `temp-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  const tempFilePath = path.join(tempDir, tempFileName);
  
  await fs.promises.writeFile(tempFilePath, buffer);
  return tempFilePath;
});

ipcMain.handle('delete-temp-paths', async (event, paths) => {
  if (!Array.isArray(paths)) {
    throw new Error('Lista de caminhos temporários inválida.');
  }

  await Promise.all(paths.map(async (targetPath) => {
    if (typeof targetPath !== 'string' || !targetPath.trim()) return;
    try {
      await fs.promises.unlink(targetPath);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.logError('TEMP_DELETE_FAILED', error);
      }
    }
  }));

  return true;
});

ipcMain.handle('move-temp-file-to-dest', async (event, { tempPath, targetName, outputDir: requestedOutputDir }) => {
  if (typeof tempPath !== 'string' || typeof targetName !== 'string') {
    throw new Error('Caminhos inválidos para movimentação.');
  }
  
  const config = configService.getConfig();
  // Temporary files are only an implementation detail. The caller may provide
  // the original document folder; otherwise keep the result beside the temp
  // file instead of silently redirecting it to Downloads or another folder.
  let outputDir = typeof requestedOutputDir === 'string' && requestedOutputDir.trim()
    ? requestedOutputDir.trim()
    : (config.defaultOutputDir || '').trim();
  const tempDir = path.resolve(configService.getTempPath());
  const relativeToTemp = outputDir ? path.relative(tempDir, path.resolve(outputDir)) : '';
  const outputIsTemp = outputDir && (
    relativeToTemp === ''
    || (relativeToTemp !== '..' && !relativeToTemp.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeToTemp))
  );
  if (!outputDir || outputIsTemp) {
    outputDir = app.getPath('downloads') || path.dirname(tempPath);
  }
  assertDirectory(outputDir, 'Pasta de saída inválida.');
  
  const finalPath = path.join(outputDir, targetName);
  await fs.promises.rename(tempPath, finalPath);
  return finalPath;
});

ipcMain.handle('get-queue-status', () => sanitizeQueueStatusForRenderer(queue.getQueueStatus()));

ipcMain.handle('cancel-operation', (event, taskId) => {
  if (typeof taskId !== 'string' || taskId.length === 0) {
    throw new Error('Invalid task ID.');
  }
  const cancelled = queue.cancel(taskId);
  if (cancelled) {
    logger.logOperation('OPERATION_CANCELLED', `Task ${taskId} cancelled by user`);
  }
  return cancelled;
});

ipcMain.handle('queue-operation', async (event, payload) => {
  try {
    if (!payload || typeof payload !== 'object') {
      throw new Error('Formato de envio inválido.');
    }

    const { type, files, options } = payload;
    if (!OPERATION_TYPES.has(type)) {
      throw new Error('Tipo de operação inválido.');
    }

    const preparedFiles = await validateFiles(type, files);
    const effectiveFiles = preparedFiles.files;
    const validationWarnings = preparedFiles.warnings;

    if (!options || typeof options !== 'object') {
      throw new Error('Parâmetros da operação inválidos.');
    }

    const outputDir = resolveOutputDirectory(effectiveFiles, options);

    if (type === 'organize') {
      validateOrganizeOptions(options);
    } else if (type === 'watermark') {
      validateWatermarkOptions(options);
    } else if (type === 'sign') {
      validateSignatureOptions(options);
    } else if (type === 'protect') {
      validateProtectOptions(options);
    } else if (type === 'unlock') {
      if (!options.password) {
        throw new Error('Informe a senha do PDF para desbloquear.');
      }
    } else if (type === 'redact') {
      validateRedactOptions(options);
    }

    const signatureDetections = type === 'images-to-pdf'
      ? []
      : effectiveFiles.filter((file) => pdfService.hasDigitalSignatures(file));
    if (signatureDetections.length > 0 && ['split-pages', 'split-range', 'split-size', 'organize', 'compress', 'watermark', 'sign', 'pdf-to-word', 'protect', 'unlock', 'redact'].includes(type)) {
      logger.logOperation('SIGNATURE_WARNING', `Operation ${type} contains digitally signed documents. Signatures will be invalidated.`);
    }

    const taskId = buildTaskId(type);
    const friendlyName = getFriendlyName(type);
    const taskDefinition = createTaskExecutor(type, effectiveFiles, options, outputDir);

    const enqueuedId = queue.enqueue({
      id: taskId,
      name: friendlyName,
      filePaths: effectiveFiles,
      quietNotifications: Boolean(options.quietNotifications),
      totalItems: taskDefinition.totalItems,
      createExecution: (updateProgress) => {
        logger.logOperation('OPERATION_START', `Task ${taskId} (${friendlyName}) started`);
        const execution = taskDefinition.createExecution(updateProgress);
        return {
          cancel: execution.cancel,
          promise: execution.promise.then(async (result) => {
            if (result.reduction !== undefined) {
              logger.logOperation('COMPRESSION_STATS', `File reduced by ${result.reduction}%`);
            }
            logger.logMetric('OPERATION_RUNTIME', {
              taskId,
              type,
              files: effectiveFiles.length,
              warnings: [...validationWarnings, ...getOperationalWarnings(type, effectiveFiles)],
              resultMemoryMb: result.memoryMb || 0,
              maxSupportedBytes: PDF_LIMITS.maxSupportedBytes
            });
            configService.addHistoryEntry(friendlyName, path.basename(effectiveFiles[0]), 'sucesso', {
              outputPath: result.outputPath || result.firstOutputPath || '',
              outputDir: result.outputDir || ''
            });
            logger.logOperation('OPERATION_SUCCESS', `Task ${taskId} completed successfully`);
            await cleanUpTempFiles(effectiveFiles, options);
            return result;
          }).catch(async (error) => {
            configService.addHistoryEntry(friendlyName, path.basename(effectiveFiles[0]), 'falha', {
              errorMessage: error.message || String(error)
            });
            logger.logError('OPERATION_FAILED', error);
            await cleanUpTempFiles(effectiveFiles, options);
            throw error;
          })
        };
      },
      maxAttempts: configService.getConfig().queueRetryCount + 1,
      timeoutMs: configService.getConfig().operationTimeoutMs
    });

    return {
      success: true,
      taskId: enqueuedId,
      warnings: [...validationWarnings, ...getOperationalWarnings(type, effectiveFiles)]
    };
  } catch (err) {
    logger.logError('QUEUE_ERROR', err);
    return {
      success: false,
      error: err.message || 'Não foi possível enviar esta operação para a fila.'
    };
  }
});

ipcMain.handle('export-diagnostics', async () => {
  if (!mainWindow) return { success: false };

  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Selecione a pasta para exportar diagnóstico',
    properties: ['openDirectory']
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { success: false, reason: 'canceled' };
  }

  const exportTargetDir = path.join(result.filePaths[0], `central-pdf-diagnostics-${Date.now()}`);
  try {
    await logger.exportDiagnostics(exportTargetDir, configService.getConfig(), queue.getHealthSummary());
    logger.logOperation('DIAGNOSTICS_EXPORTED', `Diagnostics package exported: ${path.basename(exportTargetDir)}`);
    return { success: true, path: exportTargetDir };
  } catch (err) {
    logger.logError('DIAGNOSTICS_EXPORT_FAILED', err);
    return { success: false, error: err.toString() };
  }
});

ipcMain.handle('export-basic-diagnostics', async () => {
  if (!mainWindow) return { success: false };

  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Selecione a pasta para exportar diagnóstico básico',
    properties: ['openDirectory']
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { success: false, reason: 'canceled' };
  }

  const exportTargetDir = path.join(result.filePaths[0], `central-pdf-basic-diagnostics-${Date.now()}`);

  try {
    const aboutInfo = getAboutInfo();
    await logger.exportDiagnostics(exportTargetDir, configService.getConfig(), {
      version: aboutInfo.app.version,
      build: aboutInfo.app.buildLabel,
      mode: aboutInfo.app.modeLabel,
      system: aboutInfo.system.platformLabel,
      memory: aboutInfo.system.memory,
      libraries: aboutInfo.technologies.map((item) => item.name)
    });
    logger.logOperation('BASIC_DIAGNOSTICS_EXPORTED', `Basic diagnostics package exported: ${path.basename(exportTargetDir)}`);
    return { success: true, path: exportTargetDir };
  } catch (err) {
    logger.logError('BASIC_DIAGNOSTICS_EXPORT_FAILED', err);
    return { success: false, error: err.toString() };
  }
});

ipcMain.handle('open-path', async (event, targetPath) => {
  if (typeof targetPath !== 'string' || !path.isAbsolute(targetPath)) {
    return { success: false, error: 'Caminho inválido.' };
  }
  if (!fs.existsSync(targetPath)) {
    return { success: false, error: 'O arquivo ou a pasta não existe mais.' };
  }
  try {
    const result = await shell.openPath(targetPath);
    return { success: !result, error: result || '' };
  } catch (error) {
    return { success: false, error: error.message || 'Não foi possível abrir o caminho selecionado.' };
  }
});

ipcMain.handle('path-exists', (event, targetPath) => {
  if (typeof targetPath !== 'string' || targetPath.trim().length === 0 || !path.isAbsolute(targetPath)) {
    return { success: true, exists: false };
  }

  return {
    success: true,
    exists: fs.existsSync(targetPath)
  };
});

ipcMain.handle('get-file-info', (event, filePath) => {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    return { success: false, error: 'Caminho inválido.' };
  }
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) return { success: false, error: 'O caminho informado não é um arquivo.' };
    return {
      success: true,
      path: filePath,
      name: path.basename(filePath),
      extension: path.extname(filePath).toLowerCase() || 'sem extensão',
      size: stats.size,
      createdAt: stats.birthtime.toISOString(),
      modifiedAt: stats.mtime.toISOString()
    };
  } catch (error) {
    return { success: false, error: error.message || 'Não foi possível ler as informações do arquivo.' };
  }
});

ipcMain.handle('reveal-path', async (event, targetPath) => {
  if (typeof targetPath !== 'string' || !path.isAbsolute(targetPath)) {
    return { success: false, error: 'Caminho inválido.' };
  }
  if (!fs.existsSync(targetPath)) {
    return { success: false, error: 'O arquivo ou a pasta não existe mais.' };
  }
  try {
    shell.showItemInFolder(targetPath);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message || 'Não foi possível localizar o caminho selecionado.' };
  }
});

ipcMain.handle('read-file-bytes', async (event, filePath) => {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    throw new Error('Invalid file path.');
  }
  const lowerPath = filePath.toLowerCase();
  const allowed = lowerPath.endsWith('.pdf') || lowerPath.endsWith('.png') || lowerPath.endsWith('.jpg') || lowerPath.endsWith('.jpeg');
  if (!allowed) {
    throw new Error('Only PDF and supported image files can be read for preview.');
  }
  if (!fs.existsSync(filePath)) {
    throw new Error('File does not exist.');
  }
  const stats = fs.statSync(filePath);
  if (stats.size > 50 * 1024 * 1024) {
    throw new Error('File too large for preview rendering.');
  }
  const buffer = await fs.promises.readFile(filePath);
  return buffer;
});






