const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const crypto = require('crypto');
const os = require('os');
const canvasRuntime = require('@napi-rs/canvas');
const { parentPort: threadParentPort, workerData: threadWorkerData } = require('worker_threads');
const utilityParentPort = process.parentPort;
const parentPort = threadParentPort || (utilityParentPort ? {
  on: (_event, listener) => utilityParentPort.on('message', (event) => listener(event.data)),
  postMessage: (message) => utilityParentPort.postMessage(message),
  close: () => {
    if (typeof utilityParentPort.close === 'function') utilityParentPort.close();
    else process.exit(0);
  }
} : null);
let workerData = threadWorkerData || null;
const pdfService = require('./pdf-service');
const { sanitizeFilename, resolveUniqueOutputPath } = require('./utils');
const { runImageToPdfConversion, buildImageToPdfOutputPath } = require('./services/image-conversion/conversion-worker');
const { convertImagesToPdf } = require('./services/image-conversion/image-to-pdf');
const { runSignatureOperation } = require('./services/signature/signature-worker');
const { runPdfToWordConversion } = require('./services/conversion/conversion-worker');
const { recognizePdf, recognizeImage, createOcrWorkerSession, writeOcrOutput, findOcrRedactionCandidates, recognizePdfArea, searchPdfDocument, suggestPdfSplitStarts, analyzePdfOcrNeed } = require('./services/ocr/ocr-service');
const { createLowConfidenceWarnings } = require('./services/ocr/ocr-result-summary');
const { createOcrProgressUpdate } = require('./services/ocr/ocr-progress');
const { getSafeFailureCode } = require('./document-privacy');
const { sanitizeManagedTempPaths } = require('./managed-temp-paths');

let cancelled = false;
let cancelReason = 'cancelled';
const workerOwnedTempPaths = [];
let operationStarted = false;

globalThis.DOMMatrix ||= canvasRuntime.DOMMatrix;
globalThis.ImageData ||= canvasRuntime.ImageData;
globalThis.Path2D ||= canvasRuntime.Path2D;

if (parentPort) {
  parentPort.on('message', (message) => {
    if (message.type === 'cancel') {
      cancelled = true;
      cancelReason = message.reason || 'cancelled';
    }
    if (message.type === 'start' && message.payload && !operationStarted) {
      workerData = message.payload;
      runOperation();
    }
  });
}

function isCancelled() {
  return cancelled;
}

const LARGE_MERGE_FILE_THRESHOLD = 50;

function resolveBundledQpdfPath() {
  const candidates = [
    path.join(process.resourcesPath || '', 'qpdf', 'bin', 'qpdf.exe'),
    path.join(__dirname, '..', '..', 'vendor', 'qpdf', 'bin', 'qpdf.exe')
  ];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || '';
}

function shouldUseNativeMerge(files, options = {}) {
  if (options.forcePdfLib || !Array.isArray(files)) return false;
  return files.length >= LARGE_MERGE_FILE_THRESHOLD;
}

