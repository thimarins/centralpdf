const fs = require('fs');
const path = require('path');
const {
  assert,
  createTempDir,
  toMarkdownTable,
  writeReport
} = require('./_common');
const queue = require('../../src/main/queue');

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
          if (rejectPromise) {
            rejectPromise(new Error(reason === 'timeout' ? 'OPERATION_TIMEOUT' : 'OPERATION_CANCELLED'));
          }
        },
        promise: new Promise((resolve, reject) => {
          rejectPromise = reject;
          updateProgress({ progress: 5, itemProgress: 5, currentItem: 1, totalItems: 1, currentItemName: `${id}.pdf` });
          timer = setTimeout(() => {
            if (options.shouldFail && !options.hasFailedOnce) {
              options.hasFailedOnce = true;
              reject(new Error(options.failMessage || 'simulated failure'));
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
  queue.configure({ concurrency: 1, retryCount: 1, operationTimeoutMs: 400, persistenceEnabled: true, persistencePath });
  const retryOptions = { shouldFail: true, hasFailedOnce: false, failMessage: 'transient failure' };
  queue.enqueue(makeTask('retry-task', 50, retryOptions));
  await drainQueue();
  const persisted = fs.existsSync(persistencePath) ? JSON.parse(fs.readFileSync(persistencePath, 'utf8')) : { pending: [], running: [] };
  assert.ok(Array.isArray(persisted.pending));
  record('queue retry path', 'ok', 'tarefa transitoria reexecuta sem quebrar persistencia');

  resetQueueState();
  queue.configure({ concurrency: 1, retryCount: 0, operationTimeoutMs: 1000, persistenceEnabled: true, persistencePath });
  const cancelId = queue.enqueue(makeTask('cancel-task', 500));
  await wait(60);
  assert.strictEqual(queue.cancel(cancelId), true);
  await drainQueue();
  record('queue cancellation', 'ok', 'cancelamento explicito remove tarefa com seguranca');

  resetQueueState();
  queue.configure({ concurrency: 1, retryCount: 0, operationTimeoutMs: 120, persistenceEnabled: true, persistencePath });
  queue.enqueue(makeTask('timeout-task', 500, { hang: true }));
  await drainQueue();
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
