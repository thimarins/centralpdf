const path = require('path');
const assert = require('node:assert/strict');
const { ROOT } = require('./_common');
const { runCorpusAssessment } = require('./run-ocr-corpus-assessment');

async function main() {
  const corpusPath = path.join(ROOT, 'test-assets', 'ocr-smartscan-reference');
  const reportPath = path.join(ROOT, 'reports', 'ocr-smartscan-reference-report.md');
  const result = await runCorpusAssessment(corpusPath, reportPath);

  assert.equal(result.inputs, 4, 'O corpus de referência SmartScan deve conter quatro páginas anotadas.');
  assert.equal(result.outputs, 4, 'Cada imagem SmartScan válida deve gerar uma saída pesquisável.');
  assert.equal(result.failures, 0, 'As quatro páginas SmartScan devem ser processadas sem falha.');
  assert.equal(result.sourceIntegrity, true, 'A avaliação deve preservar as imagens de referência.');
  assert.deepEqual(result.accuracy?.samples, 3, 'CER/WER sequenciais devem comparar as três transcrições com ordem legível.');
  assert.deepEqual(result.accuracy?.tokenSamples, 1, 'A página girada deve ser comparada por cobertura de tokens, não pela ordem de extração.');
  assert.ok(result.accuracy.tokenRecall >= 0.85,
    `A cobertura de tokens da página girada ficou abaixo de 85% (${(result.accuracy.tokenRecall * 100).toFixed(2)}%).`);
  assert.ok(result.accuracy.cer <= 0.03,
    `CER SmartScan excedeu 3% (${(result.accuracy.cer * 100).toFixed(2)}%).`);
  assert.ok(result.accuracy.wer <= 0.12,
    `WER SmartScan excedeu 12% (${(result.accuracy.wer * 100).toFixed(2)}%).`);

  console.log(`SmartScan reference OCR passed: CER ${(result.accuracy.cer * 100).toFixed(2)}%, WER ${(result.accuracy.wer * 100).toFixed(2)}%; report contains aggregate metrics only.`);
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
