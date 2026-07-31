const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const crypto = require('crypto');
const { parentPort, workerData } = require('worker_threads');
const pdfService = require('./pdf-service');
const { sanitizeFilename } = require('./utils');
const { runImageToPdfConversion, buildImageToPdfOutputPath } = require('./services/image-conversion/conversion-worker');
const { runSignatureOperation } = require('./services/signature/signature-worker');
const { runPdfToWordConversion } = require('./services/conversion/conversion-worker');

let cancelled = false;
let cancelReason = 'cancelled';

if (parentPort) {
  parentPort.on('message', (message) => {
    if (message.type === 'cancel') {
      cancelled = true;
      cancelReason = message.reason || 'cancelled';
    }
  });
}

function isCancelled() {
  return cancelled;
}

function post(type, payload) {
  if (parentPort) {
    parentPort.postMessage({ type, payload });
  }
}

function buildOutputPath(type, files, options, outputDir) {
  if (type === 'merge' || type === 'files-to-pdf') {
    return path.join(outputDir, sanitizeFilename(options.outputName || 'merged.pdf'));
  }
  if (type === 'split-range') {
    return path.join(outputDir, sanitizeFilename(options.outputName || 'extracao.pdf'));
  }
  if (type === 'organize') {
    return path.join(outputDir, sanitizeFilename(options.outputName || 'organizado.pdf'));
  }
  if (type === 'compress') {
    const inputExt = path.extname(files[0] || '').toLowerCase();
    const baseName = path.parse(files[0] || 'arquivo').name || 'arquivo';
    const normalizedExt = /\.(png|jpe?g)$/i.test(inputExt)
      ? (inputExt === '.jpeg' ? '.jpg' : inputExt)
      : '.pdf';
    const defaultName = /\.(png|jpe?g)$/i.test(inputExt)
      ? `${baseName}_reduzido${inputExt === '.jpeg' ? '.jpg' : inputExt}`
      : 'reduzido.pdf';
    const requestedName = sanitizeFilename(options.outputName || defaultName);
    const finalName = /\.[a-z0-9]+$/i.test(requestedName) ? requestedName : `${requestedName}${normalizedExt}`;
    return path.join(outputDir, finalName);
  }
  if (type === 'images-to-pdf') {
    return buildImageToPdfOutputPath(files, options, outputDir);
  }
  if (type === 'protect') {
    return path.join(outputDir, sanitizeFilename(options.outputName || `${path.parse(files[0] || 'documento').name}_protegido.pdf`));
  }
  if (type === 'unlock') {
    return path.join(outputDir, sanitizeFilename(options.outputName || `${path.parse(files[0] || 'documento').name}_desbloqueado.pdf`));
  }
  if (type === 'redact') {
    return path.join(outputDir, sanitizeFilename(options.outputName || `${path.parse(files[0] || 'documento').name}_redigido.pdf`));
  }
  return '';
}

async function executeOperation() {
  const { type, files, options, outputDir } = workerData;
  const fileName = path.basename(files[0] || '');
  const startTime = Date.now();
  const progress = (payload) => {
    post('progress', {
      ...payload,
      memoryMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
      elapsedMs: Date.now() - startTime
    });
  };

  if (type === 'merge' || type === 'files-to-pdf') {
    const outPath = buildOutputPath(type, files, options, outputDir);
    progress({ progress: 8, currentItem: 1, totalItems: 1, currentItemName: fileName, itemProgress: 8 });
    await pdfService.mergePdfs(files, outPath, options, isCancelled, progress);
    return { outputPath: outPath };
  }

  if (type === 'split-pages') {
    progress({ progress: 8, currentItem: 1, totalItems: 1, currentItemName: fileName, itemProgress: 8 });
    const createdFiles = await pdfService.splitPdfByPages(files[0], outputDir, sanitizeFilename(options.prefix || 'separado'), isCancelled);
    return { outputDir, firstOutputPath: createdFiles[0] || '', outputCount: createdFiles.length, createdFiles };
  }

  if (type === 'split-range') {
    const outPath = buildOutputPath(type, files, options, outputDir);
    progress({ progress: 8, currentItem: 1, totalItems: 1, currentItemName: fileName, itemProgress: 8 });
    await pdfService.splitPdfByRanges(files[0], options.rangeStr, outPath, isCancelled);
    return { outputPath: outPath };
  }

  if (type === 'split-size') {
    progress({ progress: 8, currentItem: 1, totalItems: 1, currentItemName: fileName, itemProgress: 8 });
    const createdFiles = await pdfService.splitPdfBySize(
      files[0],
      outputDir,
      parseInt(options.maxSizeBytes, 10),
      sanitizeFilename(options.prefix || 'parte'),
      isCancelled,
      progress
    );
    return { outputDir, firstOutputPath: createdFiles[0] || '', outputCount: createdFiles.length, createdFiles };
  }

  if (type === 'organize') {
    const outPath = buildOutputPath(type, files, options, outputDir);
    progress({ progress: 10, currentItem: 1, totalItems: 1, currentItemName: fileName, itemProgress: 10 });
    await pdfService.organizePdf(files, options.pageActions, outPath, options, isCancelled, progress);
    return { outputPath: outPath };
  }

  if (type === 'compress') {
    const outPath = buildOutputPath(type, files, options, outputDir);
    progress({ progress: 8, currentItem: 1, totalItems: 1, currentItemName: fileName, itemProgress: 8 });
    const isImage = /\.(png|jpe?g)$/i.test(files[0] || '');
    const reduction = isImage
      ? await pdfService.compressImage(files[0], outPath, isCancelled, progress)
      : await pdfService.compressPdf(files[0], outPath, isCancelled, progress);
    return { outputPath: outPath, reduction };
  }

  if (type === 'protect') {
    const outPath = buildOutputPath(type, files, options, outputDir);
    progress({ progress: 10, currentItem: 1, totalItems: 1, currentItemName: fileName, itemProgress: 10 });
    await pdfService.encryptPdf(files[0], outPath, options.password, options, isCancelled);
    return { outputPath: outPath };
  }

  if (type === 'unlock') {
    const outPath = buildOutputPath(type, files, options, outputDir);
    progress({ progress: 10, currentItem: 1, totalItems: 1, currentItemName: fileName, itemProgress: 10 });
    await pdfService.decryptPdf(files[0], outPath, options.password, isCancelled);
    return { outputPath: outPath };
  }

  if (type === 'redact') {
    const outPath = buildOutputPath(type, files, options, outputDir);
    progress({ progress: 10, currentItem: 1, totalItems: 1, currentItemName: fileName, itemProgress: 10 });
    await pdfService.redactPdf(files[0], outPath, options, isCancelled, progress);
    return { outputPath: outPath };
  }

  if (type === 'images-to-pdf') {
    return runImageToPdfConversion({ type, files, options, outputDir }, progress, isCancelled);
  }

  if (type === 'sign') {
    return runSignatureOperation({ files, options, outputDir }, progress, isCancelled);
  }

  if (type === 'pdf-to-word') {
    return runPdfToWordConversion({ files, options, outputDir }, progress, isCancelled);
  }

  const batchResult = await pdfService.applyWatermarkBatch(files, outputDir, options, progress, isCancelled);
  return {
    outputDir,
    firstOutputPath: batchResult.createdFiles[0] || '',
    outputCount: batchResult.createdFiles.length,
    createdFiles: batchResult.createdFiles,
    warnings: batchResult.warnings || []
  };
}

