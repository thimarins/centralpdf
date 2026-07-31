const fs = require('fs');
const path = require('path');
const { LOG_POLICY } = require('./constants');

let logDir = '';
let retentionDays = 30; // default 30 days retention
let writeChain = Promise.resolve();

/**
 * Initializes the logger with directory path and retention configuration.
 * @param {string} directory Path to logs directory
 * @param {number} days Retention days limit
 */
function init(directory, days) {
  logDir = directory;
  if (typeof days === 'number') {
    retentionDays = days;
  }
  
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  // Clean old logs on initialization
  cleanOldLogs();
}

/**
 * Rotates log files: operations.log -> operations.1.log -> ... -> operations.5.log
 * @param {string} logFilePath 
 */
function rotateLog(logFilePath) {
  try {
    const ext = path.extname(logFilePath);
    const base = logFilePath.substring(0, logFilePath.length - ext.length);

    // Delete maximum index log
    const maxIndex = LOG_POLICY.maxRotatedFiles;
    const maxFile = `${base}.${maxIndex}${ext}`;
    if (fs.existsSync(maxFile)) {
      fs.unlinkSync(maxFile);
    }

    // Shift intermediate log files
    for (let i = maxIndex - 1; i >= 1; i--) {
      const currentFile = `${base}.${i}${ext}`;
      const nextFile = `${base}.${i + 1}${ext}`;
      if (fs.existsSync(currentFile)) {
        fs.renameSync(currentFile, nextFile);
      }
    }

    // Rename current active file to index 1
    fs.renameSync(logFilePath, `${base}.1${ext}`);
  } catch (err) {
    // Ignore rotation failures and keep the current log writable.
  }
}

/**
 * Writes a log entry to a specific log file, triggering rotation if needed.
 * @param {string} filename Name of the log file (e.g., 'operations.log')
 * @param {string} message Log message
 */
function writeLog(filename, message) {
  if (!logDir) return;
  
  const logFilePath = path.join(logDir, filename);
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] ${sanitizeLogText(message)}\n`;

  writeChain = writeChain
    .catch(() => {})
    .then(async () => {
      await fs.promises.appendFile(logFilePath, logEntry, 'utf8');
      const stats = await fs.promises.stat(logFilePath);
      if (stats.size > LOG_POLICY.maxLogSizeBytes) {
        rotateLog(logFilePath);
      }
    })
    .catch((err) => {
      // The logger can't log its own failure through itself; fall back to the console
      // so a missing/inaccessible log directory doesn't fail completely silently.
      console.error(`Failed to write log file ${filename}:`, err);
    });
}

function sanitizeLogText(text) {
  let value = String(text || '')
    .replace(/[A-Z]:\\[^ \r\n\t"'<>]+/gi, (match) => {
      const base = path.basename(match);
      return base ? `[path:${base}]` : '[path]';
    })
    .replace(/\\\\[^\\/\s]+\\[^ \r\n\t"'<>]+/g, '[network-path]');
  const escapedUser = osUserEscaped();
  if (escapedUser) {
    value = value.replace(new RegExp(escapedUser, 'gi'), '[user]');
  }
  return value;
}

function osUserEscaped() {
  const username = (() => {
    try {
      return require('os').userInfo().username || '';
    } catch (err) {
      return '';
    }
  })();
  return username.replace(/[.*+^${}()|[\]\\]/g, '\\$&');
}

/**
 * Logs an application event or operational action.
 * @param {string} action Operation name (e.g., 'MERGE_PDF')
 * @param {string} details Description of events, omitting sensitive content
 */
function logOperation(action, details = '') {
  writeLog('operations.log', `INFO: [${action}] ${details}`);
}

function logMetric(action, metrics = {}) {
  writeLog('operations.log', `METRIC: [${action}] ${JSON.stringify(metrics)}`);
}

/**
 * Logs an application error.
 * @param {string} action Context or command name
 * @param {Error|string} err The error details
 */
function logError(action, err) {
  const errMsg = err instanceof Error ? err.stack : err;
  writeLog('operations.log', `ERROR: [${action}] ${errMsg}`);
}

/**
 * Logs application crash warnings or uncaught exceptions in a separate file.
 * @param {Error|string} err The crash context
 */
function logCrash(err) {
  const errMsg = err instanceof Error ? err.stack : err;
  writeLog('crashes.log', `CRITICAL: ${errMsg}`);
}

/**
 * Clean log files older than the retention configuration.
 */
function cleanOldLogs() {
  if (!logDir) return;
  try {
    const files = fs.readdirSync(logDir);
    const now = Date.now();
    const expiryTime = retentionDays * 24 * 60 * 60 * 1000;

    for (const file of files) {
      const filePath = path.join(logDir, file);
      const stats = fs.statSync(filePath);
      if (now - stats.mtimeMs > expiryTime) {
        fs.unlinkSync(filePath);
      }
    }
  } catch (err) {
    // Ignore log retention cleanup failures to keep the app responsive.
  }
}

/**
 * Creates a diagnostic folder bundle at target path containing logs and sanitized config.
 * @param {string} exportPath Absolute folder path to export to
 * @param {object} currentConfig System configurations to sanitize and include
 */
async function exportDiagnostics(exportPath, currentConfig, healthSummary = {}) {
  await fs.promises.mkdir(exportPath, { recursive: true });
  await writeChain.catch(() => {});

  // 1. Copy log files
  if (fs.existsSync(logDir)) {
    const files = await fs.promises.readdir(logDir);
    for (const file of files) {
      const source = path.join(logDir, file);
      const target = path.join(exportPath, file);
      const content = await fs.promises.readFile(source, 'utf8');
      await fs.promises.writeFile(target, sanitizeLogText(content), 'utf8');
    }
  }

  // 2. Sanitize and write config file (excluding paths/histories that might contain usernames)
  const sanitizedConfig = { ...currentConfig };
  if (sanitizedConfig.defaultOutputDir) {
    sanitizedConfig.defaultOutputDir = '[configured-output-dir]';
  }
  if (sanitizedConfig.recentHistory) {
    sanitizedConfig.recentHistory = sanitizedConfig.recentHistory.map(item => ({
      ...item,
      filePath: item.filePath ? path.basename(item.filePath) : '', // only file name, hide absolute path
      outputPath: item.outputPath ? path.basename(item.outputPath) : '',
      outputDir: item.outputDir ? '[configured-output-dir]' : ''
    }));
  }
  
  await fs.promises.writeFile(
    path.join(exportPath, 'config-diagnostic.json'),
    JSON.stringify(sanitizedConfig, null, 2),
    'utf8'
  );

  await fs.promises.writeFile(
    path.join(exportPath, 'health-summary.json'),
    JSON.stringify(healthSummary, null, 2),
    'utf8'
  );

  return exportPath;
}

module.exports = {
  init,
  logOperation,
  logMetric,
  logError,
  logCrash,
  exportDiagnostics,
  cleanOldLogs
};