async function mergeWithQpdf(inputPaths, outputPath, options = {}, progress = () => {}, cancelled = () => false) {
  const qpdfPath = resolveBundledQpdfPath();
  if (!qpdfPath) return false;

  const tempOutputPath = `${outputPath}.qpdf-${process.pid}-${Date.now()}.tmp`;
  const argumentFilePath = `${outputPath}.qpdf-${process.pid}-${Date.now()}.args`;
  const ranges = Array.isArray(options.ranges) ? options.ranges : [];
  const firstRange = typeof ranges[0] === 'string' ? ranges[0].trim() : '';
  // When the first file is included in full, use it as qpdf's primary input
  // so document-level metadata and viewer preferences have a sensible source.
  // An explicit range on the first file requires --empty to preserve ordering.
  const preservePrimaryDocument = inputPaths.length > 0 && !firstRange;
  const args = preservePrimaryDocument
    ? [inputPaths[0], '--pages', '.']
    : ['--empty', '--pages'];
  const startIndex = preservePrimaryDocument ? 1 : 0;
  inputPaths.slice(startIndex).forEach((inputPath, offset) => {
    const index = startIndex + offset;
    // --file= is required on Windows because a drive letter contains a colon,
    // which qpdf otherwise may parse as part of a page range.
    args.push(`--file=${inputPath}`);
    const range = typeof ranges[index] === 'string' ? ranges[index].trim() : '';
    if (range) args.push(`--range=${range}`);
  });
  args.unshift('--warning-exit-0');
  args.push('--', tempOutputPath);

  // Windows has a relatively small command-line limit. qpdf supports one
  // argument per line through @file, so large batches do not depend on the
  // length of the selected file paths.
  let invocationArgs = args;
  if (args.join(' ').length > 6000) {
    await fs.promises.writeFile(argumentFilePath, `${args.join('\n')}\n`, 'utf8');
    invocationArgs = [`@${argumentFilePath}`];
  }

  progress({ progress: 12, itemProgress: 0, currentItem: 1, totalItems: inputPaths.length, currentItemName: 'Mesclagem otimizada' });

  try {
    await new Promise((resolve, reject) => {
      const child = execFile(qpdfPath, invocationArgs, { windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        clearInterval(cancelTimer);
        if (error) {
          const detail = String(stderr || error.message || '').trim();
          reject(new Error(`A mesclagem otimizada falhou${detail ? `: ${detail}` : '.'}`));
          return;
        }
        resolve();
      });
      const cancelTimer = setInterval(() => {
        if (cancelled()) {
          clearInterval(cancelTimer);
          child.kill();
          reject(new Error('OPERATION_CANCELLED'));
        }
      }, 250);
    });

    if (cancelled()) throw new Error('OPERATION_CANCELLED');
    if (!fs.existsSync(tempOutputPath) || !(await pdfService.validatePdfIntegrity(tempOutputPath))) {
      throw new Error('O qpdf não gerou um PDF válido.');
    }
    await fs.promises.rename(tempOutputPath, outputPath);
    progress({ progress: 95, itemProgress: 100, currentItem: inputPaths.length, totalItems: inputPaths.length, currentItemName: 'Mesclagem otimizada' });
    return true;
  } finally {
    await fs.promises.unlink(argumentFilePath).catch(() => {});
    await fs.promises.unlink(tempOutputPath).catch(() => {});
  }
}

function post(type, payload) {
  if (parentPort) {
    parentPort.postMessage({ type, payload });
  }
}

