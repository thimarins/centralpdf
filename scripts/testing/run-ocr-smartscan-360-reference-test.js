'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { ROOT } = require('./_common');
const { runCorpusAssessment } = require('./run-ocr-corpus-assessment');

async function runSmartScanSupplementReferenceTest() {
  const corpus = path.join(ROOT, 'test-assets', 'ocr-smartscan-360-reference');
  const report = path.join(ROOT, 'reports', 'ocr-smartscan-360-reference-report.md');
  const result = await runCorpusAssessment(corpus, report, { includeAccuracyByDefect: true });
  assert.equal(result.inputs, 5, 'A amostra complementar deve conter cinco imagens verificadas.');
  assert.equal(result.outputs, 5, 'Cada referência deve produzir uma saída OCR.');
  assert.equal(result.failures, 0, 'A amostra de referência não deve ter falhas de processamento.');
  assert.equal(result.accuracy.samples, 5, 'As cinco referências devem entrar na métrica sequencial.');
  assert.ok(result.accuracy.cer <= 0.02, `CER excedeu 2% (${(result.accuracy.cer * 100).toFixed(2)}%).`);
  assert.ok(result.accuracy.wer <= 0.12, `WER excedeu 12% (${(result.accuracy.wer * 100).toFixed(2)}%).`);
  assert.ok(result.accuracyByDefect?.inclinado?.cer <= 0.10,
    `A página sintética inclinada deve manter CER abaixo de 10% (${((result.accuracyByDefect?.inclinado?.cer || 0) * 100).toFixed(2)}%).`);
  assert.ok(result.accuracyByDefect?.inclinado?.wer <= 0.50,
    `A página sintética inclinada deve manter WER abaixo de 50% (${((result.accuracyByDefect?.inclinado?.wer || 0) * 100).toFixed(2)}%).`);
  assert.ok(result.accuracyByDefect?.limpo?.cer <= 0.01 && result.accuracyByDefect?.limpo?.wer <= 0.08,
    'A página sintética limpa deve manter CER abaixo de 1% e WER abaixo de 8%.');
  assert.ok(result.sourceIntegrity, 'As imagens fonte devem permanecer intactas.');
  console.log(`SmartScan 360 manual reference passed: ${result.accuracy.samples} páginas, CER ${(result.accuracy.cer * 100).toFixed(2)}%, WER ${(result.accuracy.wer * 100).toFixed(2)}%.`);
}

if (require.main === module) {
  runSmartScanSupplementReferenceTest().catch((error) => {
    console.error(error.stack || String(error));
    process.exitCode = 1;
  });
}

module.exports = { runSmartScanSupplementReferenceTest };
