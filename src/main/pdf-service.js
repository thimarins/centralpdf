const fs = require('fs');
const path = require('path');
const {
  PDFDocument,
  StandardFonts,
  degrees,
  rgb,
  PDFName,
  PDFString,
  PDFHexString,
  PDFArray,
  PDFDict,
  PDFRef
} = require('pdf-lib');
const { encryptPDF } = require('@pdfsmaller/pdf-encrypt');
const { decryptPDF, isEncrypted } = require('@pdfsmaller/pdf-decrypt');
const { isValidPdfPath, isValidImagePath, parsePageRanges, sanitizeFilename, inspectPdfFile, hasPdfEncryptionDictionary, resolveUniqueOutputPath, PDF_LIMITS, IMAGE_LIMITS } = require('./utils');

const FONT_MAP = {
  Helvetica: StandardFonts.Helvetica,
  HelveticaBold: StandardFonts.HelveticaBold,
  TimesRoman: StandardFonts.TimesRoman,
  TimesRomanBold: StandardFonts.TimesRomanBold,
  Courier: StandardFonts.Courier,
  CourierBold: StandardFonts.CourierBold
};

const AUTO_IMAGE_MAX_DIMENSION = 2200;
const AUTO_JPEG_QUALITY = 82;
const MIN_JPEG_OPTIMIZATION_BYTES = 180 * 1024;
const MIN_JPEG_REDUCTION_RATIO = 0.97;
const AGGRESSIVE_COMPRESSION_MIN_BYTES = 8 * 1024 * 1024;
const AGGRESSIVE_RENDER_SCALE = 1.5;
const AGGRESSIVE_JPEG_QUALITY = 0.82;
const MIN_AGGRESSIVE_REDUCTION_FACTOR = 0.92;

function readOutline(pdfDoc) {
  try {
    const catalog = pdfDoc.catalog;
    const outlinesRef = catalog.get(PDFName.of('Outlines'));
    if (!outlinesRef) return null;
    const outlines = pdfDoc.context.lookup(outlinesRef);
    if (!outlines) return null;

    const pageRefMap = new Map();
    const pages = pdfDoc.getPages();
    pages.forEach((page, idx) => {
      pageRefMap.set(page.ref.toString(), idx);
    });

    const rootFirstRef = outlines.get(PDFName.of('First'));
    if (!rootFirstRef) return null;

    function parseNode(nodeRef) {
      const node = pdfDoc.context.lookup(nodeRef);
      if (!node) return null;

      const titleObj = node.get(PDFName.of('Title'));
      let title = '';
      if (titleObj instanceof PDFString) {
        title = titleObj.decodeText();
      } else if (titleObj instanceof PDFHexString) {
        title = titleObj.decodeText();
      }

      let pageIndex = -1;
      let dest = node.get(PDFName.of('Dest'));
      if (!dest) {
        const action = node.get(PDFName.of('A'));
        if (action) {
          const actionDict = pdfDoc.context.lookup(action);
          dest = actionDict.get(PDFName.of('D'));
        }
      }

      if (dest) {
        const resolvedDest = pdfDoc.context.lookup(dest);
        if (resolvedDest instanceof PDFArray) {
          const pageRef = resolvedDest.get(0);
          if (pageRef) {
            pageIndex = pageRefMap.get(pageRef.toString())  -1;
          }
        }
      }

      const children = [];
      const firstChildRef = node.get(PDFName.of('First'));
      if (firstChildRef) {
        let currentChildRef = firstChildRef;
        while (currentChildRef) {
          const childNode = parseNode(currentChildRef);
          if (childNode) {
            children.push(childNode);
          }
          const childDict = pdfDoc.context.lookup(currentChildRef);
          currentChildRef = childDict.get(PDFName.of('Next'));
        }
      }

      return { title, pageIndex, children };
    }

    const nodes = [];
    let currentRef = rootFirstRef;
    while (currentRef) {
      const node = parseNode(currentRef);
      if (node) {
        nodes.push(node);
      }
      const nodeDict = pdfDoc.context.lookup(currentRef);
      currentRef = nodeDict.get(PDFName.of('Next'));
    }

    return nodes.length > 0 ? nodes : null;
  } catch (err) {
    console.warn('Failed to parse outline:', err);
    return null;
  }
}

function writeOutline(pdfDoc, outlineNodes) {
  if (!outlineNodes || outlineNodes.length === 0) return;

  try {
    const context = pdfDoc.context;
    const pages = pdfDoc.getPages();
    const outlinesRef = context.nextRef();

    function buildOutlineItems(nodes, parentRef) {
      const refs = nodes.map(() => context.nextRef());
      
      nodes.forEach((node, idx) => {
        const itemRef = refs[idx];
        const itemDict = context.obj({
          Title: PDFString.of(node.title),
          Parent: parentRef
        });

        if (idx > 0) {
          itemDict.set(PDFName.of('Prev'), refs[idx - 1]);
        }
        if (idx < nodes.length - 1) {
          itemDict.set(PDFName.of('Next'), refs[idx + 1]);
        }

        if (node.pageIndex >= 0 && node.pageIndex < pages.length) {
          const page = pages[node.pageIndex];
          const destArray = context.obj([page.ref, PDFName.of('XYZ'), null, null, null]);
          itemDict.set(PDFName.of('Dest'), destArray);
        }

        if (node.children && node.children.length > 0) {
          const childRefs = buildOutlineItems(node.children, itemRef);
          itemDict.set(PDFName.of('First'), childRefs[0]);
          itemDict.set(PDFName.of('Last'), childRefs[childRefs.length - 1]);
          itemDict.set(PDFName.of('Count'), childRefs.length);
        }

        context.assign(itemRef, itemDict);
      });

      return refs;
    }

    const rootRefs = buildOutlineItems(outlineNodes, outlinesRef);

    const outlinesDict = context.obj({
      Type: PDFName.of('Outlines'),
      First: rootRefs[0],
      Last: rootRefs[rootRefs.length - 1],
      Count: rootRefs.length
    });

    context.assign(outlinesRef, outlinesDict);
    pdfDoc.catalog.set(PDFName.of('Outlines'), outlinesRef);
  } catch (err) {
    console.warn('Failed to write outline:', err);
  }
}

async function readBuffer(filePath) {
  return fs.promises.readFile(filePath);
}

