const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { createCanvas } = require('@napi-rs/canvas');
const { createPdfWorkerExecution } = require('../../src/main/worker-runtime');
const { extractStructuredText } = require('../../src/main/services/conversion/text-extractor');
const { createTempDir, writeReport } = require('./_common');

async function main() {
  const workspace = createTempDir('ocr-file-batch-scale');
  try {
    const fileCount = Number(process.env.CENTRAL_PDF_OCR_BATCH_FILES || 100);
    assert.ok(Number.isInteger(fileCount) && fileCount >= 1 && fileCount <= 500,
      'CENTRAL_PDF_OCR_BATCH_FILES deve ser um inteiro entre 1 e 500.');

    const inputDir = path.join(workspace, 'inputs');
    const outputDir = path.join(workspace, 'outputs');
    fs.mkdirSync(inputDir, { recursive: true });
    fs.mkdirSync(outputDir, { recursive: true });
    const canvas = createCanvas(1100, 300);
    const context = canvas.getContext('2d');
    const expected = new Map();
    const originalHashes = new Map();
    const inputs = [];

    for (let index = 1; index <= fileCount; index += 1) {
      const phrase = `OCR BATCH DOCUMENT ${String(index).padStart(3, '0')} VERIFIED`;
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#111';
      context.font = '52px Arial';
      context.textBaseline = 'middle';
      context.fillText(phrase, 35, canvas.height / 2);
      const filePath = path.join(inputDir, `batch-${String(index).padStart(3, '0')}.png`);
      fs.writeFileSync(filePath, canvas.toBuffer('image/png'));
      inputs.push(filePath);
      expected.set(path.basename(filePath), phrase);
      originalHashes.set(filePath, crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'));
    }

    const invalidPath = path.join(inputDir, 'batch-invalid-midpoint.png');
    fs.writeFileSync(invalidPath, Buffer.from('not a valid image; isolate this OCR batch item'));
    originalHashes.set(invalidPath, crypto.createHash('sha256').update(fs.readFileSync(invalidPath)).digest('hex'));
    inputs.splice(Math.floor(inputs.length / 2), 0, invalidPath);

    let peakWorkerMemoryMb = 0;
    let lastProgress = null;
    const startedAt = Date.now();
    const execution = createPdfWorkerExecution({
      type: 'ocr',
      files: inputs,
      options: { language: 'eng', mode: 'auto', format: 'pdf', zipResults: false },
      outputDir
    }, (progress) => {
      lastProgress = {
        currentItem: Number(progress.currentItem) || 0,
        totalItems: Number(progress.totalItems) || 0,
        status: String(progress.status || ''),
        memoryMb: Number(progress.memoryMb) || 0
      };
      peakWorkerMemoryMb = Math.max(peakWorkerMemoryMb, lastProgress.memoryMb);
    });

    let result;
    try {
      result = await execution.promise;
    } catch (error) {
      throw new Error(`OCR em lote de ${fileCount} imagens falhou. Último progresso: ${JSON.stringify(lastProgress)}. ${error.message}`, { cause: error });
    }
    const elapsedMs = Date.now() - startedAt;

    assert.equal(result.outputCount, fileCount, 'Cada imagem válida deve gerar um PDF pesquisável.');
    assert.equal(result.recognizedPages, fileCount, 'Cada arquivo válido deve executar OCR em uma página.');
    assert.equal(result.failures.length, 1, 'A entrada inválida deve ser isolada sem interromper o lote.');
    assert.equal(result.failures[0].fileName, path.basename(invalidPath), 'A falha deve identificar o item inválido.');
    assert.equal(result.createdFiles.length, fileCount);
    assert.equal(new Set(result.createdFiles.map((filePath) => path.resolve(filePath))).size, fileCount,
      'Cada item deve produzir uma saída distinta.');

    const outputByName = new Map(result.createdFiles.map((filePath) => [path.basename(filePath).replace(/_pesquisavel\.pdf$/i, '.png'), filePath]));
    for (const [inputName, phrase] of expected) {
      const outputPath = outputByName.get(inputName);
      assert.ok(outputPath && fs.existsSync(outputPath), `Saída ausente para ${inputName}.`);
      const extracted = await extractStructuredText(outputPath);
      assert.equal(extracted.pageCount, 1, `A saída de ${inputName} deve conter uma página.`);
      assert.match(extracted.pages[0].text, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
        `A saída de ${inputName} deve conter a frase OCR correta.`);
    }

    for (const [filePath, expectedHash] of originalHashes) {
      assert.equal(crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'), expectedHash,
        `O OCR alterou a origem ${path.basename(filePath)}.`);
    }

    const reportPath = writeReport('ocr-file-batch-scale-report.md', [
      '# OCR multi-file batch scale test', '',
      `Result: passed (${fileCount}/${fileCount} valid image files produced searchable PDFs; 1 invalid item isolated).`,
      `Elapsed: ${elapsedMs} ms (local synthetic fixture; not a performance target).`,
      `Peak worker memory reported: ${peakWorkerMemoryMb || 'unavailable'} MB.`,
      `Progress reached ${lastProgress?.totalItems || inputs.length} input items; all ${fileCount} output texts verified.`,
      'SHA-256 of every original input was preserved; one failed item did not stop later files.'
    ]);
    console.log(`OCR multi-file batch scale passed: ${fileCount} outputs; 1 isolated failure; ${elapsedMs} ms; peak worker RSS ${peakWorkerMemoryMb || 'n/a'} MB; report: ${reportPath}`);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
