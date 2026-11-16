const { version: tesseractVersion } = require('tesseract.js/package.json');

const ALLOWED_MODES = new Set(['auto', 'complete', 'redo']);
const ALLOWED_FORMATS = new Set(['pdf', 'text']);
const ALLOWED_LANGUAGES = new Set(['por', 'eng', 'por+eng', 'eng+por']);
const ALLOWED_FAILURE_CODES = new Set([
  'OPERATION_CANCELLED', 'OPERATION_TIMEOUT', 'ENOSPC', 'EDQUOT', 'EACCES', 'EPERM', 'EBUSY', 'ENOENT', 'EIO',
  'OCR_RUNTIME_UNAVAILABLE', 'OCR_MODEL_UNAVAILABLE', 'OCR_OUTPUT_INVALID', 'PDF_SOURCE_CHANGED',
  'PDF_INVALID', 'PDF_PROTECTED', 'IMAGE_INVALID', 'INVALID_PAGE_RANGE', 'OCR_PAGE_TOO_LARGE'
]);

function nonNegativeInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

function averageRecognizedConfidence(result) {
  if (Number.isFinite(result?.averageOcrConfidence)) {
    return Math.round(Math.max(0, Math.min(100, result.averageOcrConfidence)));
  }
  const confidenceValues = (Array.isArray(result?.pageResults) ? result.pageResults : [])
    .filter((page) => page?.status === 'recognized' && Number.isFinite(page.confidence))
    .map((page) => Math.max(0, Math.min(100, page.confidence)));
  return confidenceValues.length
    ? Math.round(confidenceValues.reduce((sum, confidence) => sum + confidence, 0) / confidenceValues.length)
    : null;
}

function createOcrTelemetryMetrics({ taskId, durationMs, files, result = {}, options = {} } = {}) {
  const pageResults = Array.isArray(result.pageResults) ? result.pageResults : [];
  const mode = String(options.mode || 'auto').toLowerCase();
  const format = String(options.format || 'pdf').toLowerCase();
  const language = String(options.language || 'por+eng').toLowerCase();
  const failedFiles = nonNegativeInteger(Array.isArray(result.failures) ? result.failures.length : 0);
  const warningCount = nonNegativeInteger(Array.isArray(result.warnings) ? result.warnings.length : 0);
  return {
    schemaVersion: 3,
    status: failedFiles > 0 || warningCount > 0 ? 'partial' : 'success',
    taskId: typeof taskId === 'string' ? taskId.replace(/[^a-z0-9_-]/gi, '').slice(0, 120) : '',
    engine: 'Tesseract.js',
    engineVersion: tesseractVersion,
    durationMs: nonNegativeInteger(durationMs),
    files: nonNegativeInteger(files),
    outputs: nonNegativeInteger(result.outputCount),
    totalPages: nonNegativeInteger(result.pageCount, pageResults.length),
    recognizedPages: nonNegativeInteger(result.recognizedPages, pageResults.filter((page) => page?.status === 'recognized').length),
    skippedPages: nonNegativeInteger(result.skippedPages, pageResults.filter((page) => page?.status === 'skipped').length),
    unselectedPages: nonNegativeInteger(result.unselectedPages, pageResults.filter((page) => page?.status === 'out-of-range').length),
    noTextPages: nonNegativeInteger(result.noTextPages, pageResults.filter((page) => page?.status === 'no-text').length),
    averageConfidence: averageRecognizedConfidence(result),
    orientationCorrections: nonNegativeInteger(result.orientationCorrections),
    preprocessingPages: nonNegativeInteger(result.preprocessingPages),
    failedFiles,
    warningCount,
    language: ALLOWED_LANGUAGES.has(language) ? language : 'por+eng',
    mode: ALLOWED_MODES.has(mode) ? mode : 'auto',
    format: ALLOWED_FORMATS.has(format) ? format : 'pdf'
  };
}

function createOcrFailureMetrics({ taskId, durationMs, attempt, maxAttempts, error, status } = {}) {
  const rawCode = typeof error?.code === 'string' ? error.code : '';
  const failureCode = ALLOWED_FAILURE_CODES.has(rawCode)
    ? rawCode
    : error?.message === 'OPERATION_CANCELLED'
      ? 'OPERATION_CANCELLED'
      : error?.message === 'OPERATION_TIMEOUT'
        ? 'OPERATION_TIMEOUT'
        : 'OCR_FAILED';
  return {
    schemaVersion: 2,
    status: ['failed', 'cancelled', 'timeout'].includes(status)
      ? status
      : failureCode === 'OPERATION_CANCELLED' ? 'cancelled'
        : failureCode === 'OPERATION_TIMEOUT' ? 'timeout' : 'failed',
    taskId: typeof taskId === 'string' ? taskId.replace(/[^a-z0-9_-]/gi, '').slice(0, 120) : '',
    engine: 'Tesseract.js',
    engineVersion: tesseractVersion,
    durationMs: nonNegativeInteger(durationMs),
    attempt: Math.max(1, nonNegativeInteger(attempt, 1)),
    maxAttempts: Math.max(1, nonNegativeInteger(maxAttempts, 1)),
    failureCode
  };
}

module.exports = { createOcrTelemetryMetrics, createOcrFailureMetrics };
