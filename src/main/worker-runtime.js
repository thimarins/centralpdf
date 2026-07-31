const path = require('path');
const { Worker } = require('worker_threads');
const { QUEUE_POLICY } = require('./constants');

function createPdfWorkerExecution(payload, onProgress = () => {}) {
  const worker = new Worker(path.join(__dirname, 'pdf-operation-worker.js'), {
    workerData: payload
  });

  let settled = false;
  let cancelledReason = '';
  let terminationHandle = null;

  const promise = new Promise((resolve, reject) => {
    worker.on('message', (message) => {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'progress') {
        onProgress(message.payload);
        return;
      }
      if (message.type === 'result') {
        settled = true;
        clearTimeout(terminationHandle);
        resolve(message.payload);
        return;
      }
      if (message.type === 'error') {
        settled = true;
        clearTimeout(terminationHandle);
        const err = new Error(message.payload.message || 'Worker failed.');
        if (message.payload.stack) {
          err.stack = message.payload.stack;
        }
        reject(err);
      }
    });

    worker.on('error', (error) => {
      settled = true;
      clearTimeout(terminationHandle);
      reject(error);
    });

    worker.on('exit', (code) => {
      if (!settled && code !== 0) {
        const suffix = cancelledReason ? ` after ${cancelledReason}` : '';
        reject(new Error(`Worker stopped with exit code ${code}${suffix}.`));
      }
    });
  });

  return {
    promise,
    cancel: (reason = 'cancelled') => {
      if (settled) return;
      cancelledReason = reason;
      worker.postMessage({ type: 'cancel', reason });
      terminationHandle = setTimeout(() => {
        worker.terminate().catch(() => {});
      }, QUEUE_POLICY.workerTerminateDelayMs);
      terminationHandle.unref?.();
    }
  };
}

module.exports = {
  createPdfWorkerExecution
};
