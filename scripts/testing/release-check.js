const path = require('path');
const { ROOT, toMarkdownTable, writeReport } = require('./_common');
const { runHealthCheck } = require('./health-check');
const { runBuildCheck } = require('./run-build-check');

async function runReleaseCheck() {
  const steps = [];
  const startedAt = Date.now();

  function pushStep(name, ok, details, durationMs) {
    steps.push({ name, ok, details, durationMs });
  }

  const healthStart = Date.now();
  const health = await runHealthCheck({ skipBuildMinimum: true });
  pushStep('health-check', health.ok, path.relative(ROOT, health.reportPath), Date.now() - healthStart);

  const buildStart = Date.now();
  const build = await runBuildCheck({ full: true });
  pushStep('build:win', build.ok, path.relative(ROOT, build.reportPath), Date.now() - buildStart);

  const reportPath = writeReport('release-check-report.md', [
    '# Release Candidate Report',
    '',
    `Gerado em ${new Date().toISOString()}.`,
    '',
    `Tempo total: ${Date.now() - startedAt} ms.`,
    '',
    ...toMarkdownTable(['Etapa', 'Status', 'Duracao', 'Detalhes'], steps.map((step) => [step.name, step.ok ? 'ok' : 'warning', `${step.durationMs} ms`, step.details])),
    '',
    '## Resultado',
    '',
    ...(steps.every((step) => step.ok)
      ? ['- Release candidate aprovado nesta rodada automatizada.']
      : ['- Release candidate com warnings. Revise os relatórios antes de distribuir via GPO/Intune.'])
  ]);

  return {
    ok: steps.every((step) => step.ok),
    reportPath,
    steps
  };
}

if (require.main === module) {
  runReleaseCheck()
    .then((summary) => {
      console.log(`Release check completed: ${summary.steps.length} etapas`);
      process.exit(summary.ok ? 0 : 1);
    })
    .catch((error) => {
      console.error(error.stack || String(error));
      process.exit(1);
    });
}

module.exports = {
  runReleaseCheck
};
