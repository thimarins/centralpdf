const fs = require('fs');
const path = require('path');
const { PDFDocument, degrees, rgb } = require('pdf-lib');
const { inspectConvertibleImage } = require('./image-validation');
const { sanitizeFilename } = require('../../utils');
const { AUTO_IMAGE_MAX_DIMENSION, AUTO_JPEG_QUALITY, normalizeQuarterTurn } = require('../../image-processing');

const A4_PAGE = {
  portrait: { width: 595.28, height: 841.89 },
  landscape: { width: 841.89, height: 595.28 }
};

const SAFE_MARGIN = 28;
const MIRRORED_EXIF_ORIENTATIONS = new Set([2, 4, 5, 7]);

function ensureNotCancelled(isCancelled) {
  if (typeof isCancelled === 'function' && isCancelled()) {
    throw new Error('OPERATION_CANCELLED');
  }
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
    if (err && (err.code === 'EEXIST' || err.code === 'EPERM')) {
      await fs.promises.unlink(outputPath).catch(() => {});
      await fs.promises.rename(tempPath, outputPath);
      return;
    }
    throw err;
  }
}

async function validateGeneratedPdf(tempPath) {
  try {
    const bytes = await fs.promises.readFile(tempPath);
    await PDFDocument.load(bytes, { ignoreEncryption: true });
    return true;
  } catch {
    return false;
  }
}

async function savePdfAtomically(pdfDoc, outputPath, isCancelled = () => false) {
  await ensureParentDirectory(outputPath);
  const tempPath = buildTempOutputPath(outputPath);
  const pdfBytes = await pdfDoc.save({
    useObjectStreams: true,
    addDefaultPage: false,
    updateFieldAppearances: false,
    addCompatibleMetadata: false
  });
  ensureNotCancelled(isCancelled);

  try {
    await fs.promises.writeFile(tempPath, pdfBytes);
    ensureNotCancelled(isCancelled);

    if (!(await validateGeneratedPdf(tempPath))) {
      throw new Error('Falha ao validar o PDF gerado.');
    }

    ensureNotCancelled(isCancelled);
    await commitFileAtomically(tempPath, outputPath);
  } catch (error) {
    await fs.promises.unlink(tempPath).catch(() => {});
    throw error;
  }
}

function resolvePageBox(dimensions = {}) {
  const width = dimensions.width || 1;
  const height = dimensions.height || 1;
  return width >= height ? A4_PAGE.landscape : A4_PAGE.portrait;
}

function fitInsidePage(sourceWidth, sourceHeight, pageWidth, pageHeight) {
  const usableWidth = Math.max(1, pageWidth - SAFE_MARGIN * 2);
  const usableHeight = Math.max(1, pageHeight - SAFE_MARGIN * 2);
  const scale = Math.min(usableWidth / sourceWidth, usableHeight / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;

  return {
    width,
    height,
    x: (pageWidth - width) / 2,
    y: (pageHeight - height) / 2
  };
}

function parseJpegExifOrientation(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return 1;
  }

  let offset = 2;
  while (offset + 4 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = buffer[offset + 1];
    if (marker === 0xda || marker === 0xd9) break;
    const segmentLength = buffer.readUInt16BE(offset + 2);
    if (!segmentLength || segmentLength < 2 || offset + 2 + segmentLength > buffer.length) break;

    if (marker === 0xe1) {
      const exifHeader = buffer.toString('ascii', offset + 4, offset + 10);
      if (exifHeader === 'Exif\0\0') {
        const tiffStart = offset + 10;
        const littleEndian = buffer.toString('ascii', tiffStart, tiffStart + 2) === 'II';
        const readUInt16 = (position) => littleEndian ? buffer.readUInt16LE(position) : buffer.readUInt16BE(position);
        const readUInt32 = (position) => littleEndian ? buffer.readUInt32LE(position) : buffer.readUInt32BE(position);
        const firstIfdOffset = readUInt32(tiffStart + 4);
        const ifdStart = tiffStart + firstIfdOffset;
        if (ifdStart + 2 <= buffer.length) {
          const entries = readUInt16(ifdStart);
          for (let index = 0; index < entries; index += 1) {
            const entryOffset = ifdStart + 2 + (index * 12);
            if (entryOffset + 12 > buffer.length) break;
            const tag = readUInt16(entryOffset);
            if (tag === 0x0112) {
              const value = readUInt16(entryOffset + 8);
              return value >= 1 && value <= 8 ? value : 1;
            }
          }
        }
      }
    }

    offset += 2 + segmentLength;
  }

  return 1;
}