function buildOutputPathCandidate(type, files, options, outputDir) {
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

function buildOutputPath(type, files, options, outputDir) {
  const candidate = buildOutputPathCandidate(type, files, options, outputDir);
  return candidate ? resolveUniqueOutputPath(candidate) : candidate;
}

async function preparePdfInputs(files, options, progress) {
  const prepared = [];
  const sourceRotations = Array.isArray(options.sourceRotations) ? options.sourceRotations : [];
  const managedTempDir = path.join(os.tmpdir(), 'central-pdf-temp');
  await fs.promises.mkdir(managedTempDir, { recursive: true });

  for (let index = 0; index < files.length; index += 1) {
    const inputPath = files[index];
    if (!/\.(png|jpe?g)$/i.test(inputPath)) {
      prepared.push(inputPath);
      continue;
    }

    const tempPdfPath = path.join(
      managedTempDir,
      `temp-assembled-image-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.pdf`
    );
    await convertImagesToPdf(
      [inputPath],
      tempPdfPath,
      (itemProgress) => progress({
        ...itemProgress,
        progress: Math.min(45, 5 + Math.round(((index + (itemProgress.itemProgress || 0) / 100) / Math.max(1, files.length)) * 40)),
        currentItem: index + 1,
        totalItems: files.length,
        currentItemName: path.basename(inputPath)
      }),
      isCancelled,
      { sourceRotations: [sourceRotations[index] || 0] }
    );
    workerOwnedTempPaths.push(tempPdfPath);
    prepared.push(tempPdfPath);
  }

  return prepared;
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
    const preparedFiles = await preparePdfInputs(files, options, progress);
    const usedNativeMerge = (type === 'merge' || type === 'files-to-pdf') && shouldUseNativeMerge(preparedFiles, options)
      ? await mergeWithQpdf(preparedFiles, outPath, options, progress, isCancelled)
      : false;
    if (!usedNativeMerge) {
      await pdfService.mergePdfs(preparedFiles, outPath, options, isCancelled, progress);
    }
    if ((type === 'files-to-pdf' || type === 'merge') && options.searchableOcr) {
      const ocrResult = await recognizePdf(outPath, { language: options.ocrLanguage || 'por+eng', mode: 'auto' }, (item) => progress({ ...item, currentItemName: 'Criando camada pesquisável' }), isCancelled);
      if (isCancelled()) throw new Error('OPERATION_CANCELLED');
      if (!ocrResult.copyOriginal) {
        const tempPath = `${outPath}.${process.pid}.${crypto.randomUUID()}.ocr.tmp`;
        workerOwnedTempPaths.push(tempPath);
        try {
          await fs.promises.writeFile(tempPath, ocrResult.pdfBytes, { flag: 'wx' });
          if (!await pdfService.validatePdfIntegrity(tempPath)) {
            throw new Error('A camada pesquisável gerada não passou na validação. O PDF mesclado original foi preservado.');
          }
          await fs.promises.rename(tempPath, outPath);
        } catch (error) {
          await fs.promises.unlink(tempPath).catch(() => {});
          throw error;
        }
      }
      return { outputPath: outPath, ocr: {
        recognizedPages: ocrResult.recognizedPages,
        skippedPages: ocrResult.skippedPages,
        copyOriginal: ocrResult.copyOriginal === true
      } };
    }
    return { outputPath: outPath };
  }

  if (type === 'split-pages') {
    progress({ progress: 8, currentItem: 1, totalItems: 1, currentItemName: fileName, itemProgress: 8 });
    const createdFiles = await pdfService.splitPdfByPages(files[0], outputDir, sanitizeFilename(options.prefix || 'separado'), isCancelled);
    return { outputDir, firstOutputPath: createdFiles[0] || '', outputCount: createdFiles.length, createdFiles };
  }

  if (type === 'ocr') {
    const createdFiles = [];
    const pageResults = [];
    const failures = [];
    const workerSession = files.length > 1 ? createOcrWorkerSession(options.language) : null;
    try {
      for (let index = 0; index < files.length; index += 1) {
        if (isCancelled()) throw new Error('OPERATION_CANCELLED');
        const inputPath = files[index];
        const isImage = /\.(png|jpe?g|tiff?)$/i.test(inputPath);
        try {
          const reportProgress = (item) => progress(createOcrProgressUpdate(item, {
            fileIndex: index,
            fileCount: files.length,
            fileName: path.basename(inputPath),
            currentItem: index + 1,
            totalItems: files.length
          }));
          const result = isImage
            ? await recognizeImage(inputPath, options, reportProgress, isCancelled, workerSession)
            : await recognizePdf(inputPath, options, reportProgress, isCancelled, undefined, workerSession);
          const outputPath = await writeOcrOutput(result, inputPath, outputDir, options);
          createdFiles.push(outputPath);
          pageResults.push(...result.pageResults.map((page) => ({
            pageNumber: page.pageNumber,
            status: page.status,
            textLength: page.textLength,
            ...(Number.isFinite(page.orientationCorrectionDegrees) ? { orientationCorrectionDegrees: page.orientationCorrectionDegrees } : {}),
            ...(page.preprocessingApplied ? { preprocessingApplied: true } : {}),
            ...(Number.isFinite(page.confidence) ? { confidence: page.confidence } : {}),
            fileName: path.basename(inputPath)
          })));
        } catch (error) {
          if (isCancelled() || error?.message === 'OPERATION_CANCELLED') throw error;
          try {
            await workerSession?.reset();
          } catch (resetError) {
            throw new Error('O OCR encontrou uma falha e não conseguiu reiniciar o mecanismo com segurança. O restante do lote foi interrompido.', { cause: resetError });
          }
          failures.push({
            fileName: path.basename(inputPath),
            message: typeof error?.safeUserMessage === 'string'
              ? error.safeUserMessage
              : 'Não foi possível reconhecer este arquivo. Verifique se ele ainda pode ser aberto e tente novamente.',
            ...(process.env.CENTRAL_PDF_OCR_TEST_DIAGNOSTICS === '1'
              ? { testDiagnostic: String(error?.testDiagnostic || error?.message || error).slice(0, 400) }
              : {})
          });
        }
      }
    } finally {
      await workerSession?.terminate();
    }
    if (!createdFiles.length && failures.length) {
      const displayedFailures = failures.slice(0, 3).map((failure) => `${failure.fileName}: ${failure.message}`);
      const hiddenFailureCount = failures.length - displayedFailures.length;
      const details = displayedFailures.length
        ? ` Problemas: ${displayedFailures.join(' | ')}${hiddenFailureCount ? ` | e mais ${hiddenFailureCount} arquivo(s) com falha.` : ''}`
        : '';
      const error = new Error(`Nenhum arquivo do lote pôde ser reconhecido. Confira os arquivos e tente novamente.${details}`);
      error.details = failures.map(({ fileName, message, testDiagnostic }) => ({
        fileName,
        message,
        ...(testDiagnostic ? { testDiagnostic } : {})
      }));
      if (process.env.CENTRAL_PDF_OCR_TEST_DIAGNOSTICS === '1' && failures[0]?.testDiagnostic) {
        error.message += ` [diagnóstico do teste: ${failures[0].testDiagnostic}]`;
      }
      throw error;
    }
    const pagesWithoutTextByFile = new Map();
    for (const page of pageResults) {
      if (page.status !== 'no-text') continue;
      const pages = pagesWithoutTextByFile.get(page.fileName) || [];
      pages.push(page.pageNumber);
      pagesWithoutTextByFile.set(page.fileName, pages);
    }
    const failureWarnings = failures.map((item) => `${item.fileName}: ${item.message}`);
    const noTextWarnings = [...pagesWithoutTextByFile.entries()].map(([name, pages]) => {
      const sample = pages.slice(0, 5).join(', ');
      const suffix = pages.length > 5 ? ` e mais ${pages.length - 5}` : '';
      return `Arquivo "${name}": não foi possível reconhecer texto em ${pages.length} página(s)${sample ? ` (páginas ${sample}${suffix})` : ''}. Confira a qualidade da imagem.`;
    });
    const lowConfidenceWarnings = createLowConfidenceWarnings(pageResults);
    const allWarnings = [...failureWarnings, ...noTextWarnings, ...lowConfidenceWarnings];
    const warnings = allWarnings.slice(0, 8);
    if (allWarnings.length > warnings.length) warnings.push(`Há mais ${allWarnings.length - warnings.length} aviso(s) neste lote. Consulte os detalhes da operação.`);
    const confidenceValues = pageResults
      .filter((page) => page.status === 'recognized' && Number.isFinite(page.confidence))
      .map((page) => page.confidence);
    progress({ progress: 100, currentItem: files.length, totalItems: files.length, itemProgress: 100, currentItemName: 'Reconhecimento concluído' });
    return {
      outputDir,
      firstOutputPath: createdFiles[0] || '',
      outputCount: createdFiles.length,
      createdFiles,
      pageResults,
      failures,
      warnings,
      recognizedPages: pageResults.filter((item) => item.status === 'recognized').length,
      skippedPages: pageResults.filter((item) => item.status === 'skipped').length,
      unselectedPages: pageResults.filter((item) => item.status === 'out-of-range').length,
      noTextPages: pagesWithoutTextByFile.size
        ? [...pagesWithoutTextByFile.values()].reduce((total, pages) => total + pages.length, 0)
        : 0,
      averageOcrConfidence: confidenceValues.length
        ? Math.round(confidenceValues.reduce((total, value) => total + value, 0) / confidenceValues.length)
        : null,
      orientationCorrections: pageResults.filter((item) => Number(item.orientationCorrectionDegrees) !== 0).length,
      preprocessingPages: pageResults.filter((item) => item.preprocessingApplied === true).length
    };
  }

  if (type === 'redact-ocr-search') {
    progress({ progress: 3, currentItem: 1, totalItems: 1, currentItemName: 'Analisando páginas digitalizadas' });
    const result = await findOcrRedactionCandidates(files[0], options.query, options, (item) => progress(createOcrProgressUpdate(item, {
      fileName: `Página ${item.page || 1}`,
      progressStart: 3,
      progressSpan: 95
    })), isCancelled);
    if (isCancelled()) throw new Error('OPERATION_CANCELLED');
    progress({ progress: 100, currentItem: 1, totalItems: 1, itemProgress: 100, currentItemName: 'Análise OCR concluída' });
    return { ...result, fileName: path.basename(files[0]) };
  }

  if (type === 'ocr-extract-area') {
    progress({ progress: 5, currentItem: 1, totalItems: 1, currentItemName: `Reconhecendo área da página ${options.pageNumber}` });
    const result = await recognizePdfArea(files[0], options.pageNumber, options.selection, options, (item) => progress(createOcrProgressUpdate(item, {
      fileName: `Página ${options.pageNumber}`,
      progressStart: 5,
      progressSpan: 93
    })), isCancelled);
    if (isCancelled()) throw new Error('OPERATION_CANCELLED');
    progress({ progress: 100, itemProgress: 100, currentItem: 1, totalItems: 1, currentItemName: 'Reconhecimento da área concluído' });
    return result;
  }

  if (type === 'ocr-search-document') {
    progress({ progress: 3, currentItem: 1, totalItems: 1, currentItemName: 'Preparando a pesquisa no documento' });
    const result = options.suggestSplitStarts === true
      ? await suggestPdfSplitStarts(files[0], options, (item) => progress(createOcrProgressUpdate(item, {
        fileName: `Página ${item.page || 1}`,
        progressStart: 3,
        progressSpan: 95
      })), isCancelled)
      : await searchPdfDocument(files[0], options.query, options, (item) => progress(createOcrProgressUpdate(item, {
      fileName: `Página ${item.page || 1}`,
      progressStart: 3,
      progressSpan: 95
    })), isCancelled);
    if (isCancelled()) throw new Error('OPERATION_CANCELLED');
    progress({ progress: 100, currentItem: 1, totalItems: 1, itemProgress: 100, currentItemName: options.suggestSplitStarts === true ? 'Sugestões de separação prontas' : 'Pesquisa concluída' });
    return result;
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

  if (type === 'split-content') {
    const startPages = Array.isArray(options.startPages) ? options.startPages : [];
    const createdFiles = await pdfService.splitPdfByPageStarts(
      files[0], startPages, outputDir, sanitizeFilename(options.prefix || 'separado'), isCancelled, progress
    );
    return { outputDir, firstOutputPath: createdFiles[0] || '', outputCount: createdFiles.length, createdFiles, splitStartPages: [...new Set([1, ...startPages])].sort((left, right) => left - right) };
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

  if (type === 'pdf-to-word-analyze') {
    return analyzePdfOcrNeed(files[0], progress, isCancelled);
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
    } catch {
      // Best effort cleanup only.
    }
  }
}

function zipFiles(files, zipPath, outputDir) {
  return new Promise((resolve, reject) => {
    const tempZipDir = path.join(outputDir, `.tmp_zip_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`);
    const moved = [];

    const restoreMovedFiles = () => {
      for (const { original, dest } of moved) {
        try {
          if (fs.existsSync(dest) && !fs.existsSync(original)) {
            fs.renameSync(dest, original);
          }
        } catch (restoreError) {
          console.error(`Failed to restore document after ZIP failure (${getSafeFailureCode(restoreError)}).`);
        }
      }
    };

    const cleanupTempDir = () => {
      try {
        fs.rmSync(tempZipDir, { recursive: true, force: true });
      } catch (rmError) {
        console.error(`Failed to clean up temporary ZIP workspace (${getSafeFailureCode(rmError)}).`);
      }
    };

    try {
      fs.mkdirSync(tempZipDir, { recursive: true });

      // Move files to temp zip dir, tracking what moved so we can roll back on failure.
      for (const file of files) {
        if (fs.existsSync(file)) {
          const dest = path.join(tempZipDir, path.basename(file));
          fs.renameSync(file, dest);
          moved.push({ original: file, dest });
        }
      }
    } catch (err) {
      restoreMovedFiles();
      cleanupTempDir();
      reject(err);
      return;
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
      if (error) {
        restoreMovedFiles();
        cleanupTempDir();
        reject(new Error(`Erro ao compactar arquivos: ${stderr || error.message}`));
        return;
      }

      cleanupTempDir();
      resolve();
    });
  });
}

