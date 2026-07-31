const { contextBridge, ipcRenderer, webFrame } = require('electron');

// Force 90% zoom factor on the web frame
webFrame.setZoomFactor(0.9);

const safeInvoke = typeof ipcRenderer?.invoke === 'function'
  ? ipcRenderer.invoke.bind(ipcRenderer)
  : null;
const safeOn = typeof ipcRenderer?.on === 'function'
  ? ipcRenderer.on.bind(ipcRenderer)
  : null;
const safeRemoveListener = typeof ipcRenderer?.removeListener === 'function'
  ? ipcRenderer.removeListener.bind(ipcRenderer)
  : null;
const safeSend = typeof ipcRenderer?.send === 'function'
  ? ipcRenderer.send.bind(ipcRenderer)
  : null;

function invokeOrReject(channel, ...args) {
  if (!safeInvoke) {
    return Promise.reject(new Error(`Canal indisponível: ${channel}`));
  }
  return safeInvoke(channel, ...args);
}

// Safe APIs exposed to the renderer (strictly mediated)
contextBridge.exposeInMainWorld('api', {
  // Config & Preferences
  getAppMeta: () => invokeOrReject('get-app-meta'),
  getConfig: () => invokeOrReject('get-config'),
  getAboutInfo: () => invokeOrReject('get-about-info'),
  updateTheme: (theme) => invokeOrReject('update-theme', theme),
  updateColorTheme: (color) => invokeOrReject('update-color-theme', color),
  updateOutputDir: (dir) => invokeOrReject('update-output-dir', dir),
  recordHistoryEntry: (entry) => invokeOrReject('record-history-entry', entry),
  clearRecentHistory: () => invokeOrReject('clear-recent-history'),
  
  // Dialog operations
  selectDirectory: () => invokeOrReject('select-directory'),

  // Processing queue
  queueOperation: (payload) => invokeOrReject('queue-operation', payload),
  cancelOperation: (taskId) => invokeOrReject('cancel-operation', taskId),
  getQueueStatus: () => invokeOrReject('get-queue-status'),
  saveTempFile: (payload) => invokeOrReject('save-temp-file', payload),
  moveTempFileToDest: (payload) => invokeOrReject('move-temp-file-to-dest', payload),
  deleteTempPaths: (paths) => invokeOrReject('delete-temp-paths', paths),
  
  // Diagnostics
  exportDiagnostics: () => invokeOrReject('export-diagnostics'),
  exportBasicDiagnostics: () => invokeOrReject('export-basic-diagnostics'),
  openPath: (targetPath) => invokeOrReject('open-path', targetPath),
  revealPath: (targetPath) => invokeOrReject('reveal-path', targetPath),
  pathExists: (targetPath) => invokeOrReject('path-exists', targetPath),
  getFileInfo: (filePath) => invokeOrReject('get-file-info', filePath),
  copyText: (value) => invokeOrReject('copy-text', value),
  readFileBytes: (filePath) => invokeOrReject('read-file-bytes', filePath),
  closeApp: () => invokeOrReject('close-app'),
  forceCloseApp: () => invokeOrReject('force-close-app'),
  convertImageToTempPdf: (imagePath) => invokeOrReject('convert-image-to-temp-pdf', imagePath),
  convertDocumentToTempPdf: (documentPath) => invokeOrReject('convert-document-to-temp-pdf', documentPath),
  reportStartupPhase: (phase, details) => safeSend?.('startup-phase', { phase, details }),
  logRendererError: (payload) => invokeOrReject('log-renderer-error', payload),
  consumeLaunchRequest: () => invokeOrReject('consume-launch-request'),

  // Event handlers
  onQueueUpdate: (callback) => {
    const listener = (event, status) => callback(status);
    safeOn?.('queue-status-updated', listener);
    return () => {
      safeRemoveListener?.('queue-status-updated', listener);
    };
  },
  onOperationFinished: (callback) => {
    const listener = (event, task) => callback(task);
    safeOn?.('operation-finished', listener);
    return () => {
      safeRemoveListener?.('operation-finished', listener);
    };
  },
  onCloseRequest: (callback) => {
    const listener = () => callback();
    safeOn?.('app-close-requested', listener);
    return () => {
      safeRemoveListener?.('app-close-requested', listener);
    };
  },
  onLaunchRequest: (callback) => {
    const listener = (event, payload) => callback(payload);
    safeOn?.('launch-request', listener);
    return () => {
      safeRemoveListener?.('launch-request', listener);
    };
  }
});
