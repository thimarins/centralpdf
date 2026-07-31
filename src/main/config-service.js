const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { PDF_LIMITS } = require('./utils');
const { APP_DEFAULTS, APP_LIMITS, APP_PATHS } = require('./constants');
const logger = require('./logger');

let configPath = '';
let logsPath = '';
let isPortable = false;
let saveChain = Promise.resolve();
const VALID_COLOR_THEMES = new Set(['random', 'blue', 'red', 'olive', 'violet']);
let currentConfig = {
  theme: APP_DEFAULTS.theme,
  colorTheme: 'random',
  colorThemeCustomized: false,
  defaultOutputDir: '',
  logRetentionDays: APP_DEFAULTS.logRetentionDays,
  recentHistory: [],
  maxFileSizeLimit: PDF_LIMITS.maxSupportedBytes,
  queueConcurrency: APP_DEFAULTS.queueConcurrency,
  queueRetryCount: APP_DEFAULTS.queueRetryCount,
  operationTimeoutMs: APP_DEFAULTS.operationTimeoutMs,
  queuePersistenceEnabled: APP_DEFAULTS.queuePersistenceEnabled,
  memorySoftLimitMb: APP_DEFAULTS.memorySoftLimitMb,
  giantPdfWarningBytes: PDF_LIMITS.warningBytes,
  hugePdfWarningBytes: PDF_LIMITS.heavyModeBytes,
  organizePreviewThresholdBytes: PDF_LIMITS.warningBytes,
  organizeThumbnailScale: APP_DEFAULTS.organizeThumbnailScale,
  organizeLowMemoryThumbnailScale: APP_DEFAULTS.organizeLowMemoryThumbnailScale,
  organizeMaxThumbsInMemory: APP_DEFAULTS.organizeMaxThumbsInMemory,
  organizeHugePdfThumbLimit: APP_DEFAULTS.organizeHugePdfThumbLimit
};

/**
 * Initializes configuration directories and detects Portable Mode.
 */
function init() {
  const portableExecutableDir = process.env.PORTABLE_EXECUTABLE_DIR;
  const currentWorkingDir = process.cwd();
  const cwdHasPortableMarker = (() => {
    try {
      if (!currentWorkingDir || !path.isAbsolute(currentWorkingDir) || !fs.existsSync(currentWorkingDir)) {
        return false;
      }
      if (fs.existsSync(path.join(currentWorkingDir, APP_PATHS.portableMarkerFile))) {
        return true;
      }
      return fs.readdirSync(currentWorkingDir).some((entry) => /portable\.exe$/i.test(entry));
    } catch (err) {
      return false;
    }
  })();
  const effectiveExecDir = portableExecutableDir && path.isAbsolute(portableExecutableDir)
    ? portableExecutableDir
    : cwdHasPortableMarker
      ? currentWorkingDir
      : path.dirname(process.execPath);
  
  // Portable mode triggers:
  // 1. `--portable` command line flag
  // 2. A file named 'portable.txt' in the same folder as the executable
  // 3. A directory named 'data' next to the executable (in packaged mode)
  const hasPortableFlag = process.argv.includes('--portable');
  const hasPortableEnv = !!portableExecutableDir;
  const hasPortableFile = fs.existsSync(path.join(effectiveExecDir, APP_PATHS.portableMarkerFile));
  const hasDataDir = fs.existsSync(path.join(effectiveExecDir, APP_PATHS.portableDataDirName));
  
  // Prevent marking node_modules/electron/dist as portable during dev
  const isPackaged = app.isPackaged;
  
  if (hasPortableEnv || hasPortableFlag || hasPortableFile || (isPackaged && hasDataDir)) {
    isPortable = true;
    const portableDataDir = path.join(effectiveExecDir, APP_PATHS.portableDataDirName);
    if (!fs.existsSync(portableDataDir)) {
      fs.mkdirSync(portableDataDir, { recursive: true });
    }
    configPath = path.join(portableDataDir, 'config.json');
    logsPath = path.join(portableDataDir, 'logs');
  } else {
    // Installed mode: store in %APPDATA%/central-pdf
    const userDataPath = app.getPath('userData');
    configPath = path.join(userDataPath, 'config.json');
    logsPath = path.join(userDataPath, 'logs');
  }

  if (!fs.existsSync(logsPath)) {
    fs.mkdirSync(logsPath, { recursive: true });
  }

  loadConfig();
}

