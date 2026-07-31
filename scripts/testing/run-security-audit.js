const fs = require('fs');
const path = require('path');
const { ROOT, toMarkdownTable, writeReport } = require('./_common');

function listFiles(rootDir, extensions) {
  const results = [];
  const stack = [rootDir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'dist-installer' || entry.name === 'releases' || entry.name.startsWith('.git')) {
        continue;
      }
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (!extensions || extensions.includes(path.extname(entry.name).toLowerCase())) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

function grepMatches(files, regex) {
  const matches = [];
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (regex.test(line)) {
        matches.push({ file, line: index + 1, content: line.trim() });
      }
    });
  }
  return matches;
}

async function runSecurityAudit() {
  const codeFiles = listFiles(path.join(ROOT, 'src'), ['.js', '.html', '.css']);
  const findings = [];
  const checks = [];

  const dangerousPatterns = [
    { label: 'eval', regex: /\beval\s*\(/ },
    { label: 'Function constructor', regex: /new\s+Function\s*\(/ },
    { label: 'child_process.exec', regex: /\bchild_process\s*\.\s*exec\s*\(/ },
    { label: 'shell=true', regex: /shell\s*:\s*true/ },
    { label: 'nodeIntegration true', regex: /nodeIntegration\s*:\s*true/ },
    { label: 'allowRunningInsecureContent true', regex: /allowRunningInsecureContent\s*:\s*true/ }
  ];

  for (const pattern of dangerousPatterns) {
    const matches = grepMatches(codeFiles, pattern.regex);
    checks.push({ name: pattern.label, status: matches.length === 0 ? 'ok' : 'warning', details: `${matches.length} ocorrencia(s)` });
    matches.forEach((match) => findings.push(`- ${pattern.label}: ${path.relative(ROOT, match.file)}:${match.line} -> ${match.content}`));
  }

  const mainIndex = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.js'), 'utf8');
  const preload = fs.readFileSync(path.join(ROOT, 'src', 'preload', 'index.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');

  const hardeningChecks = [
    { name: 'contextIsolation', ok: /contextIsolation:\s*true/.test(mainIndex) },
    { name: 'nodeIntegration false', ok: /nodeIntegration:\s*false/.test(mainIndex) },
    { name: 'sandbox true', ok: /sandbox:\s*true/.test(mainIndex) },
    { name: 'single instance lock', ok: /requestSingleInstanceLock\s*\(/.test(mainIndex) },
    { name: 'blocked new windows', ok: /setWindowOpenHandler\(/.test(mainIndex) },
    { name: 'navigation guard', ok: /will-navigate/.test(mainIndex) },
    { name: 'CSP present', ok: /Content-Security-Policy/.test(html) },
    { name: 'preload allowlist shape', ok: /contextBridge\.exposeInMainWorld/.test(preload) && /ipcRenderer\.invoke/.test(preload) }
  ];
  hardeningChecks.forEach((item) => checks.push({ name: item.name, status: item.ok ? 'ok' : 'warning', details: item.ok ? 'validado' : 'nao encontrado' }));

  const reportPath = writeReport('security-report.md', [
    '# Security Audit Report',
    '',
    `Gerado em ${new Date().toISOString()}.`,
    '',
    '## Checks',
    '',
    ...toMarkdownTable(['Check', 'Status', 'Detalhes'], checks.map((item) => [item.name, item.status, item.details])),
    '',
    '## Findings',
    '',
    ...(findings.length ? findings : ['- Nenhum achado critico automatizado.'])
  ]);

  return {
    ok: !checks.some((item) => item.status === 'warning' && ['contextIsolation', 'nodeIntegration false', 'sandbox true', 'single instance lock', 'CSP present'].includes(item.name)) && findings.length === 0,
    reportPath,
    checks,
    findings
  };
}

if (require.main === module) {
  runSecurityAudit()
    .then((summary) => {
      console.log(`Security audit completed: ${summary.checks.length} checks`);
      process.exit(summary.ok ? 0 : 1);
    })
    .catch((error) => {
      console.error(error.stack || String(error));
      process.exit(1);
    });
}

module.exports = {
  runSecurityAudit
};
