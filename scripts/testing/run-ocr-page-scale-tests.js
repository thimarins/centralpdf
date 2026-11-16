const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { createCanvas } = require('@napi-rs/canvas');
const { PDFDocument } = require('pdf-lib');
const { createPdfWorkerExecution } = require('../../src/main/worker-runtime');
const { extractStructuredText } = require('../../src/main/services/conversion/text-extractor');
const { createTempDir, writeReport } = require('./_common');

async function main() {
  const workspace = createTempDir('ocr-scanned-page-scale');
  try {
    const requestedPageCount = Number(process.env.CENTRAL_PDF_OCR_SCALE_PAGES || 100);
    assert.ok(Number.isInteger(requestedPageCount) && requestedPageCount >= 1 && requestedPageCount <= 1000,
      'CENTRAL_PDF_OCR_SCALE_PAGES deve ser um inteiro entre 1 e 1.000.');
    const pageCount = requestedPageCount;
    const requiredMilestones = [1, 10, 50, 100, 500, pageCount]
      .filter((page, index, pages) => page <= pageCount && pages.indexOf(page) === index)
      .sort((left, right) => left - right);
    const canvas = createCanvas(1000, 260);
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#111';
    context.font = '48px Arial';
    context.textBaseline = 'middle';

    const source = await PDFDocument.create();
    const pageImages = [];
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#111';
      context.fillText(`SCANNED PAGE ${String(pageNumber).padStart(3, '0')}`, 42, canvas.height / 2);
      pageImages.push(await source.embedPng(canvas.toBuffer('image/png')));
    }
    for (const image of pageImages) {
      const page = source.addPage([canvas.width, canvas.height]);
      page.drawImage(image, { x: 0, y: 0, width: canvas.width, height: canvas.height });
    }

    const inputPath = path.join(workspace, `scanned-${pageCount}-pages.pdf`);
    fs.writeFileSync(inputPath, await source.save({ useObjectStreams: true }));
    const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(inputPath)).digest('hex');
    const outputDir = path.join(workspace, 'output');
    const milestones = new Set();
    let peakWorkerMemoryMb = 0;
    let lastProgress = null;
    const startedAt = Date.now();
    process.env.CENTRAL_PDF_OCR_TEST_DIAGNOSTICS = '1';
    const execution = createPdfWorkerExecution({
      type: 'ocr',
      files: [inputPath],
      options: { language: 'eng', mode: 'auto', format: 'pdf', zipResults: false, outputName: `scanned-${pageCount}-pages-searchable.pdf` },
      outputDir
    }, (progress) => {
      lastProgress = { page: Number(progress.page) || 0, status: String(progress.status || ''), memoryMb: Number(progress.memoryMb) || 0 };
      const page = Number(progress.page);
      if (requiredMilestones.includes(page)) milestones.add(page);
      peakWorkerMemoryMb = Math.max(peakWorkerMemoryMb, Number(progress.memoryMb) || 0);
    });
    let result;
    try {
      result = await execution.promise;
    } catch (error) {
      const failureSourceHash = fs.existsSync(inputPath)
        ? crypto.createHash('sha256').update(fs.readFileSync(inputPath)).digest('hex')
        : 'arquivo ausente';
      throw new Error(`OCR de ${pageCount} páginas falhou. Último progresso: ${JSON.stringify(lastProgress)}. Origem preservada: ${failureSourceHash === sourceHash}. ${error.message}`, { cause: error });
    } finally {
      delete process.env.CENTRAL_PDF_OCR_TEST_DIAGNOSTICS;
    }
    const elapsedMs = Date.now() - startedAt;

    assert.strictEqual(result.pageResults?.length, pageCount, 'O resumo OCR deve informar todas as páginas de entrada.');
    assert.strictEqual(result.recognizedPages, pageCount, 'O fixture digitalizado deve ser reconhecido página a página.');
    assert.deepStrictEqual([...milestones].sort((left, right) => left - right), requiredMilestones, 'O processamento não reportou todos os marcos incrementais esperados.');
    const outputPath = result.firstOutputPath || result.outputPath;
    assert.ok(outputPath && fs.existsSync(outputPath), 'O OCR deve gerar um PDF final.');
    assert.notStrictEqual(path.resolve(outputPath), path.resolve(inputPath), 'A saída não pode substituir o PDF de origem.');
    assert.strictEqual(
      crypto.createHash('sha256').update(fs.readFileSync(inputPath)).digest('hex'),
      sourceHash,
      'O OCR não pode alterar os bytes do PDF original.'
    );
    const extracted = await extractStructuredText(outputPath);
    assert.strictEqual(extracted.pages.length, pageCount, 'O PDF final deve manter todas as páginas.');
    const samplePages = [...new Set([1, 10, 25, 50, 100, 250, 500, pageCount].filter((page) => page <= pageCount))];
    for (const pageNumber of samplePages) {
      const text = extracted.pages[pageNumber - 1]?.text || '';
      assert.match(text, new RegExp(`SCANNED PAGE ${String(pageNumber).padStart(3, '0')}`, 'i'), `A página ${pageNumber} deve conter texto OCR pesquisável correspondente.`);
    }

    const reportPath = writeReport('ocr-page-scale-report.md', [
      '# OCR scanned-page scale test',
      '',
      `Result: passed (${pageCount}/${pageCount} scanned pages recognized).`,
      `Elapsed: ${elapsedMs} ms (local synthetic fixture; not a performance target).`,
      `Peak worker memory reported: ${peakWorkerMemoryMb || 'unavailable'} MB.`,
      `Progress milestones observed: ${requiredMilestones.join(', ')}.`,
      `Output PDF page count and searchable text at pages ${samplePages.join(', ')} verified.`,
      'Original PDF was retained; output created separately.'
    ]);
    console.log(`OCR scanned-page scale passed: ${pageCount}/${pageCount}; ${elapsedMs} ms; peak worker RSS ${peakWorkerMemoryMb || 'n/a'} MB; report: ${reportPath}`);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
