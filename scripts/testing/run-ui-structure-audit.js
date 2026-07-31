const fs = require('fs');
const path = require('path');
const { ROOT, toMarkdownTable, writeReport } = require('./_common');

const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
const organizeJs = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'ui', 'organize', 'organize-workspace.js'), 'utf8');
const signatureJs = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'ui', 'signature', 'signature-workspace.js'), 'utf8');
const protectJs = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'ui', 'security', 'protect-workspace.js'), 'utf8');
const unlockJs = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'ui', 'security', 'unlock-workspace.js'), 'utf8');
const queueJs = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'ui', 'queue', 'queue-status.js'), 'utf8');

function hasId(id) {
  return new RegExp(`id=["']${id}["']`).test(html);
}

function hasIdAnywhere(id) {
  return hasId(id) || new RegExp(`id=["']${id}["']`).test(appJs);
}

function hasText(code, text) {
  return code.includes(text);
}

function runUiStructureAudit() {
  const checks = [];

  function check(name, ok, details) {
    checks.push({ name, ok, details });
  }

  const moduleControls = {
    'Organizar principais': [
      'btn-run-organize',
      'btn-organize-move-first',
      'btn-organize-move-up',
      'btn-organize-move-down',
      'btn-organize-move-last',
      'btn-organize-rotate-selected',
      'btn-organize-duplicate-selected',
      'btn-organize-delete-selected',
      'btn-organize-extract-selected',
      'btn-organize-export-images',
      'btn-organize-undo-action',
      'btn-organize-reverse',
      'btn-organize-add-file',
      'btn-organize-add-image',
      'btn-organize-clear-file',
      'organize-output-name',
      'organize-zip',
      'organize-number-pages'
    ],
    'Assinar principais': [
      'btn-run-signature',
      'btn-add-signature-field',
      'btn-add-drawn-field',
      'btn-add-initials-field',
      'btn-add-date-field',
      'btn-add-text-field',
      'btn-add-seal-field',
      'signature-field-editor'
    ],
    'Proteger principais': [
      'btn-run-protect',
      'btn-protect-change-file',
      'btn-protect-clear-file',
      'btn-protect-generate-password',
      'btn-protect-copy-password',
      'btn-protect-toggle-password',
      'protect-password',
      'protect-output-name'
    ],
    'Desbloquear principais': [
      'btn-run-unlock',
      'btn-unlock-change-file',
      'btn-unlock-clear-file',
      'btn-unlock-clear-password',
      'btn-unlock-copy-password',
      'btn-unlock-toggle-password',
      'unlock-password',
      'unlock-output-name'
    ],
    'Fila e histórico': [
      'btn-dashboard-processed-history',
      'recent-history-list',
      'recent-processed-modal-list',
      'queue-status-bar',
      'queue-tasks-list'
    ]
  };

  Object.entries(moduleControls).forEach(([name, ids]) => {
    const missing = ids.filter((id) => !hasIdAnywhere(id));
    check(name, missing.length === 0, missing.length === 0 ? `${ids.length} controles encontrados` : `faltando: ${missing.join(', ')}`);
  });

  check(
    'Organizar vinculado no app',
    hasText(appJs, 'bindClick("btn-run-organize", queueOrganize);') &&
      hasText(appJs, 'organizeWorkspace.moveSelectedPages("up")') &&
      hasText(appJs, 'organizeWorkspace.rotateSelectedPages') &&
      hasText(appJs, 'organizeWorkspace.clearOrganizeWorkspace'),
    'ações principais do Organizar ligadas ao renderer'
  );

  check(
    'Organizar handlers internos',
    hasText(organizeJs, 'bindOrganizeUiOnce()') &&
      hasText(organizeJs, 'btnExtract.onclick = async') &&
      hasText(organizeJs, 'btnExportImages.onclick = async') &&
      hasText(organizeJs, 'btnShowDetails.onclick = async'),
    'handlers únicos para ações internas'
  );

  check(
    'Assinar handlers',
    hasText(signatureJs, "['signature', 'drawn', 'initials', 'date', 'text', 'seal'].forEach") &&
      hasText(signatureJs, 'btn-remove-signature-field') &&
      hasText(signatureJs, 'btn-remove-signature-field'),
    'ações de assinatura declaradas'
  );

  check(
    'Proteger handlers',
    hasText(protectJs, 'btn-protect-generate-password') &&
      hasText(protectJs, 'btn-protect-copy-password') &&
      hasText(protectJs, 'btn-protect-clear-file'),
    'ações de proteção declaradas'
  );

  check(
    'Desbloquear handlers',
    hasText(unlockJs, 'btn-unlock-clear-password') &&
      hasText(unlockJs, 'btn-unlock-copy-password') &&
      hasText(unlockJs, 'btn-unlock-clear-file'),
    'ações de desbloqueio declaradas'
  );

  check(
    'Notificações de fila',
    hasText(queueJs, 'queue-running-') &&
      hasText(queueJs, 'queue-complete-') &&
      hasText(queueJs, 'queue-error-') &&
      hasText(queueJs, "updateRecentHistory?.(task, 'sucesso')"),
    'fluxos de andamento, sucesso e erro presentes'
  );

  const reportPath = writeReport('ui-structure-audit.md', [
    '# UI Structure Audit Report',
    '',
    `Gerado em ${new Date().toISOString()}.`,
    '',
    ...toMarkdownTable(
      ['Check', 'Status', 'Detalhes'],
      checks.map((item) => [item.name, item.ok ? 'ok' : 'warning', item.details])
    )
  ]);

  return {
    ok: checks.every((item) => item.ok),
    reportPath,
    checks
  };
}

if (require.main === module) {
  try {
    const summary = runUiStructureAudit();
    console.log(`UI structure audit completed: ${summary.checks.length} checks`);
    process.exit(summary.ok ? 0 : 1);
  } catch (error) {
    console.error(error.stack || String(error));
    process.exit(1);
  }
}

module.exports = {
  runUiStructureAudit
};
