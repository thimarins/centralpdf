const PDF_PREVIEW_RANGE_CHUNK_BYTES = 64 * 1024;
const PDF_PREVIEW_SESSION_TTL_MS = 10 * 60 * 1000;
const PDF_PREVIEW_SESSION_MAX = 8;

function createPdfPreviewRangeSessions({
  fs,
  path,
  inspectPdfFileAsync,
  getMaxFileSize,
  maxSupportedBytes,
  createId,
  now = Date.now
}) {
  const sessions = new Map();

  function fingerprint(stats) {
    // On Windows, ctime may advance on a normal open; use stable file identity,
    // size, and content modification time to detect replacement or edits.
    return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}`;
  }

  function pruneExpiredSessions() {
    const currentTime = now();
    for (const [sessionId, session] of sessions) {
      if (session.expiresAt <= currentTime || session.sender.isDestroyed()) sessions.delete(sessionId);
    }
    while (sessions.size >= PDF_PREVIEW_SESSION_MAX) {
      const oldestId = sessions.keys().next().value;
      if (!oldestId) break;
      sessions.delete(oldestId);
    }
  }

  async function readChunk(filePath, expectedFingerprint, begin, end) {
    const handle = await fs.promises.open(filePath, 'r');
    try {
      const initialStats = await handle.stat();
      if (!initialStats.isFile() || fingerprint(initialStats) !== expectedFingerprint || end > initialStats.size) {
        throw new Error('O PDF foi alterado ou ficou indisponível durante a prévia. Selecione o arquivo novamente.');
      }
      const output = Buffer.allocUnsafe(end - begin);
      let offset = 0;
      while (offset < output.length) {
        const { bytesRead } = await handle.read(output, offset, output.length - offset, begin + offset);
        if (!bytesRead) throw new Error('O PDF foi reduzido ou ficou indisponível durante a prévia.');
        offset += bytesRead;
      }
      const finalStats = await handle.stat();
      if (fingerprint(finalStats) !== expectedFingerprint) {
        throw new Error('O PDF foi alterado durante a prévia. Selecione o arquivo novamente.');
      }
      return Uint8Array.from(output);
    } finally {
      await handle.close();
    }
  }

  async function open(sender, filePath) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || !/\.pdf$/i.test(filePath)) {
      throw new Error('Selecione um PDF válido para visualizar.');
    }
    const maxBytes = Number(getMaxFileSize()) || maxSupportedBytes;
    let inspection;
    let initialStats;
    try {
      inspection = await inspectPdfFileAsync(filePath, maxBytes);
      if (!inspection.ok) throw new Error('invalid-pdf');
      initialStats = await fs.promises.stat(filePath);
    } catch {
      throw new Error('Não foi possível abrir este PDF para visualizar. Verifique se o arquivo ainda existe, está íntegro e não está protegido por senha.');
    }
    if (!initialStats.isFile() || initialStats.size < 1 || initialStats.size > maxSupportedBytes) {
      throw new Error('Este PDF está vazio ou excede o limite de tamanho permitido.');
    }
    const fileFingerprint = fingerprint(initialStats);
    const initialData = await readChunk(filePath, fileFingerprint, 0, Math.min(PDF_PREVIEW_RANGE_CHUNK_BYTES, initialStats.size));
    pruneExpiredSessions();
    const sessionId = createId();
    sessions.set(sessionId, {
      path: path.resolve(filePath),
      fingerprint: fileFingerprint,
      size: initialStats.size,
      sender,
      expiresAt: now() + PDF_PREVIEW_SESSION_TTL_MS
    });
    return { sessionId, length: initialStats.size, initialData, fileName: path.basename(filePath) };
  }

  async function read(sender, payload = {}) {
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
    const session = sessions.get(sessionId);
    if (!session) throw new Error('A sessão de prévia não existe mais. Selecione o PDF novamente.');
    if (session.sender !== sender) throw new Error('Esta sessão de prévia pertence a outra janela.');
    if (session.expiresAt <= now()) {
      sessions.delete(sessionId);
      throw new Error('A sessão de prévia expirou. Selecione o PDF novamente.');
    }
    const begin = Number(payload.begin);
    const end = Number(payload.end);
    if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 || end <= begin
      || end > session.size || end - begin > PDF_PREVIEW_RANGE_CHUNK_BYTES) {
      throw new Error('A prévia solicitou um trecho inválido do PDF.');
    }
    session.expiresAt = now() + PDF_PREVIEW_SESSION_TTL_MS;
    return readChunk(session.path, session.fingerprint, begin, end);
  }

  function close(sender, sessionId) {
    if (typeof sessionId !== 'string') return false;
    const session = sessions.get(sessionId);
    if (session?.sender !== sender) return false;
    sessions.delete(sessionId);
    return true;
  }

  function closeSender(sender) {
    let closedCount = 0;
    for (const [sessionId, session] of sessions) {
      if (session.sender === sender || session.sender.isDestroyed()) {
        sessions.delete(sessionId);
        closedCount += 1;
      }
    }
    return closedCount;
  }

  return { open, read, close, closeSender };
}

module.exports = { PDF_PREVIEW_RANGE_CHUNK_BYTES, createPdfPreviewRangeSessions };
