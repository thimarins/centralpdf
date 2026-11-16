const path = require('path');
const { Worker } = require('worker_threads');
const { QUEUE_POLICY } = require('./constants');

function createOperationWorker(payload, WorkerClass) {
  if (WorkerClass) {
    return { worker: new WorkerClass(path.join(__dirname, 'pdf-operation-worker.js'), { workerData: payload }), start: () => {} };
  }
  if (process.versions.electron) {
    const { utilityProcess } = require('electron');
    const worker = utilityProcess.fork(path.join(__dirname, 'pdf-operation-worker.js'), [], {
      serviceName: 'Central PDF operation',
      stdio: 'ignore'
    });
    return { worker, start: () => worker.postMessage({ type: 'start', payload }) };
  }
  return {
    worker: new Worker(path.join(__dirname, 'pdf-operation-worker.js'), { workerData: payload }),
    start: () => {}
  };
}

function createWorkerExitError(code, cancelledReason = '') {
  if (cancelledReason === 'timeout') return new Error('OPERATION_TIMEOUT');
  if (cancelledReason) return new Error('OPERATION_CANCELLED');
  return new Error(`Worker stopped with exit code ${code}.`);
}

function createPdfWorkerExecution(payload, onProgress = () => {}, WorkerClass) {
  const { worker, start } = createOperationWorker(payload, WorkerClass);

  let settled = false;
  let cancelledReason = '';
  let terminationHandle = null;
  const disposeWorker = () => {
    clearTimeout(terminationHandle);
    terminationHandle = null;
    if (typeof worker.terminate === 'function') worker.terminate().catch(() => {});
    else worker.kill();
  };
  const releaseWorker = () => {
    clearTimeout(terminationHandle);
    terminationHandle = null;
    // A completed operation posts its result before its `finally` block has
    // finished cleaning temporary files/native objects. Let the worker exit
    // naturally so native addons (notably Skia/canvas) are not unloaded while
    // cleanup/finalizers are still running.
  };

  const promise = new Promise((resolve, reject) => {
    worker.on('message', (message) => {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'progress') {
        onProgress(message.payload);
        return;
      }
      if (message.type === 'result') {
        settled = true;
        releaseWorker();
        resolve(message.payload);
        return;
      }
      if (message.type === 'error') {
        settled = true;
        releaseWorker();
        const err = new Error(message.payload.message || 'Worker failed.');
        if (typeof message.payload.safeUserMessage === 'string' && message.payload.safeUserMessage.trim()) {
          err.safeUserMessage = message.payload.safeUserMessage.trim().slice(0, 1000);
        }
        if (typeof message.payload.code === 'string') err.code = message.payload.code;
        if (message.payload.stack) {
          err.stack = message.payload.stack;
        }
        reject(err);
      }
    });

    if (typeof worker.pid === 'number' && worker.pid > 0) {
      start();
    } else if (typeof worker.once === 'function') {
      worker.once('spawn', start);
    } else {
      start();
    }

    worker.on('error', (...details) => {
      settled = true;
      disposeWorker();
      const error = details[0] instanceof Error
        ? details[0]
        : new Error(`O processo de operação falhou${details[0] ? ` (${details[0]})` : ''}.`);
      reject(error);
    });

    worker.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(terminationHandle);
      terminationHandle = null;
      reject(createWorkerExitError(code, cancelledReason));
    });
  });

  return {
    promise,
    cancel: (reason = 'cancelled') => {
      if (settled) return;
      cancelledReason = reason;
      worker.postMessage({ type: 'cancel', reason });
      terminationHandle = setTimeout(() => {
        if (typeof worker.terminate === 'function') worker.terminate().catch(() => {});
        else worker.kill();
      }, QUEUE_POLICY.workerTerminateDelayMs);
      terminationHandle.unref?.();
    }
  };
}

module.exports = {
  createPdfWorkerExecution,
  createWorkerExitError
};