async function runOperation() {
  if (!workerData || operationStarted) return;
  operationStarted = true;
  const cleanupPaths = Array.isArray(workerData.options.cleanupPaths)
    ? workerData.options.cleanupPaths
    : [];
  const managedTempDirectory = typeof workerData.managedTempDirectory === 'string'
    ? workerData.managedTempDirectory
    : '';
  try {
    let result = await executeOperation();
    if (cancelled) {
      throw new Error(cancelReason === 'timeout' ? 'OPERATION_TIMEOUT' : 'OPERATION_CANCELLED');
    }

    const { type, options, outputDir } = workerData;
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
        zipPath = resolveUniqueOutputPath(zipPath);
        await zipFiles(filesToZip, zipPath, outputDir);
        const newResult = { outputPath: zipPath };
        if (Number.isFinite(Number(result.orientationCorrections))) {
          newResult.orientationCorrections = Number(result.orientationCorrections);
        }
        if (Number.isFinite(Number(result.preprocessingPages))) {
          newResult.preprocessingPages = Number(result.preprocessingPages);
        }
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
      ...(typeof error?.safeUserMessage === 'string' ? { safeUserMessage: error.safeUserMessage.slice(0, 1000) } : {}),
      ...(getSafeFailureCode(error) !== 'OPERATION_FAILED' ? { code: getSafeFailureCode(error) } : {}),
      stack: error.stack || ''
    });
  } finally {
    await cleanupTempPaths(sanitizeManagedTempPaths(cleanupPaths, managedTempDirectory));
    await cleanupTempPaths(workerOwnedTempPaths);
    // The utility process exits after cleanup; native crashes are isolated
    // from the main app process.
    if (utilityParentPort) {
      process.exit(0);
    } else {
      parentPort?.close?.();
    }
  }
}

if (workerData) runOperation();
