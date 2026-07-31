const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { ROOT, runCommand, toMarkdownTable, writeReport, formatBytes } = require('./_common');

function collectFiles(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  const files = [];
  const stack = [dirPath];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else {
        files.push(fullPath);
      }
    }
  }
  return files;
}

async function runBuildCheck(options = {}) {
  const full = options.full === true;
  const forceRebuild = options.forceRebuild === true;
  const checks = [];
  const packageInfo = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const releaseVersion = String(packageInfo.releaseVersion || packageInfo.version || '');

  let buildResult = { ok: false, stderr: '', stdout: '' };
  if (process.platform === 'win32') {
    const tempBuildDir = path.join(os.tmpdir(), 'central-pdf-build-temp-' + Date.now());
    try {
      fs.mkdirSync(tempBuildDir, { recursive: true });
      fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(tempBuildDir, 'package.json'));
      fs.copyFileSync(path.join(ROOT, 'vite.config.mjs'), path.join(tempBuildDir, 'vite.config.mjs'));
      
      const copyDir = (src, dest) => {
        fs.mkdirSync(dest, { recursive: true });
        const entries = fs.readdirSync(src, { withFileTypes: true });
        for (const entry of entries) {
          const srcPath = path.join(src, entry.name);
          const destPath = path.join(dest, entry.name);
          if (entry.isDirectory()) {
            copyDir(srcPath, destPath);
          } else {
            fs.copyFileSync(srcPath, destPath);
          }
        }
      };
      copyDir(path.join(ROOT, 'src'), path.join(tempBuildDir, 'src'));
      
      let targetNodeModules = 'C:\\Projetos\\Central PDF\\node_modules';
      if (!fs.existsSync(targetNodeModules)) {
        targetNodeModules = path.join(ROOT, 'node_modules');
      }
      const tempNodeModules = path.join(tempBuildDir, 'node_modules');
      execSync(`cmd.exe /c mklink /J "${tempNodeModules}" "${targetNodeModules}"`, { stdio: 'ignore' });
      
      execSync('npm run build', { cwd: tempBuildDir, stdio: 'inherit' });
      
      const distDest = path.join(ROOT, 'dist');
      if (fs.existsSync(distDest)) {
        fs.rmSync(distDest, { recursive: true, force: true });
      }
      copyDir(path.join(tempBuildDir, 'dist'), distDest);
      
      buildResult = { ok: true };
    } catch (err) {
      buildResult = { ok: false, stderr: err.message, stdout: '' };
    } finally {
      try {
        const tempNodeModules = path.join(tempBuildDir, 'node_modules');
        if (fs.existsSync(tempNodeModules)) {
          execSync(`cmd.exe /c rmdir "${tempNodeModules}"`, { stdio: 'ignore' });
        }
      } catch (e) {}
      try {
        fs.rmSync(tempBuildDir, { recursive: true, force: true });
      } catch (e) {}
    }
  } else {
    const nonWinResult = runCommand('npm', ['run', 'build'], { timeout: 10 * 60 * 1000 });
    buildResult = { ok: nonWinResult.ok, stderr: nonWinResult.stderr, stdout: nonWinResult.stdout };
  }

  checks.push({ name: 'npm run build', ok: buildResult.ok, details: buildResult.ok ? 'build do renderer concluido' : (buildResult.stderr || buildResult.stdout).trim() });
  if (!buildResult.ok) {
    const reportPath = writeReport('build-report.md', [
      '# Build Report',
      '',
      ...toMarkdownTable(['Check', 'Status', 'Detalhes'], checks.map((item) => [item.name, item.ok ? 'ok' : 'error', item.details]))
    ]);
    return { ok: false, reportPath, checks };
  }

  const distFiles = collectFiles(path.join(ROOT, 'dist'));
  const mapFiles = distFiles.filter((file) => file.endsWith('.map'));
  const distSize = distFiles.reduce((sum, file) => sum + fs.statSync(file).size, 0);
  checks.push({ name: 'dist files present', ok: distFiles.length > 0, details: `${distFiles.length} arquivo(s) em dist` });
  checks.push({ name: 'no sourcemaps in dist', ok: mapFiles.length === 0, details: mapFiles.length === 0 ? 'nenhum sourcemap encontrado' : `${mapFiles.length} sourcemap(s)` });
  checks.push({ name: 'dist size snapshot', ok: true, details: formatBytes(distSize) });

  if (full) {
    const expectedArtifacts = [
      path.join(ROOT, 'dist-installer', `Central PDF ${releaseVersion}.msi`),
      path.join(ROOT, 'dist-installer', `Central-PDF-Portable-${releaseVersion}.exe`),
      path.join(ROOT, 'releases', releaseVersion, `Central-PDF-${releaseVersion}-win-x64.msi`),
      path.join(ROOT, 'releases', releaseVersion, `Central-PDF-${releaseVersion}-win-x64-portable.exe`),
      path.join(ROOT, 'releases', 'latest', 'Central-PDF-win-x64.msi'),
      path.join(ROOT, 'releases', 'latest', 'Central-PDF-win-x64-unpacked', 'Central PDF.exe')
    ];
    const artifactsAlreadyPresent = expectedArtifacts.every((filePath) => fs.existsSync(filePath));

    if (!forceRebuild && artifactsAlreadyPresent) {
      checks.push({ name: 'build:win artifacts present', ok: true, details: `artefatos ${releaseVersion} já publicados` });
    } else {
      const winCommand = process.platform === 'win32'
        ? ['powershell.exe', ['-Command', `New-PSDrive -Name T -PSProvider FileSystem -Root '${ROOT}' -ErrorAction SilentlyContinue; Set-Location T:\\; npm run build:win`]]
        : ['npm', ['run', 'build:win']];
      const winResult = runCommand(winCommand[0], winCommand[1], { timeout: 60 * 60 * 1000 });
      checks.push({ name: 'npm run build:win', ok: winResult.ok, details: winResult.ok ? 'artefatos Windows gerados' : (winResult.stderr || winResult.stdout).trim() });
    }

    const latestUnpackedExe = path.join(ROOT, 'releases', 'latest', 'Central-PDF-win-x64-unpacked', 'Central PDF.exe');
    const latestMsi = path.join(ROOT, 'releases', 'latest', 'Central-PDF-win-x64.msi');
    checks.push({ name: 'latest unpacked exe', ok: fs.existsSync(latestUnpackedExe), details: latestUnpackedExe });
    checks.push({ name: 'latest msi', ok: fs.existsSync(latestMsi), details: latestMsi });
  }

  const reportPath = writeReport('build-report.md', [
    '# Build Report',
    '',
    `Gerado em ${new Date().toISOString()}.`,
    '',
    ...toMarkdownTable(['Check', 'Status', 'Detalhes'], checks.map((item) => [item.name, item.ok ? 'ok' : 'warning', item.details]))
  ]);

  return {
    ok: checks.every((item) => item.ok),
    reportPath,
    checks
  };
}

if (require.main === module) {
  const full = process.argv.includes('--full');
  runBuildCheck({ full })
    .then((summary) => {
      console.log(`Build check completed: ${summary.checks.length} checks`);
      process.exit(summary.ok ? 0 : 1);
    })
    .catch((error) => {
      console.error(error.stack || String(error));
      process.exit(1);
    });
}

module.exports = {
  runBuildCheck
};
