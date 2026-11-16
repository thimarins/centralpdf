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
  const pdfService = fs.readFileSync(path.join(ROOT, 'src', 'main', 'pdf-service.js'), 'utf8');
  const preload = fs.readFileSync(path.join(ROOT, 'src', 'preload', 'index.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
  const rendererApp = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
  const ocrService = fs.readFileSync(path.join(ROOT, 'src', 'main', 'services', 'ocr', 'ocr-service.js'), 'utf8');
  const ocrAreaRenderer = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'ui', 'ocr', 'ocr-area-extractor.js'), 'utf8');
  const queueSource = fs.readFileSync(path.join(ROOT, 'src', 'main', 'queue.js'), 'utf8');
  const managedTempCleanup = fs.readFileSync(path.join(ROOT, 'src', 'main', 'managed-temp-cleanup.js'), 'utf8');
  const managedTempPaths = fs.readFileSync(path.join(ROOT, 'src', 'main', 'managed-temp-paths.js'), 'utf8');

  const hardeningChecks = [
    { name: 'contextIsolation', ok: /contextIsolation:\s*true/.test(mainIndex) },
    { name: 'nodeIntegration false', ok: /nodeIntegration:\s*false/.test(mainIndex) },
    { name: 'sandbox true', ok: /sandbox:\s*true/.test(mainIndex) },
    { name: 'single instance lock', ok: /requestSingleInstanceLock\s*\(/.test(mainIndex) },
    { name: 'blocked new windows', ok: /setWindowOpenHandler\(/.test(mainIndex) },
    { name: 'navigation guard', ok: /will-navigate/.test(mainIndex) },
    { name: 'CSP present', ok: /Content-Security-Policy/.test(html) },
    { name: 'preload allowlist shape', ok: /contextBridge\.exposeInMainWorld/.test(preload) && /ipcRenderer\.invoke/.test(preload) },
    { name: 'managed temp confinement', ok: /getManagedTempDirectory/.test(mainIndex) && /sanitizeManagedTempPaths/.test(mainIndex) && /isPathInsideDirectory/.test(mainIndex) },
    { name: 'managed temp cleanup resolves parent and rejects links', ok: /realpathSync\(path\.dirname\(absoluteTarget\)\)/.test(managedTempPaths) && /isSymbolicLink\(\)/.test(managedTempPaths) && /!targetStats\.isFile\(\)/.test(managedTempPaths) && /sanitizeManagedTempPaths\(cleanupPaths, managedTempDirectory\)/.test(fs.readFileSync(path.join(ROOT, 'src', 'main', 'pdf-operation-worker.js'), 'utf8')) },
    { name: 'stale managed temp cleanup is age-bounded and confined to direct files', ok: /cleanupStaleManagedTempFiles\(/.test(mainIndex) && /parentDirectory:\s*configService\.getTempPath\(\)/.test(mainIndex) && /MANAGED_TEMP_DIRECTORY_NAME\s*=\s*'central-pdf-temp'/.test(managedTempCleanup) && /stats\.mtimeMs\s*>=\s*cutoff/.test(managedTempCleanup) && /entry\.isFile\(\)/.test(managedTempCleanup) && /isSymbolicLink\(\)/.test(managedTempCleanup) && /DEFAULT_MAX_ENTRIES\s*=\s*5_000/.test(managedTempCleanup) },
    { name: 'temporary file extension allowlist', ok: /ExtensÃ£o nÃ£o permitida para arquivo temporÃ¡rio|Extensão não permitida para arquivo temporário/.test(mainIndex) },
    { name: 'temporary file size limit', ok: /buffer\.length > maxBytes/.test(mainIndex) },
    { name: 'pending cancellation cleanup', ok: /task\.onCancel/.test(queueSource) && /onCancel:\s*\(\) => cleanUpTempFiles/.test(mainIndex) },
    { name: 'OCR warns when a digital signature may be invalidated', ok: /'redact', 'ocr'/.test(mainIndex) && /signatureWarning/.test(mainIndex) && /invalidar a assinatura/.test(mainIndex) },
    { name: 'Redaction stamp images are confined to validated managed temporary files', ok: /function validateRedactOptions[\s\S]{0,2200}sanitizeManagedTempPaths\(options\.cleanupPaths\)[\s\S]{0,1200}fs\.realpathSync\(imagePath\)[\s\S]{0,500}isPathInsideDirectory\(managedRealDirectory, realImagePath\)[\s\S]{0,500}inspectImageFile\(imagePath\)/.test(mainIndex) && /redactedPageIndexes\.has\(item\.pageIndex\)/.test(pdfService) && /item\.pageIndex >= pageCount/.test(pdfService) },
    { name: 'Irreversible redaction raster uses lossless PNG output', ok: /canvas\.toDataURL\('image\/png'\)/.test(fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'ui', 'redact', 'redact-workspace.js'), 'utf8')) && /saveTempFile\(\{ base64Data, extension: 'png' \}\)/.test(fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'ui', 'redact', 'redact-workspace.js'), 'utf8')) },
    { name: 'Digital signature scan is asynchronous and reads bounded chunks', ok: /async function hasDigitalSignatures/.test(pdfService) && /chunkSize = 256 \* 1024/.test(pdfService) && /await handle\.read\(/.test(pdfService) && /finally\s*\{\s*await handle\?\.close\(\)/.test(pdfService) },
    { name: 'Signature warning covers merging and OCR transformations', ok: /invalidatesDigitalSignatures = \['merge', 'files-to-pdf'/.test(mainIndex) && /'redact', 'ocr'\]/.test(mainIndex) },
    { name: 'renderer test API is E2E-only', ok: /get-e2e-test-mode/.test(mainIndex) && /isE2ETestMode:\s*\(\)\s*=>\s*invokeOrReject\('get-e2e-test-mode'\)/.test(preload) && /if \(await window\.api\?\.isE2ETestMode\?\.\(\)\) exposeAutomatedTestApi\(\)/.test(rendererApp) },
    { name: 'OCR area extraction is bounded and local', ok: /event\.sender !== mainWindow\.webContents/.test(mainIndex) && /activeOcrAreaJobs/.test(mainIndex) && /300_000/.test(mainIndex) && /OCR_MAX_RENDER_PIXELS/.test(ocrService) && /text:\s*rawText\.slice\(0, 20_000\)/.test(ocrService) },
    { name: 'PDF search OCR validates caller, query and cancellation', ok: /ipcMain\.handle\('ocr-search-document'[\s\S]{0,500}event\.senderFrame !== mainWindow\.webContents\.mainFrame/.test(mainIndex) && /query\.length > 120/.test(mainIndex) && /activeOcrSearchJobs/.test(mainIndex) && /300_000/.test(mainIndex) && /job\?\.sender === event\.sender/.test(mainIndex) && /cancelActiveSearch\(\{ invalidate: true \}\)/.test(ocrAreaRenderer) },
    { name: 'PDF-to-Word OCR analysis is bounded, cancellable, and does not return text', ok: /ipcMain\.handle\('pdf-to-word-analyze'[\s\S]{0,500}event\.senderFrame !== mainWindow\.webContents\.mainFrame/.test(mainIndex) && /PDF_TO_WORD_ANALYSIS_MAX_BYTES = 64 \* 1024 \* 1024/.test(mainIndex) && /job\?\.sender === event\.sender/.test(mainIndex) && /45_000/.test(mainIndex) && /Math\.min\(pdf\.numPages, 16\)/.test(ocrService) && /pagesLikelyScanned/.test(ocrService) },
    { name: 'PDF search never returns extracted document text', ok: /heightRatio:\s*\(bottom - top\) \/ dimensions\.height\s*\n\s*\}/.test(ocrService) && !/text:\s*String\(text\)\.slice\(0,\s*240\)/.test(ocrService) }
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
