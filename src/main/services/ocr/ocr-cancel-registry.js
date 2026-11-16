const DEFAULT_TTL_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 128;

function createPendingOcrCancelRegistry({ ttlMs = DEFAULT_TTL_MS, maxEntries = DEFAULT_MAX_ENTRIES, now = Date.now } = {}) {
  const pending = new Map();
  const safeTtlMs = Math.max(1, Number(ttlMs) || DEFAULT_TTL_MS);
  const safeMaxEntries = Math.max(1, Math.floor(Number(maxEntries) || DEFAULT_MAX_ENTRIES));

  function removeExpired() {
    const currentTime = now();
    for (const [requestId, expiresAt] of pending) {
      if (expiresAt <= currentTime) pending.delete(requestId);
    }
  }

  return {
    remember(requestId) {
      if (typeof requestId !== 'string' || !requestId) return false;
      removeExpired();
      if (!pending.has(requestId) && pending.size >= safeMaxEntries) pending.delete(pending.keys().next().value);
      pending.set(requestId, now() + safeTtlMs);
      return true;
    },
    consume(requestId) {
      removeExpired();
      if (!pending.has(requestId)) return false;
      pending.delete(requestId);
      return true;
    },
    get size() {
      removeExpired();
      return pending.size;
    }
  };
}

module.exports = { createPendingOcrCancelRegistry };
