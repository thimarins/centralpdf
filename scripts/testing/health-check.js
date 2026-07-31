const fs = require('fs');
const path = require('path');
const { ROOT, toMarkdownTable, writeReport, withSuppressedPdfParserNoise } = require('./_common');
const { runFunctionalTests } = require('./run-functional-tests');
const { runQueueTests } = require('./run-queue-tests');
const { runSecurityAudit } = require('./run-security-audit');
const { runArchitectureAudit } = require('./run-architecture-audit');
const { runPerformanceSmoke } = require('./run-performance-smoke');
const { runVisualAudit } = require('./run-visual-audit');
const { runUiStructureAudit } = require('./run-ui-structure-audit');
const { runBuildCheck } = require('./run-build-check');
const { runRepoAudit } = require('./run-repo-audit');
const { generateTestAssets } = require('./generate-test-assets');

async function runStep(name, fn) {
  const startedAt = Date.now();
  try {
    const result = await fn();
    return {
      name,
      ok: result?.ok !== false,
      details: result?.reportPath ? path.relative(ROOT, result.reportPath) : 'ok',
      durationMs: Date.now() - startedAt,
      result
    };
  } catch (error) {
    return {
      name,
      ok: false,
      details: error.message || String(error),
      durationMs: Date.now() - startedAt,
      error
    };
  }
}

async function runHealthCheck(options = {}) {
  return withSuppressedPdfParserNoise(async () => {
    const skipBuildMinimum = options.skipBuildMinimum === true;
    await generateTestAssets();
    const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const dependencyRows = [
      ...Object.entries(packageJson.dependencies || {}).map(([name, version]) => [name, version, 'runtime']),
      ...Object.entries(packageJson.devDependencies || {}).map(([name, version]) => [name, version, 'dev'])
    ];

    const steps = [];
    steps.push(await runStep('functional', () => runFunctionalTests()));
    steps.push(await runStep('queue', () => runQueueTests()));
    steps.push(await runStep('security', () => runSecurityAudit()));
    steps.push(await runStep('architecture', () => runArchitectureAudit()));
    steps.push(await runStep('repo-hygiene', () => runRepoAudit()));
    steps.push(await runStep('performance-smoke', () => runPerformanceSmoke()));
    steps.push(await runStep('visual-audit', () => runVisualAudit()));
    steps.push(await runStep('ui-structure-audit', () => runUiStructureAudit()));
    if (!skipBuildMinimum) {
      steps.push(await runStep('build-minimum', () => runBuildCheck({ full: false })));
    }

    const warnings = steps.filter((step) => !step.ok).map((step) => `- ${step.name}: ${step.details}`);
    const reportPath = writeReport('health-report.md', [
      '# Health Report',
      '',
      `Gerado em ${new Date().toISOString()}.`,
      '',
      '## Execucao',
      '',
      ...toMarkdownTable(
        ['Suite', 'Status', 'Duracao', 'Detalhes'],
        steps.map((step) => [step.name, step.ok ? 'ok' : 'warning', `${step.durationMs} ms`, step.details])
      ),
      '',
      '## Dependencias',
      '',
      ...toMarkdownTable(['Pacote', 'Versao', 'Tipo'], dependencyRows),
      '',
      '## Warnings',
      '',
      ...(warnings.length ? warnings : ['- Nenhum warning critico nesta rodada.']),
      '',
      '## Recomendacoes',
      '',
      '- Rode `npm run release-check` antes de distribuir MSI ou pasta unpacked para TI.',
      '- Se o reporte de arquitetura apontar arquivo grande ou orfao, trate isso antes da proxima release.',
      '- Regerar `test-assets/generated` quando houver mudanca relevante no pipeline de PDFs.'
    ]);

    return {
      ok: steps.every((step) => step.ok),
      reportPath,
      steps
    };
  });
}

if (require.main === module) {
  runHealthCheck()
    .then((summary) => {
      console.log(`Health check completed: ${summary.steps.length} suites`);
      process.exit(summary.ok ? 0 : 1);
    })
    .catch((error) => {
      console.error(error.stack || String(error));
      process.exit(1);
    });
}

module.exports = {
  runHealthCheck
};
