const fs = require('fs');
const path = require('path');
const { inspectPdfFile, sanitizeFilename, PDF_LIMITS, resolveUniqueOutputPath } = require('../../utils');
const { extractStructuredText } = require('./text-extractor');
const { buildDocxBuffer } = require('./docx-builder');
const { recognizePdf } = require('../ocr/ocr-service');

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
  return resolveUniqueOutputPath(path.join(outputDir, `${baseName}${extension}`));
}

async function convertPdfToWord(inputPath, outputDir, options = {}, progress = () => {}, isCancelled = () => false) {
  const inspection = inspectPdfFile(inputPath, PDF_LIMITS.maxSupportedBytes);
  if (!inspection.ok) {
    throw new Error(`PDF inválido para conversão: ${path.basename(inputPath)}`);
  }

  const format = options.format === 'text' ? 'text' : 'docx';
  let extraction;
  let usedOcr = false;
  if (options.useOcr) {
    progress({ progress: 8, itemProgress: 8, currentItem: 1, totalItems: 1, currentItemName: 'Reconhecendo páginas digitalizadas' });
    const ocrResult = await recognizePdf(inputPath, {
      language: options.ocrLanguage || 'por+eng',
      mode: 'auto'
    }, (item) => progress({ ...item, progress: Math.min(75, 8 + Math.round((item.progress || 0) * 0.67)), currentItem: 1, totalItems: 1, currentItemName: 'Reconhecendo páginas digitalizadas' }), isCancelled);
    usedOcr = ocrResult.recognizedPages > 0;
    // Automatic OCR intentionally avoids serializing PDFs that are already
    // searchable. In that case recognizePdf returns `copyOriginal` without a
    // byte buffer; extract from the validated source path instead.
    const extractionSource = ocrResult.copyOriginal ? inputPath : ocrResult.pdfBytes;
    extraction = await extractStructuredText(extractionSource, (item) => progress({
      ...item,
      progress: Math.min(94, 75 + Math.round((item.progress || 0) * 0.2)),
      currentItem: 1,
      totalItems: 1,
      currentItemName: path.basename(inputPath)
    }), isCancelled);
  } else {
    extraction = await extractStructuredText(inputPath, progress, isCancelled);
  }
  if (!extraction.totalTextLength) {
    throw new Error('Não encontramos camada textual neste PDF. Documentos escaneados podem não converter corretamente sem OCR.');
  }

  const outputPath = buildOutputPath(inputPath, outputDir, options.outputName, format);
  const buffer = format === 'text'
    ? Buffer.from(extraction.pages.map((page) => page.text).filter(Boolean).join('\n\n'), 'utf8')
    : await buildDocxBuffer(extraction, path.basename(inputPath), { usedOcr });

  if (isCancelled()) throw new Error('OPERATION_CANCELLED');
  await writeAtomically(buffer, outputPath);
  progress({ progress: 100, itemProgress: 100, currentItem: 1, totalItems: 1, currentItemName: path.basename(inputPath) });
  return { outputPath, pageCount: extraction.pageCount, extractedCharacters: extraction.totalTextLength, format, usedOcr };
}

module.exports = {
  convertPdfToWord
};