/**
 * Loads configuration from file and applies corporate policies.
 */
function loadConfig() {
  if (fs.existsSync(configPath)) {
    try {
      const data = fs.readFileSync(configPath, 'utf8');
      const parsed = JSON.parse(data);
      currentConfig = { ...currentConfig, ...parsed };
    } catch (err) {
      // Keep defaults when local config is malformed, but make sure this is visible.
      logger.logError('CONFIG_LOAD_FAILED', err);
    }
  }

  // Ensure recent history is initialized
  if (!Array.isArray(currentConfig.recentHistory)) {
    currentConfig.recentHistory = [];
  }

  // Load and apply corporate policy overrides if present
  applyPolicies();
  normalizeConfigShape();
}

function normalizeConfigShape() {
  currentConfig.colorTheme = VALID_COLOR_THEMES.has(currentConfig.colorTheme)
    ? currentConfig.colorTheme
    : 'random';
  currentConfig.colorThemeCustomized = currentConfig.colorThemeCustomized === true;
  if (!currentConfig.colorThemeCustomized && currentConfig.colorTheme === 'blue') {
    currentConfig.colorTheme = 'random';
  }
  currentConfig.logRetentionDays = Number.isInteger(currentConfig.logRetentionDays) && currentConfig.logRetentionDays > 0
    ? currentConfig.logRetentionDays
    : APP_DEFAULTS.logRetentionDays;
  currentConfig.maxFileSizeLimit = Number.isFinite(currentConfig.maxFileSizeLimit) && currentConfig.maxFileSizeLimit > 0
    ? Number(currentConfig.maxFileSizeLimit)
    : PDF_LIMITS.maxSupportedBytes;
  currentConfig.maxFileSizeLimit = Math.min(currentConfig.maxFileSizeLimit, PDF_LIMITS.maxSupportedBytes);
  currentConfig.queueConcurrency = Number.isInteger(currentConfig.queueConcurrency) && currentConfig.queueConcurrency > 0
    ? Math.min(APP_LIMITS.maxQueueConcurrency, currentConfig.queueConcurrency)
    : APP_DEFAULTS.queueConcurrency;
  currentConfig.queueRetryCount = Number.isInteger(currentConfig.queueRetryCount) && currentConfig.queueRetryCount >= 0
    ? Math.min(APP_LIMITS.maxQueueRetryCount, currentConfig.queueRetryCount)
    : APP_DEFAULTS.queueRetryCount;
  currentConfig.operationTimeoutMs = Number.isFinite(currentConfig.operationTimeoutMs) && currentConfig.operationTimeoutMs >= APP_LIMITS.minOperationTimeoutMs
    ? Number(currentConfig.operationTimeoutMs)
    : APP_DEFAULTS.operationTimeoutMs;
  currentConfig.queuePersistenceEnabled = currentConfig.queuePersistenceEnabled !== false;
  currentConfig.memorySoftLimitMb = Number.isFinite(currentConfig.memorySoftLimitMb) && currentConfig.memorySoftLimitMb >= APP_LIMITS.minMemorySoftLimitMb
    ? Number(currentConfig.memorySoftLimitMb)
    : APP_DEFAULTS.memorySoftLimitMb;
  currentConfig.giantPdfWarningBytes = Number.isFinite(currentConfig.giantPdfWarningBytes) && currentConfig.giantPdfWarningBytes > 0
    ? Number(currentConfig.giantPdfWarningBytes)
    : PDF_LIMITS.warningBytes;
  currentConfig.hugePdfWarningBytes = Number.isFinite(currentConfig.hugePdfWarningBytes) && currentConfig.hugePdfWarningBytes > currentConfig.giantPdfWarningBytes
    ? Number(currentConfig.hugePdfWarningBytes)
    : PDF_LIMITS.heavyModeBytes;
  currentConfig.organizePreviewThresholdBytes = Number.isFinite(currentConfig.organizePreviewThresholdBytes) && currentConfig.organizePreviewThresholdBytes > 0
    ? Number(currentConfig.organizePreviewThresholdBytes)
    : PDF_LIMITS.warningBytes;
  currentConfig.organizeThumbnailScale = Number.isFinite(currentConfig.organizeThumbnailScale) && currentConfig.organizeThumbnailScale >= APP_LIMITS.minOrganizeThumbnailScale
    ? Number(currentConfig.organizeThumbnailScale)
    : APP_DEFAULTS.organizeThumbnailScale;
  currentConfig.organizeLowMemoryThumbnailScale = Number.isFinite(currentConfig.organizeLowMemoryThumbnailScale) && currentConfig.organizeLowMemoryThumbnailScale >= APP_LIMITS.minOrganizeLowMemoryThumbnailScale
    ? Number(currentConfig.organizeLowMemoryThumbnailScale)
    : APP_DEFAULTS.organizeLowMemoryThumbnailScale;
  currentConfig.organizeMaxThumbsInMemory = Number.isInteger(currentConfig.organizeMaxThumbsInMemory) && currentConfig.organizeMaxThumbsInMemory >= APP_LIMITS.minOrganizeThumbsInMemory
    ? Number(currentConfig.organizeMaxThumbsInMemory)
    : APP_DEFAULTS.organizeMaxThumbsInMemory;
  currentConfig.organizeHugePdfThumbLimit = Number.isInteger(currentConfig.organizeHugePdfThumbLimit) && currentConfig.organizeHugePdfThumbLimit >= APP_LIMITS.minHugePdfThumbLimit
    ? Number(currentConfig.organizeHugePdfThumbLimit)
    : APP_DEFAULTS.organizeHugePdfThumbLimit;
}

