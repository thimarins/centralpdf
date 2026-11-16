const assert = require('node:assert/strict');
const { writeReport } = require('./_common');
const { normalizeOcrProgressPercent, getOcrStageLabel, createOcrProgressUpdate } = require('../../src/main/services/ocr/ocr-progress');

const checks = [];
function check(name, fn, details) {
  try {
    fn();
    checks.push({ name, ok: true, details });
  } catch (error) {
    checks.push({ name, ok: false, details: error.message || String(error) });
  }
}

check('Tesseract fracionário vira percentual', () => {
  assert.equal(normalizeOcrProgressPercent(0.35, true), 35);
  assert.equal(normalizeOcrProgressPercent(1, true), 100);
}, 'valores entre 0 e 1 do motor são convertidos para 0–100');

check('Progresso de página preserva a unidade percentual', () => {
  assert.equal(normalizeOcrProgressPercent(35, false), 35);
  assert.equal(normalizeOcrProgressPercent(135, false), 100);
  assert.equal(normalizeOcrProgressPercent(-5, false), 0);
}, 'valores de etapa já expressos em porcentagem são limitados sem conversão dupla');

check('Etapa técnica é exibida em português claro', () => {
  assert.equal(getOcrStageLabel('recognizing text'), 'Reconhecendo texto');
  assert.equal(getOcrStageLabel('loading language traineddata'), 'Carregando os idiomas');
}, 'status interno do Tesseract não aparece em inglês no nome da etapa');

check('Progresso de lote inclui o arquivo e a etapa atual', () => {
  const update = createOcrProgressUpdate({ stage: 'motor', status: 'recognizing text', progress: 0.35 }, {
    fileIndex: 1, fileCount: 4, fileName: 'arquivo.pdf'
  });
  assert.equal(update.itemProgress, 35);
  assert.equal(update.progress, 34);
  assert.equal(update.currentItem, 2);
  assert.equal(update.totalItems, 4);
  assert.equal(update.currentItemName, 'arquivo.pdf — Reconhecendo texto');
}, 'progresso por arquivo é ponderado pelo tamanho do lote e mantém contexto legível');

const reportPath = writeReport('ocr-progress-report.md', [
  '# OCR Progress Test Report',
  '',
  `Gerado em ${new Date().toISOString()}.`,
  '',
  ...checks.map((item) => `- ${item.ok ? 'ok' : 'falha'} — ${item.name}: ${item.details}`),
  '',
  `Resultado: ${checks.filter((item) => item.ok).length}/${checks.length} grupos passaram.`
]);

console.log(`OCR progress checks: ${checks.filter((item) => item.ok).length}/${checks.length}; relatório: ${reportPath}`);
if (checks.some((item) => !item.ok)) process.exit(1);
