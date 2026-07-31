const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { APP_DEFAULTS, QUEUE_POLICY } = require('./constants');

class ProcessingQueue extends EventEmitter {
  constructor() {
    super();
    this.queue = [];
    this.runningTasks = new Map();
    this.recoveredTasks = [];
    this.recentTerminalTasks = [];
    this.options = {
      concurrency: 1,
      retryCount: APP_DEFAULTS.queueRetryCount,
      operationTimeoutMs: APP_DEFAULTS.operationTimeoutMs,
      persistenceEnabled: true,
      persistencePath: ''
    };
    this.persistenceWritePromise = Promise.resolve();
    this.persistenceScheduled = false;
  }

  configure(options = {}) {
    this.options = {
      ...this.options,
      ...options
    };
    this.recoverPersistedState();
    this.schedulePersistState();
  }

  recoverPersistedState() {
    if (!this.options.persistenceEnabled || !this.options.persistencePath || !fs.existsSync(this.options.persistencePath)) {
      return;
    }

    try {
      const stats = fs.statSync(this.options.persistencePath);
      if (stats.size === 0) {
        this.recoveredTasks = [];
        return;
      }
      const raw = fs.readFileSync(this.options.persistencePath, 'utf8');
      if (!raw || !raw.trim()) {
        this.recoveredTasks = [];
        return;
      }
      const data = JSON.parse(raw);
      const recovered = [...(data.pending || []), ...(data.running || [])];
      if (recovered.length > 0) {
        const recoveredAt = new Date().toISOString();
        this.recoveredTasks = recovered.map((task) => ({
          id: `${task.id}_recovered`,
          name: task.name,
          fileNames: task.fileNames || [],
          status: 'interrupted',
          quietNotifications: Boolean(task.quietNotifications),
          progress: task.progress || 0,
          itemProgress: task.itemProgress || 0,
          totalItems: task.totalItems || 1,
          currentItem: task.currentItem || 0,
          currentItemName: task.currentItemName || '',
          error: `Sessão anterior interrompida em ${recoveredAt}`,
          elapsedMs: task.elapsedMs || 0,
          etaSeconds: null,
          throughputItemsPerMinute: 0,
          attempt: task.attempt || 1,
          maxAttempts: task.maxAttempts || 1
        }));
      }
    } catch (err) {
      this.recoveredTasks = [];
    } finally {
      if (this.options.persistencePath && fs.existsSync(this.options.persistencePath)) {
        fs.promises.unlink(this.options.persistencePath).catch(() => {});
      }
    }
  }

  persistState() {
    if (!this.options.persistenceEnabled || !this.options.persistencePath) return;

    const directory = path.dirname(this.options.persistencePath);
    if (!fs.existsSync(directory)) {
      fs.mkdirSync(directory, { recursive: true });
    }

    const payload = {
      updatedAt: new Date().toISOString(),
      pending: this.queue.map((task) => this.serializeTask(task)),
      running: [...this.runningTasks.values()].map((task) => this.serializeTask(task))
    };

    try {
      fs.writeFileSync(this.options.persistencePath, JSON.stringify(payload, null, 2), 'utf8');
    } catch (e) {}
  }

  schedulePersistState() {
    if (this.persistenceScheduled) return;
    this.persistenceScheduled = true;
    setTimeout(() => {
      this.persistenceScheduled = false;
      this.persistState();
    }, QUEUE_POLICY.persistenceDebounceMs).unref?.();
  }

  serializeTask(task) {
    return {
      id: task.id,
      name: task.name,
      fileNames: task.filePaths.map((p) => path.basename(p)),
      progress: task.progress,
      itemProgress: task.itemProgress,
      totalItems: task.totalItems,
      currentItem: task.currentItem,
      currentItemName: task.currentItemName,
      elapsedMs: task.elapsedMs,
      attempt: task.attempt,
      maxAttempts: task.maxAttempts,
      status: task.status
    };
  }

