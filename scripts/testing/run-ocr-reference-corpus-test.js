const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createCanvas } = require('@napi-rs/canvas');
const { runCorpusAssessment } = require('./run-ocr-corpus-assessment');

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'central-pdf-ocr-reference-test-'));
  try {
    const expected = 'Ação válida: 12.345.678/0001-90';
    const multilineReference = 'Ação válida:\n12.345.678/0001-90';
    const imagePath = path.join(root, 'referencia.png');
    const canvas = createCanvas(1800, 220);
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#111';
    context.font = '64px Arial';
    context.textBaseline = 'top';
    context.fillText(expected, 36, 48);
    await fs.writeFile(imagePath, canvas.toBuffer('image/png'));
    await fs.writeFile(path.join(root, 'corrompida.png'), 'arquivo não é PNG', 'utf8');
    await fs.writeFile(path.join(root, 'manifesto.csv'), [
      'arquivo,texto,paper_type,defeito',
      `referencia.png,"${multilineReference}",synthetic,limpo`,
      'corrompida.png,"texto de referência indisponível",synthetic,corrompido'
    ].join('\n'), 'utf8');

    const reportPath = path.join(root, 'relatorio.md');
    const result = await runCorpusAssessment(root, reportPath);
    const report = await fs.readFile(reportPath, 'utf8');
    assert.equal(result.inputs, 2);
    assert.equal(result.outputs, 1);
    assert.equal(result.failures, 1, 'A falha de um item deve ser isolada no cálculo de qualidade do restante do corpus.');
    assert.match(report, /amostras sequenciais: 1; CER: 0\.00%; WER: 0\.00%/);
    assert.doesNotMatch(report, /Ação válida|12\.345\.678/, 'O relatório não pode reproduzir conteúdo reconhecido ou de referência.');
    console.log('OCR reference-corpus integration passed: generated labeled image, searchable output, aggregate CER/WER, no text leakage.');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
