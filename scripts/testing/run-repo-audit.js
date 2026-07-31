const fs = require('fs');
const path = require('path');
const { ROOT, toMarkdownTable, writeReport } = require('./_common');

function walk(rootDir, extensions) {
  const files = [];
  const stack = [rootDir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (['node_modules', 'dist', 'dist-installer', 'releases', '.git'].includes(entry.name)) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (!extensions || extensions.includes(path.extname(entry.name).toLowerCase())) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

function scanPattern(files, regex) {
  const matches = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      if (regex.test(line)) {
        matches.push(`${path.relative(ROOT, file)}:${index + 1} -> ${line.trim()}`);
      }
    });
  }
  return matches;
}

async function runRepoAudit() {
  const files = [
    ...walk(path.join(ROOT, 'src'), ['.js', '.html', '.css']),
    ...walk(path.join(ROOT, 'scripts'), ['.js', '.ps1']).filter((file) => !file.includes(`${path.sep}testing${path.sep}`))
  ];

  const checks = [];
  const sections = [];
  const patterns = [
    { name: 'TODO/FIXME', regex: /\b(TODO|FIXME)\b/ },
    { name: 'console.log', regex: /console\.log\s*\(/ },
    { name: 'debugger', regex: /\bdebugger\b/ },
    { name: 'hardcoded user path', regex: /C:\\Users\\/i },
    { name: 'unexpected localhost in production code', regex: /localhost:(?!5173)/i }
  ];

  for (const pattern of patterns) {
    const matches = scanPattern(files, pattern.regex);
    checks.push({ name: pattern.name, status: matches.length === 0 ? 'ok' : 'warning', details: `${matches.length} ocorrencia(s)` });
    sections.push(`## ${pattern.name}`);
    sections.push('');
    sections.push(...(matches.length ? matches.map((line) => `- ${line}`) : ['- Nenhuma ocorrencia.']));
    sections.push('');
  }

  const reportPath = writeReport('repo-audit.md', [
    '# Repository Hygiene Report',
    '',
    `Gerado em ${new Date().toISOString()}.`,
    '',
    ...toMarkdownTable(['Check', 'Status', 'Detalhes'], checks.map((item) => [item.name, item.status, item.details])),
    '',
    ...sections
  ]);

  return {
    ok: checks.every((item) => item.status === 'ok'),
    reportPath,
    checks
  };
}

if (require.main === module) {
  runRepoAudit()
    .then((summary) => {
      console.log(`Repository hygiene audit completed: ${summary.checks.length} checks`);
      process.exit(summary.ok ? 0 : 1);
    })
    .catch((error) => {
      console.error(error.stack || String(error));
      process.exit(1);
    });
}

module.exports = {
  runRepoAudit
};
