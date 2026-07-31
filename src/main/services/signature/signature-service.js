const path = require('path');
const { PDFDocument } = require('pdf-lib');
const pdfService = require('../../pdf-service');
const { sanitizeFilename, inspectPdfFile, PDF_LIMITS, resolveUniqueOutputPath } = require('../../utils');
const { normalizeSignatureOptions } = require('./field-manager');
const { embedFont, embedSealImage, embedDrawnSignature, drawTextField, drawImageField } = require('./signature-renderer');

async function applySimpleSignature(inputPath, outputPath, rawOptions, isCancelled = () => false, updateProgress = () => {}) {
  const inspection = inspectPdfFile(inputPath, PDF_LIMITS.maxSupportedBytes);
  if (!inspection.ok) {
    throw new Error(`PDF inválido para assinatura: ${path.basename(inputPath)}`);
  }

  const options = normalizeSignatureOptions(rawOptions);
  const pdfBuffer = await pdfService.__internal.readPdfBuffer(inputPath, isCancelled);
  const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  const pages = pdfDoc.getPages();

  const embeddedFonts = new Map();
  const embeddedImages = new Map();

  for (let index = 0; index < options.fields.length; index += 1) {
    const field = options.fields[index];
    if (!pages[field.pageIndex]) {
      throw new Error(`O campo ${index + 1} referencia uma página inexistente.`);
    }
  }

  for (let index = 0; index < options.fields.length; index += 1) {
    pdfService.__internal.ensureNotCancelled(isCancelled);
    const field = options.fields[index];
    const page = pages[field.pageIndex];

    if (field.type === 'seal') {
      const imageCacheKey = field.imagePath || field.imageDataUrl || field.id;
      if (!embeddedImages.has(imageCacheKey)) {
        if (field.imagePath) {
          embeddedImages.set(imageCacheKey, await embedSealImage(pdfDoc, field.imagePath));
        } else {
          embeddedImages.set(imageCacheKey, await embedDrawnSignature(pdfDoc, field.imageDataUrl));
        }
      }
      drawImageField(page, embeddedImages.get(imageCacheKey), field);
    } else if (field.imageDataUrl) {
      if (!embeddedImages.has(field.id)) {
        embeddedImages.set(field.id, await embedDrawnSignature(pdfDoc, field.imageDataUrl));
      }
      drawImageField(page, embeddedImages.get(field.id), field);
    } else {
      if (!embeddedFonts.has(field.fontFamily)) {
        embeddedFonts.set(field.fontFamily, await embedFont(pdfDoc, field.fontFamily));
      }
      drawTextField(page, embeddedFonts.get(field.fontFamily), field);
    }

    updateProgress({
      progress: Math.min(96, Math.round(((index + 1) / options.fields.length) * 96)),
      itemProgress: Math.round(((index + 1) / options.fields.length) * 100),
      currentItem: 1,
      totalItems: 1,
      currentItemName: path.basename(inputPath)
    });
  }

  await pdfService.__internal.saveAndValidatePdf(pdfDoc, outputPath, isCancelled);
  return outputPath;
}

function buildSignatureOutputPath(inputPath, outputDir, outputName, outputSuffix) {
  const parsed = path.parse(inputPath);
  const candidate = outputName
    ? path.join(outputDir, sanitizeFilename(outputName.endsWith('.pdf') ? outputName : `${outputName}.pdf`))
    : path.join(outputDir, `${parsed.name}${sanitizeFilename(outputSuffix || '_assinado').replace(/\.pdf$/i, '')}.pdf`);
  return resolveUniqueOutputPath(candidate);
}

module.exports = {
  applySimpleSignature,
  buildSignatureOutputPath,
  normalizeSignatureOptions
};
