const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, nativeImage } = require('electron');
const { nativeTheme, systemPreferences } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const cp = require('child_process');
const { performance } = require('perf_hooks');

const configService = require('./config-service');
const pdfService = require('./pdf-service');
const { APP_DEFAULTS } = require('./constants');
const queue = require('./queue');
const logger = require('./logger');
const { createPdfWorkerExecution } = require('./worker-runtime');
const { APP_META } = require('./app-meta');
const {
  inspectPdfFile,
  inspectPdfFileAsync,
  inspectImageFile,
  IMAGE_LIMITS,
  hasPdfEncryptionDictionaryAsync,
  resolveUniqueOutputPath,
  sanitizeFilename,
  PDF_LIMITS
} = require('./utils');
const { getImageBatchWarnings } = require('./services/image-conversion/image-validation');
const { createOcrTelemetryMetrics } = require('./services/ocr/ocr-telemetry');
const { getOcrRuntimeStatus } = require('./services/ocr/ocr-runtime');
const { createPendingOcrCancelRegistry } = require('./services/ocr/ocr-cancel-registry');
const { createPdfPreviewRangeSessions } = require('./services/ocr/pdf-preview-range-sessions');
const { cleanupStaleManagedTempFiles } = require('./managed-temp-cleanup');
const { isPathInsideDirectory, sanitizeManagedTempPaths: sanitizeManagedTempPathList } = require('./managed-temp-paths');
const { isPrivateDocumentOperation, createPrivateOperationFailureMetrics, createRendererFailureMetrics, getSafeFailureCode, getSafeOcrOperationErrorMessage } = require('./document-privacy');

const RECENT_UPLOAD_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const RECENT_UPLOAD_CACHE_MS = 8 * 1000;
const RECENT_UPLOAD_SCAN_BUDGET_MS = 1800;
const RECENT_UPLOAD_MAX_DIRECTORIES = 900;
const RECENT_UPLOAD_MAX_FILES = 6000;
const PDF_TO_WORD_ANALYSIS_MAX_BYTES = 64 * 1024 * 1024;
const pdfPreviewRangeSessions = createPdfPreviewRangeSessions({
  fs,
  path,
  inspectPdfFileAsync,
  getMaxFileSize: () => configService.getConfig().maxFileSizeLimit || PDF_LIMITS.maxSupportedBytes,
  maxSupportedBytes: PDF_LIMITS.maxSupportedBytes,
  createId: () => crypto.randomUUID()
});
const RECENT_UPLOAD_EXTENSIONS = new Set([
  '.pdf', '.jpg', '.jpeg', '.png', '.tif', '.tiff', '.docx', '.xlsx'
]);
const RECENT_UPLOAD_IGNORED_DIRECTORIES = new Set([
  'appdata', 'application data', 'cache', 'caches', 'cookies', 'local settings',
  'node_modules', 'recent', 'sendto', 'start menu', 'temp', 'temporary internet files'
]);
let recentUploadFilesCache = { expiresAt: 0, files: [], pending: null };

function normalizeRecentUploadExtensions(extensions) {
  if (!Array.isArray(extensions)) return [];
  return [...new Set(extensions
    .map((value) => String(value || '').trim().toLowerCase())
    .filter((value) => RECENT_UPLOAD_EXTENSIONS.has(value)))];
}

async function scanRecentUploadFiles() {
  const now = Date.now();
  const cutoff = now - RECENT_UPLOAD_MAX_AGE_MS;
  const deadline = now + RECENT_UPLOAD_SCAN_BUDGET_MS;
  const filesByPath = new Map();
  let scannedFiles = 0;

  const addCandidate = async (filePath, touchTimeMs) => {
    if (Date.now() > deadline || scannedFiles >= RECENT_UPLOAD_MAX_FILES) return;
    if (!filePath || typeof filePath !== 'string') return;
    const extension = path.extname(filePath).toLowerCase();
    if (!RECENT_UPLOAD_EXTENSIONS.has(extension)) return;
    scannedFiles += 1;
    try {
      const stats = await fs.promises.stat(filePath);
      const effectiveTouchMs = Math.max(stats.mtimeMs, Number(touchTimeMs) || 0);
      if (!stats.isFile() || stats.size <= 0 || effectiveTouchMs < cutoff || stats.mtimeMs > Date.now() + 5 * 60 * 1000) return;
      const key = path.resolve(filePath).toLowerCase();
      const existing = filesByPath.get(key);
      if (!existing || effectiveTouchMs > existing.modifiedAtMs) {
        filesByPath.set(key, {
          path: path.resolve(filePath),
          name: path.basename(filePath),
          extension,
          size: stats.size,
          modifiedAt: new Date(effectiveTouchMs).toISOString(),
          modifiedAtMs: effectiveTouchMs
        });
      }
    } catch (_) {
      // File could have been deleted or is not accessible
    }
  };

  // 1. Central PDF internal history (recent processed documents and outputs)
  try {
    const history = configService?.getConfig?.()?.recentHistory || [];
    for (const entry of history) {
      if (entry?.outputPath && typeof entry.outputPath === 'string') {
        await addCandidate(entry.outputPath, entry.timestamp ? new Date(entry.timestamp).getTime() : 0);
      }
    }
  } catch (_) {}

  // 2. Windows Recent Items: sort .lnk files by modification time DESCENDING so recently touched files come first!
  if (process.platform === 'win32' && Date.now() < deadline) {
    const recentItemsPath = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Recent');
    try {
      const dirEntries = await fs.promises.readdir(recentItemsPath, { withFileTypes: true });
      const lnkFiles = [];
      for (const entry of dirEntries) {
        if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.lnk') {
          try {
            const stat = await fs.promises.stat(path.join(recentItemsPath, entry.name));
            lnkFiles.push({ name: entry.name, mtimeMs: stat.mtimeMs });
          } catch (_) {}
        }
      }
      lnkFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);

      for (const lnk of lnkFiles) {
        if (Date.now() > deadline || filesByPath.size >= 160) break;
        try {
          const target = shell.readShortcutLink(path.join(recentItemsPath, lnk.name)).target;
          if (target && path.isAbsolute(target)) {
            await addCandidate(target, lnk.mtimeMs);
          }
        } catch (_) {}
      }
    } catch (_) {}
  }

  // 3. User standard folders: Downloads, Desktop, Documents (direct children newest-first)
  for (const folderName of ['downloads', 'desktop', 'documents']) {
    if (Date.now() > deadline) break;
    try {
      const folderPath = app.getPath(folderName);
      if (!folderPath) continue;
      const entries = await fs.promises.readdir(folderPath, { withFileTypes: true });
      const fileCandidates = [];
      for (const entry of entries) {
        if (entry.isFile() && RECENT_UPLOAD_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
          try {
            const stat = await fs.promises.stat(path.join(folderPath, entry.name));
            fileCandidates.push({ fullPath: path.join(folderPath, entry.name), mtimeMs: stat.mtimeMs });
          } catch (_) {}
        }
      }
      fileCandidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (const item of fileCandidates.slice(0, 30)) {
        if (Date.now() > deadline) break;
        await addCandidate(item.fullPath, item.mtimeMs);
      }
    } catch (_) {}
  }

  return [...filesByPath.values()]
    .sort((left, right) => right.modifiedAtMs - left.modifiedAtMs);
}

async function findRecentUploadFiles(extensions) {
  const acceptedExtensions = new Set(normalizeRecentUploadExtensions(extensions));
  if (acceptedExtensions.size === 0) return [];

  if (!recentUploadFilesCache.pending && Date.now() >= recentUploadFilesCache.expiresAt) {
    recentUploadFilesCache.pending = scanRecentUploadFiles()
      .then((files) => {
        recentUploadFilesCache.files = files;
        recentUploadFilesCache.expiresAt = Date.now() + RECENT_UPLOAD_CACHE_MS;
        return files;
      })
      .finally(() => {
        recentUploadFilesCache.pending = null;
      });
  }
  const files = recentUploadFilesCache.pending
    ? await recentUploadFilesCache.pending
    : recentUploadFilesCache.files;
  const cutoff = Date.now() - RECENT_UPLOAD_MAX_AGE_MS;
  const results = [];
  const candidates = files
    .filter((file) => acceptedExtensions.has(file.extension) && file.modifiedAtMs >= cutoff)
    .sort((left, right) => right.modifiedAtMs - left.modifiedAtMs)
    .slice(0, 40);
  for (const candidate of candidates) {
    if (results.length >= 8) break;
    try {
      const stats = await fs.promises.stat(candidate.path);
      if (!stats.isFile() || stats.size <= 0) continue;
      results.push({
        path: candidate.path,
        name: path.basename(candidate.path),
        size: stats.size,
        modifiedAt: candidate.modifiedAt || stats.mtime.toISOString()
      });
    } catch (_) {}
  }
  return results.sort((left, right) => new Date(right.modifiedAt) - new Date(left.modifiedAt));
}

function readRuntimeArgument(name) {
  const prefix = `--${name}=`;
  const value = process.argv.find((argument) => typeof argument === 'string' && argument.startsWith(prefix));
  if (value) return value.slice(prefix.length);
  try {
    return app.commandLine.getSwitchValue(name) || '';
  } catch {
    return '';
  }
}

let mainWindow = null;
let isForceClosingApp = false;
const announcedOperationEvents = new Set();
const activeOcrAreaJobs = new Map();
const activeOcrSearchJobs = new Map();
const activePdfToWordAnalyses = new Map();
const pendingOcrAreaCancels = createPendingOcrCancelRegistry();
const appIcon = nativeImage.createFromPath(path.join(__dirname, 'icon.ico'));
function getSystemAppearance() {
  let accentColor = null;
  try {
    const value = mainWindow?.getAccentColor?.();
    if (typeof value === 'string' && /^#[0-9a-f]{6,8}$/i.test(value)) {
      accentColor = value.slice(0, 7);
    }
    if (!accentColor) {
      const highlight = systemPreferences.getColor?.('highlight');
      if (typeof highlight === 'string' && /^#[0-9a-f]{6,8}$/i.test(highlight)) {
        accentColor = highlight.slice(0, 7);
      }
    }
  } catch {}
  return { shouldUseDarkColors: Boolean(nativeTheme.shouldUseDarkColors), accentColor };
}
const isE2EMode = process.env.CENTRAL_PDF_E2E === '1' || readRuntimeArgument('central-pdf-e2e') === '1';
const singleInstanceLock = isE2EMode
  ? true
  : app.requestSingleInstanceLock();
const startupTraceFile = process.env.CENTRAL_PDF_STARTUP_TRACE_FILE || readRuntimeArgument('central-pdf-startup-trace');
const startupTraceStartedAt = performance.now();
const e2eReportFile = process.env.CENTRAL_PDF_E2E_REPORT_FILE || readRuntimeArgument('central-pdf-e2e-report');
const e2eAssetsManifestFile = process.env.CENTRAL_PDF_E2E_ASSETS_MANIFEST || readRuntimeArgument('central-pdf-e2e-assets');
const developmentServerUrl = process.env.CENTRAL_PDF_DEV_SERVER_URL || readRuntimeArgument('central-pdf-dev-server') || 'http://localhost:5173';
let rendererE2eStarted = false;
let pendingLaunchRequest = null;
let resolveRendererBootstrap;
const rendererBootstrapReady = new Promise((resolve) => {
  resolveRendererBootstrap = resolve;
});

if (startupTraceFile) {
  try {
    fs.mkdirSync(path.dirname(startupTraceFile), { recursive: true });
    fs.appendFileSync(startupTraceFile, '', 'utf8');
  } catch (error) {
    process.stderr.write(`[startup-trace] ${error.message || String(error)}\n`);
  }
}

if (!singleInstanceLock) {
  process.stderr.write('[startup] outra instância já está ativa\n');
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
  '.tiff',
  '.docx',
  '.xlsx'
]);

const OPERATION_TYPES = new Set([
  'merge',
  'split-pages',
  'split-range',
  'split-size',
  'split-content',
  'organize',
  'compress',
  'watermark',
  'images-to-pdf',
  'files-to-pdf',
  'sign',
  'pdf-to-word',
  'protect',
  'unlock',
  'redact',
  'ocr',
  'redact-ocr-search'
]);

const WINDOWS_CONTEXT_ACTIONS = [
  { id: 'open', label: 'Abrir no Central PDF', multi: false },
  { id: 'organize', label: 'Organizar com Central PDF', multi: true },
  { id: 'merge', label: 'Mesclar no Central PDF', multi: true },
  { id: 'protect', label: 'Proteger com Central PDF', multi: false },
  { id: 'unlock', label: 'Desbloquear no Central PDF', multi: false },
  { id: 'compress', label: 'Reduzir tamanho com Central PDF', multi: false },
  { id: 'watermark', label: 'Marca d\'água com Central PDF', multi: true },
  { id: 'redact', label: 'Ocultar dados com Central PDF', multi: false },
  { id: 'ocr', label: 'Reconhecer texto com Central PDF', multi: false },
  { id: 'images-to-pdf', label: 'Converter para PDF com Central PDF', multi: true }
];