async function readPdfBuffer(filePath, isCancelled = () => false) {
  const inspection = inspectPdfFile(filePath, PDF_LIMITS.maxSupportedBytes);
  if (!inspection.ok) {
    throw new Error('Não foi possível abrir este PDF para processamento.');
  }

  ensureNotCancelled(isCancelled);
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    const chunkSize = size >= PDF_LIMITS.heavyModeBytes ? 4 * 1024 * 1024 : 16 * 1024 * 1024;
    const chunks = [];
    let position = 0;
    while (position < size) {
      ensureNotCancelled(isCancelled);
      const length = Math.min(chunkSize, size - position);
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (!bytesRead) break;
      chunks.push(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return Buffer.concat(chunks);
  } finally {
    await handle.close();
  }
}

function hasDigitalSignatures(filePath) {
  try {
    const header = fs.openSync(filePath, 'r');
    const stats = fs.statSync(filePath);
    const readSize = Math.min(stats.size, 256 * 1024);
    const buffer = Buffer.alloc(readSize);
    fs.readSync(header, buffer, 0, readSize, 0);
    fs.closeSync(header);
    return [
      Buffer.from('/Type /Sig'),
      Buffer.from('/Type/Sig'),
      Buffer.from('/FT /Sig'),
      Buffer.from('/FT/Sig')
    ].some((pattern) => buffer.includes(pattern));
  } catch (err) {
    return false;
  }
}

async function validatePdfIntegrity(filePath) {
  try {
    const buffer = await readBuffer(filePath);
    await PDFDocument.load(buffer, { ignoreEncryption: true });
    return true;
  } catch (err) {
    return false;
  }
}

function isEncryptedPdfError(error) {
  const message = error?.message || String(error || '');
  const normalized = message.toLowerCase();
  return normalized.includes('encrypted')
    || normalized.includes('ignoreencryption')
    || normalized.includes('/encrypt')
    || normalized.includes('password protected')
    || normalized.includes('unsupported encryption');
}

async function ensureParentDirectory(outputPath) {
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
}

function buildTempOutputPath(outputPath) {
  const parsed = path.parse(outputPath);
  return path.join(parsed.dir, `.${parsed.name}.${process.pid}.${Date.now()}.tmp`);
}

async function commitFileAtomically(tempPath, outputPath) {
  try {
    await fs.promises.rename(tempPath, outputPath);
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      await fs.promises.unlink(outputPath).catch(() => {});
      await fs.promises.rename(tempPath, outputPath);
      return;
    }
    throw err;
  }
}

function getNativeImageModule() {
  try {
    return require('electron').nativeImage;
  } catch (_) {
    return null;
  }
}

function collectFilterNames(filterValue) {
  if (!filterValue) return [];
  if (typeof filterValue.asString === 'function') {
    return [filterValue.asString()];
  }
  if (filterValue instanceof PDFArray) {
    return filterValue.asArray().map((item) => (
      item && typeof item.asString === 'function' ? item.asString() : ''
    )).filter(Boolean);
  }
  return [];
}

async function optimizeEmbeddedJpegImages(pdfDoc, isCancelled = () => false) {
  const nativeImage = getNativeImageModule();
  if (!nativeImage) {
    return { optimizedImages: 0, savedBytes: 0 };
  }

  const replacementRefs = new Map();
  let optimizedImages = 0;
  let savedBytes = 0;

  for (const page of pdfDoc.getPages()) {
    ensureNotCancelled(isCancelled);

    const pageNode = page && page.node;
    if (!pageNode || typeof pageNode.normalizedEntries !== 'function') continue;

    const xObjectDict = pageNode.normalizedEntries()?.XObject;
    if (!xObjectDict || typeof xObjectDict.entries !== 'function') continue;

    for (const [xObjectKey, xObjectRef] of xObjectDict.entries()) {
      if (!(xObjectRef instanceof PDFRef)) continue;

      const cacheKey = xObjectRef.toString();
      if (replacementRefs.has(cacheKey)) {
        xObjectDict.set(xObjectKey, replacementRefs.get(cacheKey));
        continue;
      }

      const xObject = pdfDoc.context.lookup(xObjectRef);
      if (!xObject || !xObject.dict || typeof xObject.getContents !== 'function') continue;

      const subtype = xObject.dict.lookup(PDFName.of('Subtype'));
      if (!subtype || typeof subtype.asString !== 'function' || subtype.asString() !== '/Image') continue;

      const filters = collectFilterNames(xObject.dict.lookup(PDFName.of('Filter')));
      if (!filters.includes('/DCTDecode') || filters.includes('/JPXDecode')) continue;

      const originalBytes = Buffer.from(xObject.getContents());
      if (originalBytes.length < MIN_JPEG_OPTIMIZATION_BYTES) continue;

      const originalImage = nativeImage.createFromBuffer(originalBytes);
      if (!originalImage || originalImage.isEmpty()) continue;

      const sourceSize = originalImage.getSize();
      const sourceWidth = Math.max(1, sourceSize.width || 1);
      const sourceHeight = Math.max(1, sourceSize.height || 1);
      const needsResize = sourceWidth > AUTO_IMAGE_MAX_DIMENSION || sourceHeight > AUTO_IMAGE_MAX_DIMENSION;

      let optimizedImage = originalImage;
      if (needsResize) {
        if (sourceWidth >= sourceHeight) {
          optimizedImage = originalImage.resize({
            width: AUTO_IMAGE_MAX_DIMENSION,
            height: Math.max(1, Math.round((sourceHeight * AUTO_IMAGE_MAX_DIMENSION) / sourceWidth)),
            quality: 'good'
          });
        } else {
          optimizedImage = originalImage.resize({
            width: Math.max(1, Math.round((sourceWidth * AUTO_IMAGE_MAX_DIMENSION) / sourceHeight)),
            height: AUTO_IMAGE_MAX_DIMENSION,
            quality: 'good'
          });
        }
      }

      const optimizedBytes = Buffer.from(optimizedImage.toJPEG(AUTO_JPEG_QUALITY));
      if (!optimizedBytes || optimizedBytes.length === 0) continue;
      if (optimizedBytes.length >= Math.floor(originalBytes.length * MIN_JPEG_REDUCTION_RATIO)) continue;

      const embeddedImage = await pdfDoc.embedJpg(optimizedBytes);
      xObjectDict.set(xObjectKey, embeddedImage.ref);
      replacementRefs.set(cacheKey, embeddedImage.ref);
      optimizedImages += 1;
      savedBytes += Math.max(0, originalBytes.length - optimizedBytes.length);
    }
  }

  return { optimizedImages, savedBytes };
}

async function serializePdfForOutput(pdfDoc, isCancelled = () => false) {
  try {
    await optimizeEmbeddedJpegImages(pdfDoc, isCancelled);
  } catch (error) {
    console.warn('Embedded image optimization skipped:', error);
  }

  ensureNotCancelled(isCancelled);
  return pdfDoc.save({
    useObjectStreams: true,
    addDefaultPage: false,
    updateFieldAppearances: false,
    addCompatibleMetadata: false
  });
}

