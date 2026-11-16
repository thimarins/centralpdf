const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { sanitizeManagedTempPaths } = require('../../src/main/managed-temp-paths');

const managedRoot = path.join(os.tmpdir(), 'central-pdf-managed-temp-paths-test');
const outsideRoot = path.join(os.tmpdir(), 'central-pdf-unmanaged-temp-paths-test');
const validFile = path.join(managedRoot, 'redaction-image.png');
const linkedFile = path.join(managedRoot, 'linked-file.png');
const junctionFile = path.join(managedRoot, 'junction', 'external.png');
const missingFile = path.join(managedRoot, 'already-removed.pdf');
const directoryPath = path.join(managedRoot, 'directory');
const outsideFile = path.join(outsideRoot, 'private.pdf');

const fakeFs = {
  realpathSync(target) {
    const resolved = path.resolve(target);
    if (resolved === path.resolve(managedRoot)) return managedRoot;
    if (resolved === path.resolve(path.join(managedRoot, 'junction'))) return outsideRoot;
    return resolved;
  },
  lstatSync(target) {
    const resolved = path.resolve(target);
    if (resolved === path.resolve(missingFile)) {
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    }
    if (resolved === path.resolve(linkedFile)) return { isFile: () => false, isSymbolicLink: () => true };
    if (resolved === path.resolve(directoryPath)) return { isFile: () => false, isSymbolicLink: () => false };
    return { isFile: () => true, isSymbolicLink: () => false };
  }
};

assert.deepStrictEqual(
  sanitizeManagedTempPaths([
    validFile, linkedFile, junctionFile, missingFile, directoryPath, outsideFile,
    path.join(managedRoot, '..', 'escape.pdf'), managedRoot
  ], managedRoot, fakeFs),
  [validFile, missingFile],
  'A limpeza deve permitir arquivos regulares sob a raiz canônica e ignorar links/junções, diretórios e escapes.'
);
assert.deepStrictEqual(sanitizeManagedTempPaths([validFile], path.join(managedRoot, 'root-ausente'), fakeFs), []);

console.log('Managed temp path security passed: canonical parent, symlink/junction, directory, outside-root, traversal, and missing-file cases.');
