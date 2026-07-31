const path = require('path');
const fs = require('fs');
const PDF_LIMITS = {
  warningBytes: 300 * 1024 * 1024,
  heavyModeBytes: 1024 * 1024 * 1024,
  maxSupportedBytes: 2 * 1024 * 1024 * 1024
};

const IMAGE_LIMITS = {
  maxImageBytes: 25 * 1024 * 1024,
  maxSvgBytes: 5 * 1024 * 1024,
  maxRasterPixels: 64 * 1024 * 1024
};

function readFileSlice(filePath, offset, length) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

function hasPdfMagicBytes(filePath) {
  try {
    const header = readFileSlice(filePath, 0, 8).toString('latin1');
    return header.startsWith('%PDF-');
  } catch (err) {
    return false;
  }
}

function readFileSliceAsync(filePath, offset, length) {
  return fs.promises.open(filePath, 'r').then(async (handle) => {
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  });
}

function hasPdfTailMarker(filePath) {
  try {
    const stats = fs.statSync(filePath);
    const readSize = Math.min(2048, stats.size);
    const tail = readFileSlice(filePath, Math.max(0, stats.size - readSize), readSize).toString('latin1');
    return tail.includes('%%EOF');
  } catch (err) {
    return false;
  }
}

function inspectPdfFile(filePath, maxSizeBytes = PDF_LIMITS.maxSupportedBytes) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    return { ok: false, reason: 'path', filePath, warnings: [] };
  }

  try {
    const stats = fs.statSync(filePath);
    const size = stats.size;
    const extensionValid = path.extname(filePath).toLowerCase() === '.pdf';
    const magicBytesValid = extensionValid && hasPdfMagicBytes(filePath);
    const tailMarkerValid = extensionValid && hasPdfTailMarker(filePath);
    const warnings = [];

    if (size >= PDF_LIMITS.warningBytes) warnings.push('large');
    if (size >= PDF_LIMITS.heavyModeBytes) warnings.push('heavy-mode');
    if (size >= PDF_LIMITS.maxSupportedBytes * 0.95) warnings.push('near-limit');
    if (!tailMarkerValid) warnings.push('tail-marker-missing');

    return {
      ok: stats.isFile() && extensionValid && magicBytesValid && size <= maxSizeBytes,
      filePath,
      size,
      isFile: stats.isFile(),
      extensionValid,
      magicBytesValid,
      tailMarkerValid,
      warnings
    };
  } catch (err) {
    return { ok: false, reason: err.message, filePath, warnings: [] };
  }
}

function hasPdfEncryptionDictionary(filePath) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    return false;
  }

  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile() || stats.size <= 0) return false;

    const sampleSize = Math.min(128 * 1024, stats.size);
    const tail = readFileSlice(filePath, Math.max(0, stats.size - sampleSize), sampleSize).toString('latin1');
    if (tail.includes('/Encrypt')) return true;

    const headSize = Math.min(64 * 1024, stats.size);
    const head = readFileSlice(filePath, 0, headSize).toString('latin1');
    return head.includes('/Encrypt');
  } catch (err) {
    return false;
  }
}

async function hasPdfEncryptionDictionaryAsync(filePath) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    return false;
  }

  try {
    const stats = await fs.promises.stat(filePath);
    if (!stats.isFile() || stats.size <= 0) return false;

    const sampleSize = Math.min(128 * 1024, stats.size);
    const tail = (await readFileSliceAsync(filePath, Math.max(0, stats.size - sampleSize), sampleSize)).toString('latin1');
    if (tail.includes('/Encrypt')) return true;

    const headSize = Math.min(64 * 1024, stats.size);
    const head = (await readFileSliceAsync(filePath, 0, headSize)).toString('latin1');
    return head.includes('/Encrypt');
  } catch (err) {
    return false;
  }
}

/**
 * Sanitizes a filename by removing invalid NTFS/Windows characters and preventing directory traversal.
 * @param {string} filename 
 * @returns {string}
 */
