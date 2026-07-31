const fs = require('fs');
const path = require('path');
const { inspectPdfFile, sanitizeFilename, PDF_LIMITS } = require('../../utils');
const { extractStructuredText } = require('./text-extractor');
const { buildDocxBuffer } = require('./docx-builder');

async function writeAtomically(buffer, outputPath) {
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  const tempPath = path.join(path.dirname(outputPath), `.${path.basename(outputPath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await fs.promises.writeFile(tempPath, buffer);
    try {
      await fs.promises.rename(tempPath, outputPath);
    } catch (err) {
      if (err && (err.code === 'EEXIST' || err.code === 'EPERM')) {
        await fs.promises.unlink(outputPath).catch(() => {});
        await fs.promises.rename(tempPath, outputPath);
      } else {
        throw err;
      }
    }
  } catch (error) {
    await fs.promises.unlink(tempPath).catch(() => {});
    throw error;
  }
}

function buildOutputPath(inputPath, outputDir, outputName, format) {
  const parsed = path.parse(inputPath);
  const extension = format === 'text' ? '.txt' : '.docx';
  const baseName = outputName ? sanitizeFilename(outputName.replace(/\.(docx|txt)$/i, '')) : `${parsed.name}_convertido`;
  let candidate = path.join(outputDir, `${baseName}${extension}`);
  let counter = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(outputDir, `${baseName}_${counter}${extension}`);
    counter += 1;
  }
  return candidate;
}

async function convertPdfToWord(inputPath, outputDir, options = {}, progress = () => {}, isCancelled = () => false) {
  const inspection = inspectPdfFile(inputPath, PDF_LIMITS.maxSupportedBytes);
  if (!inspection.ok) {
    throw new Error(`PDF inválido para conversão: ${path.basename(inputPath)}`);
  }

  const format = options.format === 'text' ? 'text' : 'docx';
  const extraction = await extractStructuredText(inputPath, progress, isCancelled);
  if (!extraction.totalTextLength) {
    throw new Error('Não encontramos camada textual neste PDF. Documentos escaneados podem não converter corretamente sem OCR.');
  }

  const outputPath = buildOutputPath(inputPath, outputDir, options.outputName, format);
  const buffer = format === 'text'
    ? Buffer.from(extraction.pages.map((page) => page.text).filter(Boolean).join('\n\n'), 'utf8')
    : await buildDocxBuffer(extraction, path.basename(inputPath));

  if (isCancelled()) throw new Error('OPERATION_CANCELLED');
  await writeAtomically(buffer, outputPath);
  progress({ progress: 100, itemProgress: 100, currentItem: 1, totalItems: 1, currentItemName: path.basename(inputPath) });
  return { outputPath, pageCount: extraction.pageCount, extractedCharacters: extraction.totalTextLength, format };
}

module.exports = {
  convertPdfToWord
};
