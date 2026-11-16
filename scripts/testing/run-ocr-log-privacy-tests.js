const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const logger = require('../../src/main/logger');
const queue = require('../../src/main/queue');
const { PRIVATE_DOCUMENT_OPERATION_TYPES, isPrivateDocumentOperation, createPrivateOperationFailureMetrics, createRendererFailureMetrics, getSafeFailureCode, getSafeDocumentOperationErrorMessage, getSafeOcrOperationErrorMessage } = require('../../src/main/document-privacy');
const { normalizeOcrDocumentError, normalizeOcrReadError } = require('../../src/main/services/ocr/ocr-service');
const { createOcrFailureMetrics } = require('../../src/main/services/ocr/ocr-telemetry');
const { createTempDir } = require('./_common');

const secret = 'CPF-LEAK-84910276300';
const fileName = 'cliente-confidencial-84910276300.pdf';
const filePath = `C:\\Users\\Thiago\\Documents\\${fileName}`;
for (const [code, expectedText] of [
  ['EACCES', /permissões/],
  ['EBUSY', /Feche-o/],
  ['ENOENT', /Adicione o arquivo novamente/],
  ['EIO', /Verifique a unidade/]
]) {
  const rawError = Object.assign(new Error(`Access denied: ${filePath}; ${secret}`), { code });
  const normalized = normalizeOcrReadError(rawError, 'análise');
  assert.match(normalized.safeUserMessage, expectedText);
  assert.equal(normalized.code, code);
  assert.ok(!normalized.message.includes(filePath) && !normalized.message.includes(secret), 'Erro de leitura OCR não pode expor mensagem bruta, caminho ou conteúdo.');
  assert.equal(getSafeFailureCode(normalized), code, 'O código técnico permitido deve continuar disponível para diagnóstico.');
}
const unknownReadError = normalizeOcrReadError(Object.assign(new Error(`ENOENT ${filePath}; ${secret}`), { code: '__proto__' }), 'OCR');
assert.match(unknownReadError.message, /Não foi possível ler o PDF durante o OCR/);
assert.ok(!unknownReadError.message.includes(filePath) && !unknownReadError.message.includes(secret));
assert.equal(getSafeFailureCode(unknownReadError), 'OPERATION_FAILED');
for (const [operation, type, expectedText] of [
  ['search', 'ocr-search-document', /Não foi possível pesquisar este PDF/],
  ['area', 'ocr-extract-area', /Não foi possível reconhecer a área selecionada/],
  ['redaction', 'redact-ocr-search', /Não foi possível analisar este PDF/],
  ['recognition', 'ocr', /Não foi possível reconhecer o texto/]
]) {
  const raw = Object.assign(new Error(`Internal PDF.js failure at ${filePath}: ${secret}`), { stack: `${filePath} ${secret}` });
  const safe = getSafeOcrOperationErrorMessage(raw, operation);
  assert.match(safe, expectedText);
  assert.ok(!safe.includes(filePath) && !safe.includes(secret), 'Falha inesperada de OCR não pode expor caminho ou conteúdo.');
  assert.strictEqual(getSafeDocumentOperationErrorMessage(raw, type), safe, 'A fila deve aplicar mensagem segura conforme o fluxo OCR.');
}
assert.match(getSafeOcrOperationErrorMessage(Object.assign(new Error('raw path'), { code: 'PDF_PROTECTED' }), 'search'), /Desbloquear PDF/);
assert.strictEqual(getSafeOcrOperationErrorMessage(Object.assign(new Error('raw path'), { safeUserMessage: 'Mensagem segura do serviço.' }), 'search'), 'Mensagem segura do serviço.');
const mainSource = fs.readFileSync(path.join(__dirname, '../../src/main/index.js'), 'utf8');
const rendererSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/app.js'), 'utf8');
const queueSource = fs.readFileSync(path.join(__dirname, '../../src/main/queue.js'), 'utf8');
const pdfServiceSource = fs.readFileSync(path.join(__dirname, '../../src/main/pdf-service.js'), 'utf8');
const pdfOperationWorkerSource = fs.readFileSync(path.join(__dirname, '../../src/main/pdf-operation-worker.js'), 'utf8');
const redactWorkspaceSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/ui/redact/redact-workspace.js'), 'utf8');
const organizeWorkspaceSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/ui/organize/organize-workspace.js'), 'utf8');
const organizeErrorsSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/ui/organize/organize-errors.mjs'), 'utf8');
assert.match(mainSource, /!privateDocumentOperation && logFileNames\.length > 0/, 'Logs de operações sensíveis não devem incluir nomes originais.');
assert.match(mainSource, /warnings: privateDocumentOperation\s*\?\s*\[\]/, 'A telemetria de operações sensíveis não deve serializar avisos textuais.');
assert.match(mainSource, /!privateDocumentOperation && outputName/, 'Logs de operações sensíveis não devem incluir nomes de saída.');
assert.match(mainSource, /if \(!privateDocumentOperation\) logger\.logError\('OPERATION_FAILED', error\)/, 'Falhas sensíveis devem usar métricas seguras, nunca stack/mensagem bruta.');
assert.match(mainSource, /logger\.logMetric\('QUEUE_SUBMISSION_FAILED', createPrivateOperationFailureMetrics\(/, 'Falhas no pré-processamento/entrada na fila não devem registrar texto bruto de validação.');
assert.match(mainSource, /getSafeOcrOperationErrorMessage\(error, 'area'\)/, 'Falhas de extração OCR por área devem ser sanitizadas antes de voltar pela ponte IPC.');
assert.match(mainSource, /getSafeOcrOperationErrorMessage\(error, 'search'\)/, 'Falhas de busca OCR devem ser sanitizadas antes de voltar pela ponte IPC.');
assert.doesNotMatch(mainSource, /logger\.logError\('QUEUE_ERROR', err\)/, 'A exceção de upload não deve ser gravada diretamente no log.');
assert.match(mainSource, /logger\.logMetric\('RENDERER_RUNTIME_FAILURE', metrics\)/, 'Exceções da interface devem ser registradas como métricas sanitizadas.');
assert.match(mainSource, /process\.stderr\.write\(`\[uncaughtException\] failureCode=\$\{getSafeFailureCode\(err\)\}/, 'O handler de crash não deve escrever stack ou conteúdo bruto no stderr.');
assert.match(mainSource, /logger\.logMetric\('UNHANDLED_REJECTION', \{ schemaVersion: 1, failureCode: getSafeFailureCode\(reason\) \}\)/, 'Rejeições não tratadas devem ser registradas sem mensagem/stack.');
const loggerSource = fs.readFileSync(path.join(__dirname, '../../src/main/logger.js'), 'utf8');
assert.match(loggerSource, /CRITICAL: failureCode=\$\{getSafeFailureCode\(err\)\}/, 'O log de crashes não deve persistir stack de documento.');
assert.doesNotMatch(loggerSource, /writeLog\('crashes\.log', `CRITICAL: \$\{errMsg\}`\)/, 'O logger não pode restaurar a gravação de stack bruta.');
assert.doesNotMatch(mainSource, /safePayload\.(?:message|stack|context)/, 'O IPC não deve registrar mensagens, stacks ou caminhos recebidos da interface.');
assert.match(rendererSource, /logRendererError\?\.\(\{\s*scope,\s*errorName,\s*errorCode\s*\}\)/, 'A interface deve enviar apenas classe/escopo/código de erro, sem mensagem nem stack.');
assert.doesNotMatch(rendererSource, /reportRuntimeIssue\("window-error", event\.error \|\| fallbackError, event\.filename/, 'O caminho de script recebido no evento error não deve ser enviado ao log.');
assert.match(mainSource, /logger\.logMetric\('TEMP_DELETE_FAILED', \{ schemaVersion: 1, failureCode: getSafeFailureCode\(error\) \}\)/, 'Falhas ao limpar temporários não devem registrar paths brutos.');
assert.match(queueSource, /logger\.logMetric\('QUEUE_CANCEL_CLEANUP_FAILED', \{ schemaVersion: 1, failureCode: getSafeFailureCode\(error\) \}\)/, 'Falhas de limpeza ao cancelar não devem registrar mensagens ou caminhos.');
assert.match(queueSource, /getSafeDocumentOperationErrorMessage\(error, task\.type\)/, 'A fila deve escolher uma mensagem segura conforme o tipo da operação OCR.');
assert.doesNotMatch(pdfServiceSource, /console\.warn\([^\n]*,\s*(?:err|error)\)/, 'Avisos do processamento de PDF não devem escrever objetos de erro brutos no console.');
assert.doesNotMatch(pdfOperationWorkerSource, /console\.error\([^\n]*,\s*(?:restoreError|rmError)\)/, 'Falhas de ZIP não devem escrever erros com caminhos de documentos.');
assert.doesNotMatch(redactWorkspaceSource, /console\.(?:warn|error)\("[^"]*:",\s*(?:error|err)\)/, 'O workspace de ocultação não deve despejar exceções PDF.js brutas no console.');
assert.doesNotMatch(redactWorkspaceSource, /message:\s*err\?\.message\s*\|\|\s*'Não foi possível analisar este PDF no momento\.'/i, 'Falhas internas de análise OCR não devem aparecer sem tradução na mensagem ao usuário.');
assert.match(redactWorkspaceSource, /normalizeRedactErrorMessage\(err, 'Não foi possível analisar este PDF\./, 'A busca OCR deve traduzir falhas técnicas para orientação simples em português.');
assert.doesNotMatch(organizeWorkspaceSource, /console\.(?:warn|error)\([^\n]*,\s*(?:error|err)\)/, 'A organização não deve imprimir exceções brutas que possam incluir caminhos ou conteúdo.');
assert.match(organizeWorkspaceSource, /scope:\s*'organize-workspace'/, 'Falhas da organização devem usar o canal central de diagnóstico sanitizado.');
assert.doesNotMatch(organizeWorkspaceSource, /status\.textContent\s*=\s*error\?\.message/i, 'Falhas da pesquisa OCR na organização não devem expor a mensagem técnica sem tradução.');
assert.match(organizeWorkspaceSource, /Não foi possível pesquisar os documentos:\s*\$\{normalizeOrganizeLoadReason\(error\)\}/, 'A pesquisa OCR deve traduzir falhas em mensagem simples e sem caminhos.');
assert.doesNotMatch(organizeErrorsSource, /return raw|return raw\.length|\$\{raw/, 'Mensagens de upload não devem devolver texto técnico bruto ao usuário.');
assert.doesNotMatch(mainSource, /SECOND_INSTANCE_RECEIVED['"], `argv=\$\{commandLine\.join/, 'O caminho aberto pelo Explorer não deve ser escrito nos logs de segunda instância.');
const operationTypesBlock = mainSource.match(/const OPERATION_TYPES = new Set\(\[([\s\S]*?)\]\);/);
assert.ok(operationTypesBlock, 'O inventário das operações do aplicativo deve continuar explícito para a auditoria de privacidade.');
const applicationOperationTypes = [...operationTypesBlock[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
assert.ok(applicationOperationTypes.length > 0);
for (const type of applicationOperationTypes) {
  assert.strictEqual(isPrivateDocumentOperation(type), true, `Nova operação ${type} entrou no processamento de documentos sem proteção de log.`);
}
for (const type of PRIVATE_DOCUMENT_OPERATION_TYPES) {
  assert.strictEqual(isPrivateDocumentOperation(type), true, `A operação documental ${type} deve aplicar a política de log privado.`);
}
assert.strictEqual(isPrivateDocumentOperation('merge', { searchableOcr: false }), true, 'Mesmo a mesclagem convencional não grava nomes de documento nos logs.');
const safeGenericFailure = createPrivateOperationFailureMetrics({
  type: 'merge', taskId: 'merge-private', durationMs: 15, attempt: 1, maxAttempts: 1,
  error: Object.assign(new Error(`CPF-LEAK ${secret} em ${filePath}`), { code: `CPF-${secret}` })
});
assert.strictEqual(safeGenericFailure.failureCode, 'OPERATION_FAILED', 'Códigos desconhecidos não podem carregar conteúdo de documentos.');
assert.ok(!JSON.stringify(safeGenericFailure).includes(secret));
assert.ok(!JSON.stringify(safeGenericFailure).includes(filePath));
assert.strictEqual(getSafeFailureCode(Object.assign(new Error(filePath), { code: `CPF-${secret}` })), 'OPERATION_FAILED');
assert.strictEqual(getSafeFailureCode(Object.assign(new Error(filePath), { code: 'EACCES' })), 'EACCES');
  assert.deepStrictEqual(createRendererFailureMetrics({ scope: 'organize-workspace', errorName: 'Error', errorCode: 'ORGANIZE_PDF_LOAD_FAILED' }), {
    schemaVersion: 1,
    scope: 'organize-workspace',
    errorName: 'Error',
    errorCode: 'ORGANIZE_PDF_LOAD_FAILED'
  });
  assert.strictEqual(createRendererFailureMetrics({ scope: 'organize-workspace', errorName: 'Error', errorCode: 'ORGANIZE_DOCUMENT_SEARCH_FAILED' }).errorCode, 'ORGANIZE_DOCUMENT_SEARCH_FAILED');
  assert.deepStrictEqual(createRendererFailureMetrics({ scope: filePath, errorName: 'Error', errorCode: secret }), {
    schemaVersion: 1,
    scope: 'renderer',
    errorName: 'Error',
    errorCode: ''
  });
const safeRendererFailure = createRendererFailureMetrics({
  scope: 'window-error', errorName: 'TypeError', errorCode: `CPF-${secret}`,
  message: `CPF ${secret} em ${filePath}`, stack: `${filePath}:18:2`, context: filePath
});
assert.deepStrictEqual(safeRendererFailure, { schemaVersion: 1, scope: 'window-error', errorName: 'TypeError', errorCode: '' });
assert.ok(!JSON.stringify(safeRendererFailure).includes(secret));
assert.ok(!JSON.stringify(safeRendererFailure).includes(filePath));
const logsDir = createTempDir('ocr-log-privacy-logs');
const exportDir = path.join(createTempDir('ocr-log-privacy-export'), 'bundle');

async function waitForFailure(taskId, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const task = queue.getQueueStatus().find((entry) => entry.id === taskId);
    if (task?.status === 'failed') return task;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Fila OCR não concluiu a falha simulada no tempo esperado.');
}

async function waitForStatus(taskId, expectedStatus, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const task = queue.getQueueStatus().find((entry) => entry.id === taskId);
    if (task?.status === expectedStatus) return task;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Fila OCR não atingiu o estado ${expectedStatus} no tempo esperado.`);
}

async function runOcrLogPrivacyTests() {
  const { normalizeOrganizeLoadReason } = await import('../../src/renderer/ui/organize/organize-errors.mjs');
  const safeOrganizeMessages = [
    normalizeOrganizeLoadReason(Object.assign(new Error(`Invalid PDF at ${filePath}; ${secret}`), { code: 'PDF_INVALID' })),
    normalizeOrganizeLoadReason(Object.assign(new Error(`Access denied: ${filePath}`), { code: 'EACCES' })),
    normalizeOrganizeLoadReason(Object.assign(new Error(`Failed to read ${filePath}; ${secret}`), { code: 'EIO' }))
  ];
  for (const message of safeOrganizeMessages) {
    assert.ok(!message.includes(secret) && !message.includes(filePath), 'Mensagem de upload da organização expôs caminho ou conteúdo.');
  }
  assert.match(safeOrganizeMessages[0], /inválido ou corrompido/);
  assert.match(safeOrganizeMessages[1], /falta de permissão/);
  assert.match(safeOrganizeMessages[2], /falha ao ler/);

  logger.init(logsDir, 30);

  // A failed logger write must not leak the log directory or raw OS error to stderr.
  const originalAppendFile = fs.promises.appendFile;
  const originalConsoleError = console.error;
  const fallbackOutput = [];
  fs.promises.appendFile = async () => {
    const error = new Error(`Access denied at ${filePath}; ${secret}`);
    error.code = 'EACCES';
    throw error;
  };
  console.error = (...args) => fallbackOutput.push(args.join(' '));
  try {
    logger.logMetric('LOGGER_WRITE_FAILURE_TEST', { failureCode: 'EACCES' });
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    fs.promises.appendFile = originalAppendFile;
    console.error = originalConsoleError;
  }
  assert.strictEqual(fallbackOutput.length, 1, 'Falha de gravação deve gerar um único diagnóstico local, sem repetir tentativas de log.');
  assert.match(fallbackOutput[0], /failureCode=EACCES/);
  for (const sensitiveValue of [secret, fileName, 'C:\\Users\\Thiago']) {
    assert.ok(!fallbackOutput[0].includes(sensitiveValue), `Fallback do logger expôs dado sensível: ${sensitiveValue}`);
  }

  logger.logCrash(new Error(`CPF ${secret} em ${filePath}`));
  queue.configure({ concurrency: 1, retryCount: 1, operationTimeoutMs: 5000, persistenceEnabled: false, persistencePath: '' });
  queue.enqueue({
    id: 'ocr-privacy-test',
    type: 'ocr',
    name: 'Reconhecer texto (OCR)',
    filePaths: [filePath],
    originalFileNames: [fileName],
    maxAttempts: 1,
    timeoutMs: 5000,
    createExecution: () => ({
      cancel() {},
      promise: Promise.reject(Object.assign(new Error(`Falha ao reconhecer ${secret} em ${filePath}`), { code: 'EACCES' }))
    })
  });

  const failedTask = await waitForFailure('ocr-privacy-test');
  assert.strictEqual(
    failedTask.error,
    'Não foi possível acessar um arquivo ou salvar o resultado. Verifique as permissões e se o documento está aberto em outro programa.',
    'A falha EACCES deve ser explicada sem propagar o diagnóstico bruto à interface.'
  );
  assert.ok(!failedTask.error.includes(secret) && !failedTask.error.includes(filePath));

  const normalizedReadFailure = normalizeOcrReadError(Object.assign(
    new Error(`Access denied: ${filePath}; ${secret}`), { code: 'EACCES' }
  ), 'análise');
  queue.enqueue({
    id: 'ocr-read-error-privacy-test', type: 'ocr', name: 'Reconhecer texto (OCR)',
    filePaths: [filePath], originalFileNames: [fileName], maxAttempts: 1, timeoutMs: 5000,
    createExecution: () => ({ cancel() {}, promise: Promise.reject(normalizedReadFailure) })
  });
  const failedReadTask = await waitForFailure('ocr-read-error-privacy-test');
  assert.strictEqual(failedReadTask.error, normalizedReadFailure.safeUserMessage);
  assert.match(failedReadTask.error, /permissões/);
  assert.ok(!failedReadTask.error.includes(secret) && !failedReadTask.error.includes(filePath));

  const normalizedPasswordError = normalizeOcrDocumentError(Object.assign(
    new Error(`Password required for ${filePath}; ${secret}`), { name: 'PasswordException', code: 1 }
  ));
  assert.strictEqual(normalizedPasswordError.code, 'PDF_PROTECTED', 'A normalização amigável deve preservar um código diagnóstico seguro para o log.');
  assert.strictEqual(createOcrFailureMetrics({ error: normalizedPasswordError }).failureCode, 'PDF_PROTECTED');
  assert.ok(!JSON.stringify(createOcrFailureMetrics({ error: normalizedPasswordError })).includes(secret));
  queue.enqueue({
    id: 'ocr-password-privacy-test', type: 'ocr', name: 'Reconhecer texto (OCR)', filePaths: [filePath],
    originalFileNames: [fileName], maxAttempts: 1, timeoutMs: 5000,
    createExecution: () => ({ cancel() {}, promise: Promise.reject(normalizedPasswordError) })
  });
  const failedPasswordTask = await waitForFailure('ocr-password-privacy-test');
  assert.match(failedPasswordTask.error, /PDF está protegido por senha.*Desbloquear PDF/i);
  assert.ok(!failedPasswordTask.error.includes(secret) && !failedPasswordTask.error.includes(filePath));
  const normalizedInvalidPdfError = normalizeOcrDocumentError(Object.assign(
    new Error(`Invalid PDF ${filePath}; ${secret}`), { name: 'InvalidPDFException' }
  ));
  assert.strictEqual(normalizedInvalidPdfError.code, 'PDF_INVALID');
  assert.strictEqual(createOcrFailureMetrics({ error: normalizedInvalidPdfError }).failureCode, 'PDF_INVALID');
  assert.strictEqual(createOcrFailureMetrics({ error: Object.assign(new Error(`quota ${filePath}`), { code: 'EDQUOT' }) }).failureCode, 'EDQUOT');
  queue.enqueue({
    id: 'ocr-invalid-pdf-privacy-test', type: 'ocr', name: 'Reconhecer texto (OCR)', filePaths: [filePath],
    originalFileNames: [fileName], maxAttempts: 1, timeoutMs: 5000,
    createExecution: () => ({ cancel() {}, promise: Promise.reject(normalizedInvalidPdfError) })
  });
  const failedInvalidPdfTask = await waitForFailure('ocr-invalid-pdf-privacy-test');
  assert.match(failedInvalidPdfTask.error, /PDF parece inválido ou danificado/i);
  assert.ok(!failedInvalidPdfTask.error.includes(secret) && !failedInvalidPdfTask.error.includes(filePath));

  let retryCount = 0;
  queue.enqueue({
    id: 'ocr-privacy-retry-test', type: 'ocr', name: 'Reconhecer texto (OCR)', filePaths: [filePath],
    originalFileNames: [fileName], maxAttempts: 2, timeoutMs: 5000,
    createExecution: () => {
      retryCount += 1;
      return {
        cancel() {},
        promise: retryCount === 1
          ? Promise.reject(new Error(`CPF 998.765.432-10 em ${filePath}`))
          : Promise.resolve({ outputPath: path.join(path.dirname(filePath), 'resultado.pdf') })
      };
    }
  });
  await waitForStatus('ocr-privacy-retry-test', 'completed');
  assert.strictEqual(retryCount, 2, 'A regressão deve confirmar que falha transitória OCR pode ser repetida e concluída.');

  queue.enqueue({
    id: 'ocr-cancel-telemetry-test', type: 'ocr', name: 'Reconhecer texto (OCR)', filePaths: [filePath],
    originalFileNames: [fileName], maxAttempts: 1, timeoutMs: 5000,
    createExecution: () => {
      let rejectExecution;
      const promise = new Promise((resolve, reject) => { rejectExecution = reject; });
      return { promise, cancel: () => rejectExecution(new Error('OPERATION_CANCELLED')) };
    }
  });
  await waitForStatus('ocr-cancel-telemetry-test', 'running');
  queue.cancel('ocr-cancel-telemetry-test');
  await waitForStatus('ocr-cancel-telemetry-test', 'cancelled');

  queue.enqueue({
    id: 'ocr-cancel-pending-active-test', type: 'ocr', name: 'Reconhecer texto (OCR)', filePaths: [filePath],
    originalFileNames: [fileName], maxAttempts: 1, timeoutMs: 5000,
    createExecution: () => {
      let rejectExecution;
      const promise = new Promise((resolve, reject) => { rejectExecution = reject; });
      return { promise, cancel: () => rejectExecution(new Error('OPERATION_CANCELLED')) };
    }
  });
  await waitForStatus('ocr-cancel-pending-active-test', 'running');
  queue.enqueue({
    id: 'ocr-cancel-pending-telemetry-test', type: 'ocr', name: 'Reconhecer texto (OCR)', filePaths: [`${filePath}.pending`],
    originalFileNames: [fileName], maxAttempts: 1, timeoutMs: 5000,
    createExecution: () => ({ promise: Promise.resolve({}), cancel() {} })
  });
  queue.cancel('ocr-cancel-pending-telemetry-test');
  await waitForStatus('ocr-cancel-pending-telemetry-test', 'cancelled');
  queue.cancel('ocr-cancel-pending-active-test');
  await waitForStatus('ocr-cancel-pending-active-test', 'cancelled');

  queue.enqueue({
    id: 'ocr-timeout-telemetry-test', type: 'ocr', name: 'Reconhecer texto (OCR)', filePaths: [filePath],
    originalFileNames: [fileName], maxAttempts: 1, timeoutMs: 40,
    createExecution: () => {
      let rejectExecution;
      const promise = new Promise((resolve, reject) => { rejectExecution = reject; });
      return { promise, cancel: () => rejectExecution(new Error('OPERATION_TIMEOUT')) };
    }
  });
  await waitForStatus('ocr-timeout-telemetry-test', 'timeout');

  queue.enqueue({
    id: 'redact-ocr-privacy-test', type: 'redact-ocr-search', name: 'Ocultar Dados', filePaths: [filePath],
    originalFileNames: [fileName], maxAttempts: 1, timeoutMs: 5000,
    createExecution: () => ({
      cancel() {},
      promise: Promise.reject(new Error(`Consulta ${secret} falhou no documento ${filePath}`))
    })
  });
  const failedRedactionSearch = await waitForFailure('redact-ocr-privacy-test');
  assert.match(failedRedactionSearch.error, /Não foi possível analisar este PDF para localizar dados/);
  assert.ok(!failedRedactionSearch.error.includes(secret) && !failedRedactionSearch.error.includes(filePath), 'Falhas da busca OCR para ocultação não podem expor texto do documento nem caminho local.');

  queue.enqueue({
    id: 'merge-document-privacy-test', type: 'merge', name: 'Mesclar', filePaths: [filePath],
    originalFileNames: [fileName], maxAttempts: 1, timeoutMs: 5000,
    createExecution: () => ({
      cancel() {},
      promise: Promise.reject(Object.assign(new Error(`CPF-LEAK ${secret} em ${filePath}`), { code: `CPF-${secret}` }))
    })
  });
  const failedMerge = await waitForFailure('merge-document-privacy-test');
  assert.match(failedMerge.error, new RegExp(secret), 'A mensagem detalhada permanece visível na fila também para operações comuns.');

  await logger.exportDiagnostics(exportDir, {
    recentHistory: [{ fileName, filePath, outputPath: filePath, outputDir: path.dirname(filePath), errorMessage: secret }]
  }, queue.getHealthSummary());

  const operationsLog = fs.readFileSync(path.join(exportDir, 'operations.log'), 'utf8');
  const crashesLog = fs.readFileSync(path.join(exportDir, 'crashes.log'), 'utf8');
  const exportedConfig = fs.readFileSync(path.join(exportDir, 'config-diagnostic.json'), 'utf8');
  assert.strictEqual((operationsLog.match(/OCR_ATTEMPT_FAILURE/g) || []).length, 5, 'Uma métrica segura deve ser gravada por tentativa com falha, sem duplicação no encerramento da fila.');
  assert.strictEqual((operationsLog.match(/DOCUMENT_OPERATION_ATTEMPT_FAILURE/g) || []).length, 2, 'Busca OCR de ocultação e mesclagem devem registrar apenas códigos seguros, sem stack nem nome de arquivo.');
  assert.match(operationsLog, /EACCES/);
  assert.match(operationsLog, /PDF_PROTECTED/);
  assert.match(operationsLog, /PDF_INVALID/);
  assert.match(operationsLog, /OCR_OPERATION_TERMINAL.*cancelled/);
  assert.match(operationsLog, /OCR_OPERATION_TERMINAL.*timeout/);
  assert.strictEqual((operationsLog.match(/OCR_OPERATION_TERMINAL/g) || []).length, 4, 'Cada cancelamento/timeout, inclusive da fila pendente, deve gerar exatamente um evento terminal.');
  for (const sensitiveValue of [secret, fileName, 'C:\\Users\\Thiago', '84910276300']) {
    assert.ok(!operationsLog.includes(sensitiveValue), `Log de falha OCR expôs dado sensível: ${sensitiveValue}`);
    assert.ok(!crashesLog.includes(sensitiveValue), `Log de crash expôs dado sensível: ${sensitiveValue}`);
    assert.ok(!exportedConfig.includes(sensitiveValue), `Configuração exportada expôs dado sensível: ${sensitiveValue}`);
  }
  assert.match(exportedConfig, /A operação não foi concluída\./);
  console.log('Document privacy passed: known filesystem failures use safe user messages; operation logs and diagnostics exclude document text, filenames, and paths.');
}

if (require.main === module) {
  runOcrLogPrivacyTests().catch((error) => {
    console.error(error.stack || String(error));
    process.exitCode = 1;
  });
}

module.exports = { runOcrLogPrivacyTests };