function sanitizeFilename(filename) {
  if (typeof filename !== 'string') return '';
  // Remove directory paths to prevent traversal
  let baseName = path.basename(filename);
  // Replace invalid characters: \ / : * ? " < > | and control characters
  baseName = baseName.replace(/[\\/:*?"<>|\x00-\x1F\x7F]/g, '_');
  // Avoid reserved Windows names
  const reservedNames = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)$/i;
  if (reservedNames.test(baseName)) {
    baseName = 'safe_' + baseName;
  }
  // Trim leading/trailing spaces and dots
  baseName = baseName.trim().replace(/^\.+|\.+$/g, '');
  return baseName || 'unnamed_file';
}

/**
 * Given a desired output path, atomically claims it (or the first
 * "name (1).ext", "name (2).ext", ... variant that is free) by creating an
 * empty placeholder file there via exclusive create (O_EXCL). This is what
 * makes the check-and-claim race-free across concurrent workers/processes,
 * not just within a single thread: two callers racing for the same name can
 * never both "win" the same path, because the OS serializes the exclusive
 * create. The caller is expected to write the real content shortly after
 * (via a temp-file-then-rename commit), which overwrites the placeholder.
 * @param {string} outputPath
 * @returns {string}
 */
function resolveUniqueOutputPath(outputPath) {
  const parsed = path.parse(outputPath);
  fs.mkdirSync(parsed.dir, { recursive: true });

  let candidate = outputPath;
  let counter = 0;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(candidate, 'wx'));
      return candidate;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      counter += 1;
      candidate = path.join(parsed.dir, `${parsed.name} (${counter})${parsed.ext}`);
    }
  }
}

/**
 * Validates a file path to ensure it is absolute and belongs to an existing file.
 * @param {string} filePath 
 * @param {number} maxSizeBytes Maximum allowed file size in bytes (default 300MB)
 * @returns {boolean}
 */
function isValidPdfPath(filePath, maxSizeBytes = PDF_LIMITS.maxSupportedBytes) {
  return inspectPdfFile(filePath, maxSizeBytes).ok;
}

function parsePngDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;
  const signature = buffer.subarray(0, 8).toString('hex');
  if (signature !== '89504e470d0a1a0a') return null;
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  };
}

function parseJpegDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    const segmentLength = buffer.readUInt16BE(offset + 2);
    const isStartOfFrame = marker >= 0xc0 && marker <= 0xc3;
    if (isStartOfFrame && offset + 8 < buffer.length) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7)
      };
    }
    if (!segmentLength || segmentLength < 2) break;
    offset += 2 + segmentLength;
  }
  return null;
}

function inspectImageBuffer(buffer, extension) {
  const normalizedExt = String(extension || '').toLowerCase();
  if (normalizedExt === '.png') {
    const dimensions = parsePngDimensions(buffer);
    if (!dimensions) return { ok: false, reason: 'invalid-png' };
    return {
      ok: dimensions.width > 0 && dimensions.height > 0 && (dimensions.width * dimensions.height) <= IMAGE_LIMITS.maxRasterPixels,
      kind: 'png',
      dimensions
    };
  }

  if (normalizedExt === '.jpg' || normalizedExt === '.jpeg') {
    const dimensions = parseJpegDimensions(buffer);
    if (!dimensions) return { ok: false, reason: 'invalid-jpeg' };
    return {
      ok: dimensions.width > 0 && dimensions.height > 0 && (dimensions.width * dimensions.height) <= IMAGE_LIMITS.maxRasterPixels,
      kind: 'jpeg',
      dimensions
    };
  }

  return { ok: false, reason: 'unsupported-image' };
}