  enqueue(task) {
    const activePaths = this.getActiveFilePaths();
    const hasOverlap = task.filePaths.some((filePath) => activePaths.has(filePath));
    if (hasOverlap) {
      throw new Error('Um dos arquivos desta operação já está em processamento.');
    }

    const queueItem = {
      ...task,
      status: 'pending',
      progress: 0,
      itemProgress: 0,
      totalItems: task.totalItems || 1,
      currentItem: 0,
      currentItemName: '',
      error: null,
      elapsedMs: 0,
      etaSeconds: null,
      throughputItemsPerMinute: 0,
      memoryMb: 0,
      cancelled: false,
      attempt: 1,
      maxAttempts: Math.max(1, (task.maxAttempts ?? this.options.retryCount + 1)),
      timeoutMs: task.timeoutMs || this.options.operationTimeoutMs,
      createdAt: Date.now(),
      startedAt: 0,
      finishedAt: 0,
      execution: null,
      timeoutHandle: null,
      lastProgressAt: 0
    };

    this.queue.push(queueItem);
    this.schedulePersistState();
    this.emit('update', this.getQueueStatus());
    process.nextTick(() => this.pump());
    return queueItem.id;
  }

  getActiveFilePaths() {
    const paths = new Set();
    [...this.runningTasks.values(), ...this.queue].forEach((task) => {
      task.filePaths.forEach((filePath) => paths.add(filePath));
    });
    return paths;
  }

  cancel(taskId) {
    if (this.runningTasks.has(taskId)) {
      const task = this.runningTasks.get(taskId);
      task.cancelled = true;
      task.status = 'cancelled';
      task.execution.cancel?.('cancelled');
      this.schedulePersistState();
      this.emit('update', this.getQueueStatus());
      return true;
    }

    const index = this.queue.findIndex((task) => task.id === taskId);
    if (index !== -1) {
      const [task] = this.queue.splice(index, 1);
      task.status = 'cancelled';
      this.addRecentTerminalTask(task);
      this.schedulePersistState();
      this.emit('update', this.getQueueStatus());
      return true;
    }

    return false;
  }

  pump() {
    while (this.runningTasks.size < this.options.concurrency && this.queue.length > 0) {
      const nextTask = this.queue.shift();
      this.startTask(nextTask);
    }
  }

  startTask(task) {
    task.status = 'running';
    task.startedAt = Date.now();
    task.lastProgressAt = task.startedAt;
    this.runningTasks.set(task.id, task);
    this.schedulePersistState();
    this.emit('update', this.getQueueStatus());

    const progressHandler = (progress) => {
      if (!this.runningTasks.has(task.id)) return;
      if (task.cancelled) {
        throw new Error('OPERATION_CANCELLED');
      }

      if (typeof progress.progress === 'number') task.progress = progress.progress;
      if (typeof progress.itemProgress === 'number') task.itemProgress = progress.itemProgress;
      if (typeof progress.totalItems === 'number' && progress.totalItems > 0) task.totalItems = progress.totalItems;
      if (typeof progress.currentItem === 'number' && progress.currentItem >= 0) task.currentItem = progress.currentItem;
      if (typeof progress.currentItemName === 'string') task.currentItemName = progress.currentItemName;
      if (typeof progress.memoryMb === 'number') task.memoryMb = progress.memoryMb;

      const now = Date.now();
      task.elapsedMs = now - task.startedAt;
      task.lastProgressAt = now;
      if (task.progress > 0) {
        const progressRatio = Math.max(0.01, task.progress / 100);
        const estimatedTotalMs = task.elapsedMs / progressRatio;
        task.etaSeconds = Math.max(0, Math.round((estimatedTotalMs - task.elapsedMs) / 1000));
      }
      if (task.elapsedMs > 0 && task.currentItem > 0) {
        task.throughputItemsPerMinute = Number(((task.currentItem / task.elapsedMs) * 60_000).toFixed(2));
      }

      this.schedulePersistState();
      this.emit('update', this.getQueueStatus());
    };

    task.execution = task.createExecution(progressHandler, () => task.cancelled);
    task.timeoutHandle = setTimeout(() => {
      task.cancelled = true;
      task.status = 'timeout';
      task.execution.cancel?.('timeout');
    }, task.timeoutMs);

    task.execution.promise
      .then((result) => {
        task.finishedAt = Date.now();
        task.elapsedMs = task.finishedAt - task.startedAt;
        if (task.status === 'timeout') {
          task.error = 'A operação excedeu o tempo limite configurado.';
          this.emit('update', this.getQueueStatus());
          return;
        }
        if (task.cancelled) {
          task.status = 'cancelled';
          this.emit('update', this.getQueueStatus());
          return;
        }
        task.status = 'completed';
        task.progress = 100;
        task.itemProgress = 100;
        task.result = result;
        this.emit('update', this.getQueueStatus());
      })
      .catch((error) => {
        task.finishedAt = Date.now();
        task.elapsedMs = task.finishedAt - task.startedAt;

        if (task.status === 'timeout' || error.message === 'OPERATION_TIMEOUT') {
          task.status = 'timeout';
          task.error = 'A operação excedeu o tempo limite configurado.';
          this.emit('update', this.getQueueStatus());
          return;
        }

        if (task.cancelled || error.message === 'OPERATION_CANCELLED') {
          task.status = 'cancelled';
          this.emit('update', this.getQueueStatus());
          return;
        }

        task.error = error.message || String(error);
        if (task.attempt < task.maxAttempts) {
          task.attempt += 1;
          task.status = 'pending';
          task.error = `Tentando novamente (${task.attempt}/${task.maxAttempts}): ${task.error}`;
          task.progress = 0;
          task.itemProgress = 0;
          task.currentItem = 0;
          task.currentItemName = '';
          task.etaSeconds = null;
          task.execution = null;
          task.timeoutHandle = null;
          this.runningTasks.delete(task.id);
          this.queue.unshift(task);
          this.schedulePersistState();
          this.emit('update', this.getQueueStatus());
          process.nextTick(() => this.pump());
          return;
        }

        task.status = 'failed';
        this.emit('update', this.getQueueStatus());
      })
      .finally(() => {
        clearTimeout(task.timeoutHandle);
        if (this.runningTasks.get(task.id) === task) {
          this.runningTasks.delete(task.id);
        }
        if (['completed', 'failed', 'cancelled', 'timeout'].includes(task.status)) {
          this.addRecentTerminalTask(task);
        }
        this.schedulePersistState();
        this.emit('update', this.getQueueStatus());
        process.nextTick(() => this.pump());
      });
  }