function pageHasImageXObject(page) {
  const pageNode = page && page.node;
  if (!pageNode || typeof pageNode.normalizedEntries !== 'function') return false;
  const xObjectDict = pageNode.normalizedEntries()?.XObject;
  if (!xObjectDict || typeof xObjectDict.entries !== 'function') return false;

  for (const [, xObjectRef] of xObjectDict.entries()) {
    if (!(xObjectRef instanceof PDFRef)) continue;
    const xObject = page.doc.context.lookup(xObjectRef);
    if (!xObject || !xObject.dict) continue;
    const subtype = xObject.dict.lookup(PDFName.of('Subtype'));
    if (subtype && typeof subtype.asString === 'function' && subtype.asString() === '/Image') {
      return true;
    }
  }

  return false;
}

async function rasterizePdfToOptimizedBytes(filePath, isCancelled = () => false) {
  const { createCanvas } = require('@napi-rs/canvas');
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const sourceBytes = await fs.promises.readFile(filePath);
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(sourceBytes),
    disableWorker: true,
    useSystemFonts: true
  });
  const sourcePdf = await loadingTask.promise;
  const targetPdf = await PDFDocument.create();

  for (let pageIndex = 1; pageIndex <= sourcePdf.numPages; pageIndex += 1) {
    ensureNotCancelled(isCancelled);
    const sourcePage = await sourcePdf.getPage(pageIndex);
    const baseViewport = sourcePage.getViewport({ scale: 1 });
    const renderViewport = sourcePage.getViewport({ scale: AGGRESSIVE_RENDER_SCALE });
    const canvas = createCanvas(Math.ceil(renderViewport.width), Math.ceil(renderViewport.height));
    const context = canvas.getContext('2d');

    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    await sourcePage.render({ canvasContext: context, viewport: renderViewport }).promise;

    const jpegBytes = canvas.toBuffer('image/jpeg', { quality: AGGRESSIVE_JPEG_QUALITY });
    const embeddedImage = await targetPdf.embedJpg(jpegBytes);
    const targetPage = targetPdf.addPage([baseViewport.width, baseViewport.height]);
    targetPage.drawRectangle({
      x: 0,
      y: 0,
      width: baseViewport.width,
      height: baseViewport.height,
      color: rgb(1, 1, 1)
    });
    targetPage.drawImage(embeddedImage, {
      x: 0,
      y: 0,
      width: baseViewport.width,
      height: baseViewport.height
    });
  }

  return targetPdf.save({
    useObjectStreams: true,
    addDefaultPage: false,
    updateFieldAppearances: false,
    addCompatibleMetadata: false
  });
}

async function maybeApplyAggressiveCompression(outputPath, isCancelled = () => false) {
  const originalStats = await fs.promises.stat(outputPath).catch(() => null);
  if (!originalStats || originalStats.size < AGGRESSIVE_COMPRESSION_MIN_BYTES) return;

  let outputPdf;
  try {
    outputPdf = await PDFDocument.load(await readPdfBuffer(outputPath, isCancelled));
  } catch (_) {
    return;
  }

  const pages = outputPdf.getPages();
  if (!pages.length || pages.some((page) => !pageHasImageXObject(page))) {
    return;
  }

  let optimizedBytes;
  try {
    optimizedBytes = await rasterizePdfToOptimizedBytes(outputPath, isCancelled);
  } catch (error) {
    console.warn('Aggressive PDF compression skipped:', error);
    return;
  }

  if (!optimizedBytes || optimizedBytes.length >= Math.floor(originalStats.size * MIN_AGGRESSIVE_REDUCTION_FACTOR)) {
    return;
  }

  const tempPath = buildTempOutputPath(outputPath);
  try {
    await fs.promises.writeFile(tempPath, optimizedBytes);
    if (!(await validatePdfIntegrity(tempPath))) {
      throw new Error('Falha ao validar a versão compactada do PDF.');
    }
    ensureNotCancelled(isCancelled);
    await commitFileAtomically(tempPath, outputPath);
  } catch (error) {
    await fs.promises.unlink(tempPath).catch(() => {});
    throw error;
  }
}

function ensureNotCancelled(isCancelled) {
  if (typeof isCancelled === 'function' && isCancelled()) {
    throw new Error('OPERATION_CANCELLED');
  }
}

function updatePagedProgress(updateProgress, pageIndex, totalPages, baseProgress, progressRange, extra = {}) {
  const safeTotal = Math.max(1, totalPages);
  const itemProgress = Math.round(((pageIndex + 1) / safeTotal) * 100);
  const progress = Math.min(99, Math.round(baseProgress + (itemProgress / 100) * progressRange));
  updateProgress({
    progress,
    itemProgress,
    ...extra
  });
}

function getColorRgb(colorHex) {
  const normalized = String(colorHex || '#a80000').trim().replace('#', '');
  const safeHex = /^[0-9a-fA-F]{6}$/.test(normalized) ? normalized : 'a80000';
  const intValue = parseInt(safeHex, 16);
  return rgb(
    ((intValue >> 16) & 255) / 255,
    ((intValue >> 8) & 255) / 255,
    (intValue & 255) / 255
  );
}

