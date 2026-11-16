const PRIVATE_DOCUMENT_OPERATION_TYPES = new Set([
  'merge', 'split-pages', 'split-range', 'split-size', 'split-content', 'organize', 'compress', 'watermark',
  'images-to-pdf', 'files-to-pdf', 'sign', 'pdf-to-word', 'protect', 'unlock', 'redact',
  'ocr',
  'redact-ocr-search', 'ocr-search-document', 'ocr-extract-area',
  'single-pdf', 'single-pdf-or-image', 'single-pdf-unlock', 'pdf-to-word-analyze'
]);

const ALLOWED_FAILURE_CODES = new Set([
  'OPERATION_CANCELLED', 'OPERATION_TIMEOUT', 'ENOSPC', 'EDQUOT', 'EACCES', 'EPERM', 'EBUSY', 'ENOENT', 'EIO',
  'PDF_INVALID', 'PDF_PROTECTED', 'IMAGE_INVALID', 'INVALID_PAGE_RANGE', 'OCR_OUTPUT_INVALID',
  'OCR_RUNTIME_UNAVAILABLE', 'OCR_MODEL_UNAVAILABLE', 'PDF_SOURCE_CHANGED', 'OCR_PAGE_TOO_LARGE',
  'ORGANIZE_ZOOM_RENDER_FAILED', 'ORGANIZE_TEMP_CLEANUP_FAILED', 'ORGANIZE_THUMBNAIL_RENDER_FAILED',
  'ORGANIZE_OUTLINE_LOAD_FAILED', 'ORGANIZE_PDF_LOAD_FAILED', 'ORGANIZE_FILE_ADD_FAILED',
  'ORGANIZE_METADATA_READ_FAILED', 'ORGANIZE_PAGE_EXPORT_FAILED', 'ORGANIZE_DOCUMENT_SEARCH_FAILED'
]);
const ALLOWED_RENDERER_SCOPES = new Set(['window-error', 'unhandled-rejection', 'organize-workspace']);
const ALLOWED_ERROR_NAMES = new Set(['Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'URIError']);

function getSafeFailureCode(error) {
  const rawCode = typeof error?.code === 'string' ? error.code : '';
  if (ALLOWED_FAILURE_CODES.has(rawCode)) return rawCode;
  if (error?.message === 'OPERATION_CANCELLED') return 'OPERATION_CANCELLED';
  if (error?.message === 'OPERATION_TIMEOUT') return 'OPERATION_TIMEOUT';
  if (error?.name === 'PasswordException') return 'PDF_PROTECTED';
  if (error?.name === 'InvalidPDFException' || error?.name === 'FormatError') return 'PDF_INVALID';
  return 'OPERATION_FAILED';
}

function getSafeDocumentOperationErrorMessage(error, operationType = '') {
  if (['ocr', 'redact-ocr-search', 'ocr-search-document', 'ocr-extract-area'].includes(String(operationType))) {
    const ocrOperation = operationType === 'redact-ocr-search'
      ? 'redaction'
      : operationType === 'ocr-search-document' ? 'search'
        : operationType === 'ocr-extract-area' ? 'area' : 'recognition';
    return getSafeOcrOperationErrorMessage(error, ocrOperation);
  }
  if (typeof error?.safeUserMessage === 'string' && error.safeUserMessage.trim()) {
    return error.safeUserMessage.trim();
  }

  switch (getSafeFailureCode(error)) {
    case 'ENOSPC':
    case 'EDQUOT':
      return 'Não foi possível salvar o resultado porque não há espaço suficiente no disco. Libere espaço e tente novamente.';
    case 'EACCES':
    case 'EPERM':
      return 'Não foi possível acessar ou salvar o arquivo. Verifique as permissões da pasta e se o documento não está aberto em outro programa.';
    case 'EBUSY':
      return 'O arquivo ou a pasta está em uso. Feche o documento em outro programa e tente novamente.';
    case 'ENOENT':
      return 'O arquivo de origem ou a pasta de saída não foi encontrado. Confira se ainda existe e tente novamente.';
    case 'EIO':
      return 'Ocorreu uma falha ao ler ou gravar no disco. Verifique a unidade e tente novamente.';
    default:
      return typeof error?.message === 'string' && error.message.trim()
        ? error.message
        : 'Não foi possível concluir a operação. Confira o arquivo e tente novamente.';
  }
}

function getSafeOcrOperationErrorMessage(error, operation = 'recognition') {
  if (typeof error?.safeUserMessage === 'string' && error.safeUserMessage.trim()) {
    return error.safeUserMessage.trim();
  }

  const code = getSafeFailureCode(error);
  const filesystemMessages = {
    ENOSPC: 'Não foi possível concluir o OCR porque não há espaço suficiente no disco. Libere espaço e tente novamente.',
    EDQUOT: 'Não foi possível concluir o OCR porque o limite de armazenamento foi atingido. Libere espaço e tente novamente.',
    EACCES: 'Não foi possível acessar um arquivo ou salvar o resultado. Verifique as permissões e se o documento está aberto em outro programa.',
    EPERM: 'O Windows impediu o acesso a um arquivo ou o salvamento do resultado. Verifique as permissões e tente novamente.',
    EBUSY: 'Um arquivo ou pasta usado pelo OCR está em uso. Feche-o em outro programa e tente novamente.',
    ENOENT: 'Um arquivo de origem ou a pasta de saída não foi encontrado. Confira os arquivos e tente novamente.',
    EIO: 'Ocorreu uma falha ao ler ou salvar o documento. Verifique a unidade e tente novamente.'
  };
  if (Object.hasOwn(filesystemMessages, code)) return filesystemMessages[code];
  if (code === 'PDF_PROTECTED') return 'Este PDF está protegido por senha. Use “Desbloquear PDF” e tente novamente.';
  if (code === 'PDF_INVALID') return 'Este PDF parece inválido ou danificado. Confira o arquivo e tente novamente.';

  const messages = {
    search: 'Não foi possível pesquisar este PDF. Verifique se ele continua acessível e tente novamente.',
    area: 'Não foi possível reconhecer a área selecionada. Tente novamente ou escolha uma região maior.',
    redaction: 'Não foi possível analisar este PDF para localizar dados. Verifique se ele continua acessível e tente novamente.',
    recognition: 'Não foi possível reconhecer o texto deste arquivo. Confira o documento e tente novamente.'
  };
  return messages[operation] || messages.recognition;
}

function isPrivateDocumentOperation(type, options = {}) {
  if (PRIVATE_DOCUMENT_OPERATION_TYPES.has(String(type || ''))) return true;
  if (!options || typeof options !== 'object') return false;
  return options.searchableOcr === true || options.useOcr === true;
}

function createPrivateOperationFailureMetrics({ type, taskId, durationMs, attempt, maxAttempts, error } = {}) {
  return {
    schemaVersion: 1,
    taskId: typeof taskId === 'string' ? taskId.replace(/[^a-z0-9_-]/gi, '').slice(0, 120) : '',
    operationType: PRIVATE_DOCUMENT_OPERATION_TYPES.has(String(type || '')) ? String(type) : 'document-operation',
    durationMs: Number.isSafeInteger(Number(durationMs)) && Number(durationMs) >= 0 ? Number(durationMs) : 0,
    attempt: Math.max(1, Number.isSafeInteger(Number(attempt)) ? Number(attempt) : 1),
    maxAttempts: Math.max(1, Number.isSafeInteger(Number(maxAttempts)) ? Number(maxAttempts) : 1),
    failureCode: getSafeFailureCode(error)
  };
}

function createRendererFailureMetrics({ scope, errorName, errorCode } = {}) {
  const normalizedCode = typeof errorCode === 'string' && ALLOWED_FAILURE_CODES.has(errorCode) ? errorCode : '';
  return {
    schemaVersion: 1,
    scope: ALLOWED_RENDERER_SCOPES.has(String(scope || '')) ? String(scope) : 'renderer',
    errorName: ALLOWED_ERROR_NAMES.has(String(errorName || '')) ? String(errorName) : 'Error',
    errorCode: normalizedCode
  };
}

module.exports = {
  PRIVATE_DOCUMENT_OPERATION_TYPES,
  isPrivateDocumentOperation,
  getSafeFailureCode,
  getSafeDocumentOperationErrorMessage,
  getSafeOcrOperationErrorMessage,
  createPrivateOperationFailureMetrics,
  createRendererFailureMetrics
};
