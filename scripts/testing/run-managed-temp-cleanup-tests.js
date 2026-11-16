const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { cleanupStaleManagedTempFiles } = require('../../src/main/managed-temp-cleanup');

async function run() {
  const parentDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'central-pdf-temp-cleanup-'));
  const directory = path.join(parentDirectory, 'central-pdf-temp');
  const outsideDirectory = path.join(parentDirectory, 'unrelated');
  const now = Date.now();
  try {
    await fs.mkdir(directory);
    await fs.mkdir(outsideDirectory);
    const staleTemp = path.join(directory, 'temp-redact-image-1234-abcd.png');
    const freshTemp = path.join(directory, 'temp-ocr-current-5678.pdf');
    const userNamedFile = path.join(directory, 'my-temp-not-owned.pdf');
    const oldSubdirectory = path.join(directory, 'temp-subdir');
    const outsideTemp = path.join(outsideDirectory, 'temp-private.pdf');
    await Promise.all([
      fs.writeFile(staleTemp, 'sensitive temp fixture'),
      fs.writeFile(freshTemp, 'active temp fixture'),
      fs.writeFile(userNamedFile, 'not an app temp'),
      fs.mkdir(oldSubdirectory),
      fs.writeFile(outsideTemp, 'outside managed root')
    ]);
    const oldDate = new Date(now - 48 * 60 * 60 * 1000);
    await fs.utimes(staleTemp, oldDate, oldDate);
    await fs.utimes(oldSubdirectory, oldDate, oldDate);

    const result = await cleanupStaleManagedTempFiles({ directory, parentDirectory, now });
    assert.deepEqual(result, { deleted: 1, failed: 0, skipped: false });
    await assert.rejects(fs.access(staleTemp), { code: 'ENOENT' });
    await Promise.all([freshTemp, userNamedFile, oldSubdirectory, outsideTemp].map((filePath) => fs.access(filePath)));

    const wrongParent = await cleanupStaleManagedTempFiles({ directory, parentDirectory: os.tmpdir(), now });
    assert.deepEqual(wrongParent, { deleted: 0, failed: 0, skipped: true });

    const symlinkPath = path.join(directory, 'temp-linked-file.pdf');
    try {
      await fs.symlink(outsideTemp, symlinkPath, 'file');
      const symlinkStats = await fs.lstat(symlinkPath);
      const symlinkRun = await cleanupStaleManagedTempFiles({ directory, parentDirectory, now });
      assert.equal(symlinkRun.deleted, 0, 'A limpeza não deve seguir nem remover links simbólicos.');
      assert.ok((await fs.lstat(symlinkPath)).isSymbolicLink());
      assert.equal(symlinkStats.isSymbolicLink(), true);
      assert.equal(await fs.readFile(outsideTemp, 'utf8'), 'outside managed root');
      await fs.unlink(symlinkPath);
    } catch (error) {
      if (!['EPERM', 'EACCES', 'ENOSYS'].includes(error?.code)) throw error;
    }

    console.log('Managed temporary cleanup passed: aged app temp removed; fresh, unrelated, directory, outside-root, and symlink targets preserved.');
  } finally {
    await fs.rm(parentDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

run().catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