function getOrientationRotation(orientation = 1) {
  if (orientation === 3) return 180;
  if (orientation === 6) return 90;
  if (orientation === 8) return 270;
  return 0;
}

async function normalizeMirroredJpegOrientation(originalBytes, orientation) {
  if (!MIRRORED_EXIF_ORIENTATIONS.has(orientation)) return null;

  const { createCanvas, loadImage } = require('@napi-rs/canvas');
  const source = await loadImage(originalBytes);
  const sourceWidth = Math.max(1, Number(source.width) || 1);
  const sourceHeight = Math.max(1, Number(source.height) || 1);
  const canvas = createCanvas(sourceWidth, sourceHeight);
  const context = canvas.getContext('2d');

  // The raster decoder applies EXIF before drawing. Exporting that decoded
  // image to PNG removes the mirrored EXIF metadata while preserving its
  // visual orientation for pdf-lib.
  context.drawImage(source, 0, 0, sourceWidth, sourceHeight);
  return {
    bytes: Buffer.from(canvas.toBuffer('image/png')),
    extension: '.png',
    orientation: 1,
    dimensions: { width: sourceWidth, height: sourceHeight }
  };
}

function getRotatedDimensions(dimensions = {}, rotation = 0) {
  const width = Math.max(1, Number(dimensions.width) || 1);
  const height = Math.max(1, Number(dimensions.height) || 1);
  const normalizedRotation = normalizeQuarterTurn(rotation);
  return normalizedRotation === 90 || normalizedRotation === 270
    ? { width: height, height: width }
    : { width, height };
}

function resolveRotatedImageDrawOptions(placement, rotation = 0) {
  const normalizedRotation = normalizeQuarterTurn(rotation);
  if (normalizedRotation === 90) {
    return {
      x: placement.x + placement.width,
      y: placement.y,
      width: placement.height,
      height: placement.width,
      rotate: degrees(90)
    };
  }
  if (normalizedRotation === 180) {
    return {
      x: placement.x + placement.width,
      y: placement.y + placement.height,
      width: placement.width,
      height: placement.height,
      rotate: degrees(180)
    };
  }
  if (normalizedRotation === 270) {
    return {
      x: placement.x,
      y: placement.y + placement.height,
      width: placement.height,
      height: placement.width,
      rotate: degrees(270)
    };
  }
  return {
    x: placement.x,
    y: placement.y,
    width: placement.width,
    height: placement.height
  };
}

async function readImageBytes(filePath) {
  return fs.promises.readFile(filePath);
}

async function prepareImageForPdf(filePath, inspection = {}) {
  const extension = path.extname(filePath).toLowerCase();
  const originalBytes = await readImageBytes(filePath);
  const originalOrientation = extension === '.jpg' || extension === '.jpeg'
    ? parseJpegExifOrientation(originalBytes)
    : 1;
  const originalDimensions = {
    width: Math.max(1, Number(inspection.dimensions?.width) || 1),
    height: Math.max(1, Number(inspection.dimensions?.height) || 1)
  };

  const normalizedMirroredImage = await normalizeMirroredJpegOrientation(originalBytes, originalOrientation);
  if (normalizedMirroredImage) {
    return normalizedMirroredImage;
  }

  let nativeImageModule;
  try {
    nativeImageModule = require('electron').nativeImage;
  } catch {}

  if (!nativeImageModule) {
    return {
      bytes: originalBytes,
      extension,
      orientation: originalOrientation,
      dimensions: originalDimensions
    };
  }

  const rawImage = nativeImageModule.createFromPath(filePath);
  if (!rawImage || rawImage.isEmpty()) {
    return {
      bytes: originalBytes,
      extension,
      orientation: originalOrientation,
      dimensions: originalDimensions
    };
  }

  const sourceSize = rawImage.getSize();
  const sourceWidth = Math.max(1, sourceSize.width || originalDimensions.width || 1);
  const sourceHeight = Math.max(1, sourceSize.height || originalDimensions.height || 1);
  const needsResize = sourceWidth > AUTO_IMAGE_MAX_DIMENSION || sourceHeight > AUTO_IMAGE_MAX_DIMENSION;
  const shouldReencodeJpeg = extension === '.jpg' || extension === '.jpeg';

  if (!needsResize && !shouldReencodeJpeg) {
    return {
      bytes: originalBytes,
      extension,
      orientation: originalOrientation,
      dimensions: originalDimensions
    };
  }

  let resizedImage = rawImage;
  if (needsResize) {
    if (sourceWidth >= sourceHeight) {
      resizedImage = rawImage.resize({
        width: AUTO_IMAGE_MAX_DIMENSION,
        height: Math.max(1, Math.round((sourceHeight * AUTO_IMAGE_MAX_DIMENSION) / sourceWidth)),
        quality: 'good'
      });
    } else {
      resizedImage = rawImage.resize({
        width: Math.max(1, Math.round((sourceWidth * AUTO_IMAGE_MAX_DIMENSION) / sourceHeight)),
        height: AUTO_IMAGE_MAX_DIMENSION,
        quality: 'good'
      });
    }
  }

  const optimizedBytes = shouldReencodeJpeg
    ? Buffer.from(resizedImage.toJPEG(AUTO_JPEG_QUALITY))
    : resizedImage.toPNG();

  if (!optimizedBytes || optimizedBytes.length === 0 || optimizedBytes.length >= originalBytes.length) {
    return {
      bytes: originalBytes,
      extension,
      orientation: originalOrientation,
      dimensions: originalDimensions
    };
  }

  const optimizedSize = resizedImage.getSize();
  return {
    bytes: optimizedBytes,
    extension: shouldReencodeJpeg ? '.jpg' : extension,
    orientation: 1,
    dimensions: {
      width: Math.max(1, optimizedSize.width || sourceWidth),
      height: Math.max(1, optimizedSize.height || sourceHeight)
    }
  };
}

