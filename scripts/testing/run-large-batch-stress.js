const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const pdfService = require('../../src/main/pdf-service');
const utils = require('../../src/main/utils');
const { createTempDir, countPdfPages, formatBytes, writeReport, assert } = require('./_common');
const { generateTestAssets } = require('./generate-test-assets');

const VALID_COUNT = 200;
const INVALID_COUNT = 23;

async function runLargeBatchStress() {
  const manifest = await generateTestAssets();
  const assets = manifest.files;
  const workspace = createTempDir('large-batch-stress');
  const inputsDir = path.join(workspace, 'inputs');
  fs.mkdirSync(inputsDir, { recursive: true });

  const validFiles = Array.from({ length: VALID_COUNT }, (_, index) => {
    const filePath = path.join(inputsDir, `documento-${String(index + 1).padStart(3, '0')}.pdf`);
    fs.copyFileSync(assets.smallPdf, filePath);
    return filePath;
  });
  const invalidFiles = Array.from({ length: INVALID_COUNT }, (_, index) => {
    const filePath = path.join(inputsDir, `arquivo-com-erro-${String(index + 1).padStart(2, '0')}.pdf`);
    fs.writeFileSync(filePath, index % 2 ? Buffer.from('arquivo incompatível') : Buffer.alloc(0));
    return filePath;
  });

  const preflightStart = performance.now();
  const inspections = [...validFiles, ...invalidFiles].map((filePath) => utils.inspectPdfFile(filePath));
  const preflightMs = Math.round(performance.now() - preflightStart);
  assert.strictEqual(inspections.filter((item) => item.ok).length, VALID_COUNT);
  assert.strictEqual(inspections.filter((item) => !item.ok).length, INVALID_COUNT);

  let progressEvents = 0;
  const output = path.join(workspace, 'merge-200-validos.pdf');
  const mergeStart = performance.now();
  await pdfService.mergePdfs(validFiles, output, {}, () => false, () => { progressEvents += 1; });
  const mergeMs = Math.round(performance.now() - mergeStart);
  const outputPages = await countPdfPages(output);
  assert.strictEqual(outputPages, VALID_COUNT * 2);
  assert.strictEqual(progressEvents, VALID_COUNT);

  const reportPath = writeReport('large-batch-stress-report.md', [
    '# Large Batch Stress Report',
    '',
    `Gerado em ${new Date().toISOString()}.`,
    '',
    `Lote válido: ${VALID_COUNT} PDFs | lote inválido: ${INVALID_COUNT} PDFs.`,
    '',
    '| Cenário | Resultado | Tempo | Memória RSS final |',
    '| --- | --- | --- | --- |',
    `| Pré-validação agrupada | ${VALID_COUNT} aceitos / ${INVALID_COUNT} rejeitados | ${preflightMs} ms | ${formatBytes(process.memoryUsage().rss)} |`,
    `| Mesclagem dos válidos | ${outputPages} páginas / ${progressEvents} eventos | ${mergeMs} ms | ${formatBytes(process.memoryUsage().rss)} |`,
    '',
    'Critério: arquivos inválidos são identificados antes da execução; a operação prossegue somente com os arquivos válidos e mantém progresso por item.',
    'Este teste valida estabilidade do serviço local com centenas de entradas pequenas; PDFs grandes ou complexos ainda dependem de RAM, disco e limite oficial do aplicativo.'
  ]);

  return { ok: true, reportPath, validCount: VALID_COUNT, invalidCount: INVALID_COUNT, outputPages, progressEvents, preflightMs, mergeMs };
}

if (require.main === module) {
  runLargeBatchStress()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error.stack || String(error));
      process.exit(1);
    });
}

module.exports = { runLargeBatchStress };