/**
 * Saves current user configuration to JSON file (excluding policy-overridden variables if they should remain clean).
 */
function saveConfig() {
  if (!configPath) return saveChain;
  const payload = JSON.stringify(currentConfig, null, 2);
  const tempPath = `${configPath}.${process.pid}.tmp`;
  saveChain = saveChain
    .catch(() => {})
    .then(async () => {
      await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
      await fs.promises.writeFile(tempPath, payload, 'utf8');
      try {
        await fs.promises.rename(tempPath, configPath);
      } catch (err) {
        if (err && (err.code === 'EEXIST' || err.code === 'EPERM')) {
          await fs.promises.unlink(configPath).catch(() => {});
          await fs.promises.rename(tempPath, configPath);
          return;
        }
        throw err;
      }
    })
    .catch(() => {});
  return saveChain;
}

/**
 * Applies administrative policies from C:\ProgramData\Central PDF\policy.json.
 */
function applyPolicies() {
  if (!fs.existsSync(APP_PATHS.policyFilePath)) return;

  try {
    const policyData = fs.readFileSync(APP_PATHS.policyFilePath, 'utf8');
    const policy = JSON.parse(policyData);

    // Apply policy overrides
    if (policy.forceTheme) {
      currentConfig.theme = policy.forceTheme;
      currentConfig.policyThemeEnforced = true;
    }
    if (policy.forceColorTheme) {
      currentConfig.colorTheme = policy.forceColorTheme;
      currentConfig.policyColorThemeEnforced = true;
    }
    if (policy.forceDefaultOutputDir) {
      currentConfig.defaultOutputDir = policy.forceDefaultOutputDir;
      currentConfig.policyOutputDirEnforced = true;
    }
    if (policy.disableRecentHistory) {
      currentConfig.recentHistory = [];
      currentConfig.policyHistoryDisabled = true;
    }
    if (policy.logRetentionDays) {
      currentConfig.logRetentionDays = policy.logRetentionDays;
      currentConfig.policyLogRetentionEnforced = true;
    }
    if (policy.maxFileSizeLimit) {
      currentConfig.maxFileSizeLimit = policy.maxFileSizeLimit; // In bytes
    }
    if (policy.queueConcurrency) {
      currentConfig.queueConcurrency = policy.queueConcurrency;
    }
    if (policy.queueRetryCount !== undefined) {
      currentConfig.queueRetryCount = policy.queueRetryCount;
    }
    if (policy.operationTimeoutMs) {
      currentConfig.operationTimeoutMs = policy.operationTimeoutMs;
    }
    if (policy.queuePersistenceEnabled !== undefined) {
      currentConfig.queuePersistenceEnabled = !!policy.queuePersistenceEnabled;
    }
    if (policy.memorySoftLimitMb) {
      currentConfig.memorySoftLimitMb = policy.memorySoftLimitMb;
    }
    if (policy.giantPdfWarningBytes) {
      currentConfig.giantPdfWarningBytes = policy.giantPdfWarningBytes;
    }
    if (policy.hugePdfWarningBytes) {
      currentConfig.hugePdfWarningBytes = policy.hugePdfWarningBytes;
    }
    if (policy.organizePreviewThresholdBytes) {
      currentConfig.organizePreviewThresholdBytes = policy.organizePreviewThresholdBytes;
    }
    if (policy.organizeThumbnailScale) {
      currentConfig.organizeThumbnailScale = policy.organizeThumbnailScale;
    }
    if (policy.organizeLowMemoryThumbnailScale) {
      currentConfig.organizeLowMemoryThumbnailScale = policy.organizeLowMemoryThumbnailScale;
    }
    if (policy.organizeMaxThumbsInMemory) {
      currentConfig.organizeMaxThumbsInMemory = policy.organizeMaxThumbsInMemory;
    }
  } catch (err) {
    // Keep local settings when the policy file cannot be parsed, but make sure this is visible.
    logger.logError('POLICY_LOAD_FAILED', err);
  }
}