async function cleanupTempPaths(paths = []) {
  for (const targetPath of paths) {
    if (typeof targetPath !== 'string' || !targetPath.trim()) continue;
    try {
      if (fs.existsSync(targetPath)) {
        fs.rmSync(targetPath, { force: true });
      }
    } catch (error) {
      // Best effort cleanup only.
    }
  }
}

function zipFiles(files, zipPath, outputDir) {
  return new Promise((resolve, reject) => {
    try {
      const tempZipDir = path.join(outputDir, `.tmp_zip_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`);
      fs.mkdirSync(tempZipDir, { recursive: true });

      // Move files to temp zip dir
      for (const file of files) {
        if (fs.existsSync(file)) {
          const dest = path.join(tempZipDir, path.basename(file));
          fs.renameSync(file, dest);
        }
      }

      const sourceWildcard = path.join(tempZipDir, '*');
      const sourceWildcardEscaped = sourceWildcard.replace(/'/g, "''");
      const zipPathEscaped = zipPath.replace(/'/g, "''");

      const args = [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Compress-Archive -Path '${sourceWildcardEscaped}' -DestinationPath '${zipPathEscaped}' -Force`
      ];

      execFile('powershell.exe', args, (error, stdout, stderr) => {
        // Clean up the temporary folder in any case
        try {
          fs.rmSync(tempZipDir, { recursive: true, force: true });
        } catch (rmError) {
          console.error('Failed to clean up temp zip dir:', rmError);
        }

        if (error) {
          reject(new Error(`Erro ao compactar arquivos: ${stderr || error.message}`));
        } else {
          resolve();
        }
      });
    } catch (err) {
      reject(err);
    }
  });
}

(async () => {
  const cleanupPaths = Array.isArray(workerData.options.cleanupPaths)
    ? workerData.options.cleanupPaths
    : [];
  try {
    let result = await executeOperation();
    if (cancelled) {
      throw new Error(cancelReason === 'timeout' ? 'OPERATION_TIMEOUT' : 'OPERATION_CANCELLED');
    }

    const { type, files, options, outputDir } = workerData;
    if (options && options.zipResults) {
      let filesToZip = [];
      let zipPath = '';

      if (result.outputPath) {
        filesToZip = [result.outputPath];
        zipPath = result.outputPath.replace(/\.[a-zA-Z0-9]+$/, '') + '.zip';
      } else if (result.createdFiles && Array.isArray(result.createdFiles)) {
        filesToZip = result.createdFiles;
        if (type === 'watermark') {
          zipPath = path.join(outputDir, 'marca_dagua.zip');
        } else {
          // split-pages or split-size
          const prefix = sanitizeFilename(options.prefix || (type === 'split-pages' ? 'separado' : 'parte'));
          zipPath = path.join(outputDir, `${prefix}.zip`);
        }
      }

      if (filesToZip.length > 0 && zipPath) {
        await zipFiles(filesToZip, zipPath, outputDir);
        const newResult = { outputPath: zipPath };
        if (result.reduction !== undefined) {
          newResult.reduction = result.reduction;
        }
        if (Array.isArray(result.warnings) && result.warnings.length > 0) {
          newResult.warnings = result.warnings;
        }
        result = newResult;
      }
    }

    post('result', {
      ...result,
      memoryMb: Math.round(process.memoryUsage().rss / (1024 * 1024))
    });
  } catch (error) {
    post('error', {
      message: error.message || String(error),
      stack: error.stack || ''
    });
  } finally {
    await cleanupTempPaths(cleanupPaths);
  }
})();
