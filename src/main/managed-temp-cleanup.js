const fs = require('node:fs/promises');
const path = require('node:path');

const MANAGED_TEMP_DIRECTORY_NAME = 'central-pdf-temp';
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 5_000;

function samePath(left, right) {
  return path.relative(path.resolve(left), path.resolve(right)) === '';
}

async function cleanupStaleManagedTempFiles({
  directory,
  parentDirectory,
  now = Date.now(),
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  maxEntries = DEFAULT_MAX_ENTRIES
} = {}) {
  if (typeof directory !== 'string' || typeof parentDirectory !== 'string') {
    return { deleted: 0, failed: 0, skipped: true };
  }

  const requestedDirectory = path.resolve(directory);
  const requestedParent = path.resolve(parentDirectory);
  if (path.basename(requestedDirectory) !== MANAGED_TEMP_DIRECTORY_NAME
    || !samePath(path.dirname(requestedDirectory), requestedParent)) {
    return { deleted: 0, failed: 0, skipped: true };
  }

  let realDirectory;
  let realParent;
  try {
    [realDirectory, realParent] = await Promise.all([
      fs.realpath(requestedDirectory),
      fs.realpath(requestedParent)
    ]);
    const directoryStats = await fs.lstat(requestedDirectory);
    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()
      || !samePath(path.dirname(realDirectory), realParent)
      || path.basename(realDirectory) !== MANAGED_TEMP_DIRECTORY_NAME) {
      return { deleted: 0, failed: 0, skipped: true };
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return { deleted: 0, failed: 0, skipped: true };
    return { deleted: 0, failed: 1, skipped: false };
  }

  let entries;
  try {
    entries = await fs.readdir(realDirectory, { withFileTypes: true });
  } catch {
    return { deleted: 0, failed: 1, skipped: false };
  }

  const safeMaxEntries = Number.isSafeInteger(maxEntries) ? Math.min(20_000, Math.max(1, maxEntries)) : DEFAULT_MAX_ENTRIES;
  const safeMaxAgeMs = Number.isFinite(maxAgeMs) ? Math.max(0, maxAgeMs) : DEFAULT_MAX_AGE_MS;
  const cutoff = now - safeMaxAgeMs;
  let deleted = 0;
  let failed = 0;

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name)).slice(0, safeMaxEntries)) {
    if (!entry.isFile() || !/^temp-[a-z0-9][a-z0-9._-]{0,180}$/i.test(entry.name)) continue;
    const filePath = path.join(realDirectory, entry.name);
    try {
      const stats = await fs.lstat(filePath);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.mtimeMs > now || stats.mtimeMs >= cutoff) continue;
      await fs.unlink(filePath);
      deleted += 1;
    } catch (error) {
      if (error?.code !== 'ENOENT') failed += 1;
    }
  }

  return { deleted, failed, skipped: false };
}

module.exports = { cleanupStaleManagedTempFiles, DEFAULT_MAX_AGE_MS, DEFAULT_MAX_ENTRIES };
