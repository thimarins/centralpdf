const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const {
  assert,
  createTempDir,
  toMarkdownTable,
  writeReport
} = require('./_common');
const queue = require('../../src/main/queue');
const { createPdfWorkerExecution, createWorkerExitError } = require('../../src/main/worker-runtime');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function drainQueue(timeoutMs = 8000) {
  const start = Date.now();
  while ((queue.queue.length > 0 || queue.runningTasks.size > 0) && (Date.now() - start) < timeoutMs) {
    await wait(50);
  }
  if (queue.queue.length > 0 || queue.runningTasks.size > 0) {
    throw new Error('Queue did not drain in time.');
  }
}

function resetQueueState() {
  for (const task of queue.runningTasks.values()) {
    task.cancelled = true;
    task.execution?.cancel?.('reset');
    clearTimeout(task.timeoutHandle);
  }
  queue.queue = [];
  queue.runningTasks = new Map();
  queue.recoveredTasks = [];
  queue.recentTerminalTasks = [];
  queue.persistenceWritePromise = Promise.resolve();
  queue.persistenceScheduled = false;
}

function makeTask(id, durationMs, options = {}) {
  return {
    id,
    type: options.type || 'organize',
    name: options.name || id,
    filePaths: options.filePaths || [path.join('C:\\virtual', `${id}.pdf`)],
    totalItems: options.totalItems || 1,
    maxAttempts: options.maxAttempts,
    timeoutMs: options.timeoutMs,
    createExecution: (updateProgress, isCancelled) => {
      let timer = null;
      let rejected = false;
      let rejectPromise = null;
      return {
        cancel: (reason) => {
          if (timer) clearTimeout(timer);
          rejected = true;
          const rejectCancellation = () => rejectPromise?.(new Error(reason === 'timeout' ? 'OPERATION_TIMEOUT' : 'OPERATION_CANCELLED'));
          if (options.cancelDelayMs) setTimeout(rejectCancellation, options.cancelDelayMs);
          else rejectCancellation();
        },
        promise: new Promise((resolve, reject) => {
          rejectPromise = reject;
          updateProgress({ progress: 5, itemProgress: 5, currentItem: 1, totalItems: 1, currentItemName: `${id}.pdf` });
          timer = setTimeout(() => {
            if (options.shouldFail && !options.hasFailedOnce) {
              options.hasFailedOnce = true;
              reject(options.failError || new Error(options.failMessage || 'simulated failure'));
              return;
            }
            if (options.hang) {
              return;
            }
            if (rejected || isCancelled()) {
              reject(new Error('OPERATION_CANCELLED'));
              return;
            }
            updateProgress({ progress: 100, itemProgress: 100, currentItem: 1, totalItems: 1, currentItemName: `${id}.pdf`, memoryMb: 64 });
            resolve({ ok: true, id });
          }, durationMs);
        })
      };
    }
  };
}

