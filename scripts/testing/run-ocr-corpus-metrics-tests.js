const assert = require('node:assert/strict');
const { summarizeBlankPageDetection, calculateAccuracyTotals, normalizeReferenceText, parseCsvRecords } = require('./run-ocr-corpus-assessment');

const result = summarizeBlankPageDetection([
  { defect: 'branco', status: 'noText' },
  { defect: 'branco', status: 'recognized' },
  { defect: 'branco', status: 'failed' },
  { defect: 'limpo', status: 'recognized' },
  { defect: 'limpo', status: 'noText' },
  { defect: 'duplicada_do_arquivo_anterior', status: 'noText' },
  { defect: 'quase_branco', status: 'skipped' }
]);

assert.deepEqual(result, {
  explicitBlank: { total: 3, detectedBlank: 1, detectedText: 1, unresolved: 1 },
  explicitText: { total: 3, detectedBlank: 2, detectedText: 1, unresolved: 0 },
  ambiguousDuplicate: { total: 1, detectedBlank: 1, detectedText: 0, unresolved: 0 }
});

assert.equal(normalizeReferenceText('ＣＮＰＪ  12.345.678/0001-90'), 'cnpj 12.345.678/0001-90', 'A normalização deve tratar Unicode e espaços sem apagar pontuação de identificadores.');
assert.deepEqual(calculateAccuracyTotals([
  { expected: 'Ação válida: 12.345.', actual: 'Ação válida: 12.345.' },
  { expected: 'texto conhecido', actual: 'texto reconhecido' }
]), {
  samples: 2,
  cer: 2 / 35,
  wer: 1 / 5
});
assert.deepEqual(calculateAccuracyTotals([
  { expected: 'ordem código valor', actual: 'valor ordem código', metricMode: 'tokens' },
  { expected: 'Ação valor', actual: 'ação extra', metricMode: 'tokens' }
]), { samples: 0, cer: null, wer: null, tokenSamples: 2, tokenRecall: 0.8 }, 'A métrica por tokens deve ignorar ordem, preservar repetição e deixar CER/WER como não aplicável.');
assert.deepEqual(calculateAccuracyTotals([{ expected: '', actual: '' }]), { samples: 1, cer: 0, wer: 0 }, 'Referência explicitamente vazia deve contar como acerto quando o OCR também não encontra texto.');
assert.equal(calculateAccuracyTotals([]), null, 'Sem amostras, a avaliação deve ser n/a, não 0% de erro.');
assert.deepEqual(parseCsvRecords('arquivo,texto,nota\r\na.png,"linha 1, com vírgula\nlinha 2 e ""aspas""",ok\r\n'), [
  ['arquivo', 'texto', 'nota'],
  ['a.png', 'linha 1, com vírgula\nlinha 2 e "aspas"', 'ok']
], 'O manifesto deve preservar textos de referência CSV com vírgulas, quebras de linha e aspas escapadas.');
assert.throws(() => parseCsvRecords('arquivo,texto\na.png,"sem fechamento'), /sem aspas de fechamento/);

console.log('OCR corpus metric regressions passed: blank-page labels, Unicode/punctuation, aggregate CER/WER, multiline CSV, empty references, and no-sample handling.');