async function loadWatermarkAsset(imagePath) {
  const extension = path.extname(imagePath).toLowerCase();
  if (extension === '.png' || extension === '.jpg' || extension === '.jpeg') {
    return readBuffer(imagePath);
  }

  if (extension === '.svg') {
    try {
      const { nativeImage } = require('electron');
      const svgContent = await fs.promises.readFile(imagePath, 'utf8');
      const image = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svgContent, 'utf8').toString('base64')}`);
      const pngBuffer = image.toPNG();
      if (!pngBuffer || pngBuffer.length === 0) {
        throw new Error('A imagem SVG não pôde ser processada.');
      }
      return pngBuffer;
    } catch (err) {
      throw new Error(`A imagem SVG não pôde ser processada neste ambiente: ${err.message}`);
    }
  }

  throw new Error('Formato de imagem para marca d\'água não suportado.');
}

function buildWatermarkOutputPath(inputPath, outputDir, suffix) {
  const parsed = path.parse(inputPath);
  const safeSuffix = sanitizeFilename(suffix || '_marca_dagua').replace(/\.pdf$/i, '');
  return resolveUniqueOutputPath(path.join(outputDir, `${parsed.name}${safeSuffix}.pdf`));
}

async function saveAndValidatePdf(pdfDoc, outputPath, isCancelled = () => false) {
  await ensureParentDirectory(outputPath);
  const tempPath = buildTempOutputPath(outputPath);
  const pdfBytes = await serializePdfForOutput(pdfDoc, isCancelled);
  ensureNotCancelled(isCancelled);

  try {
    await fs.promises.writeFile(tempPath, pdfBytes);
    ensureNotCancelled(isCancelled);

    if (!(await validatePdfIntegrity(tempPath))) {
      throw new Error('Falha ao validar o PDF gerado.');
    }

    ensureNotCancelled(isCancelled);
    await commitFileAtomically(tempPath, outputPath);
    await maybeApplyAggressiveCompression(outputPath, isCancelled);
  } catch (error) {
    await fs.promises.unlink(tempPath).catch(() => {});
    throw error;
  }
}

async function mergePdfs(inputPaths, outputPath, options = {}, isCancelled = () => false, updateProgress = () => {}) {
  for (const inputPath of inputPaths) {
    if (!isValidPdfPath(inputPath, PDF_LIMITS.maxSupportedBytes)) {
      throw new Error('Não foi possível abrir este PDF para processamento.');
    }
  }

  const mergedPdf = await PDFDocument.create();
  const ranges = options && Array.isArray(options.ranges) ? options.ranges : [];
  const combinedOutlines = [];

  for (let index = 0; index < inputPaths.length; index += 1) {
    ensureNotCancelled(isCancelled);
    const inputPath = inputPaths[index];
    const pdf = await PDFDocument.load(await readPdfBuffer(inputPath, isCancelled));
    
    let pageIndices = pdf.getPageIndices();
    const rangeStr = ranges[index];
    if (rangeStr && typeof rangeStr === 'string' && rangeStr.trim() !== '') {
      pageIndices = parsePageRanges(rangeStr.trim(), pdf.getPageCount());
      if (pageIndices.length === 0) {
        throw new Error('O intervalo informado não contém páginas válidas.');
      }
    }

    const mergedPageIndexOffset = mergedPdf.getPageCount();
    const sourceOutline = readOutline(pdf);
    if (sourceOutline) {
      function remapNodes(nodes) {
        const remapped = [];
        nodes.forEach((node) => {
          let newPageIndex = -1;
          if (node.pageIndex >= 0) {
            const idxInCopied = pageIndices.indexOf(node.pageIndex);
            if (idxInCopied !== -1) {
              newPageIndex = mergedPageIndexOffset + idxInCopied;
            }
          }

          const newChildren = node.children ? remapNodes(node.children) : [];

          if (newPageIndex !== -1 || newChildren.length > 0) {
            remapped.push({
              title: node.title,
              pageIndex: newPageIndex,
              children: newChildren
            });
          }
        });
        return remapped;
      }

      const remappedOutline = remapNodes(sourceOutline);
      if (remappedOutline.length > 0) {
        combinedOutlines.push(...remappedOutline);
      }
    }

    const pages = await mergedPdf.copyPages(pdf, pageIndices);
    pages.forEach((page) => mergedPdf.addPage(page));
    updateProgress({
      progress: Math.min(95, Math.round(((index + 1) / inputPaths.length) * 95)),
      itemProgress: Math.round(((index + 1) / inputPaths.length) * 100),
      currentItem: index + 1,
      totalItems: inputPaths.length,
      currentItemName: path.basename(inputPath)
    });
  }

  if (combinedOutlines.length > 0) {
    writeOutline(mergedPdf, combinedOutlines);
  }

  await saveAndValidatePdf(mergedPdf, outputPath, isCancelled);
}

async function splitPdfByPages(inputPath, outputDir, prefix = 'page', isCancelled = () => false) {
  if (!isValidPdfPath(inputPath)) {
    throw new Error('Não foi possível abrir este PDF para processamento.');
  }

  const sourcePdf = await PDFDocument.load(await readPdfBuffer(inputPath, isCancelled));
  const pageCount = sourcePdf.getPageCount();
  const createdFiles = [];
  const warnings = [];
  let skippedProtectedCount = 0;

  for (let i = 0; i < pageCount; i += 1) {
    ensureNotCancelled(isCancelled);
    const newPdf = await PDFDocument.create();
    const [copiedPage] = await newPdf.copyPages(sourcePdf, [i]);
    newPdf.addPage(copiedPage);
    const outputPath = resolveUniqueOutputPath(path.join(outputDir, `${prefix}_${i + 1}.pdf`));
    await saveAndValidatePdf(newPdf, outputPath, isCancelled);
    createdFiles.push(outputPath);
  }

  return createdFiles;
}

async function splitPdfByRanges(inputPath, rangeStr, outputPath, isCancelled = () => false) {
  if (!isValidPdfPath(inputPath)) {
    throw new Error('Não foi possível abrir este PDF para processamento.');
  }

  ensureNotCancelled(isCancelled);
  const sourcePdf = await PDFDocument.load(await readPdfBuffer(inputPath, isCancelled));
  const pageIndices = parsePageRanges(rangeStr, sourcePdf.getPageCount());
  if (!Array.isArray(pageIndices) || pageIndices.length === 0) {
    throw new Error('O intervalo informado não contém páginas válidas.');
  }
  const newPdf = await PDFDocument.create();
  const copiedPages = await newPdf.copyPages(sourcePdf, pageIndices);
  copiedPages.forEach((page) => newPdf.addPage(page));
  ensureNotCancelled(isCancelled);
  await saveAndValidatePdf(newPdf, outputPath, isCancelled);
}

async function splitPdfBySize(inputPath, outputDir, maxSizeBytes, prefix = 'part', isCancelled = () => false, updateProgress = () => {}) {
  if (!isValidPdfPath(inputPath)) {
    throw new Error('Não foi possível abrir este PDF para processamento.');
  }
  if (!Number.isFinite(maxSizeBytes) || maxSizeBytes < 50 * 1024) {
    throw new Error('O tamanho máximo informado é inválido. Use pelo menos 50 KB.');
  }

  const sourcePdf = await PDFDocument.load(await readPdfBuffer(inputPath, isCancelled));
  const pageCount = sourcePdf.getPageCount();
  const createdFiles = [];
  let currentPartPages = [];
  let partIndex = 1;

  async function buildBytes(indices) {
    const tempPdf = await PDFDocument.create();
    const copiedPages = await tempPdf.copyPages(sourcePdf, indices);
    copiedPages.forEach((page) => tempPdf.addPage(page));
    return tempPdf.save({ useObjectStreams: true });
  }

  for (let i = 0; i < pageCount; i += 1) {
    ensureNotCancelled(isCancelled);
    currentPartPages.push(i);
    const bytes = await buildBytes(currentPartPages);
    updatePagedProgress(updateProgress, i, pageCount, 5, 90);

    if (bytes.length > maxSizeBytes && currentPartPages.length > 1) {
      currentPartPages.pop();
      const outputPath = resolveUniqueOutputPath(path.join(outputDir, `${prefix}_${partIndex}.pdf`));
      const partPdf = await PDFDocument.create();
      const partPages = await partPdf.copyPages(sourcePdf, currentPartPages);
      partPages.forEach((page) => partPdf.addPage(page));
      await saveAndValidatePdf(partPdf, outputPath, isCancelled);
      createdFiles.push(outputPath);
      currentPartPages = [i];
      partIndex += 1;
    }
  }

  if (currentPartPages.length > 0) {
    const outputPath = resolveUniqueOutputPath(path.join(outputDir, `${prefix}_${partIndex}.pdf`));
    const finalPdf = await PDFDocument.create();
    const finalPages = await finalPdf.copyPages(sourcePdf, currentPartPages);
    finalPages.forEach((page) => finalPdf.addPage(page));
    await saveAndValidatePdf(finalPdf, outputPath, isCancelled);
    createdFiles.push(outputPath);
  }

  return createdFiles;
}

async function organizePdf(inputPaths, pageActions, outputPath, options = {}, isCancelled = () => false, updateProgress = () => {}) {
  // Normalize arguments in case options is omitted
  let finalOptions = options;
  let finalIsCancelled = isCancelled;
  let finalUpdateProgress = updateProgress;
  if (typeof options === 'function') {
    finalUpdateProgress = isCancelled;
    finalIsCancelled = options;
    finalOptions = {};
  }

  const paths = Array.isArray(inputPaths) ? inputPaths : [inputPaths];
  for (const p of paths) {
    if (!isValidPdfPath(p)) {
      throw new Error('Não foi possível abrir este PDF para processamento.');
    }
  }
  if (!Array.isArray(pageActions) || pageActions.length === 0) {
    throw new Error('Nenhuma configuração de páginas foi informada.');
  }

  const sourcePdfs = [];
  for (const p of paths) {
    const doc = await PDFDocument.load(await readPdfBuffer(p, finalIsCancelled));
    sourcePdfs.push(doc);
  }

  const newPdf = await PDFDocument.create();

  for (let index = 0; index < pageActions.length; index++) {
    ensureNotCancelled(finalIsCancelled);
    const action = pageActions[index];
    const fileIdx = action.fileIndex || 0;
    const srcIdx = action.sourceIndex;
    const sourcePdf = sourcePdfs[fileIdx];

    if (!sourcePdf) {
      throw new Error('Não foi possível carregar um dos PDFs de origem.');
    }
    if (srcIdx < 0 || srcIdx >= sourcePdf.getPageCount()) {
      throw new Error('Uma das páginas selecionadas é inválida.');
    }

    const [copiedPage] = await newPdf.copyPages(sourcePdf, [srcIdx]);
    const rotation = action.rotation || 0;
    if ([0, 90, 180, 270].includes(rotation)) {
      copiedPage.setRotation(degrees(rotation));
    }
    newPdf.addPage(copiedPage);
    updatePagedProgress(finalUpdateProgress, index, pageActions.length, 15, 70);
  }

  if (finalOptions && finalOptions.numberPages) {
    const pageNumberFont = await newPdf.embedFont(StandardFonts.HelveticaBold);
    const pageNumberColor = rgb(0.54, 0.6, 0.68);
    const pageNumberSize = 10;
    const marginX = 24;
    const marginY = 18;

    newPdf.getPages().forEach((page, pageIndex) => {
      const label = String(pageIndex + 1);
      const labelWidth = pageNumberFont.widthOfTextAtSize(label, pageNumberSize);
      const x = Math.max(marginX, page.getWidth() - labelWidth - marginX);
      const y = marginY;
      page.drawText(label, {
        x,
        y,
        size: pageNumberSize,
        font: pageNumberFont,
        color: pageNumberColor,
        opacity: 0.75
      });
    });
  }

  if (finalOptions && finalOptions.bookmarks && finalOptions.bookmarks.length > 0) {
    writeOutline(newPdf, finalOptions.bookmarks);
  }

  ensureNotCancelled(finalIsCancelled);
  await saveAndValidatePdf(newPdf, outputPath, finalIsCancelled);
}

async function compressPdf(inputPath, outputPath, isCancelled = () => false, updateProgress = () => {}) {
  if (!isValidPdfPath(inputPath)) {
    throw new Error('Não foi possível abrir este PDF para processamento.');
  }

  const originalSize = fs.statSync(inputPath).size;
  const pdfDoc = await PDFDocument.load(await readPdfBuffer(inputPath, isCancelled));
  updateProgress({ progress: 35, itemProgress: 35 });
  ensureNotCancelled(isCancelled);
  const bytes = await serializePdfForOutput(pdfDoc, isCancelled);
  const tempPath = buildTempOutputPath(outputPath);
  await ensureParentDirectory(outputPath);
  await fs.promises.writeFile(tempPath, bytes);
  updateProgress({ progress: 85, itemProgress: 85 });

  try {
    if (!(await validatePdfIntegrity(tempPath))) {
      throw new Error('Falha ao validar o PDF compactado.');
    }
    ensureNotCancelled(isCancelled);
    await commitFileAtomically(tempPath, outputPath);
    await maybeApplyAggressiveCompression(outputPath, isCancelled);
  } catch (error) {
    await fs.promises.unlink(tempPath).catch(() => {});
    throw error;
  }

  const newSize = fs.statSync(outputPath).size;
  return Math.max(0, Math.round(((originalSize - newSize) / originalSize) * 100));
}

async function compressImage(inputPath, outputPath, isCancelled = () => false, updateProgress = () => {}) {
  if (!isValidImagePath(inputPath, IMAGE_LIMITS.maxImageBytes)) {
    throw new Error('Não foi possível abrir esta imagem para processamento.');
  }

  const nativeImageModule = getNativeImageModule();
  if (!nativeImageModule) {
    throw new Error('Redução de imagem não é suportada neste ambiente.');
  }

  const originalBuffer = await fs.promises.readFile(inputPath);
  const originalSize = originalBuffer.length;
  const isPng = path.extname(inputPath).toLowerCase() === '.png';

  updateProgress({ progress: 15, itemProgress: 15 });
  ensureNotCancelled(isCancelled);

  const originalImage = nativeImageModule.createFromBuffer(originalBuffer);
  if (!originalImage || originalImage.isEmpty()) {
    throw new Error('Não foi possível abrir esta imagem para processamento.');
  }

  const { width: sourceWidth, height: sourceHeight } = originalImage.getSize();
  const needsResize = Math.max(sourceWidth, sourceHeight) > AUTO_IMAGE_MAX_DIMENSION;
  const workingImage = needsResize
    ? (sourceWidth >= sourceHeight
      ? originalImage.resize({
        width: AUTO_IMAGE_MAX_DIMENSION,
        height: Math.max(1, Math.round((sourceHeight * AUTO_IMAGE_MAX_DIMENSION) / sourceWidth)),
        quality: 'good'
      })
      : originalImage.resize({
        width: Math.max(1, Math.round((sourceWidth * AUTO_IMAGE_MAX_DIMENSION) / sourceHeight)),
        height: AUTO_IMAGE_MAX_DIMENSION,
        quality: 'good'
      }))
    : originalImage;

  updateProgress({ progress: 55, itemProgress: 55 });
  ensureNotCancelled(isCancelled);

  const compressedBuffer = isPng ? workingImage.toPNG() : Buffer.from(workingImage.toJPEG(AUTO_JPEG_QUALITY));
  const finalBuffer = compressedBuffer.length < originalSize ? compressedBuffer : originalBuffer;

  const tempPath = buildTempOutputPath(outputPath);
  await ensureParentDirectory(outputPath);
  await fs.promises.writeFile(tempPath, finalBuffer);
  updateProgress({ progress: 90, itemProgress: 90 });

  try {
    ensureNotCancelled(isCancelled);
    await commitFileAtomically(tempPath, outputPath);
  } catch (error) {
    await fs.promises.unlink(tempPath).catch(() => {});
    throw error;
  }

  const newSize = fs.statSync(outputPath).size;
  return Math.max(0, Math.round(((originalSize - newSize) / originalSize) * 100));
}

async function embedWatermarkAsset(pdfDoc, options) {
  if (options.watermarkKind === 'image') {
    const imageBytes = await loadWatermarkAsset(options.imagePath);
    if (path.extname(options.imagePath).toLowerCase() === '.png' || path.extname(options.imagePath).toLowerCase() === '.svg') {
      return { kind: 'image', asset: await pdfDoc.embedPng(imageBytes) };
    }
    return { kind: 'image', asset: await pdfDoc.embedJpg(imageBytes) };
  }

  const fontName = FONT_MAP[options.fontFamily] || StandardFonts.HelveticaBold;
  const font = await pdfDoc.embedFont(fontName);
  return { kind: 'text', asset: font };
}

function applyTextWatermark(page, font, options) {
  const pageWidth = page.getWidth();
  const pageHeight = page.getHeight();
  const fontSize = Math.max(12, Math.min(96, options.fontSize || 32));
  const opacity = Math.max(0.05, Math.min(0.8, (options.opacity || 18) / 100));
  const rotation = degrees(options.rotation || 0);
  const text = options.text;
  const color = getColorRgb(options.color);

  const lineWidth = font.widthOfTextAtSize(text, fontSize);
  const textHeight = fontSize;

  const resolveCenteredOrigin = (boxWidth, boxHeight, rotationDegrees = 0, centerX = pageWidth / 2, centerY = pageHeight / 2) => {
    const angle = (rotationDegrees * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const offsetX = (boxWidth / 2) * cos - (boxHeight / 2) * sin;
    const offsetY = (boxWidth / 2) * sin + (boxHeight / 2) * cos;

    return {
      x: centerX - offsetX,
      y: centerY - offsetY
    };
  };

  const drawText = (x, y, extraRotation = rotation) => {
    page.drawText(text, {
      x,
      y,
      size: fontSize,
      font,
      rotate: extraRotation,
      color,
      opacity
    });
  };

  if (options.position === 'repeated') {
    const stepX = Math.max(110, lineWidth + 40);
    const stepY = Math.max(90, fontSize + 50);
    for (let y = 40; y < pageHeight + stepY; y += stepY) {
      for (let x = 20; x < pageWidth + stepX; x += stepX) {
        drawText(x, y, degrees(options.rotation || -30));
      }
    }
    return;
  }

  if (options.position === 'corner') {
    drawText(pageWidth - lineWidth - 28, pageHeight - fontSize - 32, degrees(0));
    return;
  }

  if (options.position === 'center') {
    const centered = resolveCenteredOrigin(lineWidth, textHeight, 0);
    drawText(centered.x, centered.y, degrees(0));
    return;
  }

  const centered = resolveCenteredOrigin(lineWidth, textHeight, options.rotation || -35);
  drawText(centered.x, centered.y, degrees(options.rotation || -35));
}

function applyImageWatermark(page, image, options) {
  const pageWidth = page.getWidth();
  const pageHeight = page.getHeight();
  const opacity = Math.max(0.05, Math.min(0.8, (options.opacity || 18) / 100));
  const scaleFactor = Math.max(0.1, Math.min(2.5, (options.scale || 100) / 100));
  const embeddedScale = image.scale(scaleFactor * 0.35);
  const baseWidth = Math.min(embeddedScale.width, pageWidth * 0.75);
  const ratio = baseWidth / embeddedScale.width;
  const width = embeddedScale.width * ratio;
  const height = embeddedScale.height * ratio;

  const resolveCenteredOrigin = (boxWidth, boxHeight, rotationDegrees = 0, centerX = pageWidth / 2, centerY = pageHeight / 2) => {
    const angle = (rotationDegrees * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const offsetX = (boxWidth / 2) * cos - (boxHeight / 2) * sin;
    const offsetY = (boxWidth / 2) * sin + (boxHeight / 2) * cos;

    return {
      x: centerX - offsetX,
      y: centerY - offsetY
    };
  };

  const drawImage = (x, y, rotateAngle = options.rotation || 0) => {
    page.drawImage(image, {
      x,
      y,
      width,
      height,
      rotate: degrees(rotateAngle),
      opacity
    });
  };

  if (options.position === 'repeated') {
    const stepX = Math.max(120, width + 28);
    const stepY = Math.max(120, height + 32);
    for (let y = 20; y < pageHeight + stepY; y += stepY) {
      for (let x = 20; x < pageWidth + stepX; x += stepX) {
        drawImage(x, y);
      }
    }
    return;
  }

  if (options.position === 'corner') {
    drawImage(pageWidth - width - 26, pageHeight - height - 26, 0);
    return;
  }

  if (options.position === 'center') {
    const centered = resolveCenteredOrigin(width, height, 0);
    drawImage(centered.x, centered.y, 0);
    return;
  }

  const centered = resolveCenteredOrigin(width, height, options.rotation || -30);
  drawImage(centered.x, centered.y, options.rotation || -30);
}

async function watermarkPdf(inputPath, outputPath, options, updateProgress = () => {}, isCancelled = () => false, batchContext = {}) {
  if (!isValidPdfPath(inputPath)) {
    throw new Error('Não foi possível abrir este PDF para processamento.');
  }

  const pdfDoc = await PDFDocument.load(await readPdfBuffer(inputPath, isCancelled));
  const watermarkAsset = await embedWatermarkAsset(pdfDoc, options);
  const pages = pdfDoc.getPages();
  const totalPages = pages.length;

  updateProgress({
    progress: batchContext.baseProgress || 0,
    itemProgress: 0,
    totalItems: batchContext.totalItems || 1,
    currentItem: batchContext.currentItem || 1,
    currentItemName: batchContext.currentItemName || path.basename(inputPath)
  });

  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    ensureNotCancelled(isCancelled);
    const page = pages[pageIndex];
    if (watermarkAsset.kind === 'text') {
      applyTextWatermark(page, watermarkAsset.asset, options);
    } else {
      applyImageWatermark(page, watermarkAsset.asset, options);
    }

    updatePagedProgress(
      updateProgress,
      pageIndex,
      totalPages,
      batchContext.baseProgress || 0,
      batchContext.progressRange || 100,
      {
        totalItems: batchContext.totalItems || 1,
        currentItem: batchContext.currentItem || 1,
        currentItemName: batchContext.currentItemName || path.basename(inputPath)
      }
    );
  }

  if (options.numberPages) {
    const pageNumberFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const pageNumberColor = rgb(0.35, 0.4, 0.48);
    pages.forEach((page, pageIndex) => {
      const label = `${pageIndex + 1} / ${totalPages}`;
      const fontSize = 10;
      const marginX = 24;
      const marginY = 18;
      const labelWidth = pageNumberFont.widthOfTextAtSize(label, fontSize);
      page.drawText(label, {
        x: Math.max(marginX, page.getWidth() - labelWidth - marginX),
        y: marginY,
        size: fontSize,
        font: pageNumberFont,
        color: pageNumberColor,
        opacity: 0.8
      });
    });
  }

  await saveAndValidatePdf(pdfDoc, outputPath, isCancelled);
}

async function applyWatermarkBatch(inputPaths, outputDir, options, updateProgress = () => {}, isCancelled = () => false) {
  if (!Array.isArray(inputPaths) || inputPaths.length === 0) {
    throw new Error('Nenhum arquivo foi informado para marca d\'água.');
  }

  const totalItems = inputPaths.length;
  const suffix = options.outputSuffix || '_marca_dagua';
  const createdFiles = [];
  const warnings = [];
  let skippedProtectedCount = 0;

  for (let itemIndex = 0; itemIndex < inputPaths.length; itemIndex += 1) {
    ensureNotCancelled(isCancelled);

    const inputPath = inputPaths[itemIndex];
    const itemName = path.basename(inputPath);
    const outputPath = buildWatermarkOutputPath(inputPath, outputDir, suffix);
    const itemBaseProgress = Math.round((itemIndex / totalItems) * 100);
    const nextBaseProgress = Math.round(((itemIndex + 1) / totalItems) * 100);

    const isImage = /\.(jpg|jpeg|png)$/i.test(inputPath);
    let pathToWatermark = inputPath;
    let tempPdfPath = null;

    if (isImage) {
      try {
        const { convertImagesToPdf } = require('./services/image-conversion/image-to-pdf');
        const crypto = require('crypto');
        const os = require('os');
        const tempDir = path.join(os.tmpdir(), 'central-pdf-temp');
        await fs.promises.mkdir(tempDir, { recursive: true });
        const tempPdfName = `temp-watermark-image-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.pdf`;
        tempPdfPath = path.join(tempDir, tempPdfName);
        
        await convertImagesToPdf([inputPath], tempPdfPath);
        pathToWatermark = tempPdfPath;
      } catch (err) {
        throw new Error(`Não foi possível converter a imagem ${itemName} para PDF: ${err.message}`);
      }
    }

    try {
      try {
        await watermarkPdf(
          pathToWatermark,
          outputPath,
          options,
          updateProgress,
          isCancelled,
          {
            totalItems,
            currentItem: itemIndex + 1,
            currentItemName: itemName,
            baseProgress: itemBaseProgress,
            progressRange: Math.max(1, nextBaseProgress - itemBaseProgress)
          }
        );
        createdFiles.push(outputPath);
      } catch (error) {
        if (isEncryptedPdfError(error)) {
          if (totalItems > 1) {
            skippedProtectedCount += 1;
            continue;
          }
          throw new Error('Arquivo protegido. Remova a senha para continuar.');
        }
        throw error;
      }
    } finally {
      if (tempPdfPath) {
        await fs.promises.unlink(tempPdfPath).catch(() => {});
      }
    }
  }

  if (createdFiles.length === 0 && skippedProtectedCount > 0) {
    throw new Error(
      skippedProtectedCount === 1
        ? 'Arquivo protegido. Remova a senha para continuar.'
        : 'Todos os arquivos deste lote estão protegidos.'
    );
  }

  if (skippedProtectedCount > 0) {
    warnings.push(
      skippedProtectedCount === 1
        ? '1 arquivo protegido foi ignorado.'
        : `${skippedProtectedCount} arquivos protegidos foram ignorados.`
    );
  }

  return { createdFiles, warnings };
}

async function encryptPdf(inputPath, outputPath, password, options = {}, isCancelled = () => false) {
  if (!isValidPdfPath(inputPath)) {
    throw new Error('Não foi possível abrir este PDF para processamento.');
  }
  if (!password || typeof password !== 'string' || password.trim() === '') {
    throw new Error('A senha de proteção não pode ser vazia.');
  }

  ensureNotCancelled(isCancelled);
  const pdfBytes = await readPdfBuffer(inputPath, isCancelled);
  ensureNotCancelled(isCancelled);

  let bytesForEncryption = Buffer.from(pdfBytes);
  try {
    const pdfDoc = await PDFDocument.load(pdfBytes);
    bytesForEncryption = Buffer.from(await serializePdfForOutput(pdfDoc, isCancelled));
  } catch (error) {
    console.warn('Pre-encryption optimization skipped:', error);
  }

  const encryptedBytes = await encryptPDF(new Uint8Array(bytesForEncryption), password, {
    algorithm: options.algorithm || 'AES-256',
    ownerPassword: options.ownerPassword || password,
    allowPrinting: options.allowPrinting !== false,
    allowModifying: options.allowModifying !== false,
    allowCopying: options.allowCopying !== false,
    allowAnnotating: options.allowAnnotating !== false,
    allowFillingForms: options.allowFillingForms !== false,
    allowExtraction: options.allowExtraction !== false,
    allowAssembly: options.allowAssembly !== false,
    allowHighQualityPrint: options.allowHighQualityPrint !== false
  });

  ensureNotCancelled(isCancelled);
  await ensureParentDirectory(outputPath);
  const tempPath = buildTempOutputPath(outputPath);

  try {
    await fs.promises.writeFile(tempPath, encryptedBytes);
    ensureNotCancelled(isCancelled);

    if (!(await validatePdfIntegrity(tempPath))) {
      throw new Error('Falha ao validar o PDF gerado.');
    }

    ensureNotCancelled(isCancelled);
    await commitFileAtomically(tempPath, outputPath);
  } catch (error) {
    await fs.promises.unlink(tempPath).catch(() => {});
    throw error;
  }
}

async function decryptPdf(inputPath, outputPath, password, isCancelled = () => false) {
  if (!isValidPdfPath(inputPath)) {
    throw new Error('Não foi possível abrir este PDF para processamento.');
  }
  if (password === undefined || typeof password !== 'string') {
    throw new Error('A senha de abertura é necessária.');
  }

  ensureNotCancelled(isCancelled);
  const pdfBytes = await readPdfBuffer(inputPath, isCancelled);
  ensureNotCancelled(isCancelled);

  let decryptedBytes;
  try {
    const encrypted = await isEncrypted(new Uint8Array(pdfBytes));
    if (!encrypted) {
      throw new Error('NOT_ENCRYPTED');
    }
    decryptedBytes = Buffer.from(await decryptPDF(new Uint8Array(pdfBytes), password));
  } catch (error) {
    const message = String(error && error.message ? error.message : error || '');
    const normalized = message.toLowerCase();

    if (message === 'NOT_ENCRYPTED' || normalized.includes('not encrypted') || normalized.includes('not password protected')) {
      throw new Error('Este PDF não tem senha.');
    }
    if (
      normalized.includes('incorrect password') ||
      normalized.includes('wrong password') ||
      normalized.includes('invalid password') ||
      normalized.includes('bad password')
    ) {
      throw new Error('A senha informada está incorreta.');
    }
    if (normalized.includes('unsupported encryption') || normalized.includes('unsupported security handler')) {
      throw new Error('Este tipo de proteção ainda não é suportado pelo desbloqueio local.');
    }
    if (normalized.includes('failed to fetch') || normalized.includes('fetch')) {
      throw new Error('O mecanismo local de desbloqueio não carregou corretamente. Reinicie o app e tente novamente.');
    }
    throw new Error('Não foi possível desbloquear o PDF. Verifique a senha ou a integridade do arquivo.');
  }

  try {
    const normalizedDoc = await PDFDocument.load(decryptedBytes, { ignoreEncryption: true });
    decryptedBytes = await serializePdfForOutput(normalizedDoc, isCancelled);
  } catch (error) {
    console.warn('Post-decryption optimization skipped:', error);
  }

  ensureNotCancelled(isCancelled);
  await ensureParentDirectory(outputPath);
  const tempPath = buildTempOutputPath(outputPath);

  try {
    await fs.promises.writeFile(tempPath, decryptedBytes);
    ensureNotCancelled(isCancelled);

    if (!(await validatePdfIntegrity(tempPath))) {
      throw new Error('Falha ao validar o PDF desbloqueado.');
    }

    ensureNotCancelled(isCancelled);
    await commitFileAtomically(tempPath, outputPath);
    await maybeApplyAggressiveCompression(outputPath, isCancelled);
  } catch (error) {
    await fs.promises.unlink(tempPath).catch(() => {});
    throw error;
  }
}

async function redactPdf(inputPath, outputPath, options = {}, isCancelled = () => false, updateProgress = () => {}) {
  if (!isValidPdfPath(inputPath)) {
    throw new Error('Não foi possível abrir este PDF para processamento.');
  }
  if (!options || !Array.isArray(options.redactedPages) || options.redactedPages.length === 0) {
    throw new Error('Nenhuma página para ocultação foi informada.');
  }

  ensureNotCancelled(isCancelled);
  const sourceBytes = await readPdfBuffer(inputPath, isCancelled);
  const sourcePdf = await PDFDocument.load(sourceBytes);
  const pageCount = sourcePdf.getPageCount();

  const sourceOutline = readOutline(sourcePdf);

  const redactedMap = new Map();
  for (const item of options.redactedPages) {
    redactedMap.set(item.pageIndex, item.imagePath);
  }

  const targetPdf = await PDFDocument.create();
  const usedImagePaths = [];

  for (let i = 0; i < pageCount; i += 1) {
    ensureNotCancelled(isCancelled);
    if (redactedMap.has(i)) {
      const originalPage = sourcePdf.getPage(i);
      const { width, height } = originalPage.getSize();
      const newPage = targetPdf.addPage([width, height]);

      const imagePath = redactedMap.get(i);
      const imgBytes = await fs.promises.readFile(imagePath);
      const isPng = imagePath.toLowerCase().endsWith('.png');
      const embeddedImage = isPng ? await targetPdf.embedPng(imgBytes) : await targetPdf.embedJpg(imgBytes);

      newPage.drawImage(embeddedImage, {
        x: 0,
        y: 0,
        width,
        height
      });

      usedImagePaths.push(imagePath);
    } else {
      const [copiedPage] = await targetPdf.copyPages(sourcePdf, [i]);
      targetPdf.addPage(copiedPage);
    }

    updatePagedProgress(updateProgress, i, pageCount, 10, 80);
  }

  if (sourceOutline) {
    writeOutline(targetPdf, sourceOutline);
  }

  ensureNotCancelled(isCancelled);
  await saveAndValidatePdf(targetPdf, outputPath, isCancelled);

  // Only delete the source stamp images once the final PDF is committed,
  // so a failed/cancelled attempt can retry using the same stamps.
  await Promise.all(usedImagePaths.map((imagePath) => fs.promises.unlink(imagePath).catch(() => {})));
}

module.exports = {
  hasDigitalSignatures,
  validatePdfIntegrity,
  mergePdfs,
  splitPdfByPages,
  splitPdfByRanges,
  splitPdfBySize,
  organizePdf,
  compressPdf,
  compressImage,
  encryptPdf,
  decryptPdf,
  redactPdf,
  applyWatermarkBatch,
  __internal: {
    readPdfBuffer,
    saveAndValidatePdf,
    ensureNotCancelled
  }
};