/**
 * Adds an operation to the recent history tracking.
 * @param {string} action 
 * @param {string} fileName 
 * @param {string} status 'success' | 'failed'
 */
function addHistoryEntry(action, fileName, status, extras = {}) {
  // If corporate policy disabled history, skip
  if (currentConfig.policyHistoryDisabled) return;

  const entry = {
    action,
    fileName,
    status,
    timestamp: new Date().toISOString(),
    errorMessage: typeof extras.errorMessage === 'string' ? extras.errorMessage : '',
    outputPath: typeof extras.outputPath === 'string' ? extras.outputPath : '',
    outputDir: typeof extras.outputDir === 'string' ? extras.outputDir : ''
  };

  currentConfig.recentHistory.unshift(entry);

  // Maintain max 10 entries
  if (currentConfig.recentHistory.length > APP_DEFAULTS.maxRecentHistoryEntries) {
    currentConfig.recentHistory = currentConfig.recentHistory.slice(0, APP_DEFAULTS.maxRecentHistoryEntries);
  }

  saveConfig();
}

function clearRecentHistory() {
  if (currentConfig.policyHistoryDisabled) return;
  currentConfig.recentHistory = [];
  saveConfig();
}

module.exports = {
  init,
  getConfig: () => ({
    ...currentConfig,
    isPortableMode: isPortable
  }),
  getConfigPath: () => configPath,
  saveConfig,
  addHistoryEntry,
  clearRecentHistory,
  getLogsPath: () => logsPath,
  getQueueStatePath: () => path.join(logsPath, APP_PATHS.queueStateFileName),
  getTempPath: () => app.getPath('temp'),
  getPolicyPath: () => APP_PATHS.policyFilePath,
  isPortableMode: () => isPortable,
  updateTheme: (theme) => {
    if (currentConfig.policyThemeEnforced) return;
    currentConfig.theme = theme;
    saveConfig();
  },
  updateColorTheme: (color) => {
    if (currentConfig.policyColorThemeEnforced) return;
    currentConfig.colorTheme = color;
    currentConfig.colorThemeCustomized = color !== 'random';
    saveConfig();
  },
  updateOutputDir: (dir) => {
    if (currentConfig.policyOutputDirEnforced) return;
    currentConfig.defaultOutputDir = dir;
    saveConfig();
  }
};

