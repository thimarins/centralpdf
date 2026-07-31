const path = require('path');
const { applySimpleSignature, buildSignatureOutputPath, normalizeSignatureOptions } = require('./signature-service');

async function runSignatureOperation({ files, options, outputDir }, progress, isCancelled) {
  const normalizedOptions = normalizeSignatureOptions(options);
  const outputPath = buildSignatureOutputPath(files[0], outputDir, normalizedOptions.outputName, normalizedOptions.outputSuffix);
  progress({ progress: 6, itemProgress: 6, currentItem: 1, totalItems: 1, currentItemName: path.basename(files[0]) });
  await applySimpleSignature(files[0], outputPath, normalizedOptions, isCancelled, progress);
  return { outputPath };
}

module.exports = {
  runSignatureOperation
};
