const path = require('path');
const { sanitizeFilename, resolveUniqueOutputPath } = require('../../utils');
const { convertImagesToPdf } = require('./image-to-pdf');

function buildImageToPdfOutputPath(files, options, outputDir) {
  const requestedName = sanitizeFilename(options.outputName || 'imagens.pdf');
  const normalizedName = requestedName.toLowerCase().endsWith('.pdf') ? requestedName : `${requestedName}.pdf`;
  return resolveUniqueOutputPath(path.join(outputDir, normalizedName));
}

async function runImageToPdfConversion(payload, updateProgress, isCancelled) {
  const outPath = buildImageToPdfOutputPath(payload.files, payload.options, payload.outputDir);
  updateProgress({
    progress: 6,
    itemProgress: 0,
    currentItem: 0,
    totalItems: payload.files.length,
    currentItemName: ''
  });
  return convertImagesToPdf(payload.files, outPath, updateProgress, isCancelled);
}

module.exports = {
  runImageToPdfConversion,
  buildImageToPdfOutputPath
};