const WINDOWS_CONTEXT_ACTIONS_BY_EXTENSION = Object.freeze({
  '.pdf': ['organize', 'merge', 'compress'],
  '.docx': ['images-to-pdf'],
  '.xlsx': ['images-to-pdf'],
  '.webp': ['images-to-pdf', 'ocr', 'watermark'],
  '.bmp': ['images-to-pdf', 'ocr', 'watermark'],
  '.gif': ['images-to-pdf', 'ocr', 'watermark'],
  '.jpg': ['images-to-pdf', 'ocr', 'watermark'],
  '.jpeg': ['images-to-pdf', 'ocr', 'watermark'],
  '.png': ['images-to-pdf', 'ocr', 'watermark'],
  '.tif': ['ocr'],
  '.tiff': ['ocr']
});

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
  const candidateResults = Array.isArray(task.result?.candidates)
    ? task.result.candidates.slice(0, 500).map((candidate) => ({
        pageIndex: Number.isSafeInteger(candidate.pageIndex) && candidate.pageIndex >= 0 ? candidate.pageIndex : 0,
        xRatio: Number.isFinite(candidate.xRatio) ? Math.max(0, Math.min(1, candidate.xRatio)) : 0,
        yRatio: Number.isFinite(candidate.yRatio) ? Math.max(0, Math.min(1, candidate.yRatio)) : 0,
        widthRatio: Number.isFinite(candidate.widthRatio) ? Math.max(0, Math.min(1, candidate.widthRatio)) : 0,
        heightRatio: Number.isFinite(candidate.heightRatio) ? Math.max(0, Math.min(1, candidate.heightRatio)) : 0,
        confidence: Number.isFinite(candidate.confidence) ? Math.max(0, Math.min(100, candidate.confidence)) : 0
      })).filter((candidate) => candidate.widthRatio > 0 && candidate.heightRatio > 0)
    : undefined;
  const result = task.result && typeof task.result === 'object'
    ? {
        outputPath: typeof task.result.outputPath === 'string' ? task.result.outputPath : '',
        firstOutputPath: typeof task.result.firstOutputPath === 'string' ? task.result.firstOutputPath : '',
        outputDir: typeof task.result.outputDir === 'string' ? task.result.outputDir : '',
        outputCount: Number(task.result.outputCount || 0),
        orientationCorrections: Math.max(0, Number(task.result.orientationCorrections) || 0),
        preprocessingPages: Math.max(0, Number(task.result.preprocessingPages) || 0),
        reduction: task.result.reduction ?? null,
        format: typeof task.result.format === 'string' ? task.result.format : '',
        pageCount: Math.max(0, Number(task.result.pageCount || task.result.pageResults?.length) || 0),
        recognizedPages: Math.max(0, Number(task.result.recognizedPages) || 0),
        skippedPages: Math.max(0, Number(task.result.skippedPages) || 0),
        unselectedPages: Math.max(0, Number(task.result.unselectedPages) || 0),
        noTextPages: Math.max(0, Number(task.result.noTextPages) || 0),
        averageOcrConfidence: Number.isFinite(task.result.averageOcrConfidence)
          ? Math.max(0, Math.min(100, Math.round(task.result.averageOcrConfidence)))
          : null,
        failedFiles: Array.isArray(task.result.failures) ? task.result.failures.length : 0,
        warnings: Array.isArray(task.result.warnings)
          ? task.result.warnings.slice(0, 8)
            .filter((warning) => typeof warning === 'string' && warning.trim())
            .map((warning) => [...warning]
              .map((character) => {
                const code = character.charCodeAt(0);
                return code < 32 || code === 127 ? ' ' : character;
              })
              .join('')
              .slice(0, 1000))
          : [],
        extractedCharacters: Number(task.result.extractedCharacters || 0),
        usedOcr: Boolean(task.result.usedOcr),
        ...(task.result.ocr && typeof task.result.ocr === 'object' ? {
          ocr: {
            recognizedPages: Math.max(0, Number(task.result.ocr.recognizedPages) || 0),
            skippedPages: Math.max(0, Number(task.result.ocr.skippedPages) || 0),
            copyOriginal: task.result.ocr.copyOriginal === true
          }
        } : {}),
        ...(candidateResults ? {
          candidates: candidateResults,
          scannedPages: Math.max(0, Number(task.result.scannedPages) || 0),
          skippedPages: Math.max(0, Number(task.result.skippedPages) || 0),
          totalMatches: Math.max(0, Number(task.result.totalMatches) || 0),
          lowConfidenceMatches: Math.max(0, Number(task.result.lowConfidenceMatches) || 0),
          truncated: Boolean(task.result.truncated),
          minimumConfidence: Math.max(0, Math.min(100, Number(task.result.minimumConfidence) || 0)),
          fileName: typeof task.result.fileName === 'string' ? path.basename(task.result.fileName).slice(0, 255) : ''
        } : {})
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
    process.stderr.write(`[startup-trace] ${error.message || String(error)}\n`);
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
    open: 'open',
    abrir: 'open',
    'images-to-pdf': 'images-to-pdf',
    ocr: 'ocr',
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
    action: action || (files.length > 0 && files.every((file) => ['.docx', '.xlsx'].includes(file.ext)) ? 'images-to-pdf' : 'organize'),
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
    : `"${exePath}" --action=${actionId} "%1"`;
}