async function embedPreparedImage(pdfDoc, preparedImage) {
  if (preparedImage.extension === '.png') {
    return {
      image: await pdfDoc.embedPng(preparedImage.bytes),
      orientation: preparedImage.orientation,
      dimensions: preparedImage.dimensions
    };
  }

  return {
    image: await pdfDoc.embedJpg(preparedImage.bytes),
    orientation: preparedImage.orientation,
    dimensions: preparedImage.dimensions
  };
}

async function convertImagesToPdf(inputPaths, outputPath, updateProgress = () => {}, isCancelled = () => false, options = {}) {
  const inspections = inputPaths.map((filePath) => inspectConvertibleImage(filePath));
  const invalid = inspections.find((inspection) => !inspection.ok);
  if (invalid) {
    throw new Error(`Imagem inválida ou não suportada: ${path.basename(invalid.filePath || '')}`);
  }

  const pdfDoc = await PDFDocument.create();

  for (let index = 0; index < inputPaths.length; index += 1) {
    ensureNotCancelled(isCancelled);
    const inputPath = inputPaths[index];
    const inspection = inspections[index];
    const preparedImage = await prepareImageForPdf(inputPath, inspection);
    const { image, orientation, dimensions } = await embedPreparedImage(pdfDoc, preparedImage);
    const manualRotation = normalizeQuarterTurn(options.sourceRotations?.[index]);
    const combinedRotation = normalizeQuarterTurn(getOrientationRotation(orientation) + manualRotation);
    const effectiveDimensions = getRotatedDimensions(dimensions, combinedRotation);
    const pageBox = resolvePageBox(effectiveDimensions);
    const page = pdfDoc.addPage([pageBox.width, pageBox.height]);
    const placement = fitInsidePage(effectiveDimensions.width, effectiveDimensions.height, pageBox.width, pageBox.height);

    page.drawRectangle({
      x: 0,
      y: 0,
      width: pageBox.width,
      height: pageBox.height,
      color: rgb(1, 1, 1)
    });
    page.drawImage(image, resolveRotatedImageDrawOptions(placement, combinedRotation));

    const itemProgress = Math.round(((index + 1) / inputPaths.length) * 100);
    updateProgress({
      progress: Math.min(96, itemProgress),
      itemProgress,
      currentItem: index + 1,
      totalItems: inputPaths.length,
      currentItemName: path.basename(inputPath)
    });
    if ((index + 1) % 4 === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  ensureNotCancelled(isCancelled);
  await savePdfAtomically(pdfDoc, outputPath, isCancelled);

  return {
    outputPath,
    pageCount: inputPaths.length,
    outputName: sanitizeFilename(path.basename(outputPath))
  };
}

module.exports = {
  convertImagesToPdf,
  prepareImageForPdf
};