  getQueueStatus() {
    const live = [
      ...this.recoveredTasks,
      ...this.recentTerminalTasks,
      ...[...this.runningTasks.values()].map((task) => this.publicTask(task)),
      ...this.queue.map((task) => this.publicTask(task))
    ];
    return live;
  }

  addRecentTerminalTask(task) {
    const snapshot = {
      ...this.publicTask(task),
      finishedAt: Date.now()
    };
    this.recentTerminalTasks = this.recentTerminalTasks
      .filter((item) => item.id !== snapshot.id)
      .concat(snapshot);

    const cleanupHandle = setTimeout(() => {
      this.recentTerminalTasks = this.recentTerminalTasks.filter((item) => item.id !== snapshot.id);
      this.emit('update', this.getQueueStatus());
    }, 12_000);
    cleanupHandle.unref?.();
  }

  publicTask(task) {
    return {
      id: task.id,
      type: task.type || '',
      name: task.name,
      fileNames: task.filePaths.map((p) => path.basename(p)) || task.fileNames || [],
      quietNotifications: Boolean(task.quietNotifications),
      status: task.status,
      progress: task.progress || 0,
      itemProgress: task.itemProgress || 0,
      totalItems: task.totalItems || 1,
      currentItem: task.currentItem || 0,
      currentItemName: task.currentItemName || '',
      error: task.error || null,
      elapsedMs: task.elapsedMs || 0,
      etaSeconds: task.etaSeconds ?? null,
      throughputItemsPerMinute: task.throughputItemsPerMinute || 0,
      memoryMb: task.memoryMb || 0,
      attempt: task.attempt || 1,
      maxAttempts: task.maxAttempts || 1,
      result: task.result || null
    };
  }

  getHealthSummary() {
    return {
      concurrency: this.options.concurrency,
      retryCount: this.options.retryCount,
      operationTimeoutMs: this.options.operationTimeoutMs,
      pendingTasks: this.queue.length,
      runningTasks: this.runningTasks.size,
      recoveredInterruptedTasks: this.recoveredTasks.length
    };
  }
}

module.exports = new ProcessingQueue();