async function syncWindowsPdfContextMenus() {
  if (!canSyncWindowsContextMenus()) return;
  const syncVersion = String(APP_META.buildLabel || APP_META.releaseVersion || '1');
  const versionValue = 'CentralPDF.ContextMenuVersion';
  try {
    for (const [extension, actionIds] of Object.entries(WINDOWS_CONTEXT_ACTIONS_BY_EXTENSION)) {
      const baseKeys = [
        `HKCU\\Software\\Classes\\SystemFileAssociations\\${extension}\\shell`,
        `HKCU\\Software\\Classes\\${extension}\\shell`
      ];
      const actions = actionIds
        .map((id) => WINDOWS_CONTEXT_ACTIONS.find((action) => action.id === id))
        .filter(Boolean);

      for (const baseKey of baseKeys) {
        try {
          const currentVersion = await runRegCommandAsync(['query', baseKey, '/v', versionValue]);
          if (currentVersion.stdout.includes(syncVersion)) continue;
        } catch {
          // A chave ainda não existe na primeira execução; os comandos `add` abaixo a criarão.
        }

        // Remove older Central PDF entries so upgrades cannot leave stale commands behind.
        const staleActions = extension === '.pdf'
          ? WINDOWS_CONTEXT_ACTIONS
          : WINDOWS_CONTEXT_ACTIONS.filter((action) => actionIds.includes(action.id));
        for (const action of staleActions) {
          try {
            await runRegCommandAsync(['delete', `${baseKey}\\CentralPDF.${action.id}`, '/f']);
          } catch {
            // Old versions or file types may not have registered this action.
          }
        }

        for (const action of actions) {
          const actionKey = `${baseKey}\\CentralPDF.${action.id}`;
          await runRegCommandAsync(['add', actionKey, '/ve', '/d', action.label, '/f']);
          await runRegCommandAsync(['add', actionKey, '/v', 'Icon', '/d', `"${process.execPath}",0`, '/f']);
          await runRegCommandAsync(['add', actionKey, '/v', 'MultiSelectModel', '/d', action.multi ? 'Player' : 'Single', '/f']);
          await runRegCommandAsync(['add', `${actionKey}\\command`, '/ve', '/d', buildContextMenuCommand(action.id, { multi: action.multi }), '/f']);
        }
        await runRegCommandAsync(['add', baseKey, '/v', versionValue, '/d', syncVersion, '/f']);
      }
    }
    logger.logOperation('WINDOWS_CONTEXT_MENU_SYNCED', `Synced context shortcuts for ${Object.keys(WINDOWS_CONTEXT_ACTIONS_BY_EXTENSION).length} file types.`);
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

function buildRendererE2EScript({ manifest, outputDir }) {
  const manifestJson = JSON.stringify(manifest || {});
  const outputDirJson = JSON.stringify(outputDir || '');
  const testPasswordJson = JSON.stringify(process.env.CENTRAL_PDF_E2E_TEST_PASSWORD || 'SenhaForte123!');
  const e2eStepFilterJson = JSON.stringify(String(process.env.CENTRAL_PDF_E2E_STEPS || '').split(',').map((step) => step.trim()).filter(Boolean));
  return `
    (async () => {
      const manifest = ${manifestJson};
      const signatureFixtureType = String(manifest.signedFixtureType || 'unknown');
      const e2eStepFilter = new Set(${e2eStepFilterJson});

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
          signatureInput: (() => {
            const input = document.getElementById('signature-file-input');
            const file = input?.files?.[0];
            let path = '';
            try { path = file ? window.api?.getPathForFile?.(file) || '' : ''; } catch {}
            return { exists: Boolean(input), count: input?.files?.length || 0, name: file?.name || '', path, dropzoneReady: input?.dataset.dropzoneReady === 'true' };
          })(),
          signatureState: { hasFile: Boolean(window.__CENTRAL_PDF_TEST_API__?.state?.signatureFile), pageCount: window.__CENTRAL_PDF_TEST_API__?.state?.signaturePageCount || 0 },
          feedback: String(document.querySelector('[role="status"], [role="alert"], .toast-message')?.innerText || '').slice(0, 240),
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

      async function sha256File(filePath) {
        const bytes = toArrayBuffer(await window.api.readFileBytes(filePath));
        const digest = await window.crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
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
      const e2eOutputDir = ${outputDirJson};
      const capturedTasks = [];
      const finishedTasks = [];
      const results = [];
      let blockRemainingE2eSteps = false;
      let completedOcrResultPath = '';
      const originalQueueOperation = window.api.queueOperation.bind(window.api);
      const unsubscribeFinished = window.api.onOperationFinished((task) => {
        finishedTasks.push(task);
      });

      async function queuePayload(payload) {
        payload.options = payload.options || {};
        payload.options.outputDir = e2eOutputDir;
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

      async function waitForTask(type, timeoutMs = 15 * 60 * 1000) {
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

      async function cancelLingeringE2eWork() {
        let cleanupFailure = '';
        try {
          api.ocrAreaExtractor?.cancelAll?.();
          await waitFor(() => {
            const current = api.ocrAreaExtractor?.getState?.();
            return !current?.busy && !current?.searching;
          }, 20000, 'encerramento da pesquisa/extração OCR');
        } catch (error) {
          cleanupFailure = error.message || String(error);
        }
        try {
          const current = await window.api.getQueueStatus();
          const active = (current || []).filter((task) => ['pending', 'running'].includes(task.status));
          await Promise.allSettled(active.map((task) => window.api.cancelOperation(task.id)));
          const activeIds = new Set(active.map((task) => task.id));
          if (activeIds.size) {
            await waitFor(async () => {
              const refreshed = await window.api.getQueueStatus();
              return !(refreshed || []).some((task) => activeIds.has(task.id) && ['pending', 'running'].includes(task.status));
            }, 20000, 'limpeza das tarefas E2E canceladas');
          }
        } catch (error) {
          cleanupFailure ||= error.message || String(error);
        }
        return cleanupFailure;
      }

      // OCR may legitimately take several minutes on a busy workstation.
      // Keep a failed/expired step from leaving a file lock that poisons later tests.
      async function runStep(name, fn, timeoutMs = 15 * 60 * 1000) {
        if (blockRemainingE2eSteps) {
          results.push({ name, ok: false, skipped: true, durationMs: 0, detail: 'Ignorada porque uma etapa anterior excedeu o limite e a fila não confirmou o encerramento seguro.' });
          return;
        }
        if (e2eStepFilter.size && !e2eStepFilter.has(name)) {
          results.push({ name, ok: true, skipped: true, durationMs: 0, detail: 'Ignorada pelo filtro CENTRAL_PDF_E2E_STEPS' });
          return;
        }
        const startedAt = Date.now();
        let timeoutHandle = null;
        window.api?.reportStartupPhase?.('e2e-step-start', { step: name });
        try {
          const detail = await Promise.race([
            fn(),
            new Promise((_, reject) => { timeoutHandle = window.setTimeout(() => reject(new Error('Timeout interno da etapa')), timeoutMs); })
          ]);
          results.push({
            name,
            ok: true,
            durationMs: Date.now() - startedAt,
            detail: detail || ''
          });
          window.api?.reportStartupPhase?.('e2e-step-finish', { step: name, ok: true, durationMs: Date.now() - startedAt, detail: detail || '' });
        } catch (error) {
          const cleanupFailure = await cancelLingeringE2eWork();
          if (cleanupFailure) blockRemainingE2eSteps = true;
          const stackContext = String(error.stack || '').split(String.fromCharCode(10)).slice(1, 4).map((line) => line.trim()).join(' | ');
          const detail = [error.message || String(error), stackContext, cleanupFailure ? 'Limpeza OCR: ' + cleanupFailure : ''].filter(Boolean).join(' | ');
          results.push({
            name,
            ok: false,
            durationMs: Date.now() - startedAt,
            detail
          });
          window.api?.reportStartupPhase?.('e2e-step-finish', { step: name, ok: false, durationMs: Date.now() - startedAt, detail });
        } finally {
          if (timeoutHandle !== null) window.clearTimeout(timeoutHandle);
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

      async function waitForSearchResults(statusId, resultsSelector, label, timeoutMs) {
        return waitFor(() => {
          const status = document.getElementById(statusId);
          const tone = status?.dataset.tone || '';
          if (tone === 'error' || tone === 'warning') {
            throw new Error(label + ': ' + (status?.textContent?.trim() || 'a busca não encontrou resultado'));
          }
          return tone === 'success' && document.querySelectorAll(resultsSelector).length > 0;
        }, timeoutMs, label);
      }

      const password = ${testPasswordJson};

      await runStep('startup renderer', async () => {
        await waitFor(() => document.body && api.dom && api.switchTab, 10000, 'renderer pronto');
        return 'Renderer inicializado';
      });

      await runStep('signature-native-file-input', async () => {
        api.switchTab('signature', { skipGuard: true });
        await waitFor(
          () => state.signatureFile && state.signaturePdfDoc && state.signaturePageCount > 0,
          30000,
          'seletor nativo da assinatura'
        );

        const fileInput = document.getElementById('signature-file-input');
        const workspace = document.getElementById('signature-workspace');
        const dock = workspace?.querySelector('.module-output-dock');
        const fileInputStyle = fileInput ? getComputedStyle(fileInput) : null;
        const dockStyle = dock ? getComputedStyle(dock) : null;

        if (!workspace || workspace.classList.contains('hidden')) {
          throw new Error('Workspace da assinatura permaneceu oculto após selecionar o PDF.');
        }
        if (!fileInputStyle || fileInputStyle.pointerEvents !== 'none' || Number(fileInputStyle.opacity) !== 0) {
          throw new Error('O seletor nativo de arquivo ainda está visível sobre o dropzone.');
        }
        if (!dockStyle || dockStyle.position !== 'fixed') {
          throw new Error('A barra de saída não está fixa no rodapé da janela.');
        }

        const selectedName = state.signatureFile.name || '';
        api.signatureWorkspace.clearWorkspace();
        return selectedName + ' | dock fixo';
      }, 60000);

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

      await runStep('ocr-signed-pdf-warning', async () => {
        if (signatureFixtureType === 'cms-detached-self-signed-v1') {
          const signatureBytes = new Uint8Array(toArrayBuffer(await window.api.readFileBytes(files.signedValidPdf)));
          const signaturePdfText = new TextDecoder().decode(signatureBytes);
          const byteRangeMatch = signaturePdfText.match(new RegExp('/ByteRange\\\\s*\\\\[\\\\s*0\\\\s+(\\\\d+)\\\\s+(\\\\d+)\\\\s+(\\\\d+)\\\\s*\\\\]'));
          const contentsMatch = signaturePdfText.match(new RegExp('/Contents\\\\s*<([0-9a-f]+)>', 'i'));
          const firstLength = Number(byteRangeMatch?.[1]);
          const secondStart = Number(byteRangeMatch?.[2]);
          const secondLength = Number(byteRangeMatch?.[3]);
          if (!byteRangeMatch || !contentsMatch || firstLength <= 0 || secondStart <= firstLength || secondStart + secondLength !== signatureBytes.length || !/[1-9a-f]/i.test(contentsMatch[1])) {
            throw new Error('O fixture marcado como CMS destacado não contém intervalos e conteúdo de assinatura coerentes.');
          }
        }
        const signatureSourceHash = await sha256File(files.signedValidPdf);
        if (manifest.signedFixtureSha256 && signatureSourceHash !== manifest.signedFixtureSha256) {
          throw new Error('O SHA-256 do fixture de assinatura não corresponde ao manifesto de testes.');
        }
        const queued = await queuePayload({
          type: 'ocr',
          files: [files.signedValidPdf],
          options: { language: 'por+eng', mode: 'auto', format: 'pdf', outputName: 'e2e_assinatura_preservada.pdf', zipResults: false }
        });
        if (!queued.warnings?.some((warning) => /assinado digitalmente pode invalidar/i.test(warning))) {
          throw new Error('O OCR não exibiu, ao entrar na fila, o aviso sobre possível invalidação da assinatura digital. Avisos recebidos: ' + JSON.stringify(queued.warnings || []));
        }
        const task = await ensureCompleted('ocr');
        const signatureSourceHashAfter = await sha256File(files.signedValidPdf);
        if (signatureSourceHashAfter !== signatureSourceHash) {
          throw new Error('O OCR alterou os bytes do PDF de origem com marcador de assinatura.');
        }
        const signedOutputPath = task.result?.outputPath || task.result?.firstOutputPath || '';
        if (!signedOutputPath) {
          throw new Error('A tarefa OCR terminou sem informar o caminho da saída. Detalhes seguros: ' + JSON.stringify({
            outputDir: task.result?.outputDir || '',
            outputCount: task.result?.outputCount || 0,
            pageCount: task.result?.pageCount || 0,
            warnings: task.result?.warnings || []
          }));
        }
        try {
          await window.api.readFileBytes(signedOutputPath);
        } catch {
          throw new Error('O aviso de assinatura foi exibido, mas o arquivo de saída informado não pode ser aberto.');
        }
        const fixtureDescription = signatureFixtureType === 'cms-detached-self-signed-v1'
          ? 'fixture CMS destacado com certificado de teste verificado'
          : 'fixture de marcador; assinatura criptográfica não verificada';
        return 'aviso exibido antes do OCR; saída criada e SHA-256 do original preservado; ' + fixtureDescription;
      });

      await runStep('ocr', async () => {
        api.switchTab('ocr', { skipGuard: true });
        await api.handleOcrFiles([await makeFileLike(files.landscapePng), await makeFileLike(files.smallPdf)]);
        if (state.ocrFiles.length !== 2 || state.ocrFiles.some((entry) => entry.validation?.status !== 'valid')) {
          throw new Error(state.ocrFiles.find((entry) => entry.validation?.status !== 'valid')?.validation?.message || 'O upload OCR não foi validado corretamente.');
        }
        if (!state.ocrRuntime?.available || !['por', 'eng'].every((language) => state.ocrRuntime.availableLanguages.includes(language))) {
          throw new Error(state.ocrRuntime?.message || 'Os modelos OCR de português e inglês não foram detectados no aplicativo empacotado.');
        }
        if (document.getElementById('ocr-settings-card')?.classList.contains('hidden')) {
          throw new Error('As configurações OCR não foram abertas após o upload.');
        }
        if (!document.getElementById('ocr-dropzone')?.classList.contains('hidden')) {
          throw new Error('A área de envio permaneceu aberta após carregar o arquivo OCR.');
        }
        await waitFor(() => api.ocrAreaExtractor.getState().pageCount > 0, 20000, 'prévia OCR do PDF carregado');
        const areaFileSelect = document.getElementById('ocr-area-file');
        const pdfEntries = state.ocrFiles.filter((entry) => entry.name.toLowerCase().endsWith('.pdf'));
        const selectedPdfIndex = pdfEntries.findIndex((entry) => entry.path === files.smallPdf);
        if (selectedPdfIndex < 0 || areaFileSelect.options.length !== pdfEntries.length) {
          throw new Error('A lista de PDFs da ferramenta de extração por região não corresponde aos arquivos validados.');
        }
        if (areaFileSelect.value !== String(selectedPdfIndex)) {
          areaFileSelect.value = String(selectedPdfIndex);
          areaFileSelect.dispatchEvent(new Event('change', { bubbles: true }));
        }
        await waitFor(() => api.ocrAreaExtractor.getState().pageCount > 0 && !document.getElementById('btn-ocr-area-draw')?.disabled, 20000, 'PDF pronto para marcar área');
        const documentSearchInput = document.getElementById('ocr-document-search-input');
        const ocrLanguageSelect = document.getElementById('ocr-language');
        if (ocrLanguageSelect) {
          ocrLanguageSelect.value = 'eng';
          ocrLanguageSelect.dispatchEvent(new Event('change', { bubbles: true }));
        }
        documentSearchInput.value = 'Small Test PDF';
        document.getElementById('btn-ocr-document-search')?.click();
        await waitForSearchResults('ocr-document-search-status', '.ocr-document-search-result', 'busca textual/OCR no PDF', 310_000);
        document.querySelector('.ocr-document-search-result')?.click();
        await waitFor(() => document.querySelectorAll('#ocr-area-search-highlights .ocr-area-search-highlight').length > 0, 5000, 'destaque de resultado da busca no PDF');
        document.getElementById('btn-ocr-area-draw')?.click();
        const areaCanvas = document.getElementById('ocr-area-canvas');
        const areaBounds = areaCanvas.getBoundingClientRect();
        const pointerEvent = (type, clientX, clientY) => new PointerEvent(type, { bubbles: true, pointerId: 71, isPrimary: true, button: 0, clientX, clientY });
        areaCanvas.dispatchEvent(pointerEvent('pointerdown', areaBounds.left + areaBounds.width * 0.05, areaBounds.top + areaBounds.height * 0.05));
        areaCanvas.dispatchEvent(pointerEvent('pointermove', areaBounds.left + areaBounds.width * 0.95, areaBounds.top + areaBounds.height * 0.95));
        areaCanvas.dispatchEvent(pointerEvent('pointerup', areaBounds.left + areaBounds.width * 0.95, areaBounds.top + areaBounds.height * 0.95));
        await waitFor(() => api.ocrAreaExtractor.getState().hasSelection, 5000, 'seleção de região para OCR');
        document.getElementById('btn-ocr-area-extract')?.click();
        await waitFor(() => api.ocrAreaExtractor.getState().busy, 5000, 'início do reconhecimento da região');
        const cancelAcknowledgement = await api.ocrAreaExtractor.cancel();
        if (!cancelAcknowledgement?.accepted) throw new Error('O aplicativo não confirmou o pedido de cancelamento do OCR regional.');
        await waitFor(() => !api.ocrAreaExtractor.getState().busy, 15000, 'cancelamento do reconhecimento da região');
        if (!/cancelad/i.test(document.getElementById('ocr-area-status')?.textContent || '')) {
          throw new Error('O cancelamento da extração por região não foi informado claramente.');
        }
        document.getElementById('btn-ocr-area-extract')?.click();
        await waitFor(() => api.ocrAreaExtractor.getState().busy, 5000, 'nova extração após cancelamento');
        await waitFor(() => !api.ocrAreaExtractor.getState().busy, 5 * 60 * 1000, 'fim do reconhecimento da região');
        const areaText = document.getElementById('ocr-area-text')?.value || '';
        const areaStatus = document.getElementById('ocr-area-status')?.textContent || '';
        if (areaText.trim().length < 20 || document.getElementById('ocr-area-status')?.dataset.tone !== 'success') {
          throw new Error('A extração OCR da região não retornou texto utilizável. Estado: ' + areaStatus + '; caracteres: ' + areaText.length);
        }
        await queuePayload({
          type: 'ocr',
          files: state.ocrFiles.map((entry) => entry.path),
          options: {
            language: 'por+eng',
            mode: 'auto',
            format: 'pdf',
            outputName: 'e2e_ocr.pdf',
            zipResults: false
          }
        });
        const task = await ensureCompleted('ocr');
        if (task.name !== 'Reconhecer texto (OCR)') {
          throw new Error('A operação OCR apareceu sem nome correto na fila: ' + String(task.name || '(vazio)'));
        }
        return 'upload validado; busca nativa com navegação/destaque; OCR regional, cancelamento e nova tentativa testados; ' + (task.result.outputPath || task.result.firstOutputPath || '');
      }, 15 * 60 * 1000);

      await runStep('ocr-complete', async () => {
        await queuePayload({
          type: 'ocr',
          files: [files.smallPdf],
          options: {
            language: 'por+eng',
            mode: 'complete',
            format: 'pdf',
            outputName: 'e2e_ocr_completo.pdf',
            zipResults: false
          }
        });
        const task = await ensureCompleted('ocr');
        if (Number(task.result.pageCount) !== 2 || Number(task.result.recognizedPages) !== 2 || !(task.result.firstOutputPath || task.result.outputPath)) {
          throw new Error('O modo completo não analisou todas as páginas do PDF de teste.');
        }
        completedOcrResultPath = task.result.firstOutputPath || task.result.outputPath;
        if (!Number.isFinite(task.result.averageOcrConfidence) || task.result.averageOcrConfidence < 0 || task.result.averageOcrConfidence > 100
          || Object.hasOwn(task.result, 'pageResults') || Number(task.result.noTextPages) !== 0) {
          throw new Error('O resumo OCR da fila não informou métricas seguras sem expor o texto reconhecido.');
        }
        return 'Todas as ' + task.result.pageCount + ' páginas foram analisadas; arquivo original mantido.';
      });

      await runStep('ocr-redo', async () => {
        if (!completedOcrResultPath) throw new Error('O teste de OCR completo não gerou o arquivo necessário para validar a substituição da camada.');
        await queuePayload({
          type: 'ocr',
          files: [completedOcrResultPath],
          options: {
            language: 'por+eng',
            mode: 'redo',
            format: 'pdf',
            outputName: 'e2e_ocr_refeito.pdf',
            zipResults: false
          }
        });
        const redoTask = await ensureCompleted('ocr');
        if (Number(redoTask.result.recognizedPages) !== 2
          || !(redoTask.result.firstOutputPath || redoTask.result.outputPath)) {
          throw new Error('Refazer OCR não substituiu a camada rastreável no PDF de teste.');
        }
        return 'Camada OCR substituída sem alterar o arquivo de origem.';
      });

      await runStep('ocr-batch-utility-cancel', async () => {
        const queued = await queuePayload({
          type: 'ocr',
          files: [files.landscapePng, files.signedValidPdf, files.portraitPng],
          options: { language: 'eng', mode: 'auto', format: 'pdf', outputName: 'e2e_ocr_lote_cancelado.pdf', zipResults: false }
        });
        const activeThirdItem = await waitFor(async () => {
          const queue = await window.api.getQueueStatus();
          const task = (queue || []).find((item) => item.id === queued.taskId);
          if (!task || ['completed', 'failed', 'timeout', 'cancelled', 'interrupted'].includes(task.status)) return null;
          return task.currentItem === 3 && task.itemProgress > 0 ? task : null;
        }, 90000, 'início do reconhecimento do terceiro arquivo no lote OCR');
        const accepted = await window.api.cancelOperation(queued.taskId);
        if (!accepted) throw new Error('A fila não aceitou o cancelamento do lote OCR no utilityProcess.');
        const task = await waitForTask('ocr', 30000);
        if (task.status !== 'cancelled') {
          throw new Error('O lote OCR não encerrou como cancelado após começar o terceiro arquivo: ' + String(task.status || 'estado desconhecido'));
        }
        return 'utilityProcess processou a primeira imagem, leu um PDF por faixas e iniciou a terceira imagem antes de confirmar o cancelamento (item ' + activeThirdItem.currentItem + '/3).';
      }, 120000);

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

      await runStep('merge-searchable-native', async () => {
        const queued = await queuePayload({
          type: 'merge',
          files: [files.smallPdf, files.mediumPdf],
          options: {
            searchableOcr: true,
            ocrLanguage: 'eng',
            outputName: 'e2e_mesclado_nativo_pesquisavel.pdf',
            zipResults: false,
            cleanupPaths: []
          }
        });
        const task = await ensureCompleted('merge');
        if (!task.result.outputPath || !task.result.ocr?.copyOriginal
          || task.result.ocr.recognizedPages !== 0 || task.result.ocr.skippedPages < 2) {
          throw new Error('A mesclagem pesquisável nativa não preservou o resumo seguro do OCR: ' + JSON.stringify(task.result));
        }
        return 'mesclagem nativa concluída sem reserialização; resumo OCR seguro preservado para a interface; tarefa ' + queued.taskId;
      });

      await runStep('split-pages', async () => {
        api.switchTab('split', { skipGuard: true });
        api.handleSplitFile(await makeFileLike(files.smallPdf));
        const contentMode = document.querySelector('input[name="split-mode"][value="content"]');
        contentMode.checked = true;
        contentMode.dispatchEvent(new Event('change', { bubbles: true }));
        document.getElementById('split-content-query').value = 'Validation line 1 - asset small';
        document.getElementById('btn-split-content-analyze').click();
        await waitForSearchResults('split-content-status', '#split-content-result-list input[type="checkbox"]', 'pontos de separação por conteúdo', 310_000);
        const contentBreak = document.querySelector('#split-content-result-list input[type="checkbox"][value="2"]');
        if (!contentBreak?.checked) throw new Error('A busca por conteúdo não identificou a página 2 como ponto de corte.');
        state.operationOutputDirs['split-pages'] = e2eOutputDir;
        const contentQueued = await api.queueSplit();
        if (!contentQueued?.success || !contentQueued.taskId) throw new Error(contentQueued?.error || 'A divisão por conteúdo não entrou na fila.');
        capturedTasks.push({ type: 'split-content', taskId: contentQueued.taskId, success: true, error: '' });
        const contentTask = await ensureCompleted('split-content');
        if (contentTask.result.outputCount !== 2) {
          throw new Error('A divisão por conteúdo não respeitou os pontos selecionados.');
        }

        api.handleSplitFile(await makeFileLike(files.scannedContentSplitPdf));
        const scannedContentMode = document.querySelector('input[name="split-mode"][value="content"]');
        scannedContentMode.checked = true;
        scannedContentMode.dispatchEvent(new Event('change', { bubbles: true }));
        document.getElementById('split-content-query').value = 'SCANNED PAGE TWO MARKER';
        document.getElementById('btn-split-content-analyze').click();
        await waitForSearchResults('split-content-status', '#split-content-result-list input[type="checkbox"]', 'ponto de separação em página digitalizada via OCR', 310_000);
        const scannedContentBreak = document.querySelector('#split-content-result-list input[type="checkbox"][value="2"]');
        if (!scannedContentBreak?.checked || !document.querySelector('#split-content-result-list')?.textContent.includes('texto reconhecido')) {
          throw new Error('A busca por conteúdo não identificou a página digitalizada 2 via OCR para revisão.');
        }
        const scannedSplitQueued = await api.queueSplit();
        if (!scannedSplitQueued?.success || !scannedSplitQueued.taskId) {
          throw new Error(scannedSplitQueued?.error || 'A divisão OCR por conteúdo não entrou na fila.');
        }
        capturedTasks.push({ type: 'split-content', taskId: scannedSplitQueued.taskId, success: true, error: '' });
        const scannedContentTask = await ensureCompleted('split-content');
        if (scannedContentTask.result.outputCount !== 2) {
          throw new Error('A divisão revisada por OCR não gerou duas partes conforme o corte selecionado.');
        }

        api.handleSplitFile(await makeFileLike(files.recurringTitleSplitPdf));
        document.getElementById('split-content-query').value = '';
        document.getElementById('btn-split-content-suggest').click();
        await waitFor(() => {
          const status = document.getElementById('split-content-status');
          return status?.dataset.tone === 'success'
            && document.querySelectorAll('#split-content-result-list input[type="checkbox"]').length > 0;
        }, 120_000, 'sugestões de início por títulos recorrentes');
        const suggestedRows = [...document.querySelectorAll('#split-content-result-list label')];
        const suggestedStart = suggestedRows.find((row) => row.textContent.includes('Página 3')
          && row.textContent.includes('SERVICE ORDER 2026')
          && row.textContent.includes('OCR')
          && row.textContent.includes('aparece em 2 páginas'));
        const suggestedChecks = suggestedRows.map((row) => row.querySelector('input[type="checkbox"]')).filter(Boolean);
        if (!suggestedStart || suggestedChecks.length !== 1 || suggestedChecks[0].checked) {
          throw new Error('A sugestão não isolou o início provável da página 3 ou não exigiu confirmação manual. Linhas: '
            + suggestedRows.map((row) => row.textContent).join(' | '));
        }
        suggestedChecks[0].checked = true;
        suggestedChecks[0].dispatchEvent(new Event('change', { bubbles: true }));
        const suggestedSplit = await api.queueSplit();
        if (!suggestedSplit?.success || !suggestedSplit.taskId) {
          throw new Error(suggestedSplit?.error || 'O corte escolhido a partir de uma sugestão não entrou na fila.');
        }
        capturedTasks.push({ type: 'split-content', taskId: suggestedSplit.taskId, success: true, error: '' });
        const suggestedSplitTask = await ensureCompleted('split-content');
        if (suggestedSplitTask.result.outputCount !== 2) {
          throw new Error('A confirmação do início sugerido não gerou as duas partes esperadas.');
        }

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
        return 'busca nativa, busca OCR e sugestão revisável de título recorrente; corte OCR começou desmarcado, foi confirmado e dividido em duas partes; ' + (task.result.outputDir || task.result.firstOutputPath || '');
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
        if (!protectedOutputPath) throw new Error('Saída protegida ausente');
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
        await waitFor(() => ['native', 'scanned', 'skipped-large', 'inconclusive'].includes(api.pdfToWordWorkspace.getAnalysisState().status), 45_000, 'análise automática do PDF para Word');
        if (api.pdfToWordWorkspace.getAnalysisState().status !== 'native') {
          throw new Error('O PDF digital do teste foi classificado incorretamente para OCR. Estado: ' + JSON.stringify(api.pdfToWordWorkspace.getAnalysisState()));
        }
        if (!/texto digital detectado/i.test(document.getElementById('pdf-to-word-status')?.textContent || '')
          || document.getElementById('pdf-to-word-use-ocr')?.checked) {
          throw new Error('O resultado nativo não foi explicado claramente ou o OCR foi ativado sem escolha do usuário.');
        }
        setValue('pdf-to-word-output-name', 'e2e_convertido.docx');
        await queuePayload(api.pdfToWordWorkspace.getQueuePayload());
        const task = await ensureCompleted('pdf-to-word');
        return task.result.outputPath || task.result.firstOutputPath || '';
      });

      await runStep('pdf-to-word-hybrid-ocr', async () => {
        api.switchTab('pdf-to-word', { skipGuard: true });
        api.pdfToWordWorkspace.handleFile(await makeFileLike(files.pdfToWordHybridPdf));
        await waitFor(() => ['native', 'scanned', 'skipped-large', 'inconclusive'].includes(api.pdfToWordWorkspace.getAnalysisState().status), 45_000, 'detecção de páginas digitalizadas no PDF híbrido');
        const analysis = api.pdfToWordWorkspace.getAnalysisState();
        if (analysis.status !== 'scanned' || !analysis.pagesLikelyScanned.includes(1)) {
          throw new Error('A análise do PDF híbrido não indicou a página escaneada: ' + JSON.stringify(analysis));
        }
        if (!/páginas digitalizadas/i.test(document.getElementById('pdf-to-word-status')?.textContent || '')
          || document.getElementById('pdf-to-word-use-ocr')?.checked) {
          throw new Error('O aplicativo não recomendou OCR de forma clara ou o ativou sem consentimento.');
        }
        setChecked('pdf-to-word-use-ocr', true);
        setValue('pdf-to-word-output-name', 'e2e_hibrido_ocr.docx');
        const finishedTaskCount = finishedTasks.length;
        await api.queuePdfToWord();
        const task = await waitFor(
          () => finishedTasks.slice(finishedTaskCount).find((item) => item.status && ['completed', 'failed', 'timeout', 'cancelled', 'interrupted'].includes(item.status)),
          15 * 60 * 1000,
          'conclusão da conversão híbrida com OCR'
        );
        if (task.status !== 'completed') throw new Error((task.error || ('Conversão terminou com status ' + task.status)) + ' | tarefa=' + JSON.stringify(task));
        if (task.result?.usedOcr !== true) throw new Error('A conversão híbrida não informou que reconheceu a região escaneada.');
        return 'botão da interface executou OCR, preservou texto nativo e reconheceu a mesma página híbrida';
      });

      await runStep('watermark', async () => {
        api.switchTab('watermark', { skipGuard: true });
        api.watermarkWorkspace.handleFiles([await makeFileLike(files.landscapePng)]);
        await waitFor(
          () => {
            const canvas = document.getElementById('watermark-preview-canvas');
            return canvas && canvas.width > canvas.height;
          },
          15000,
          "preview horizontal da marca d'agua"
        );
        api.switchTab('dashboard');
        const leaveModal = document.getElementById('custom-confirm-modal');
        await waitFor(
          () => leaveModal && !leaveModal.classList.contains('hidden')
            && String(document.getElementById('custom-confirm-message')?.textContent || '').includes("Marca d'água"),
          5000,
          "confirmação ao sair da marca d'água"
        );
        document.getElementById('custom-confirm-btn-cancel')?.click();
        await waitFor(
          () => state.activeTab === 'watermark' && state.watermarkFiles.length === 1,
          5000,
          "permanência na marca d'água após cancelar"
        );
        api.watermarkWorkspace.rotateCurrentSource(90);
        await waitFor(
          () => {
            const canvas = document.getElementById('watermark-preview-canvas');
            return canvas && canvas.height > canvas.width;
          },
          5000,
          "preview rotacionado da marca d'agua"
        );
        setValue('watermark-text-value', 'CONFIDENCIAL');
        setValue('watermark-output-suffix', '_wm');
        setChecked('watermark-zip', false);
        const watermarkPayload = api.watermarkWorkspace.getQueuePayload();
        watermarkPayload.files = [files.landscapePng];
        await queuePayload(watermarkPayload);
        const task = await ensureCompleted('watermark');
        return task.result.outputPath || task.result.firstOutputPath || '';
      });

      await runStep('organize-checkbox-selection', async () => {
        api.switchTab('organize', { skipGuard: true });
        await api.organizeWorkspace.handleOrganizeFile(await makeFileLike(files.smallPdf));
        await waitFor(
          () => state.organizePages.length > 0 && document.querySelector('.page-card .page-selection-control'),
          15000,
          'controle de seleção da primeira página'
        );

        const organizeSearchInput = document.getElementById('organize-document-search-input');
        organizeSearchInput.value = 'Small Test PDF';
        document.getElementById('btn-organize-document-search')?.click();
        await waitForSearchResults('organize-document-search-status', '.organize-document-search-result', 'busca textual/OCR e localização da página organizada', 310_000);
        document.querySelector('.organize-document-search-result')?.click();
        await waitFor(
          () => document.querySelector('.page-card.is-search-result-focus'),
          5000,
          'destaque da página encontrada na organização'
        );

        const firstPageId = state.organizePages[0].id;
        const selectionControl = document.querySelector('[data-page-id="' + firstPageId + '"] .page-selection-control');
        if (!selectionControl) throw new Error('Checkbox da primeira página não encontrado.');
        selectionControl.click();

        await waitFor(
          () => state.organizeSelection.has(firstPageId),
          5000,
          'seleção da página pelo checkbox'
        );

        const overlay = document.getElementById('organize-hold-zoom-overlay');
        if (overlay && !overlay.classList.contains('hidden')) {
          throw new Error('O checkbox abriu indevidamente a visualização ampliada.');
        }

        await waitFor(
          () => state.organizePages[0].thumbnailDataUrl
            && document.querySelector('[data-page-id="' + firstPageId + '"] .page-selection-control'),
          15000,
          'checkbox preservado após renderizar a miniatura'
        );

        const selectedCount = state.organizeSelection.size;
        api.organizeWorkspace.clearOrganizeWorkspace();
        return selectedCount + ' página selecionada sem abrir a prévia; busca textual localizou e destacou a página';
      }, 15 * 60 * 1000);

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
      }, 60000);

      await runStep('redact', async () => {
        api.switchTab('redact', { skipGuard: true });
        await api.redactWorkspace.handleRedactFile(await makeFileLike(files.smallPdf));
        document.getElementById('btn-add-redact-box')?.click();
        const redactedPages = await api.redactWorkspace.generateRedactedPagesPayload();
        await queuePayload({
          type: 'redact',
          files: [api.state.redactFile.path],
          options: {
            outputName: 'e2e_ocultado.png.pdf',
            redactedPages,
            cleanupPaths: [...new Set(api.state.redactTempPaths || [])],
            zipResults: false
          }
        });
        const task = await ensureCompleted('redact');
        return task.result.outputPath || task.result.firstOutputPath || '';
      // Redaction rebuilds every page and validates the final PDF; packaged
      // OCR runs can leave the utility process and renderer under load.
      }, 180000);

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
  let debuggerAttachedForFileInput = false;
  try {
    const manifest = JSON.parse(fs.readFileSync(e2eAssetsManifestFile, 'utf8'));
    const requestedE2eOutputDir = String(process.env.CENTRAL_PDF_E2E_OUTPUT_DIR || '').trim();
    const e2eOutputDir = requestedE2eOutputDir || path.join(path.dirname(e2eReportFile), 'outputs');
    await fs.promises.mkdir(e2eOutputDir, { recursive: true });
    const bootstrapOutcome = await Promise.race([
      rendererBootstrapReady,
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, timeout: true }), 60_000))
    ]);
    if (!bootstrapOutcome.ok) {
      const reason = bootstrapOutcome.timeout
        ? 'O renderer não concluiu a inicialização em até 60 segundos.'
        : `O renderer informou falha durante a inicialização${bootstrapOutcome.message ? `: ${bootstrapOutcome.message}` : '.'}`;
      throw new Error(reason);
    }
    await mainWindow.webContents.executeJavaScript(`
      (async () => {
        if (!window.__CENTRAL_PDF_TEST_API__) {
          throw new Error('O renderer concluiu o bootstrap, mas a API de teste não foi exposta.');
        }
        window.__CENTRAL_PDF_TEST_API__.switchTab('signature', { skipGuard: true });
        const signatureStartedAt = Date.now();
        while (!document.getElementById('signature-file-input')?.dataset.dropzoneReady && Date.now() - signatureStartedAt < 30000) {
          await new Promise((resolve) => window.setTimeout(resolve, 100));
        }
        if (!document.getElementById('signature-file-input')?.dataset.dropzoneReady) {
          throw new Error('A área de seleção de arquivo da assinatura não ficou disponível.');
        }
        return true;
      })();
    `, true);
    const debuggerClient = mainWindow.webContents.debugger;
    if (!debuggerClient.isAttached()) {
      debuggerClient.attach('1.3');
      debuggerAttachedForFileInput = true;
    }
    const documentTree = await debuggerClient.sendCommand('DOM.getDocument', { depth: -1, pierce: true });
    const inputNode = await debuggerClient.sendCommand('DOM.querySelector', {
      nodeId: documentTree.root.nodeId,
      selector: '#signature-file-input'
    });
    if (!inputNode.nodeId) {
      throw new Error('Input nativo da assinatura não encontrado para o E2E.');
    }
    await debuggerClient.sendCommand('DOM.setFileInputFiles', {
      nodeId: inputNode.nodeId,
      files: [manifest.files.smallPdf]
    });
    await mainWindow.webContents.executeJavaScript(`
      (() => {
        const input = document.getElementById('signature-file-input');
        if (!input || !input.files || input.files.length !== 1) {
          throw new Error('O arquivo nativo da assinatura não foi atribuído pelo DevTools.');
        }
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return input.files[0].name;
      })();
    `, true);
    const result = await mainWindow.webContents.executeJavaScript(buildRendererE2EScript({ manifest, outputDir: e2eOutputDir }), true);
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
    } catch {}
    reportStartupPhase('renderer-e2e-failed', {
      message: error.message || String(error)
    });
    setTimeout(() => app.exit(2), 250);
  } finally {
    if (debuggerAttachedForFileInput && mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.webContents.debugger.detach();
      } catch {}
    }
  }
}

function getFriendlyName(type) {
  return {
    merge: 'Mesclar',
    'split-pages': 'Separar Páginas',
    'split-range': 'Dividir por Intervalo',
    'split-size': 'Dividir por Tamanho',
    'split-content': 'Separar por Conteúdo',
    organize: 'Organizar Páginas',
    compress: 'Reduzir tamanho',
    watermark: 'Marca d\'água em Lote',
    'images-to-pdf': 'Converter arquivos para PDF',
    'files-to-pdf': 'Converter arquivos para PDF',
    sign: 'Assinar PDF',
    'pdf-to-word': 'Converter para Word',
    ocr: 'Reconhecer texto (OCR)',
    protect: 'Proteger PDF',
    unlock: 'Desbloquear PDF',
    redact: 'Ocultar Dados',
    'redact-ocr-search': 'Busca OCR para Ocultar Dados'
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
      { name: 'Tesseract.js', description: 'Reconhecimento óptico local de texto em português e inglês, sem nuvem.' },
      { name: 'qpdf 12.3.2', description: 'Motor nativo distribuído localmente para mesclagens grandes e operações estruturais; licença Apache 2.0 incluída no instalador.' },
      { name: '@pdfsmaller/pdf-encrypt', description: 'Biblioteca para criptografia e proteção local de PDFs.' },
      { name: 'docx', description: 'Geração local de arquivos Word para exportação textual.' },
      { name: 'Lucide Icons', description: 'Sistema visual de ícones do aplicativo.' },
      { name: 'Vanilla CSS', description: 'Camada visual leve e direta.' },
      { name: 'electron-builder', description: 'Empacotamento MSI, portable e unpacked.' },
      { name: 'Logging interno', description: 'Logs rotativos e diagnóstico local sanitizado.' }
    ],
    safeguards: {
      offlineMessage: 'Central PDF foi desenvolvido para processamento seguro e local de documentos PDF em ambientes corporativos. Nenhum arquivo é enviado para internet. O OCR usa modelos locais em português e inglês.',
      maxFileSizeBytes: config.maxFileSizeLimit
    }
  };
}

function createTaskExecutor(type, files, options, outputDir, managedTempDirectory) {
  return {
    totalItems: ['watermark', 'images-to-pdf', 'ocr'].includes(type) ? files.length : 1,
    createExecution: (updateProgress) => createPdfWorkerExecution({
      type,
      files,
      options,
      outputDir,
      managedTempDirectory
    }, updateProgress)
  };
}

function assertDirectory(dirPath, errorMessage = 'Directory does not exist.') {
  if (typeof dirPath !== 'string' || !path.isAbsolute(dirPath)) {
    throw new Error(errorMessage);
  }
  const stats = fs.existsSync(dirPath) ? fs.statSync(dirPath) : null;
  if (!stats || !stats.isDirectory()) {
    throw new Error(errorMessage);
  }
}

function getManagedTempDirectory() {
  return path.join(path.resolve(configService.getTempPath()), 'central-pdf-temp');
}

function sanitizeManagedTempPaths(paths = []) {
  return sanitizeManagedTempPathList(paths, getManagedTempDirectory());
}

function normalizeSourceRotation(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  const normalized = ((value % 360) + 360) % 360;
  return [0, 90, 180, 270].includes(normalized) ? normalized : 0;
}

function sanitizeSourceRotations(originalFiles, effectiveFiles, rotations) {
  const values = Array.isArray(rotations) ? rotations : [];
  const rotationByPath = new Map();
  (Array.isArray(originalFiles) ? originalFiles : []).forEach((filePath, index) => {
    if (typeof filePath === 'string' && filePath.trim()) {
      rotationByPath.set(filePath, normalizeSourceRotation(values[index]));
    }
  });
  return effectiveFiles.map((filePath) => rotationByPath.get(filePath) || 0);
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
    const fileName = path.basename(filePath || 'arquivo.pdf');
    const reason = inspection.reason === 'path'
      ? 'o caminho informado é inválido'
      : /enoent|no such file|não existe/i.test(String(inspection.reason || ''))
        ? 'o arquivo não existe mais'
        : /eacces|eperm|permission/i.test(String(inspection.reason || ''))
          ? 'o arquivo não pode ser lido por falta de permissão'
          : inspection.isFile === false
            ? 'o caminho não aponta para um arquivo'
            : inspection.extensionValid === false
              ? 'a extensão não é .pdf'
              : inspection.magicBytesValid === false
                ? 'o conteúdo não começa com uma assinatura PDF válida; pode estar corrompido ou ter outra extensão'
                : inspection.size > (configService.getConfig().maxFileSizeLimit || PDF_LIMITS.maxSupportedBytes)
                  ? 'o arquivo excede o limite máximo permitido'
                  : 'o conteúdo não é um PDF válido';
    throw new Error(`Falha no arquivo "${fileName}": ${reason}.`);
  }
  return inspection;
}

function validateImageFile(filePath, { ocr = false } = {}) {
  const inspection = inspectImageFile(
    filePath,
    IMAGE_LIMITS.maxImageBytes,
    ocr ? IMAGE_LIMITS.maxOcrPagePixels : IMAGE_LIMITS.maxRasterPixels
  );
  if (!inspection.ok) {
    const fileName = path.basename(filePath || 'imagem');
    let fileStats = null;
    try { fileStats = fs.statSync(filePath); } catch {}
    const inspectionReason = String(inspection.reason || '');
    let reason = 'o conteúdo não é uma imagem suportada ou está corrompido';
    if (/enoent|no such file|não existe/i.test(inspectionReason)) {
      reason = 'o arquivo não existe mais';
    } else if (/eacces|eperm|permission/i.test(inspectionReason)) {
      reason = 'o arquivo não pode ser lido por falta de permissão';
    } else if (inspectionReason === 'size' && fileStats?.isFile() && fileStats.size > IMAGE_LIMITS.maxImageBytes) {
      reason = `o arquivo excede o limite de ${Math.floor(IMAGE_LIMITS.maxImageBytes / (1024 * 1024))} MB`;
    } else if (inspectionReason === 'size' && fileStats && !fileStats.isFile()) {
      reason = 'o caminho não aponta para um arquivo';
    } else if (inspectionReason === 'tiff-pixel-limit') {
      reason = 'o TIFF ultrapassa o limite de resolução total; divida o documento ou reduza a resolução';
    } else if (inspectionReason === 'tiff-page-pixel-limit' || inspectionReason === 'pixel-limit') {
      reason = `a imagem excede o limite de resolução${ocr ? ' de 32 megapixels por página' : ' de 64 megapixels'}`;
    } else if (inspectionReason === 'tiff-page-count') {
      reason = 'o TIFF está vazio ou excede o limite de 1.000 páginas';
    } else if (inspectionReason === 'tiff-dimensions') {
      reason = 'uma das páginas TIFF tem dimensões inválidas';
    }
    throw new Error(`Falha no arquivo "${fileName}": ${reason}.`);
  }
  return inspection;
}

function resolvePrimaryFileName(originalFileNames, effectiveFiles) {
  const candidate = Array.isArray(originalFileNames) ? originalFileNames[0] : '';
  if (typeof candidate === 'string' && candidate.trim()) {
    return candidate.trim().slice(0, 255);
  }
  return path.basename(effectiveFiles[0] || '');
}

function resolveLogFileNames(originalFileNames, effectiveFiles) {
  const names = Array.isArray(originalFileNames)
    ? originalFileNames.filter((item) => typeof item === 'string' && item.trim())
    : [];
  if (names.length > 0) {
    return names.map((item) => item.trim().slice(0, 255));
  }
  return (Array.isArray(effectiveFiles) ? effectiveFiles : [])
    .map((filePath) => path.basename(String(filePath || '')))
    .filter(Boolean);
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
  const invalidBatchFiles = [];
  const fileIndexes = [];
  const supportsImageInputs = type === 'merge' || type === 'files-to-pdf' || type === 'watermark' || type === 'compress' || type === 'ocr';
  const canSkipProtectedInBatch = type === 'merge' || type === 'files-to-pdf' || type === 'watermark' || type === 'ocr';

  if (type === 'images-to-pdf') {
    uniqueFiles.forEach(validateImageFile);
    return { files: uniqueFiles, warnings, fileIndexes: uniqueFiles.map((_, index) => index) };
  }

  if (type === 'merge') {
    if (uniqueFiles.length < 2) {
      throw new Error('Selecione pelo menos 2 arquivos para mesclar.');
    }
  }

  // TIFF inspection reads bounded image bytes and parses IFDs synchronously.
  // Validate those individually and yield so a large scan batch does not
  // monopolize the Electron main event loop or multiply peak memory by 8.
  const validationResults = [];
  for (let start = 0; start < uniqueFiles.length;) {
    const startsWithOcrTiff = type === 'ocr' && /\.tiff?$/i.test(uniqueFiles[start]);
    let validationConcurrency = 1;
    if (!startsWithOcrTiff) {
      while (validationConcurrency < 8
        && start + validationConcurrency < uniqueFiles.length
        && !(type === 'ocr' && /\.tiff?$/i.test(uniqueFiles[start + validationConcurrency]))) {
        validationConcurrency += 1;
      }
    }
    const chunk = uniqueFiles.slice(start, start + validationConcurrency);
    const chunkResults = await Promise.all(chunk.map(async (filePath, offset) => {
      const fileIndex = start + offset;
      try {
        if (supportsImageInputs && (/\.(png|jpe?g)$/i.test(filePath) || (type === 'ocr' && /\.tiff?$/i.test(filePath)))) {
          validateImageFile(filePath, { ocr: type === 'ocr' });
        } else {
          await validatePdfFile(filePath);
        }

        if (type !== 'unlock' && /\.pdf$/i.test(filePath) && await hasPdfEncryptionDictionaryAsync(filePath)) {
          return { fileIndex, filePath, protected: true };
        }
        return { fileIndex, filePath, valid: true };
      } catch (error) {
        return { fileIndex, filePath, error };
      }
    }));
    validationResults.push(...chunkResults);
    start += chunk.length;
    if (startsWithOcrTiff) await new Promise((resolve) => setImmediate(resolve));
  }

  // Process results in input order so output order, ranges and log names never
  // change just because the filesystem completed one check before another.
  for (const result of validationResults) {
    const { fileIndex, filePath } = result;
    if (result.error) {
      if (['merge', 'files-to-pdf', 'watermark', 'ocr'].includes(type)) {
        const reason = result.error.message || 'arquivo inválido';
        invalidBatchFiles.push({ fileName: path.basename(filePath), reason });
        warnings.push(`Arquivo "${path.basename(filePath)}" foi ignorado: ${reason}`);
        continue;
      }
      throw result.error;
    }

    // Protected PDFs are the expected input of the unlock module. Every other
    // operation still rejects or skips encrypted documents before processing.
    if (result.protected) {
      if (canSkipProtectedInBatch && uniqueFiles.length > 1) {
        skippedProtectedFiles.push(filePath);
        warnings.push(`Arquivo "${path.basename(filePath)}" foi ignorado porque está protegido por senha.`);
        continue;
      }
      throw new Error('Arquivo protegido. Remova a senha para continuar.');
    }

    filteredFiles.push(filePath);
    fileIndexes.push(fileIndex);
  }

  if (invalidBatchFiles.length > 0 && filteredFiles.length < (type === 'merge' ? 2 : 1)) {
    const visibleErrors = invalidBatchFiles.slice(0, 8)
      .map(({ fileName, reason }) => `• ${fileName}: ${reason.replace(/^Falha no arquivo\s*["']?[^"']+["']?:\s*/i, '')}`)
      .join('\n');
    const remaining = invalidBatchFiles.length - Math.min(8, invalidBatchFiles.length);
    const actionLabel = type === 'merge'
      ? 'mesclar'
      : type === 'watermark'
        ? 'aplicar a marca d\'água'
      : type === 'ocr'
        ? 'reconhecer o texto'
        : 'converter os arquivos para PDF';
    throw new Error(
      `Não foi possível ${actionLabel} porque ${invalidBatchFiles.length} arquivo(s) têm problemas.\n${visibleErrors}`
      + (remaining > 0 ? `\n• ... e mais ${remaining} arquivo(s).` : '')
    );
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
    fileIndexes,
    warnings
  };
}

async function preflightBatchFiles(type, files) {
  const inputFiles = Array.isArray(files) ? files : [];
  const operationLabels = {
    merge: 'mesclagem',
    watermark: "aplicação da marca d'água",
    'files-to-pdf': 'conversão',
    ocr: 'reconhecimento de texto',
    'single-pdf': 'processamento',
    'single-pdf-or-image': 'processamento',
    'single-pdf-unlock': 'desbloqueio'
  };
  const operationLabel = operationLabels[type] || 'processamento';
  const results = [];
  for (let start = 0; start < inputFiles.length;) {
    const startsWithOcrTiff = type === 'ocr' && /\.tiff?$/i.test(String(inputFiles[start] || ''));
    let concurrency = 1;
    if (!startsWithOcrTiff) {
      while (concurrency < 8
        && start + concurrency < inputFiles.length
        && !(type === 'ocr' && /\.tiff?$/i.test(String(inputFiles[start + concurrency] || '')))) {
        concurrency += 1;
      }
    }
    const chunk = inputFiles.slice(start, start + concurrency);
    const chunkResults = await Promise.all(chunk.map(async (filePath) => {
    const base = { path: filePath, name: path.basename(String(filePath || '')) };
    try {
      if ((type === 'merge' || type === 'watermark' || type === 'files-to-pdf' || type === 'ocr' || type === 'single-pdf-or-image') && (/\.(png|jpe?g)$/i.test(filePath) || (type === 'ocr' && /\.tiff?$/i.test(filePath)))) {
        validateImageFile(filePath, { ocr: type === 'ocr' });
        return { ...base, status: 'valid', message: `Pronto para ${operationLabel}.` };
      }
      if (type === 'files-to-pdf' && /\.(docx|xlsx)$/i.test(filePath)) {
        const stat = await fs.promises.stat(filePath);
        if (!stat.isFile() || stat.size <= 0) throw new Error('o arquivo está vazio ou não é um arquivo comum');
        return { ...base, status: 'valid', message: 'Arquivo disponível para conversão.' };
      }
      await validatePdfFile(filePath);
      if (!['unlock', 'single-pdf-unlock'].includes(type) && await hasPdfEncryptionDictionaryAsync(filePath)) {
        return { ...base, status: 'protected', message: 'Arquivo protegido por senha; será ignorado.' };
      }
      return { ...base, status: 'valid', message: `Pronto para ${operationLabel}.` };
    } catch (error) {
      return { ...base, status: 'invalid', message: String(error.message || 'Arquivo inválido.').replace(/^Falha no arquivo\s*"[^"]+":\s*/i, '') };
    }
    }));
    results.push(...chunkResults);
    start += chunk.length;
    if (startsWithOcrTiff) await new Promise((resolve) => setImmediate(resolve));
  }
  return {
    success: true,
    results,
    ...(type === 'ocr' ? { ocrRuntime: getOcrRuntimeStatus() } : {})
  };
}

function validateOrganizeOptions(options = {}) {
  if (!Array.isArray(options.pageActions) || options.pageActions.length === 0) {
    throw new Error('A organização precisa de pelo menos uma página.');
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

  const managedPaths = new Set(sanitizeManagedTempPaths(options.cleanupPaths)
    .map((targetPath) => path.resolve(targetPath).toLowerCase()));
  const managedRealDirectory = (() => {
    try {
      return fs.realpathSync(getManagedTempDirectory());
    } catch {
      throw new Error('A pasta temporária segura não está disponível. Gere a prévia novamente.');
    }
  })();
  for (const page of options.redactedPages) {
    const imagePath = typeof page?.imagePath === 'string' ? path.resolve(page.imagePath) : '';
    const extension = path.extname(imagePath).toLowerCase();
    if (!Number.isInteger(page?.pageIndex) || page.pageIndex < 0) {
      throw new Error('Uma das páginas preparadas para ocultação é inválida. Gere a prévia novamente.');
    }
    if (!imagePath || !['.jpg', '.jpeg', '.png'].includes(extension)
      || !managedPaths.has(imagePath.toLowerCase())) {
      throw new Error('Uma imagem temporária da ocultação não pertence à área segura do Central PDF. Gere a prévia novamente.');
    }
    const realImagePath = (() => {
      try {
        return fs.realpathSync(imagePath);
      } catch {
        throw new Error('Uma imagem temporária da ocultação está inválida ou indisponível. Gere a prévia novamente.');
      }
    })();
    if (!isPathInsideDirectory(managedRealDirectory, realImagePath)) {
      throw new Error('Uma imagem temporária da ocultação aponta para fora da área segura do Central PDF. Gere a prévia novamente.');
    }
    const inspection = inspectImageFile(imagePath);
    if (!inspection.ok) {
      throw new Error('Uma imagem temporária da ocultação está inválida ou indisponível. Gere a prévia novamente.');
    }
  }
}

function validateOcrOptions(options = {}) {
  for (const optionName of ['autoRotate', 'imageEnhancement']) {
    if (typeof options[optionName] !== 'undefined' && typeof options[optionName] !== 'boolean') {
      throw new Error('As opções de correção e melhoria da imagem devem estar ativadas ou desativadas.');
    }
  }
  const language = typeof options.language === 'string' ? options.language : 'por+eng';
  const supported = new Set(['por', 'eng']);
  const languages = language.split(/[+,\s]+/).filter(Boolean);
  if (!languages.length || languages.some((item) => !supported.has(item.toLowerCase()))) {
    throw new Error('Escolha português, inglês ou os dois idiomas para reconhecer o documento.');
  }
  if (!['auto', 'complete', 'redo'].includes(options.mode || 'auto')) {
    throw new Error('Escolha um modo de reconhecimento válido: automático, completo ou refazer OCR.');
  }
  if (!['pdf', 'text'].includes(options.format || 'pdf')) {
    throw new Error('Formato de saída do reconhecimento inválido.');
  }
}

function validateOcrRedactSearchOptions(options = {}) {
  const query = String(options.query || '').trim();
  if (!query || query.length > 120) throw new Error('Informe um termo de busca com até 120 caracteres.');
  if (typeof options.language !== 'undefined' && !['por', 'eng', 'por+eng'].includes(options.language)) {
    throw new Error('Escolha português, inglês ou os dois idiomas para a busca OCR.');
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
  if (type === 'images-to-pdf') {
    warnings.push(...getImageBatchWarnings(files, configService.getConfig().memorySoftLimitMb));
  }

  return warnings;
}

async function cleanUpTempFiles(files, options = {}) {
  const cleanupPaths = sanitizeManagedTempPaths(options.cleanupPaths);
  for (const filePath of cleanupPaths) {
    if (typeof filePath !== 'string' || !filePath.trim()) continue;
    try {
      await fs.promises.rm(filePath, { force: true });
    } catch {}
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
      // Keep renderer timers deterministic while the automated app test runs
      // behind another Central PDF window. Production keeps Electron's normal
      // background throttling to avoid unnecessary CPU usage.
      backgroundThrottling: !isE2EMode,
      devTools: !app.isPackaged
    }
  });
  const window = mainWindow;
  const windowContents = window.webContents;

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
  if (e2eReportFile) {
    mainWindow.webContents.on('console-message', (details) => {
      process.stderr.write(`[renderer-console:${details.level}] ${details.message} (${details.sourceId}:${details.lineNumber})\n`);
    });
  }
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

  window.on('closed', () => {
    pdfPreviewRangeSessions.closeSender(windowContents);
    for (const jobs of [activeOcrAreaJobs, activeOcrSearchJobs, activePdfToWordAnalyses]) {
      for (const [requestId, job] of jobs) {
        if (job.sender.isDestroyed()) {
          job.execution.cancel('window-closed');
          jobs.delete(requestId);
        }
      }
    }
    if (mainWindow === window) mainWindow = null;
  });
}

app.whenReady().then(() => {
  reportStartupPhase('app-ready');
  configService.init();
  logger.init(configService.getLogsPath(), configService.getConfig().logRetentionDays);
  logger.logOperation('APP_STARTUP', `Application started. Version: ${APP_META.releaseVersion}. Mode: ${configService.isPortableMode() ? 'Portable' : 'Installed'}`);
  void cleanupStaleManagedTempFiles({
    directory: getManagedTempDirectory(),
    parentDirectory: configService.getTempPath()
  }).then(({ deleted, failed }) => {
    if (deleted || failed) {
      logger.logMetric('MANAGED_TEMP_STARTUP_CLEANUP', { schemaVersion: 1, deletedCount: deleted, failedCount: failed });
    }
  }).catch(() => {
    logger.logMetric('MANAGED_TEMP_STARTUP_CLEANUP', { schemaVersion: 1, deletedCount: 0, failedCount: 1 });
  });
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
  if (payload.phase === 'renderer-bootstrap-complete') {
    resolveRendererBootstrap?.({ ok: true });
    resolveRendererBootstrap = null;
  } else if (payload.phase === 'renderer-bootstrap-failed') {
    resolveRendererBootstrap?.({ ok: false, message: String(payload.details?.message || '').slice(0, 500) });
    resolveRendererBootstrap = null;
  }
  if (payload.phase === 'renderer-bootstrap-complete' && process.env.CENTRAL_PDF_STARTUP_SMOKE_AUTO_QUIT === '1') {
    setImmediate(() => {
      // The normal close guard is for users; automated startup smoke must exit
      // cleanly after proving the renderer booted, without leaving Chromium children.
      isForceClosingApp = true;
      app.quit();
    });
  }
});

app.on('second-instance', (event, commandLine = []) => {
  try {
    logger.logOperation('SECOND_INSTANCE_RECEIVED', `Document target: ${hasExplicitOpenTarget(commandLine) ? 'yes' : 'no'}`);
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
  process.stderr.write(`[uncaughtException] failureCode=${getSafeFailureCode(err)}\n`);
  logger.logCrash(err);
  app.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.logMetric('UNHANDLED_REJECTION', { schemaVersion: 1, failureCode: getSafeFailureCode(reason) });
});

ipcMain.handle('get-app-meta', () => APP_META);
ipcMain.handle('get-e2e-test-mode', () => isE2EMode);
ipcMain.handle('find-recent-upload-files', async (event, extensions) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error('A busca de arquivos recentes não veio da janela principal.');
  }
  return { success: true, files: await findRecentUploadFiles(extensions) };
});
ipcMain.handle('consume-launch-request', () => {
  const request = pendingLaunchRequest;
  pendingLaunchRequest = null;
  return request;
});

ipcMain.handle('get-config', () => configService.getConfig());

ipcMain.handle('get-system-appearance', () => getSystemAppearance());

ipcMain.handle('get-about-info', () => getAboutInfo());

ipcMain.handle('pdf-to-word-analyze', async (event, payload = {}) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error('A solicitação de análise não veio da janela principal.');
  }
  const requestId = typeof payload.requestId === 'string' ? payload.requestId : '';
  const filePath = typeof payload.filePath === 'string' ? path.resolve(payload.filePath) : '';
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(requestId) || activePdfToWordAnalyses.has(requestId)) {
    throw new Error('Não foi possível iniciar a análise automática do PDF.');
  }
  if (!filePath || !/\.pdf$/i.test(filePath)) throw new Error('Selecione um PDF válido para analisar.');
  const inspection = await inspectPdfFileAsync(filePath, configService.getConfig().maxFileSizeLimit || PDF_LIMITS.maxSupportedBytes);
  if (!inspection.ok) return { status: 'inconclusive', totalPages: 0, sampledPages: 0, pagesLikelyScanned: [] };
  if (inspection.size > PDF_TO_WORD_ANALYSIS_MAX_BYTES) {
    return { status: 'skipped-large', totalPages: 0, sampledPages: 0, pagesLikelyScanned: [] };
  }
  for (const [activeId, job] of activePdfToWordAnalyses) {
    if (job.sender === event.sender) {
      job.execution.cancel('superseded');
      activePdfToWordAnalyses.delete(activeId);
    }
  }
  const execution = createPdfWorkerExecution({
    type: 'pdf-to-word-analyze', files: [filePath], options: {}, outputDir: os.tmpdir()
  }, () => {});
  activePdfToWordAnalyses.set(requestId, { execution, sender: event.sender });
  const timeout = setTimeout(() => execution.cancel('timeout'), 45_000);
  try {
    return await execution.promise;
  } catch (error) {
    if (error?.message === 'OPERATION_CANCELLED') return { status: 'cancelled', totalPages: 0, sampledPages: 0, pagesLikelyScanned: [] };
    if (error?.message === 'OPERATION_TIMEOUT') return { status: 'inconclusive', totalPages: 0, sampledPages: 0, pagesLikelyScanned: [] };
    return { status: 'inconclusive', totalPages: 0, sampledPages: 0, pagesLikelyScanned: [] };
  } finally {
    clearTimeout(timeout);
    activePdfToWordAnalyses.delete(requestId);
  }
});

ipcMain.on('pdf-to-word-analyze-cancel', (event, requestId) => {
  const job = typeof requestId === 'string' ? activePdfToWordAnalyses.get(requestId) : null;
  if (job?.sender === event.sender) job.execution.cancel('cancelled');
});

ipcMain.handle('ocr-extract-area', async (event, payload = {}) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('A solicitação de OCR não veio da janela principal.');
  const requestId = typeof payload.requestId === 'string' ? payload.requestId : '';
  const filePath = typeof payload.filePath === 'string' ? path.resolve(payload.filePath) : '';
  const pageNumber = Number(payload.pageNumber);
  const selection = payload.selection;
  const language = typeof payload.language === 'string' ? payload.language : 'por+eng';
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(requestId) || activeOcrAreaJobs.has(requestId)) {
    throw new Error('Não foi possível iniciar o reconhecimento da área selecionada. Tente novamente.');
  }
  if (pendingOcrAreaCancels.consume(requestId)) return { cancelled: true };
  if ([activeOcrAreaJobs, activeOcrSearchJobs].some((jobs) => [...jobs.values()].some((job) => job.sender === event.sender))) {
    throw new Error('Aguarde o reconhecimento atual terminar ou cancele-o antes de iniciar outro.');
  }
  if (!filePath || !/\.pdf$/i.test(filePath) || !inspectPdfFile(filePath, configService.getConfig().maxFileSizeLimit || PDF_LIMITS.maxSupportedBytes).ok) {
    throw new Error('Selecione um PDF válido e tente novamente.');
  }
  if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) throw new Error('Selecione uma página válida para reconhecer.');
  if (!selection || typeof selection !== 'object' || ['x', 'y', 'width', 'height'].some((key) => !Number.isFinite(Number(selection[key])))
    || Number(selection.x) < -0.01 || Number(selection.y) < -0.01 || Number(selection.width) <= 0 || Number(selection.height) <= 0
    || Number(selection.x) + Number(selection.width) > 1.05 || Number(selection.y) + Number(selection.height) > 1.05) {
    throw new Error('Selecione uma área válida da página antes de reconhecer.');
  }
  const rawX = Number(selection.x);
  const rawY = Number(selection.y);
  const normX = Math.max(0, Math.min(0.999, rawX));
  const normY = Math.max(0, Math.min(0.999, rawY));
  const normWidth = Math.max(0.005, Math.min(1 - normX, Number(selection.width)));
  const normHeight = Math.max(0.005, Math.min(1 - normY, Number(selection.height)));
  const normalizedSelection = { x: normX, y: normY, width: normWidth, height: normHeight };
  const execution = createPdfWorkerExecution({
    type: 'ocr-extract-area', files: [filePath], options: { pageNumber, selection: normalizedSelection, language }, outputDir: os.tmpdir()
  }, (progress) => {
    if (!event.sender.isDestroyed()) event.sender.send('ocr-area-progress', { requestId, progress: Math.max(0, Math.min(100, Number(progress.progress) || 0)), page: Number(progress.page) || pageNumber, stageName: progress.currentItemName || '' });
  });
  const job = { execution, sender: event.sender };
  activeOcrAreaJobs.set(requestId, job);
  if (pendingOcrAreaCancels.consume(requestId)) execution.cancel('cancelled');
  const timeout = setTimeout(() => execution.cancel('timeout'), 300_000);
  try {
    return await execution.promise;
  } catch (error) {
    if (error?.message === 'OPERATION_CANCELLED') return { cancelled: true };
    if (error?.message === 'OPERATION_TIMEOUT') throw new Error('O reconhecimento da área demorou demais. Selecione uma região menor e tente novamente.', { cause: error });
    throw new Error(getSafeOcrOperationErrorMessage(error, 'area'), { cause: error });
  } finally {
    clearTimeout(timeout);
    activeOcrAreaJobs.delete(requestId);
  }
});

ipcMain.handle('ocr-extract-area-cancel', (event, requestId) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame
    || typeof requestId !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(requestId)) {
    return { accepted: false };
  }
  const job = activeOcrAreaJobs.get(requestId);
  if (job?.sender === event.sender) {
    job.execution.cancel('cancelled');
    return { accepted: true, pending: false };
  }
  pendingOcrAreaCancels.remember(requestId);
  return { accepted: true, pending: true };
});

ipcMain.handle('ocr-search-document', async (event, payload = {}) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('A solicitação de pesquisa não veio da janela principal.');
  const requestId = typeof payload.requestId === 'string' ? payload.requestId : '';
  const filePath = typeof payload.filePath === 'string' ? path.resolve(payload.filePath) : '';
  const query = typeof payload.query === 'string' ? payload.query.trim() : '';
  const suggestSplitStarts = payload.suggestSplitStarts === true;
  const language = typeof payload.language === 'string' ? payload.language : 'por+eng';
  const pageRange = typeof payload.pageRange === 'string' ? payload.pageRange.slice(0, 500) : '';
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(requestId) || activeOcrSearchJobs.has(requestId)) throw new Error('Não foi possível iniciar a pesquisa. Tente novamente.');
  if ([activeOcrAreaJobs, activeOcrSearchJobs].some((jobs) => [...jobs.values()].some((job) => job.sender === event.sender))) throw new Error('Aguarde o reconhecimento atual terminar ou cancele-o antes de iniciar outra operação OCR.');
  if (!filePath || !/\.pdf$/i.test(filePath) || !inspectPdfFile(filePath, configService.getConfig().maxFileSizeLimit || PDF_LIMITS.maxSupportedBytes).ok) throw new Error('Selecione um PDF válido e tente novamente.');
  if (!suggestSplitStarts && (!query || query.length > 120)) throw new Error('Digite um termo ou uma frase de até 120 caracteres.');
  if (!['por', 'eng', 'por+eng'].includes(language)) throw new Error('Escolha português, inglês ou os dois idiomas.');
  const execution = createPdfWorkerExecution({
    type: 'ocr-search-document', files: [filePath], options: { query, language, pageRange, suggestSplitStarts }, outputDir: os.tmpdir()
  }, (progress) => {
    if (!event.sender.isDestroyed()) event.sender.send('ocr-search-progress', { requestId, progress: Math.max(0, Math.min(100, Number(progress.progress) || 0)), page: Number(progress.page) || 0, totalPages: Number(progress.totalPages) || 0 });
  });
  activeOcrSearchJobs.set(requestId, { execution, sender: event.sender });
  const timeout = setTimeout(() => execution.cancel('timeout'), suggestSplitStarts ? 600_000 : 300_000);
  try {
    return await execution.promise;
  } catch (error) {
    if (error?.message === 'OPERATION_CANCELLED') return { cancelled: true };
    if (error?.message === 'OPERATION_TIMEOUT') throw new Error(suggestSplitStarts
      ? 'A análise de títulos demorou demais. Use a busca por palavra ou frase ou divida o documento em partes menores.'
      : 'A pesquisa demorou demais. Limite o intervalo de páginas e tente novamente.', { cause: error });
    throw new Error(getSafeOcrOperationErrorMessage(error, 'search'), { cause: error });
  } finally {
    clearTimeout(timeout);
    activeOcrSearchJobs.delete(requestId);
  }
});

ipcMain.on('ocr-search-document-cancel', (event, requestId) => {
  const job = typeof requestId === 'string' ? activeOcrSearchJobs.get(requestId) : null;
  if (job?.sender === event.sender) job.execution.cancel('cancelled');
});

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
  const metrics = createRendererFailureMetrics(safePayload);
  logger.logMetric('RENDERER_RUNTIME_FAILURE', metrics);
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

nativeTheme.on('updated', () => {
  mainWindow?.webContents.send('system-appearance-updated', getSystemAppearance());
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

ipcMain.handle('update-open-output-automatically', (event, enabled) => {
  if (typeof enabled !== 'boolean') {
    throw new Error('Invalid automatic output opening preference.');
  }
  configService.updateOpenOutputAutomatically(enabled);
  logger.logOperation('SETTINGS_CHANGED', `Automatic output opening ${enabled ? 'enabled' : 'disabled'}`);
  return true;
});

ipcMain.handle('select-directory', async () => {
  if (!mainWindow) return '';
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  return result.canceled ? '' : result.filePaths[0];
});

ipcMain.handle('convert-image-to-temp-pdf', async (event, imagePath, sourceRotation = 0) => {
  const { inspectConvertibleImage } = require('./services/image-conversion/image-validation');
  const inspection = inspectConvertibleImage(imagePath);
  if (!inspection.ok) {
    throw new Error('Imagem inválida ou não suportada.');
  }

  const tempDir = getManagedTempDirectory();
  const { convertImagesToPdf } = require('./services/image-conversion/image-to-pdf');
  const tempPdfName = `temp-redact-image-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.pdf`;
  const tempPdfPath = path.join(tempDir, tempPdfName);

  await fs.promises.mkdir(tempDir, { recursive: true });
  await convertImagesToPdf([imagePath], tempPdfPath, () => {}, () => false, {
    sourceRotations: [normalizeSourceRotation(sourceRotation)]
  });
  return tempPdfPath;
});

ipcMain.handle('convert-document-to-temp-pdf', async (event, documentPath) => {
  const { getDocumentExtension, convertDocumentToPdf } = require('./services/document-conversion/document-to-pdf');
  const extension = getDocumentExtension(documentPath);
  if (!['.docx', '.xlsx'].includes(extension)) {
    throw new Error('Selecione um documento DOCX ou XLSX válido.');
  }

  const tempDir = getManagedTempDirectory();
  const tempPdfName = `temp-document-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.pdf`;
  const tempPdfPath = path.join(tempDir, tempPdfName);
  await fs.promises.mkdir(tempDir, { recursive: true });

  const timeoutMs = configService.getConfig().operationTimeoutMs || APP_DEFAULTS.operationTimeoutMs;
  const conversion = convertDocumentToPdf(documentPath, tempPdfPath);
  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('A conversão do documento excedeu o tempo limite configurado.')), timeoutMs);
  });
  const result = await Promise.race([conversion, timeout]);
  return result.outputPath;
});

ipcMain.handle('save-temp-file', async (event, { base64Data, extension }) => {
  if (typeof base64Data !== 'string' || base64Data.trim() === '') {
    throw new Error('Dados inválidos para arquivo temporário.');
  }
  const ext = String(extension || 'jpg').replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (!['pdf', 'png', 'jpg', 'jpeg', 'svg', 'docx', 'xlsx'].includes(ext)) {
    throw new Error('Extensão não permitida para arquivo temporário.');
  }
  const buffer = Buffer.from(base64Data, 'base64');
  const maxBytes = configService.getConfig().maxFileSizeLimit || PDF_LIMITS.maxSupportedBytes;
  if (buffer.length === 0 || buffer.length > maxBytes) {
    throw new Error('Arquivo temporário vazio ou acima do limite permitido.');
  }
  
  const tempDir = getManagedTempDirectory();
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

  const safePaths = sanitizeManagedTempPaths(paths);
  if (safePaths.length !== paths.filter((item) => typeof item === 'string' && item.trim()).length) {
    throw new Error('Um ou mais caminhos não pertencem à área temporária do Central PDF.');
  }

  await Promise.all(safePaths.map(async (targetPath) => {
    try {
      await fs.promises.unlink(targetPath);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.logMetric('TEMP_DELETE_FAILED', { schemaVersion: 1, failureCode: getSafeFailureCode(error) });
      }
    }
  }));

  return true;
});

ipcMain.handle('move-temp-file-to-dest', async (event, { tempPath, targetName, outputDir: requestedOutputDir }) => {
  if (typeof tempPath !== 'string' || typeof targetName !== 'string') {
    throw new Error('Caminhos inválidos para movimentação.');
  }

  const tempDir = path.resolve(getManagedTempDirectory());
  const relativeToTempDir = path.relative(tempDir, path.resolve(tempPath));
  const tempPathIsInsideTempDir = relativeToTempDir === ''
    || (relativeToTempDir !== '..' && !relativeToTempDir.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeToTempDir));
  if (!path.isAbsolute(tempPath) || !tempPathIsInsideTempDir) {
    throw new Error('Caminho temporário inválido.');
  }

  const config = configService.getConfig();
  // Temporary files are only an implementation detail. The caller may provide
  // the original document folder; otherwise keep the result beside the temp
  // file instead of silently redirecting it to Downloads or another folder.
  let outputDir = typeof requestedOutputDir === 'string' && requestedOutputDir.trim()
    ? requestedOutputDir.trim()
    : (config.defaultOutputDir || '').trim();
  const relativeToTemp = outputDir ? path.relative(tempDir, path.resolve(outputDir)) : '';
  const outputIsTemp = outputDir && (
    relativeToTemp === ''
    || (relativeToTemp !== '..' && !relativeToTemp.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeToTemp))
  );
  if (!outputDir || outputIsTemp) {
    outputDir = app.getPath('downloads') || path.dirname(tempPath);
  }
  assertDirectory(outputDir, 'Pasta de saída inválida.');
  
  const safeTargetName = sanitizeFilename(targetName);
  if (!safeTargetName) {
    throw new Error('Nome de arquivo de destino inválido.');
  }
  const finalPath = resolveUniqueOutputPath(path.join(outputDir, safeTargetName));
  await fs.promises.rename(tempPath, finalPath);
  return finalPath;
});

ipcMain.handle('get-queue-status', () => sanitizeQueueStatusForRenderer(queue.getQueueStatus()));

ipcMain.handle('preflight-batch-files', async (event, payload = {}) => {
  if (!payload || !['merge', 'watermark', 'files-to-pdf', 'ocr', 'redact-ocr-search', 'single-pdf', 'single-pdf-or-image', 'single-pdf-unlock'].includes(payload.type) || !Array.isArray(payload.files)) {
    return { success: false, error: 'Pré-validação de lote inválida.' };
  }
  return preflightBatchFiles(payload.type, payload.files);
});

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

    const preparationWarnings = Array.isArray(options.validationWarnings)
      ? options.validationWarnings.filter((item) => typeof item === 'string' && item.trim()).slice(0, 32)
      : [];
    delete options.validationWarnings;
    options.cleanupPaths = sanitizeManagedTempPaths(options.cleanupPaths);
    options.sourceRotations = sanitizeSourceRotations(files, effectiveFiles, options.sourceRotations);
    if (Array.isArray(options.ranges) && Array.isArray(preparedFiles.fileIndexes)) {
      options.ranges = preparedFiles.fileIndexes.map((index) => options.ranges[index] || '');
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
    } else if (type === 'ocr') {
      validateOcrOptions(options);
    } else if (type === 'redact-ocr-search') {
      validateOcrRedactSearchOptions(options);
    }

    const invalidatesDigitalSignatures = ['merge', 'files-to-pdf', 'split-pages', 'split-range', 'split-size', 'split-content', 'organize', 'compress', 'watermark', 'sign', 'pdf-to-word', 'protect', 'unlock', 'redact', 'ocr'];
    const signatureDetections = [];
    if (invalidatesDigitalSignatures.includes(type)) {
      for (const file of effectiveFiles) {
        if (await pdfService.hasDigitalSignatures(file)) signatureDetections.push(file);
      }
    }
    const signatureWarning = signatureDetections.length > 0 && invalidatesDigitalSignatures.includes(type)
      ? 'O processamento de um PDF assinado digitalmente pode invalidar a assinatura. Guarde o original para preservar a versão assinada.'
      : '';
    if (signatureWarning) {
      logger.logOperation('SIGNATURE_WARNING', `Operation ${type} contains digitally signed documents. Signatures will be invalidated.`);
    }

    const taskId = buildTaskId(type);
    const friendlyName = getFriendlyName(type);
    const taskDefinition = createTaskExecutor(type, effectiveFiles, options, outputDir, getManagedTempDirectory());
    const privateDocumentOperation = isPrivateDocumentOperation(type, options);
    const originalFileNames = Array.isArray(options.originalFileNames)
      ? (Array.isArray(preparedFiles.fileIndexes)
        ? preparedFiles.fileIndexes.map((index) => options.originalFileNames[index])
        : options.originalFileNames)
        .filter((item) => typeof item === 'string' && item.trim())
        .map((item) => item.trim().slice(0, 255))
      : [];
    const primaryFileName = resolvePrimaryFileName(originalFileNames, effectiveFiles);

    const enqueuedId = queue.enqueue({
      id: taskId,
      type,
      name: friendlyName,
      privateDocumentOperation,
      filePaths: effectiveFiles,
      originalFileNames,
      quietNotifications: Boolean(options.quietNotifications),
      totalItems: taskDefinition.totalItems,
      onCancel: () => cleanUpTempFiles(effectiveFiles, options),
      createExecution: (updateProgress) => {
        const operationStartedAt = Date.now();
        const operationalWarnings = getOperationalWarnings(type, effectiveFiles);
        const logFileNames = resolveLogFileNames(originalFileNames, effectiveFiles);
        const fileSummary = !privateDocumentOperation && logFileNames.length > 0
          ? `; arquivos=${logFileNames.join(' | ')}`
          : '';
        logger.logOperation('OPERATION_START', `Task ${taskId} (${friendlyName}) started${fileSummary}`);
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
              warnings: privateDocumentOperation
                ? []
                : [...preparationWarnings, ...validationWarnings, ...operationalWarnings, ...(signatureWarning ? [signatureWarning] : [])],
              warningCount: preparationWarnings.length + validationWarnings.length + operationalWarnings.length + (signatureWarning ? 1 : 0),
              resultMemoryMb: result.memoryMb || 0,
              maxSupportedBytes: PDF_LIMITS.maxSupportedBytes
            });
            if (type === 'ocr') {
              logger.logMetric('OCR_RESULT', createOcrTelemetryMetrics({
                taskId,
                durationMs: Date.now() - operationStartedAt,
                files: effectiveFiles.length,
                result,
                options
              }));
            }
            if (type !== 'redact-ocr-search') {
              configService.addHistoryEntry(friendlyName, primaryFileName, 'sucesso', {
                outputPath: result.outputPath || result.firstOutputPath || '',
                outputDir: result.outputDir || ''
              });
            }
            const outputName = result.outputPath || result.firstOutputPath
              ? path.basename(result.outputPath || result.firstOutputPath)
              : '';
            logger.logOperation(
              'OPERATION_SUCCESS',
              `Task ${taskId} completed successfully${!privateDocumentOperation && outputName ? `; arquivoSaida=${outputName}` : ''}`
            );
            await cleanUpTempFiles(effectiveFiles, options);
            return result;
          }).catch(async (error) => {
            if (type !== 'redact-ocr-search') {
              configService.addHistoryEntry(friendlyName, primaryFileName, 'falha', {
                errorMessage: privateDocumentOperation ? 'A operação não foi concluída. Consulte o status da fila.' : error.message || String(error)
              });
            }
            if (!privateDocumentOperation) logger.logError('OPERATION_FAILED', error);
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
      warnings: [...preparationWarnings, ...validationWarnings, ...getOperationalWarnings(type, effectiveFiles), ...(signatureWarning ? [signatureWarning] : [])]
    };
  } catch (err) {
    logger.logMetric('QUEUE_SUBMISSION_FAILED', createPrivateOperationFailureMetrics({
      type: payload?.type,
      durationMs: 0,
      attempt: 1,
      maxAttempts: 1,
      error: err
    }));
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

function isMainFrameRequest(event) {
  return Boolean(mainWindow && event.sender === mainWindow.webContents && event.senderFrame === mainWindow.webContents.mainFrame);
}

ipcMain.handle('open-pdf-preview-range-session', async (event, filePath) => {
  if (!isMainFrameRequest(event)) throw new Error('Não foi possível abrir a prévia do PDF.');
  return pdfPreviewRangeSessions.open(event.sender, filePath);
});

ipcMain.handle('read-pdf-preview-range', async (event, payload = {}) => {
  if (!isMainFrameRequest(event)) throw new Error('Não foi possível continuar a prévia do PDF.');
  return pdfPreviewRangeSessions.read(event.sender, payload);
});

ipcMain.handle('close-pdf-preview-range-session', (event, sessionId) => {
  if (!isMainFrameRequest(event) || typeof sessionId !== 'string') return { closed: false };
  return { closed: pdfPreviewRangeSessions.close(event.sender, sessionId) };
});






