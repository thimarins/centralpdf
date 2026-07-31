const fs = require('fs');
const path = require('path');
const { ROOT, toMarkdownTable, writeReport } = require('./_common');

const SRC_DIR = path.join(ROOT, 'src');
const ENTRY_FILES = [
  path.join(SRC_DIR, 'main', 'index.js'),
  path.join(SRC_DIR, 'main', 'pdf-operation-worker.js'),
  path.join(SRC_DIR, 'preload', 'index.js'),
  path.join(SRC_DIR, 'renderer', 'app.js'),
  path.join(SRC_DIR, 'renderer', 'index.html'),
  path.join(SRC_DIR, 'renderer', 'style.css')
];

function listProjectFiles(rootDir) {
  const results = [];
  const stack = [rootDir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (/\.(js|html|css)$/.test(entry.name)) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

function resolveImport(fromFile, request) {
  if (!request.startsWith('.')) return null;
  const candidate = path.resolve(path.dirname(fromFile), request);
  const attempts = [candidate, `${candidate}.js`, path.join(candidate, 'index.js')];
  return attempts.find((file) => fs.existsSync(file)) || null;
}

function buildGraph(files) {
  const graph = new Map();
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    const dependencies = new Set();
    const requireRegex = /require\(['"]([^'"]+)['"]\)/g;
    const importRegex = /from\s+['"]([^'"]+)['"]|import\(['"]([^'"]+)['"]\)/g;
    const cssImportRegex = /@import\s+["']([^"']+)["']/g;

    let match;
    while ((match = requireRegex.exec(content))) {
      const resolved = resolveImport(file, match[1]);
      if (resolved) dependencies.add(resolved);
    }
    while ((match = importRegex.exec(content))) {
      const specifier = match[1] || match[2];
      const resolved = resolveImport(file, specifier);
      if (resolved) dependencies.add(resolved);
    }
    while ((match = cssImportRegex.exec(content))) {
      const resolved = resolveImport(file, match[1]);
      if (resolved) dependencies.add(resolved);
    }

    graph.set(file, [...dependencies]);
  }
  return graph;
}

function findCycles(graph) {
  const visited = new Set();
  const stack = new Set();
  const cycles = [];

  function dfs(node, trail) {
    if (stack.has(node)) {
      const startIndex = trail.indexOf(node);
      cycles.push(trail.slice(startIndex).concat(node));
      return;
    }
    if (visited.has(node)) return;
    visited.add(node);
    stack.add(node);
    for (const dep of graph.get(node) || []) {
      dfs(dep, trail.concat(dep));
    }
    stack.delete(node);
  }

  for (const node of graph.keys()) {
    dfs(node, [node]);
  }
  return cycles;
}

function findReachable(graph, entries) {
  const reachable = new Set();
  const stack = [...entries.filter((entry) => fs.existsSync(entry))];
  while (stack.length) {
    const current = stack.pop();
    if (reachable.has(current)) continue;
    reachable.add(current);
    for (const dep of graph.get(current) || []) {
      stack.push(dep);
    }
  }
  return reachable;
}

async function runArchitectureAudit() {
  const files = listProjectFiles(SRC_DIR);
  const graph = buildGraph(files);
  const cycles = findCycles(graph);
  const reachable = findReachable(graph, ENTRY_FILES);
  const orphanFiles = files.filter((file) => !reachable.has(file) && !file.endsWith('index.html'));
  const largeFiles = files
    .map((file) => ({ file, lines: fs.readFileSync(file, 'utf8').split(/\r?\n/).length }))
    .filter((item) => item.lines > 1200)
    .sort((a, b) => b.lines - a.lines);

  const checks = [
    { name: 'Circular dependencies', status: cycles.length === 0 ? 'ok' : 'warning', details: `${cycles.length} ciclo(s)` },
    { name: 'Potential orphan files', status: orphanFiles.length === 0 ? 'ok' : 'warning', details: `${orphanFiles.length} arquivo(s)` },
    { name: 'Large source files (>1200 linhas)', status: largeFiles.length === 0 ? 'ok' : 'warning', details: `${largeFiles.length} arquivo(s)` }
  ];

  const reportPath = writeReport('architecture-report.md', [
    '# Architecture Audit Report',
    '',
    `Gerado em ${new Date().toISOString()}.`,
    '',
    '## Checks',
    '',
    ...toMarkdownTable(['Check', 'Status', 'Detalhes'], checks.map((item) => [item.name, item.status, item.details])),
    '',
    '## Circular Dependencies',
    '',
    ...(cycles.length ? cycles.map((cycle) => `- ${cycle.map((item) => path.relative(ROOT, item)).join(' -> ')}`) : ['- Nenhum ciclo encontrado.']),
    '',
    '## Potential Orphan Files',
    '',
    ...(orphanFiles.length ? orphanFiles.map((file) => `- ${path.relative(ROOT, file)}`) : ['- Nenhum arquivo potencialmente orfao.']),
    '',
    '## Large Files',
    '',
    ...(largeFiles.length ? largeFiles.map((item) => `- ${path.relative(ROOT, item.file)}: ${item.lines} linhas`) : ['- Nenhum arquivo acima do limiar configurado.'])
  ]);

  return {
    ok: cycles.length === 0,
    reportPath,
    checks,
    cycles,
    orphanFiles,
    largeFiles
  };
}

if (require.main === module) {
  runArchitectureAudit()
    .then((summary) => {
      console.log(`Architecture audit completed: ${summary.checks.length} checks`);
      process.exit(summary.ok ? 0 : 1);
    })
    .catch((error) => {
      console.error(error.stack || String(error));
      process.exit(1);
    });
}

module.exports = {
  runArchitectureAudit
};