function inspectImageFile(filePath, maxSizeBytes = IMAGE_LIMITS.maxImageBytes) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    return { ok: false, reason: 'path' };
  }

  try {
    const stats = fs.statSync(filePath);
    const extension = path.extname(filePath).toLowerCase();
    if (!stats.isFile() || stats.size > maxSizeBytes) {
      return { ok: false, reason: 'size' };
    }

    if (extension === '.svg') {
      if (stats.size > IMAGE_LIMITS.maxSvgBytes) {
        return { ok: false, reason: 'svg-size' };
      }
      const svg = fs.readFileSync(filePath, 'utf8');
      const forbidden = /<script|foreignObject|xlink:href\s*=|href\s*=\s*["']https:|onload\s*=|onerror\s*=/i.test(svg);
      return {
        ok: !forbidden && /<svg[\s>]/i.test(svg),
        kind: 'svg'
      };
    }

    const header = readFileSlice(filePath, 0, 512 * 1024);
    return inspectImageBuffer(header, extension);
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

async function inspectPdfFileAsync(filePath, maxSizeBytes = PDF_LIMITS.maxSupportedBytes) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    return { ok: false, reason: 'path', filePath, warnings: [] };
  }

  try {
    const stats = await fs.promises.stat(filePath);
    const size = stats.size;
    const extensionValid = path.extname(filePath).toLowerCase() === '.pdf';
    const header = extensionValid ? (await readFileSliceAsync(filePath, 0, 8)).toString('latin1') : '';
    const readSize = Math.min(2048, size);
    const tail = extensionValid ? (await readFileSliceAsync(filePath, Math.max(0, size - readSize), readSize)).toString('latin1') : '';
    const magicBytesValid = extensionValid && header.startsWith('%PDF-');
    const tailMarkerValid = extensionValid && tail.includes('%%EOF');
    const warnings = [];

    if (size >= PDF_LIMITS.warningBytes) warnings.push('large');
    if (size >= PDF_LIMITS.heavyModeBytes) warnings.push('heavy-mode');
    if (size >= PDF_LIMITS.maxSupportedBytes * 0.95) warnings.push('near-limit');
    if (!tailMarkerValid) warnings.push('tail-marker-missing');

    return {
      ok: stats.isFile() && extensionValid && magicBytesValid && size <= maxSizeBytes,
      filePath,
      size,
      isFile: stats.isFile(),
      extensionValid,
      magicBytesValid,
      tailMarkerValid,
      warnings
    };
  } catch (err) {
    return { ok: false, reason: err.message, filePath, warnings: [] };
  }
}

/**
 * Validates a local watermark image path.
 * @param {string} filePath
 * @param {number} maxSizeBytes
 * @returns {boolean}
 */
function isValidImagePath(filePath, maxSizeBytes = IMAGE_LIMITS.maxImageBytes) {
  return inspectImageFile(filePath, maxSizeBytes).ok;
}

/**
 * Safely parses integer array range string (e.g. "1-3, 5, 7-10") into an array of 0-indexed page numbers.
 * @param {string} rangeStr 
 * @param {number} totalPages Total pages in PDF (1-based index)
 * @returns {number[]} Array of 0-based page numbers
 */
function parsePageRanges(rangeStr, totalPages) {
  if (typeof rangeStr !== 'string') return [];
  const pages = new Set();
  const parts = rangeStr.split(',');
  
  for (let part of parts) {
    part = part.trim();
    if (!part) continue;
    
    if (part.includes('-')) {
      const bounds = part.split('-');
      if (bounds.length !== 2) continue;
      const start = parseInt(bounds[0].trim(), 10);
      const end = parseInt(bounds[1].trim(), 10);
      
      if (!isNaN(start) && !isNaN(end) && start > 0 && end > 0 && start <= totalPages && end <= totalPages) {
        const min = Math.min(start, end);
        const max = Math.max(start, end);
        for (let i = min; i <= max; i++) {
          pages.add(i - 1); // convert to 0-indexed
        }
      }
    } else {
      const page = parseInt(part, 10);
      if (!isNaN(page) && page > 0 && page <= totalPages) {
        pages.add(page - 1);
      }
    }
  }
  
  return Array.from(pages).sort((a, b) => a - b);
}

module.exports = {
  PDF_LIMITS,
  IMAGE_LIMITS,
  sanitizeFilename,
  resolveUniqueOutputPath,
  isValidPdfPath,
  isValidImagePath,
  parsePageRanges,
  hasPdfMagicBytes,
  hasPdfTailMarker,
  hasPdfEncryptionDictionary,
  hasPdfEncryptionDictionaryAsync,
  inspectPdfFile,
  inspectPdfFileAsync,
  inspectImageFile
};
