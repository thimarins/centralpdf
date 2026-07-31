const path = require('path');
const { convertPdfToWord } = require('./pdf-to-word');

async function runPdfToWordConversion({ files, options, outputDir }, progress, isCancelled) {
  progress({ progress: 5, itemProgress: 5, currentItem: 1, totalItems: 1, currentItemName: path.basename(files[0]) });
  return convertPdfToWord(files[0], outputDir, options, progress, isCancelled);
}

module.exports = {
  runPdfToWordConversion
};
