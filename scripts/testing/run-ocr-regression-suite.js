const path = require('path');
const { spawnSync } = require('child_process');
const { ROOT, writeReport } = require('./_common');

const suites = [
  ['Regressão de upload', 'run-upload-regression.js', 60_000],
  ['Limpeza segura de temporários antigos', 'run-managed-temp-cleanup-tests.js', 60_000],
  ['Confinamento canônico de caminhos temporários', 'run-managed-temp-paths-tests.js', 60_000],
  ['Limpeza de temporários no startup empacotado', 'run-packaged-temp-cleanup-test.js', 150_000],
  ['Auditoria transversal', 'run-cross-module-audit.js', 60_000],
  ['Segurança', 'run-security-audit.js', 60_000],
  ['Fluxos funcionais', 'run-functional-tests.js', 120_000],
  ['Fila de processamento', 'run-queue-tests.js', 60_000],
  ['Progresso OCR', 'run-ocr-progress-tests.js', 60_000],
  ['Cancelamento OCR', 'run-ocr-cancel-tests.js', 90_000],
  ['Reutilização e isolamento do worker', 'run-ocr-lazy-worker-tests.js', 60_000],
  ['Liberação de memória de renderização OCR', 'run-ocr-render-memory-tests.js', 60_000],
  ['Precisão por idioma (CER/WER)', 'run-ocr-language-accuracy.js', 180_000],
  ['Precisão em amostra SmartScan anotada (CER/WER)', 'run-ocr-smartscan-reference-test.js', 90_000],
  ['Referências manuais do corpus SmartScan 360 (CER/WER)', 'run-ocr-smartscan-360-reference-test.js', 90_000],
  ['Métricas de páginas em branco no corpus', 'run-ocr-corpus-metrics-tests.js', 60_000],
  ['Anotador de referências CER/WER', 'run-ocr-reference-annotator-tests.js', 60_000],
  ['CER/WER de manifesto rotulado e privacidade', 'run-ocr-reference-corpus-test.js', 60_000],
  ['Corpus sintético OCR rotulado (28 imagens)', 'run-ocr-synthetic-corpus-test.js', 180_000],
  ['Pré-processamento OCR', 'run-ocr-preprocess-regression.js', 120_000],
  ['OCR em PDF para Word', 'run-pdf-to-word-ocr-tests.js', 120_000],
  ['Interface de extração regional OCR', 'run-ocr-area-ui-tests.js', 60_000],
  ['Upload OCR pelo seletor e arrastar/soltar', 'run-ocr-upload-path-tests.js', 60_000],
  ['Privacidade de logs OCR', 'run-ocr-log-privacy-tests.js', 60_000],
  ['Licenças dos modelos OCR', 'run-ocr-license-tests.js', 60_000],
  ['Manifesto de licenças runtime', 'run-runtime-license-manifest-test.js', 60_000],
  ['Controles independentes de qualidade OCR', 'run-ocr-adaptive-options-tests.js', 60_000],
  ['Exportação TXT por intervalo e privacidade', 'run-ocr-page-range-export-tests.js', 60_000],
  ['Padrões de busca para ocultação OCR', 'run-ocr-redaction-pattern-tests.js', 60_000],
  ['Integridade de anexos após ocultação (qpdf)', 'run-ocr-redaction-attachment-tests.js', 60_000],
  ['Sugestões de separação por títulos recorrentes', 'run-split-title-suggestions-tests.js', 60_000],
  ['Análise de PDF híbrido para sugestões de separação', 'run-split-title-suggestions-pdf-tests.js', 120_000],
  ['Execução OCR offline com rede bloqueada', 'run-ocr-offline-regression.js', 120_000],
  ['Sintaxe do E2E', 'run-e2e-script-syntax.js', 60_000],
  ['Estresse OCR (100 páginas sintéticas)', 'run-ocr-page-scale-tests.js', 240_000],
  ['OCR funcional completo', 'run-ocr-tests.js', 600_000],
  ['Build e contratos', 'run-build-check.js', 180_000]
];

function runOcrRegressionSuite() {
  const startedAt = Date.now();
  const results = [];

  for (const [name, script, timeoutMs] of suites) {
    const stepStartedAt = Date.now();
    console.log(`\n[${results.length + 1}/${suites.length}] ${name}`);
    const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'testing', script)], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: timeoutMs,
      windowsHide: true
    });
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    const timedOut = result.error?.code === 'ETIMEDOUT';
    const ok = result.status === 0 && !result.error;
    const durationMs = Date.now() - stepStartedAt;
    results.push({ name, script, ok, timedOut, timeoutMs, durationMs, output });
    if (output) console.log(output);
    console.log(`${ok ? 'OK' : timedOut ? 'TEMPO ESGOTADO' : 'FALHOU'} — ${name} (${durationMs} ms)`);
    if (!ok) break;
  }

  const completed = results.length;
  const ok = completed === suites.length && results.every(({ ok: passed }) => passed);
  const reportPath = writeReport('ocr-regression-suite-report.md', [
    '# Suíte agrupada de regressão OCR',
    '',
    `Gerado em ${new Date().toISOString()}.`,
    '',
    `Etapas concluídas: ${completed}/${suites.length}. Tempo total: ${Date.now() - startedAt} ms.`,
    '',
    '| Grupo | Resultado | Duração | Limite |',
    '| --- | --- | ---: | ---: |',
    ...results.map(({ name, ok: passed, timedOut, durationMs, timeoutMs }) => `| ${name} | ${passed ? 'Aprovado' : timedOut ? 'Tempo esgotado' : 'Falhou'} | ${durationMs} ms | ${timeoutMs} ms |`),
    '',
    ...(ok ? ['Resultado geral: aprovado.'] : ['Resultado geral: incompleto ou reprovado; consulte a saída do primeiro grupo que falhou.'])
  ]);

  console.log(`\nSuíte OCR: ${results.filter(({ ok: passed }) => passed).length}/${suites.length} grupos; relatório: ${reportPath}`);
  return ok;
}

if (require.main === module) process.exit(runOcrRegressionSuite() ? 0 : 1);

module.exports = { runOcrRegressionSuite };
