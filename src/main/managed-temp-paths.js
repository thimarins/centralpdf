const fs = require('fs');
const path = require('path');

function isPathInsideDirectory(parentDirectory, targetPath) {
  if (typeof targetPath !== 'string' || !targetPath.trim() || !path.isAbsolute(targetPath)) return false;
  const relative = path.relative(path.resolve(parentDirectory), path.resolve(targetPath));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function sanitizeManagedTempPaths(paths = [], managedDirectory, fileSystem = fs) {
  if (!Array.isArray(paths) || typeof managedDirectory !== 'string' || !path.isAbsolute(managedDirectory)) return [];
  let realManagedDirectory;
  try {
    realManagedDirectory = fileSystem.realpathSync(managedDirectory);
  } catch {
    return [];
  }

  const lexicalManagedDirectory = path.resolve(managedDirectory);
  return [...new Set(paths.filter((targetPath) => {
    if (typeof targetPath !== 'string' || !targetPath.trim() || !path.isAbsolute(targetPath)) return false;
    const absoluteTarget = path.resolve(targetPath);
    if (absoluteTarget === lexicalManagedDirectory || !isPathInsideDirectory(lexicalManagedDirectory, absoluteTarget)) return false;
    let realParent;
    try {
      realParent = fileSystem.realpathSync(path.dirname(absoluteTarget));
    } catch {
      return false;
    }
    if (!isPathInsideDirectory(realManagedDirectory, realParent)) return false;
    try {
      const targetStats = fileSystem.lstatSync(absoluteTarget);
      // Cleanup only regular files; never follow a symlink or junction.
      if (!targetStats.isFile() || targetStats.isSymbolicLink()) return false;
    } catch (error) {
      // Missing files are safe for idempotent cleanup; fail closed otherwise.
      if (error?.code !== 'ENOENT') return false;
    }
    return true;
  }))];
}

module.exports = { isPathInsideDirectory, sanitizeManagedTempPaths };