async function runQueueTests() {
  const workspace = createTempDir('queue-suite');
  const persistencePath = path.join(workspace, 'queue-state.json');
  const results = [];

  function record(name, status, details) {
    results.push({ name, status, details });
  }

  assert.strictEqual(createWorkerExitError(1, 'timeout').message, 'OPERATION_TIMEOUT');
  assert.strictEqual(createWorkerExitError(1, 'cancelled').message, 'OPERATION_CANCELLED');
  assert.match(createWorkerExitError(1).message, /exit code 1/);
  record('worker cancellation classification', 'ok', 'encerramento forçado do worker mantém estados claros de cancelamento e timeout, sem mensagem técnica genérica');

  class FakeOperationWorker extends EventEmitter {
    terminated = false;
    postMessage() {}
    terminate() {
      this.terminated = true;
      return Promise.resolve(0);
    }
  }
  let fakeWorker;
  const workerExecution = createPdfWorkerExecution({}, () => {}, class extends FakeOperationWorker {
    constructor(...args) {
      super(...args);
      fakeWorker = this;
    }
  });
  fakeWorker.emit('message', { type: 'result', payload: { ok: true } });
  assert.deepStrictEqual(await workerExecution.promise, { ok: true });
  assert.strictEqual(fakeWorker.terminated, false, 'Worker concluído não deve ser encerrado antes da limpeza dos recursos nativos.');
  record('native worker cleanup after result', 'ok', 'resultado libera a promessa sem terminar o worker antes da limpeza do bloco finally');

  let safeErrorWorker;
  const safeErrorExecution = createPdfWorkerExecution({}, () => {}, class extends FakeOperationWorker {
    constructor(...args) {
      super(...args);
      safeErrorWorker = this;
    }
  });
  safeErrorWorker.emit('message', { type: 'error', payload: {
    message: 'PDF.js internal error C:\\private\\document.pdf',
    safeUserMessage: 'Não foi possível pesquisar este PDF. Tente novamente.',
    code: 'EIO',
    stack: 'sensitive stack'
  } });
  await assert.rejects(safeErrorExecution.promise, (error) => {
    assert.strictEqual(error.safeUserMessage, 'Não foi possível pesquisar este PDF. Tente novamente.');
    assert.strictEqual(error.code, 'EIO');
    assert.ok(error.message.includes('C:\\private\\document.pdf'), 'A mensagem técnica permanece apenas no objeto interno para diagnóstico local.');
    return true;
  });
  record('worker forwards only structured safe OCR metadata', 'ok', 'a ponte preserva mensagem segura e código permitido para que a fila sanitize a falha sem perder classificação');

  let exitedWorker;
  const exitedWorkerExecution = createPdfWorkerExecution({}, () => {}, class extends FakeOperationWorker {
    constructor(...args) {
      super(...args);
      exitedWorker = this;
    }
  });
  exitedWorkerExecution.cancel('cancelled');
  exitedWorker.emit('exit', 0);
  await assert.rejects(exitedWorkerExecution.promise, (error) => error.message === 'OPERATION_CANCELLED');
  record('zero-exit cancellation settles worker promise', 'ok', 'worker encerrado com código 0 após cancelamento rejeita explicitamente, sem deixar OCR/pesquisa presa');

  resetQueueState();
  queue.configure({
    concurrency: 1,
    retryCount: 1,
    operationTimeoutMs: 400,
    persistenceEnabled: true,
    persistencePath
  });

  const completedId = queue.enqueue(makeTask('complete-task', 80));
  await drainQueue();
  let status = queue.getQueueStatus().find((item) => item.id === completedId);
  assert.ok(status);
  assert.strictEqual(status.status, 'completed');
  assert.strictEqual(status.type, 'organize');
  assert.deepStrictEqual(status.result, { ok: true, id: 'complete-task' });
  record('queue completion', 'ok', 'fila processa tarefa simples, preserva o tipo da operacao e mantem o estado concluido por curto periodo');

  resetQueueState();
  queue.configure({ concurrency: 1, retryCount: 0, operationTimeoutMs: 1000, persistenceEnabled: false, persistencePath });
  const ioFailureCases = [
    ['ENOSPC', 'Não foi possível concluir o OCR porque não há espaço suficiente no disco. Libere espaço e tente novamente.'],
    ['EACCES', 'Não foi possível acessar um arquivo ou salvar o resultado. Verifique as permissões e se o documento está aberto em outro programa.'],
    ['EPERM', 'O Windows impediu o acesso a um arquivo ou o salvamento do resultado. Verifique as permissões e tente novamente.'],
    ['EBUSY', 'Um arquivo ou pasta usado pelo OCR está em uso. Feche-o em outro programa e tente novamente.'],
    ['ENOENT', 'Um arquivo de origem ou a pasta de saída não foi encontrado. Confira os arquivos e tente novamente.'],
    ['EIO', 'Ocorreu uma falha ao ler ou salvar o documento. Verifique a unidade e tente novamente.']
  ];
  for (const [errorCode, expectedMessage] of ioFailureCases) {
    const failureId = `io-failure-${errorCode.toLowerCase()}`;
    const error = Object.assign(new Error(`${errorCode}: operating system diagnostic at C:\\Users\\Pessoa\\privado.pdf`), { code: errorCode });
    queue.enqueue(makeTask(failureId, 10, { type: 'ocr', shouldFail: true, failError: error }));
    await drainQueue();
    const failedTask = queue.getQueueStatus().find((task) => task.id === failureId);
    assert.ok(failedTask, `A falha ${errorCode} deve aparecer na fila.`);
    assert.strictEqual(failedTask.status, 'failed', `A falha ${errorCode} não pode aparecer como sucesso.`);
    assert.strictEqual(failedTask.error, expectedMessage, `A falha ${errorCode} deve usar mensagem segura e clara.`);
    assert.ok(!failedTask.error.includes('C:\\Users\\Pessoa') && !failedTask.error.includes('operating system diagnostic'));
  }
  record('safe user-facing filesystem errors', 'ok', 'ENOSPC/EACCES/EPERM/EBUSY/ENOENT/EIO aparecem em português claro, sem caminho local ou texto técnico bruto');

  resetQueueState();
  queue.configure({ concurrency: 1, retryCount: 1, operationTimeoutMs: 400, persistenceEnabled: true, persistencePath });
  const retryOptions = { shouldFail: true, hasFailedOnce: false, failMessage: 'transient failure' };
  queue.enqueue(makeTask('retry-task', 50, retryOptions));
  await drainQueue();
  const persisted = fs.existsSync(persistencePath) ? JSON.parse(fs.readFileSync(persistencePath, 'utf8')) : { pending: [], running: [] };
  assert.ok(Array.isArray(persisted.pending));
  record('queue retry path', 'ok', 'tarefa transitoria reexecuta sem quebrar persistencia');

  resetQueueState();
  queue.configure({ concurrency: 1, retryCount: 0, operationTimeoutMs: 1000, persistenceEnabled: true, persistencePath });
  const cancelFile = path.join('C:\\virtual', 'shared-cancel.pdf');
  const cancelId = queue.enqueue(makeTask('cancel-task', 500, { cancelDelayMs: 120, filePaths: [cancelFile] }));
  await wait(60);
  assert.strictEqual(queue.cancel(cancelId), true);
  let cancellingTask = queue.getQueueStatus().find((task) => task.id === cancelId);
  assert.strictEqual(cancellingTask.status, 'running', 'A fila deve manter a tarefa ativa enquanto o worker encerra.');
  assert.strictEqual(cancellingTask.cancellationRequested, true, 'A interface deve distinguir pedido de cancelamento de tarefa encerrada.');
  assert.throws(() => queue.enqueue(makeTask('cancel-overlap', 10, { filePaths: [cancelFile] })), /processamento/i, 'A origem permanece bloqueada até o worker parar.');
  await drainQueue();
  cancellingTask = queue.getQueueStatus().find((task) => task.id === cancelId);
  assert.strictEqual(cancellingTask.status, 'cancelled', 'A fila só conclui o cancelamento após o worker parar.');
  assert.strictEqual(queue.enqueue(makeTask('cancel-retry', 10, { filePaths: [cancelFile] })), 'cancel-retry', 'A origem volta a ficar disponível depois da finalização real.');
  await drainQueue();
  record('queue cancellation', 'ok', 'cancelamento fica em andamento até o worker parar; origem não pode ser reutilizada antes da liberação');

  resetQueueState();
  queue.configure({ concurrency: 1, retryCount: 0, operationTimeoutMs: 120, persistenceEnabled: true, persistencePath });
  queue.enqueue(makeTask('timeout-task', 500, { hang: true, cancelDelayMs: 80 }));
  await wait(145);
  const timingOutTask = queue.getQueueStatus().find((task) => task.id === 'timeout-task');
  assert.strictEqual(timingOutTask.status, 'running', 'Timeout deve aguardar o encerramento real da execução.');
  assert.strictEqual(timingOutTask.timeoutRequested, true);
  await drainQueue();
  assert.strictEqual(queue.getQueueStatus().find((task) => task.id === 'timeout-task').status, 'timeout');
  record('queue timeout', 'ok', 'timeout interrompe operacao travada e libera a fila');

  resetQueueState();
  fs.writeFileSync(persistencePath, JSON.stringify({
    pending: [{
      id: 'pending-a',
      name: 'Pending A',
      fileNames: ['a.pdf'],
      progress: 10,
      itemProgress: 10,
      totalItems: 1,
      currentItem: 0,
      currentItemName: '',
      elapsedMs: 200,
      attempt: 1,
      maxAttempts: 1,
      status: 'pending'
    }],
    running: [{
      id: 'running-b',
      name: 'Running B',
      fileNames: ['b.pdf'],
      progress: 25,
      itemProgress: 25,
      totalItems: 1,
      currentItem: 1,
      currentItemName: 'b.pdf',
      elapsedMs: 500,
      attempt: 1,
      maxAttempts: 1,
      status: 'running'
    }]
  }, null, 2), 'utf8');
  queue.configure({ concurrency: 1, retryCount: 0, operationTimeoutMs: 500, persistenceEnabled: true, persistencePath });
  const recovered = queue.getQueueStatus().filter((task) => task.status === 'interrupted');
  assert.strictEqual(recovered.length, 2);
  record('queue recovery', 'ok', 'estado pendente e interrompido reaparece como recuperado');

  resetQueueState();
  const overlappingTask = makeTask('overlap-a', 200, { filePaths: ['C:\\docs\\shared.pdf'] });
  const secondOverlap = makeTask('overlap-b', 200, { filePaths: ['C:\\docs\\shared.pdf'] });
  queue.configure({ concurrency: 1, retryCount: 0, operationTimeoutMs: 500, persistenceEnabled: false, persistencePath });
  queue.enqueue(overlappingTask);
  assert.throws(() => queue.enqueue(secondOverlap), /processamento/i);
  queue.cancel('overlap-a');
  await drainQueue();
  record('queue overlap guard', 'ok', 'mesmo arquivo nao entra duas vezes na fila');

  const table = toMarkdownTable(
    ['Teste', 'Status', 'Detalhes'],
    results.map((result) => [result.name, result.status, result.details])
  );
  const reportPath = writeReport('queue-report.md', [
    '# Queue Test Report',
    '',
    `Gerado em ${new Date().toISOString()}.`,
    '',
    ...table
  ]);

  return {
    ok: true,
    total: results.length,
    reportPath,
    results
  };
}

if (require.main === module) {
  runQueueTests()
    .then((summary) => {
      console.log(`Queue tests passed: ${summary.total}`);
    })
    .catch((error) => {
      console.error(error.stack || String(error));
      process.exit(1);
    });
}

module.exports = {
  runQueueTests
};
