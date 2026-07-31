const path = require('path');
const { inspectImageFile, IMAGE_LIMITS } = require('../../utils');

const SUPPORTED_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png']);

const IMAGE_TO_PDF_LIMITS = {
  warningImageCount: 24,
  heavyImageCount: 60,
  warningTotalBytes: 150 * 1024 * 1024,
  heavyTotalBytes: 400 * 1024 * 1024
};

function inspectConvertibleImage(filePath) {
  const inspection = inspectImageFile(filePath, IMAGE_LIMITS.maxImageBytes);
  const extension = path.extname(filePath || '').toLowerCase();
  const extensionSupported = SUPPORTED_IMAGE_EXTENSIONS.has(extension);

  return {
    ...inspection,
    extension,
    extensionSupported,
    ok: Boolean(inspection.ok && extensionSupported)
  };
}

function validateImageFiles(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('Nenhuma imagem foi informada.');
  }

  const inspections = files.map((filePath) => inspectConvertibleImage(filePath));
  const invalid = inspections.find((inspection) => !inspection.ok);
  if (invalid) {
    throw new Error(`Imagem inválida, corrompida ou não suportada: ${path.basename(invalid.filePath || '')}`);
  }

  return inspections;
}

function getImageBatchWarnings(files, memorySoftLimitMb = 1024) {
  const inspections = files.map((filePath) => inspectConvertibleImage(filePath));
  const totalBytes = inspections.reduce((sum, inspection) => sum + (inspection.size || 0), 0);
  const warnings = [];

  if (inspections.length >= IMAGE_TO_PDF_LIMITS.heavyImageCount || totalBytes >= IMAGE_TO_PDF_LIMITS.heavyTotalBytes) {
    warnings.push('Grande quantidade de imagens detectada. Ativando modo otimizado para manter estabilidade.');
  } else if (inspections.length >= IMAGE_TO_PDF_LIMITS.warningImageCount || totalBytes >= IMAGE_TO_PDF_LIMITS.warningTotalBytes) {
    warnings.push('Lote de imagens moderado detectado. Pré-visualizações podem ser reduzidas para preservar fluidez.');
  }

  if (inspections.some((inspection) => (inspection.dimensions.width || 0) * (inspection.dimensions.height || 0) >= IMAGE_LIMITS.maxRasterPixels * 0.75)) {
    warnings.push('Imagens muito grandes detectadas. O PDF será gerado com ajuste proporcional e processamento mais conservador.');
  }

  if (memorySoftLimitMb <= 768 && inspections.length >= 12) {
    warnings.push('Memória disponível mais apertada detectada. O modo otimizado ajudará a manter estabilidade.');
  }

  return warnings;
}

module.exports = {
  SUPPORTED_IMAGE_EXTENSIONS,
  IMAGE_TO_PDF_LIMITS,
  inspectConvertibleImage,
  validateImageFiles,
  getImageBatchWarnings
};
