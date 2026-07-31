const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const { PDF_LIMITS } = require('../../src/main/utils');
const pdfService = require('../../src/main/pdf-service');
const {
  createTempDir,
  countPdfPages,
  formatBytes,
  toMarkdownTable,
  writeReport
} = require('./_common');
const { generateTestAssets } = require('./generate-test-assets');

async function measure(label, fn) {
  const memoryBefore = process.memoryUsage().rss;
  const start = performance.now();
  const result = await fn();
  const durationMs = performance.now() - start;
  const memoryAfter = process.memoryUsage().rss;
  return {
    label,
    durationMs: Math.round(durationMs),
    rssDeltaBytes: memoryAfter - memoryBefore,
    result
  };
}

async function runPerformanceSmoke() {
  const manifest = await generateTestAssets();
  const assets = manifest.files;
  const workspace = createTempDir('performance-suite');
  const measurements = [];

  measurements.push(await measure('merge small+medium', async () => {
    const output = path.join(workspace, 'perf-merge.pdf');
    await pdfService.mergePdfs([assets.smallPdf, assets.mediumPdf], output);
    return { output, pages: await countPdfPages(output) };
  }));

  measurements.push(await measure('split many-pages by range', async () => {
    const output = path.join(workspace, 'perf-range.pdf');
    await pdfService.splitPdfByRanges(assets.manyPagesPdf, '1-25,40-60,90-120', output);
    return { output, pages: await countPdfPages(output) };
  }));

  measurements.push(await measure('compress image-heavy', async () => {
    const output = path.join(workspace, 'perf-compress.pdf');
    const reduction = await pdfService.compressPdf(assets.imageHeavyPdf, output);
    return { output, reduction, size: fs.statSync(output).size };
  }));

  measurements.push(await measure('watermark batch text', async () => {
    const outputDir = path.join(workspace, 'wm');
    fs.mkdirSync(outputDir, { recursive: true });
    await pdfService.applyWatermarkBatch([assets.smallPdf, assets.mediumPdf], outputDir, {
      watermarkKind: 'text',
      text: 'INTERNO',
      fontSize: 60,
      color: '#6e6e6e',
      opacity: 18,
      rotation: -35,
      position: 'diagonal',
      scale: 100,
      outputSuffix: '_perf',
      fontFamily: 'HelveticaBold'
    });
    return { files: fs.readdirSync(outputDir).filter((file) => file.endsWith('.pdf')).length };
  }));

  const rows = measurements.map((item) => [
    item.label,
    `${item.durationMs} ms`,
    formatBytes(item.rssDeltaBytes),
    JSON.stringify(item.result)
  ]);

  const reportPath = writeReport('performance-report.md', [
    '# Performance Smoke Report',
    '',
    `Gerado em ${new Date().toISOString()}.`,
    '',
    `Limite oficial validado nesta suite: ${formatBytes(PDF_LIMITS.maxSupportedBytes)}.`,
    '',
    ...toMarkdownTable(['Operacao', 'Tempo', 'Delta RSS', 'Resultado'], rows),
    '',
    'Observacao: este smoke test mede regressao relativa de servicos centrais, nao substitui profiling profundo de GUI.'
  ]);

  return {
    ok: true,
    reportPath,
    measurements
  };
}

if (require.main === module) {
  runPerformanceSmoke()
    .then((summary) => {
      console.log(`Performance smoke completed: ${summary.measurements.length} measurements`);
    })
    .catch((error) => {
      console.error(error.stack || String(error));
      process.exit(1);
    });
}

module.exports = {
  runPerformanceSmoke
};
