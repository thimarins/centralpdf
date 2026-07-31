const APP_PATHS = {
  policyFilePath: 'C:\\ProgramData\\Central PDF\\policy.json',
  portableMarkerFile: 'portable.txt',
  portableDataDirName: 'data',
  queueStateFileName: 'queue-state.json',
  basicDiagnosticsDirPrefix: 'central-pdf-basic-diagnostics',
  diagnosticsDirPrefix: 'central-pdf-diagnostics'
};

const APP_DEFAULTS = {
  theme: 'system',
  logRetentionDays: 30,
  queueConcurrency: 1,
  queueRetryCount: 1,
  operationTimeoutMs: 30 * 60 * 1000,
  queuePersistenceEnabled: true,
  memorySoftLimitMb: 1024,
  organizeThumbnailScale: 0.35,
  organizeLowMemoryThumbnailScale: 0.18,
  organizeMaxThumbsInMemory: 16,
  organizeHugePdfThumbLimit: 8,
  maxRecentHistoryEntries: 10
};

const APP_LIMITS = {
  maxQueueConcurrency: 4,
  maxQueueRetryCount: 3,
  minOperationTimeoutMs: 60_000,
  minMemorySoftLimitMb: 256,
  minOrganizeThumbsInMemory: 8,
  minHugePdfThumbLimit: 4,
  minOrganizeThumbnailScale: 0.1,
  minOrganizeLowMemoryThumbnailScale: 0.08
};

const QUEUE_POLICY = {
  persistenceDebounceMs: 120,
  workerTerminateDelayMs: 5_000
};

const LOG_POLICY = {
  maxLogSizeBytes: 5 * 1024 * 1024,
  maxRotatedFiles: 5
};

module.exports = {
  APP_PATHS,
  APP_DEFAULTS,
  APP_LIMITS,
  QUEUE_POLICY,
  LOG_POLICY
};

