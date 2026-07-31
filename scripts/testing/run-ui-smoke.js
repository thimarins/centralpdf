const fs = require('fs');
const path = require('path');
const {
  createTempDir,
  writeReport,
  toMarkdownTable,
  countPdfPages
} = require('./_common');
const { generateTestAssets } = require('./generate-test-assets');
const { runUiStructureAudit } = require('./run-ui-structure-audit');
const pdfService = require('../../src/main/pdf-service');
const { hasPdfEncryptionDictionaryAsync } = require('../../src/main/utils');

function runWorkflowSuggestionAudit() {
  const checks = [];
  const appSource = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'app.js'), 'utf8');
  const indexSource = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'index.html'), 'utf8');
  const documentServiceSource = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'services', 'document-conversion', 'document-to-pdf.js'), 'utf8');
  const preloadSource = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'preload', 'index.js'), 'utf8');
  const queueSource = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'queue.js'), 'utf8');

  function check(name, ok, details) {
    checks.push({ name, ok: Boolean(ok), details });
  }

  const expectedSuggestionTypes = [
    'merge',
    'sign',
    'organize',
    'watermark',
    'redact',
    'images-to-pdf'
  ];

  const missingSuggestionTypes = expectedSuggestionTypes.filter((type) => {
    const signature = type === 'images-to-pdf' ? `"${type}": [` : `${type}: [`;
    return !appSource.includes(signature);
  });

  check(
    'sugestões mapeadas',
    missingSuggestionTypes.length === 0,
    missingSuggestionTypes.length === 0
      ? 'módulos com próximos passos continuam mapeados'
      : `faltando mapa para: ${missingSuggestionTypes.join(', ')}`
  );

  const converterLabel = appSource.includes('Converter para PDF')
    && indexSource.includes('Converter para PDF')
    && indexSource.includes('.docx')
    && indexSource.includes('.xlsx')
    && documentServiceSource.includes('mammoth')
    && documentServiceSource.includes('xlsx')
    && preloadSource.includes('convertDocumentToTempPdf');
  check(
    'conversor de arquivos documentado na interface',
    converterLabel,
    converterLabel
      ? 'interface aceita imagens, Word e Excel'
      : 'faltam nome ou formatos do conversor de arquivos'
  );

  const preservesType = /publicTask\s*\(task\)\s*\{[\s\S]*?type:\s*task\.type\s*\|\|\s*['"]['"]/.test(queueSource);
  check(
    'fila preserva tipo da operação',
    preservesType,
    preservesType
      ? 'snapshot público da fila mantém o tipo usado pelas sugestões'
      : 'tipo da operação não está exposto pela fila pública'
  );

  return checks;
}

async function withSuppressedStderr(fn) {
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  try {
    return await fn();
  } finally {
    process.stderr.write = originalWrite;
  }
}

async function withSuppressedConsoleWarn(fn) {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.warn = originalWarn;
  }
}

async function runProtectUnlockFlow(assets) {
  const workspace = createTempDir('ui-smoke-unlock');
  const protectedPath = path.join(workspace, 'protected.pdf');
  const unlockedPath = path.join(workspace, 'unlocked.pdf');
  const password = 'SenhaForte123!';
  const checks = [];

  function check(name, ok, details) {
    checks.push({ name, ok: Boolean(ok), details });
  }

  await withSuppressedConsoleWarn(() => pdfService.encryptPdf(assets.mediumPdf, protectedPath, password));
  check('proteger gera arquivo', fs.existsSync(protectedPath), 'arquivo protegido criado');

  const encrypted = await hasPdfEncryptionDictionaryAsync(protectedPath);
  check('proteger aplica criptografia', encrypted, 'dicionário de criptografia detectado');

  let wrongPasswordRejected = false;
  try {
    await withSuppressedConsoleWarn(() => withSuppressedStderr(() => pdfService.decryptPdf(protectedPath, path.join(workspace, 'wrong.pdf'), 'senha-errada')));
  } catch (error) {
    wrongPasswordRejected = /senha|password|crypt|encrypt|decrypt|abrir/i.test(error.message || String(error));
  }
  check('desbloquear rejeita senha errada', wrongPasswordRejected, 'erro controlado para senha inválida');

  await withSuppressedConsoleWarn(() => pdfService.decryptPdf(protectedPath, unlockedPath, password));
  check('desbloquear gera arquivo', fs.existsSync(unlockedPath), 'arquivo desbloqueado criado');

  const originalPages = await countPdfPages(assets.mediumPdf);
  const unlockedPages = await countPdfPages(unlockedPath);
  check('desbloquear preserva páginas', originalPages === unlockedPages, `${originalPages} páginas esperadas, ${unlockedPages} obtidas`);

  const unlockedBytes = fs.statSync(unlockedPath).size;
  check('desbloquear saída válida', unlockedBytes > 0, `${unlockedBytes} bytes gerados`);

  return checks;
}

async function runUiSmoke() {
  const manifest = await generateTestAssets();
  const assets = manifest.files;
  const reportRows = [];

  const structure = runUiStructureAudit();
  structure.checks.forEach((item) => {
    reportRows.push([
      `estrutura: ${item.name}`,
      item.ok ? 'ok' : 'erro',
      item.details || ''
    ]);
  });

  const workflowSuggestionChecks = runWorkflowSuggestionAudit();
  workflowSuggestionChecks.forEach((item) => {
    reportRows.push([
      `sugestões: ${item.name}`,
      item.ok ? 'ok' : 'erro',
      item.details || ''
    ]);
  });

  const unlockChecks = await runProtectUnlockFlow(assets);
  unlockChecks.forEach((item) => {
    reportRows.push([
      `desbloquear: ${item.name}`,
      item.ok ? 'ok' : 'erro',
      item.details || ''
    ]);
  });

  const ok = reportRows.every((row) => row[1] === 'ok');
  const reportPath = writeReport('ui-smoke-report.md', [
    '# UI Smoke Report',
    '',
    `Gerado em ${new Date().toISOString()}.`,
    '',
    ...toMarkdownTable(['Teste', 'Status', 'Detalhes'], reportRows)
  ]);

  return {
    ok,
    reportPath,
    results: reportRows.map(([name, status, details]) => ({ name, ok: status === 'ok', details }))
  };
}

if (require.main === module) {
  runUiSmoke()
    .then((summary) => {
      console.log(JSON.stringify(summary, null, 2));
      process.exit(summary.ok ? 0 : 1);
    })
    .catch((error) => {
      console.error(error.stack || String(error));
      process.exit(1);
    });
}

module.exports = {
  runUiSmoke
};
