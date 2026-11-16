const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { PDFDocument, PDFPage, StandardFonts, rgb, degrees, PDFName, PDFBool, PDFArray, PDFRef, PDFStream, PDFHexString } = require('pdf-lib');
const { createWorker, PSM } = require('tesseract.js');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const UTIF = require('utif');
const { inspectPdfFile, PDF_LIMITS, IMAGE_LIMITS, inspectImageBuffer, sanitizeFilename, resolveUniqueOutputPath } = require('../../utils');
const { getOcrRuntimeStatus, getOcrTessdataDirectory } = require('./ocr-runtime');
const { openPdfJsDocumentFromFile } = require('./pdf-range-transport');
const { suggestSplitStarts } = require('./split-start-suggestions');
const OCR_TESSDATA = getOcrTessdataDirectory();
const OCR_LANGUAGES = new Set(['por', 'eng']);
const OCR_DEFAULT_LANGUAGE = 'por+eng';
const OCR_RENDER_SCALE = 2;
const OCR_MAX_RENDER_PIXELS = IMAGE_LIMITS.maxOcrPagePixels;
const OCR_ADAPTIVE_THRESHOLD_MAX_PIXELS = 4_000_000;
const OCR_ISOLATED_NOISE_MAX_PIXELS = 1_000_000;
const OCR_HYBRID_IMAGE_COVERAGE_THRESHOLD = 0.18;
const OCR_HYBRID_MAX_NATIVE_CHARACTERS = 160;
const OCR_DEFAULT_MODE = 'auto';
const OCR_PROCESSED_PAGE_KEY = PDFName.of('CentralPDFOCRProcessed');
const OCR_LAYER_CONTENTS_KEY = PDFName.of('CentralPDFOCRLayerContents');
const OCR_LAYER_STREAM_KEY = PDFName.of('CentralPDFOCRLayer');
const OCR_LAYER_ABSENT_KEY = PDFName.of('CentralPDFOCRLayerAbsent');
const OCR_NATIVE_BOXES_KEY = PDFName.of('CentralPDFOCRNativeBoxes');
const OCR_NATIVE_BOXES_MAX_BYTES = 512 * 1024;
const OCR_REDACTION_MIN_CONFIDENCE = 75;
const OCR_REDACTION_MAX_CANDIDATES = 500;
const PDFJS_STANDARD_FONTS = `${path.resolve(path.dirname(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')), '../../standard_fonts').replace(/\\/g, '/')}/`;
const PDFJS_WORKER_SOURCE = pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')).href;

function getSourceFingerprint(stats) {
  // On Windows, ctime is the metadata-change timestamp and can be updated by
  // antivirus/indexing activity during a long read without changing the PDF.
  // Keep file identity, size and content modification time in the guard there.
  const identity = `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}`;
  return process.platform === 'win32' ? identity : `${identity}:${stats.ctimeMs}`;
}

function normalizeOcrDocumentError(error) {
  const name = String(error?.name || '');
  const message = String(error?.message || '');
  const code = Number(error?.code);
  if (name === 'PasswordException' || code === 1 || code === 2 || /(?:password|senha).{0,40}(?:required|incorrect|protected|necess[aá]ria|incorreta|protegido)|(?:encrypted|criptografad)/i.test(message)) {
    const normalized = new Error('Este PDF está protegido por senha. Use “Desbloquear PDF” e tente novamente.', { cause: error });
    normalized.code = 'PDF_PROTECTED';
    normalized.safeUserMessage = normalized.message;
    return normalized;
  }
  if (name === 'InvalidPDFException' || name === 'FormatError') {
    const normalized = new Error('Este PDF parece inválido ou danificado. Confira o arquivo e tente novamente.', { cause: error });
    normalized.code = 'PDF_INVALID';
    normalized.safeUserMessage = normalized.message;
    return normalized;
  }
  return error;
}

function normalizeOcrReadError(error, operation = 'reconhecimento') {
  const code = typeof error?.code === 'string' ? error.code : '';
  const messageByCode = {
    ENOSPC: 'Não foi possível preparar o processamento porque não há espaço suficiente no disco. Libere espaço e tente novamente.',
    EDQUOT: 'Não foi possível preparar o processamento porque o limite de armazenamento foi atingido. Libere espaço e tente novamente.',
    EACCES: 'Não foi possível acessar o PDF. Verifique as permissões e se o arquivo está aberto em outro programa.',
    EPERM: 'O Windows impediu o acesso ao PDF. Verifique as permissões e tente novamente.',
    EBUSY: 'O PDF está em uso por outro programa. Feche-o e tente novamente.',
    ENOENT: 'O PDF não foi encontrado durante o processamento. Adicione o arquivo novamente.',
    EIO: 'Ocorreu uma falha ao ler o PDF. Verifique a unidade e tente novamente.'
  };
  const message = Object.hasOwn(messageByCode, code)
    ? messageByCode[code]
    : `Não foi possível ler o PDF durante o ${operation}. Verifique se o arquivo continua acessível e tente novamente.`;
  const normalized = new Error(message, { cause: error });
  normalized.safeUserMessage = message;
  if (Object.hasOwn(messageByCode, code)) normalized.code = code;
  return normalized;
}

function normalizeLanguages(value = OCR_DEFAULT_LANGUAGE) {
  const values = String(value).split(/[+,\s]+/).map((item) => item.trim().toLowerCase()).filter(Boolean);
  const selected = [...new Set(values.filter((item) => OCR_LANGUAGES.has(item)))];
  if (!selected.length) throw new Error('Selecione português, inglês ou os dois idiomas.');
  return selected.join('+');
}

function normalizeOcrMode(value = OCR_DEFAULT_MODE) {
  const mode = String(value || OCR_DEFAULT_MODE).trim().toLowerCase();
  if (![OCR_DEFAULT_MODE, 'complete', 'redo'].includes(mode)) {
    throw new Error('Modo de reconhecimento inválido. Use automático, completo ou refazer OCR.');
  }
  return mode;
}

function ensureSupportedLanguageFiles(language) {
  const status = getOcrRuntimeStatus(normalizeLanguages(language).split('+'));
  if (!status.available) throw new Error(status.message);
}

function normalizeText(text = '') {
  return String(text).replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function cleanRedundantText(text = '') {
  const rawLines = String(text || '').replace(/\r/g, '').split('\n');
  const result = [];
  for (const rawLine of rawLines) {
    const trimmed = rawLine.trim().replace(/[ \t]+/g, ' ');
    if (!trimmed) {
      if (result.length > 0 && result[result.length - 1] !== '') {
        result.push('');
      }
      continue;
    }
    if (result.length > 0 && result[result.length - 1] === trimmed) {
      continue;
    }
    if (result.length > 0) {
      const prev = result[result.length - 1];
      if (prev.length > 6 && trimmed.length > 6) {
        if (prev.includes(trimmed) && trimmed.length / prev.length > 0.85) continue;
        if (trimmed.includes(prev) && prev.length / trimmed.length > 0.85) {
          result[result.length - 1] = trimmed;
          continue;
        }
      }
    }
    result.push(trimmed);
  }
  return result.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function extractNativeTextInRect(textContent, viewport, rect) {
  if (!textContent?.items?.length || !viewport || !rect) return '';
  const matched = [];
  for (const item of textContent.items) {
    const str = typeof item.str === 'string' ? item.str : '';
    if (!str.trim()) continue;
    const transform = item.transform || [];
    if (transform.length < 6) continue;
    const x0 = Number(transform[4]);
    const y0 = Number(transform[5]);
    const width = Number(item.width) || 0;
    const height = Number(item.height) || Math.hypot(Number(transform[2]) || 0, Number(transform[3]) || 0);
    if (![x0, y0, width, height].every(Number.isFinite) || width <= 0 || height <= 0) continue;
    const p1 = viewport.convertToViewportPoint(x0, y0 - height * 0.2);
    const p2 = viewport.convertToViewportPoint(x0 + width, y0 + height * 0.8);
    const itemBox = {
      x0: Math.min(p1[0], p2[0]) / viewport.width,
      y0: Math.min(p1[1], p2[1]) / viewport.height,
      x1: Math.max(p1[0], p2[0]) / viewport.width,
      y1: Math.max(p1[1], p2[1]) / viewport.height
    };
    const overlapX = Math.max(0, Math.min(rect.x + rect.width, itemBox.x1) - Math.max(rect.x, itemBox.x0));
    const overlapY = Math.max(0, Math.min(rect.y + rect.height, itemBox.y1) - Math.max(rect.y, itemBox.y0));
    const itemArea = (itemBox.x1 - itemBox.x0) * (itemBox.y1 - itemBox.y0);
    const overlapArea = overlapX * overlapY;
    const centerX = (itemBox.x0 + itemBox.x1) / 2;
    const centerY = (itemBox.y0 + itemBox.y1) / 2;
    const centerInside = centerX >= rect.x && centerX <= rect.x + rect.width && centerY >= rect.y && centerY <= rect.y + rect.height;
    if (centerInside || (itemArea > 0 && overlapArea / itemArea >= 0.35)) {
      matched.push({ str, box: itemBox });
    }
  }
  if (!matched.length) return '';
  const uniqueMatched = [];
  for (const item of matched) {
    const isDup = uniqueMatched.some((existing) => {
      if (existing.str.trim() !== item.str.trim()) return false;
      const ox = Math.max(0, Math.min(existing.box.x1, item.box.x1) - Math.max(existing.box.x0, item.box.x0));
      const oy = Math.max(0, Math.min(existing.box.y1, item.box.y1) - Math.max(existing.box.y0, item.box.y0));
      const area = (item.box.x1 - item.box.x0) * (item.box.y1 - item.box.y0);
      return area > 0 && (ox * oy) / area >= 0.5;
    });
    if (!isDup) uniqueMatched.push(item);
  }
  uniqueMatched.sort((a, b) => {
    const lineDiff = a.box.y0 - b.box.y0;
    if (Math.abs(lineDiff) > 0.012) return lineDiff;
    return a.box.x0 - b.box.x0;
  });
  const lines = [];
  let currentLine = [];
  let lastY = null;
  let lastHeight = 0.015;
  for (const item of uniqueMatched) {
    const itemHeight = item.box.y1 - item.box.y0;
    const threshold = Math.max(0.008, Math.min(0.02, (itemHeight + lastHeight) * 0.5));
    if (lastY === null || Math.abs(item.box.y0 - lastY) <= threshold) {
      currentLine.push(item.str);
      lastY = item.box.y0;
      lastHeight = itemHeight;
    } else {
      lines.push(currentLine.join(' '));
      currentLine = [item.str];
      lastY = item.box.y0;
      lastHeight = itemHeight;
    }
  }
  if (currentLine.length) lines.push(currentLine.join(' '));
  return lines.join('\n');
}

function getOcrWords(ocrData) {
  if (Array.isArray(ocrData?.words) && ocrData.words.length > 0) return ocrData.words;
  return (Array.isArray(ocrData?.blocks) ? ocrData.blocks : [])
    .flatMap((block) => block.paragraphs || [])
    .flatMap((paragraph) => paragraph.lines || [])
    .flatMap((line) => line.words || []);
}

function pageNeedsOcr(text = '', imageCoverage = 0) {
  const normalized = normalizeText(text);
  if (!normalized) return true;
  const compact = normalized.replace(/\s/g, '');
  return compact.length < 20 || (compact.length < OCR_HYBRID_MAX_NATIVE_CHARACTERS
    && Number(imageCoverage) >= OCR_HYBRID_IMAGE_COVERAGE_THRESHOLD);
}

async function getPageImageCoverage(pdfPage, ops) {
  if (!pdfPage || !ops) return 0;
  const view = Array.isArray(pdfPage.view) ? pdfPage.view : [];
  const pageWidth = Number(view[2]) - Number(view[0]);
  const pageHeight = Number(view[3]) - Number(view[1]);
  const pageArea = pageWidth > 0 && pageHeight > 0
    ? pageWidth * pageHeight
    : (() => { const viewport = pdfPage.getViewport({ scale: 1 }); return viewport.width * viewport.height; })();
  if (!Number.isFinite(pageArea) || pageArea <= 0) return 0;

  const imagePaintOperations = new Set([
    ops.paintImageXObject,
    ops.paintInlineImageXObject,
    ops.paintImageXObjectGroup,
    ops.paintInlineImageXObjectGroup
  ].filter(Number.isFinite));
  const operatorList = await pdfPage.getOperatorList();
  const transformScales = [];
  let currentScale = 1;
  let estimatedImageArea = 0;
  for (let index = 0; index < operatorList.fnArray.length; index += 1) {
    const operation = operatorList.fnArray[index];
    if (operation === ops.save) {
      transformScales.push(currentScale);
    } else if (operation === ops.restore) {
      currentScale = transformScales.pop() ?? 1;
    } else if (operation === ops.transform) {
      const matrix = operatorList.argsArray[index];
      if (Array.isArray(matrix) && matrix.length >= 4) {
        const determinant = Math.abs((Number(matrix[0]) * Number(matrix[3])) - (Number(matrix[1]) * Number(matrix[2])));
        if (Number.isFinite(determinant) && determinant > 0) currentScale *= determinant;
      }
    } else if (imagePaintOperations.has(operation)) {
      estimatedImageArea += currentScale;
    }
  }
  return Math.max(0, Math.min(1, estimatedImageArea / pageArea));
}

async function pdfPageNeedsOcr(pdfPage, text = '', ops) {
  if (pageNeedsOcr(text)) return true;
  const compactLength = normalizeText(text).replace(/\s/g, '').length;
  if (compactLength >= OCR_HYBRID_MAX_NATIVE_CHARACTERS) return false;
  const imageCoverage = await getPageImageCoverage(pdfPage, ops);
  return pageNeedsOcr(text, imageCoverage);
}

async function analyzePdfOcrNeed(inputPath, progress = () => {}, isCancelled = () => false) {
  const inspection = inspectPdfFile(inputPath, PDF_LIMITS.maxSupportedBytes);
  if (!inspection.ok) throw new Error('Não foi possível analisar este PDF. Verifique se o arquivo é válido e tente novamente.');
  if (isCancelled()) throw new Error('OPERATION_CANCELLED');
  const pdfjs = await loadPdfJs();
  let fileDocument;
  try {
    fileDocument = await openPdfJsDocumentFromFile(pdfjs, inputPath, {
      standardFontDataUrl: PDFJS_STANDARD_FONTS,
      isEvalSupported: false,
      useWorkerFetch: false,
      stopAtErrors: true
    }, isCancelled);
  } catch (error) {
    if (isCancelled() || error?.message === 'OPERATION_CANCELLED') throw new Error('OPERATION_CANCELLED', { cause: error });
    const normalized = new Error('Não foi possível acessar este PDF para análise. Verifique se o arquivo ainda existe e se você tem permissão para abri-lo.', { cause: error });
    normalized.safeUserMessage = normalized.message;
    throw normalized;
  }
  const { loadingTask } = fileDocument;
  try {
    let pdf;
    try {
      pdf = await loadingTask.promise;
    } catch (error) {
      if (isCancelled() || error?.message === 'OPERATION_CANCELLED') throw new Error('OPERATION_CANCELLED', { cause: error });
      const readError = fileDocument.getReadError();
      if (readError) {
        const normalized = new Error('Não foi possível ler o PDF durante a análise. Verifique se o arquivo continua acessível.', { cause: readError });
        normalized.safeUserMessage = normalized.message;
        throw normalized;
      }
      throw normalizeOcrDocumentError(error);
    }
    const sampleCount = Math.min(pdf.numPages, 16);
    const sampledPages = [...new Set(Array.from({ length: sampleCount }, (_, index) => (
      sampleCount === 1 ? 1 : 1 + Math.round((index * (pdf.numPages - 1)) / (sampleCount - 1))
    )))];
    const pagesLikelyScanned = [];
    for (let index = 0; index < sampledPages.length; index += 1) {
      if (isCancelled()) throw new Error('OPERATION_CANCELLED');
      const pageNumber = sampledPages[index];
      const page = await pdf.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        const text = normalizeText((content.items || []).map((item) => item.str || '').join(' '));
        const imageCoverage = await getPageImageCoverage(page, pdfjs.OPS);
        if (imageCoverage >= 0.02 && pageNeedsOcr(text, imageCoverage)) pagesLikelyScanned.push(pageNumber);
      } finally {
        page.cleanup();
      }
      progress({ progress: Math.round(((index + 1) / sampledPages.length) * 100), page: pageNumber, totalPages: pdf.numPages });
    }
    return {
      status: pagesLikelyScanned.length ? 'scanned' : 'native',
      totalPages: pdf.numPages,
      sampledPages: sampledPages.length,
      pagesLikelyScanned
    };
  } finally {
    await loadingTask.destroy?.();
    await fileDocument.close();
  }
}

function parsePageRange(value, pageCount) {
  const source = String(value || '').trim();
  if (!source) return null;
  const selected = new Set();
  for (const part of source.split(',')) {
    const match = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!match) throw new Error('Intervalo inválido. Use, por exemplo, 1-3, 5.');
    const first = Number(match[1]);
    const last = Number(match[2] || match[1]);
    if (first < 1 || last < first || last > pageCount) throw new Error(`O intervalo deve estar entre as páginas 1 e ${pageCount}.`);
    for (let page = first; page <= last; page += 1) selected.add(page);
  }
  if (!selected.size) throw new Error('Informe pelo menos uma página válida.');
  return selected;
}

async function loadPdfJs() {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_SOURCE;
  return pdfjs;
}

class OcrCanvasFactory {
  constructor() {}

  create(width, height) {
    const canvas = createCanvas(width, height);
    return { canvas, context: canvas.getContext('2d') };
  }

  reset(entry, width, height) {
    entry.canvas.width = width;
    entry.canvas.height = height;
    entry.context = entry.canvas.getContext('2d');
  }

  destroy(entry) {
    if (!entry) return;
    entry.canvas.width = 0;
    entry.canvas.height = 0;
    entry.canvas = null;
    entry.context = null;
  }
}

function getOcrPdfDocument(pdfjs, options) {
  return pdfjs.getDocument({ ...options, CanvasFactory: OcrCanvasFactory });
}

function getSafeOcrRenderDimensions(width, height) {
  const safeWidth = Math.max(1, Math.ceil(Number(width) || 0));
  const safeHeight = Math.max(1, Math.ceil(Number(height) || 0));
  if (safeWidth * safeHeight > OCR_MAX_RENDER_PIXELS) {
    throw new Error('Esta página é grande demais para o OCR com segurança. Reduza a resolução ou divida o documento e tente novamente.');
  }
  return { width: safeWidth, height: safeHeight };
}

function validateTiffPages(ifds) {
  if (!Array.isArray(ifds) || ifds.length === 0) {
    throw new Error('O TIFF não contém páginas de imagem reconhecíveis.');
  }
  if (ifds.length > 1000) {
    throw new Error('O TIFF excede o limite de 1.000 páginas por arquivo.');
  }
  let totalPixels = 0;
  return ifds.map((ifd, index) => {
    // UTIF only exposes `width`/`height` after decodeImage; before allocating
    // anything, read the dimensions directly from the TIFF ImageWidth/Length tags.
    const width = Number(ifd?.width ?? ifd?.t256?.[0]);
    const height = Number(ifd?.height ?? ifd?.t257?.[0]);
    if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) {
      throw new Error(`A página ${index + 1} do TIFF tem dimensões inválidas.`);
    }
    const dimensions = getSafeOcrRenderDimensions(width, height);
    totalPixels += dimensions.width * dimensions.height;
    if (!Number.isSafeInteger(totalPixels) || totalPixels > IMAGE_LIMITS.maxRasterPixels) {
      const error = new Error('O TIFF tem resolução total alta demais para o reconhecimento. Divida o documento e tente novamente.');
      error.safeUserMessage = error.message;
      throw error;
    }
    return dimensions;
  });
}

function decodeTiffPageToPng(bytes, ifd, dimensions) {
  UTIF.decodeImage(bytes, ifd);
  const canvas = createCanvas(dimensions.width, dimensions.height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const imageData = context.createImageData(dimensions.width, dimensions.height);
  imageData.data.set(UTIF.toRGBA8(ifd));
  // UTIF retains decoded source pixels on the IFD. Release them before OCR
  // awaits so multipage TIFFs keep only the current page's raw raster alive.
  ifd.data = null;
  context.putImageData(imageData, 0, 0);
  return canvas.toBuffer('image/png');
}

function getTiffArrayBuffer(byteView) {
  const { buffer, byteOffset, byteLength } = byteView;
  // fs.readFile normally returns an exact-sized backing store. Reuse it to
  // avoid a second full-file allocation; pooled/subarray views must be copied
  // so UTIF cannot observe unrelated bytes outside the file content.
  if (byteOffset === 0 && byteLength === buffer.byteLength) return buffer;
  return buffer.slice(byteOffset, byteOffset + byteLength);
}

function getExactByteView(byteView) {
  const { buffer, byteOffset, byteLength } = byteView;
  if (byteOffset === 0 && byteLength === buffer.byteLength) return byteView;
  // pdf-lib's JPEG embedder reads from imageData.buffer at offset zero rather
  // than honoring a Buffer/Uint8Array byteOffset. Node may return pooled
  // Buffers for small images, so give it an exact-sized backing store.
  return new Uint8Array(buffer.slice(byteOffset, byteOffset + byteLength));
}

async function readOcrImage(inputPath) {
  const extension = path.extname(inputPath).toLowerCase();
  if (!['.png', '.jpg', '.jpeg', '.tif', '.tiff'].includes(extension)) {
    const error = new Error('Formato de imagem não compatível com o reconhecimento de texto.');
    error.safeUserMessage = error.message;
    throw error;
  }

  let handle;
  try {
    handle = await fs.promises.open(inputPath, 'r');
    const sourceStats = await handle.stat();
    if (!sourceStats.isFile()) throw Object.assign(new Error('O item selecionado não é um arquivo regular.'), { safeUserMessage: 'O item selecionado não é um arquivo de imagem válido.' });
    if (sourceStats.size < 1) throw Object.assign(new Error('O arquivo de imagem está vazio.'), { safeUserMessage: 'O arquivo de imagem está vazio.' });
    if (sourceStats.size > IMAGE_LIMITS.maxImageBytes) {
      throw Object.assign(new Error('A imagem excede o limite de 25 MB para reconhecimento.'), { safeUserMessage: 'A imagem excede o limite de 25 MB para reconhecimento.' });
    }

    const bytes = Buffer.allocUnsafe(sourceStats.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw Object.assign(new Error('O arquivo de imagem mudou ou foi truncado durante a leitura.'), { safeUserMessage: 'O arquivo de imagem mudou durante a leitura. Adicione-o novamente.' });
      offset += bytesRead;
    }
    const readStats = await handle.stat();
    if (getSourceFingerprint(readStats) !== getSourceFingerprint(sourceStats)) {
      throw Object.assign(new Error('O arquivo de imagem foi alterado durante a leitura.'), { safeUserMessage: 'O arquivo de imagem foi alterado durante a leitura. Adicione-o novamente.' });
    }
    const pathStats = await fs.promises.stat(inputPath);
    if (getSourceFingerprint(pathStats) !== getSourceFingerprint(sourceStats)) {
      throw Object.assign(new Error('O caminho da imagem mudou durante a leitura.'), { safeUserMessage: 'O arquivo de imagem mudou durante a leitura. Adicione-o novamente.' });
    }

    let ifds = null;
    let pageDimensions = null;
    if (extension === '.tif' || extension === '.tiff') {
      ifds = UTIF.decode(getTiffArrayBuffer(bytes));
      pageDimensions = validateTiffPages(ifds);
    } else {
      const inspection = inspectImageBuffer(bytes, extension, OCR_MAX_RENDER_PIXELS);
      if (!inspection.ok) throw Object.assign(new Error('A imagem não passou pela validação estrutural.'), { safeUserMessage: 'A imagem parece inválida, danificada ou grande demais para o reconhecimento.' });
    }

    return { bytes, ifds, pageDimensions, sourceFingerprint: getSourceFingerprint(sourceStats) };
  } catch (error) {
    if (error?.safeUserMessage) throw error;
    const safeError = new Error('Não foi possível ler a imagem. Verifique se o arquivo continua acessível e tente adicioná-lo novamente.', { cause: error });
    safeError.safeUserMessage = safeError.message;
    throw safeError;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function createOcrWorker(language, onProgress) {
  ensureSupportedLanguageFiles(language);
  const worker = await createWorker(normalizeLanguages(language), 1, {
    langPath: OCR_TESSDATA,
    gzip: false,
    cacheMethod: 'none',
    logger: (message) => onProgress?.(message)
  });
  try {
    // Tesseract.js' implicit segmentation default omitted prominent headings
    // and table rows in the labeled SmartScan image corpus. Pin AUTO so OCR
    // remains consistent across worker versions and form-like pages.
    await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
    return worker;
  } catch (error) {
    await Promise.resolve(worker.terminate?.()).catch(() => {});
    throw error;
  }
}

function createOcrWorkerSession(language, workerFactory = createOcrWorker) {
  let workerPromise = null;
  let activeWorker = null;
  let progressHandler = () => {};
  let closed = false;

  const reset = async () => {
    const worker = activeWorker || await workerPromise?.catch(() => null);
    activeWorker = null;
    workerPromise = null;
    await worker?.terminate?.();
  };

  return {
    async getWorker(onProgress) {
      if (closed) throw new Error('A sessão de OCR deste lote já foi encerrada.');
      progressHandler = typeof onProgress === 'function' ? onProgress : () => {};
      if (!workerPromise) {
        workerPromise = Promise.resolve()
          .then(() => workerFactory(language, (message) => progressHandler(message)))
          .then((worker) => {
            activeWorker = worker;
            return worker;
          });
      }
      return workerPromise;
    },
    reset,
    async terminate() {
      closed = true;
      await reset();
    }
  };
}

async function renderPdfPage(pdfPage, scale = OCR_RENDER_SCALE, { retainCanvas = false } = {}) {
  const viewport = pdfPage.getViewport({ scale });
  const { width, height } = getSafeOcrRenderDimensions(viewport.width, viewport.height);
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  // pdf.js otherwise creates its DOMCanvasFactory, which assumes `document`
  // exists. OCR runs in Electron utility processes where only the Skia canvas
  // implementation is available; inline images/patterns require this factory.
  let transferredCanvas = false;
  try {
    await pdfPage.render({ canvasContext: context, viewport }).promise;
    const bytes = canvas.toBuffer('image/png');
    transferredCanvas = retainCanvas;
    return { canvas: transferredCanvas ? canvas : null, bytes, width, height };
  } finally {
    // The PNG bytes are the only raster representation needed by OCR and
    // search. Drop the much larger native RGBA surface before the next page.
    if (!transferredCanvas) releaseOcrCanvas(canvas);
  }
}

function releaseOcrCanvas(canvas) {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
}

function scoreOcrResult(data = {}) {
  const text = normalizeText(data.text || '');
  if (!text) return -1;
  const words = getOcrWords(data).filter((word) => normalizeText(word?.text || ''));
  const confidence = Number.isFinite(Number(data.confidence)) ? Number(data.confidence) : 0;
  const lexicalRatio = [...text].filter((character) => /[\p{L}\p{N}]/u.test(character)).length / Math.max(1, [...text].length);
  const wordConfidence = words.length
    ? words.reduce((sum, word) => sum + (Number.isFinite(Number(word.confidence)) ? Number(word.confidence) : confidence), 0) / words.length
    : confidence;
  const compactLength = [...text].filter((character) => /[\p{L}\p{N}]/u.test(character)).length;
  const shortTextPenalty = compactLength < 12 ? 30 : 0;
  const weakLexicalPenalty = lexicalRatio < 0.55 ? 18 : 0;
  return confidence * 0.65 + wordConfidence * 0.25 + Math.min(8, words.length * 0.35) + lexicalRatio * 5 - shortTextPenalty - weakLexicalPenalty;
}

function hasVerticalOcrLine(data = {}) {
  for (const block of data.blocks || []) {
    for (const paragraph of block.paragraphs || []) {
      for (const line of paragraph.lines || []) {
        const baseline = line.baseline;
        if (![baseline?.x0, baseline?.y0, baseline?.x1, baseline?.y1].every((value) => Number.isFinite(Number(value)))) continue;
        const horizontalLength = Math.abs(Number(baseline.x1) - Number(baseline.x0));
        const verticalLength = Math.abs(Number(baseline.y1) - Number(baseline.y0));
        if (verticalLength >= 30 && verticalLength > horizontalLength * 2) return true;
      }
    }
  }
  return false;
}

function estimateBaselineSkewCorrection(data = {}, { minimumAngle = 0.75, maximumAngle = 7 } = {}) {
  const angles = [];
  for (const block of data.blocks || []) {
    for (const paragraph of block.paragraphs || []) {
      for (const line of paragraph.lines || []) {
        const baseline = line.baseline;
        if (![baseline?.x0, baseline?.y0, baseline?.x1, baseline?.y1].every((value) => Number.isFinite(Number(value)))) continue;
        let horizontal = Number(baseline.x1) - Number(baseline.x0);
        let vertical = Number(baseline.y1) - Number(baseline.y0);
        if (horizontal < 0) {
          horizontal *= -1;
          vertical *= -1;
        }
        if (horizontal < 30) continue;
        const angle = Math.atan2(vertical, horizontal) * 180 / Math.PI;
        if (Math.abs(angle) <= maximumAngle) angles.push(angle);
      }
    }
  }
  if (angles.length < 3) return 0;
  angles.sort((left, right) => left - right);
  const middle = Math.floor(angles.length / 2);
  const median = angles.length % 2 ? angles[middle] : (angles[middle - 1] + angles[middle]) / 2;
  const deviations = angles.map((angle) => Math.abs(angle - median)).sort((left, right) => left - right);
  const medianDeviation = deviations.length % 2
    ? deviations[middle]
    : (deviations[middle - 1] + deviations[middle]) / 2;
  if (Math.abs(median) < minimumAngle || medianDeviation > 1.25) return 0;
  return Math.round(-median * 100) / 100;
}

async function rotateImageBytes(sourceBytes, angleDegrees) {
  const image = await loadImage(sourceBytes);
  const radians = angleDegrees * Math.PI / 180;
  const cosine = Math.abs(Math.cos(radians));
  const sine = Math.abs(Math.sin(radians));
  const dimensions = getSafeOcrRenderDimensions(
    Math.ceil(image.width * cosine + image.height * sine),
    Math.ceil(image.width * sine + image.height * cosine)
  );
  const canvas = createCanvas(dimensions.width, dimensions.height);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.translate(canvas.width / 2, canvas.height / 2);
  context.rotate(radians);
  context.drawImage(image, -image.width / 2, -image.height / 2);
  return { bytes: canvas.toBuffer('image/png'), width: canvas.width, height: canvas.height };
}

function mapPointToOriginal(x, y, angleDegrees, originalWidth, originalHeight, transformedWidth, transformedHeight) {
  const angle = angleDegrees * Math.PI / 180;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const centeredX = x - transformedWidth / 2;
  const centeredY = y - transformedHeight / 2;
  return {
    x: cosine * centeredX + sine * centeredY + originalWidth / 2,
    y: -sine * centeredX + cosine * centeredY + originalHeight / 2
  };
}

function mapOcrBoxesToOriginal(data, angleDegrees, originalWidth, originalHeight, transformedWidth, transformedHeight, cropOffset = { x: 0, y: 0 }) {
  const offsetX = Number(cropOffset?.x) || 0;
  const offsetY = Number(cropOffset?.y) || 0;
  if (!angleDegrees && !offsetX && !offsetY) return data;
  const words = getOcrWords(data);
  for (const word of words) {
    const box = word?.bbox;
    if (!box || ![box.x0, box.y0, box.x1, box.y1].every((value) => Number.isFinite(Number(value)))) continue;
    const points = [
      [Number(box.x0) + offsetX, Number(box.y0) + offsetY], [Number(box.x1) + offsetX, Number(box.y0) + offsetY],
      [Number(box.x0) + offsetX, Number(box.y1) + offsetY], [Number(box.x1) + offsetX, Number(box.y1) + offsetY]
    ].map(([x, y]) => angleDegrees
      ? mapPointToOriginal(x, y, angleDegrees, originalWidth, originalHeight, transformedWidth, transformedHeight)
      : { x, y });
    box.x0 = Math.max(0, Math.min(originalWidth, Math.min(...points.map(({ x }) => x))));
    box.y0 = Math.max(0, Math.min(originalHeight, Math.min(...points.map(({ y }) => y))));
    box.x1 = Math.max(box.x0, Math.min(originalWidth, Math.max(...points.map(({ x }) => x))));
    box.y1 = Math.max(box.y0, Math.min(originalHeight, Math.max(...points.map(({ y }) => y))));
  }
  if (offsetX || offsetY) {
    for (const block of data.blocks || []) {
      for (const paragraph of block.paragraphs || []) {
        for (const line of paragraph.lines || []) {
          if (!line.baseline) continue;
          if (Number.isFinite(Number(line.baseline.x0))) line.baseline.x0 = Number(line.baseline.x0) + offsetX;
          if (Number.isFinite(Number(line.baseline.x1))) line.baseline.x1 = Number(line.baseline.x1) + offsetX;
          if (Number.isFinite(Number(line.baseline.y0))) line.baseline.y0 = Number(line.baseline.y0) + offsetY;
          if (Number.isFinite(Number(line.baseline.y1))) line.baseline.y1 = Number(line.baseline.y1) + offsetY;
        }
      }
    }
  }
  return data;
}

async function createContrastEnhancedImage(sourceBytes) {
  const image = await loadImage(sourceBytes);
  const { width, height } = getSafeOcrRenderDimensions(image.width, image.height);
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height);
  const histogram = new Uint32Array(256);
  const luminances = new Uint8Array(width * height);
  for (let pixel = 0; pixel < luminances.length; pixel += 1) {
    const offset = pixel * 4;
    const luminance = Math.round(0.2126 * pixels.data[offset] + 0.7152 * pixels.data[offset + 1] + 0.0722 * pixels.data[offset + 2]);
    luminances[pixel] = luminance;
    histogram[luminance] += 1;
  }
  const percentile = (ratio) => {
    const target = Math.floor(luminances.length * ratio);
    let cumulative = 0;
    for (let value = 0; value < histogram.length; value += 1) {
      cumulative += histogram[value];
      if (cumulative >= target) return value;
    }
    return 255;
  };
  const low = percentile(0.04);
  const high = percentile(0.96);
  if (high - low >= 220) return null;
  const range = Math.max(1, high - low);
  for (let pixel = 0; pixel < luminances.length; pixel += 1) {
    const value = Math.max(0, Math.min(255, Math.round(((luminances[pixel] - low) / range) * 255)));
    const offset = pixel * 4;
    pixels.data[offset] = value;
    pixels.data[offset + 1] = value;
    pixels.data[offset + 2] = value;
  }
  context.putImageData(pixels, 0, 0);
  return canvas.toBuffer('image/png');
}

async function createInvertedImage(sourceBytes) {
  const image = await loadImage(sourceBytes);
  const { width, height } = getSafeOcrRenderDimensions(image.width, image.height);
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(image, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height);
  for (let i = 0; i < pixels.data.length; i += 4) {
    pixels.data[i] = 255 - pixels.data[i];
    pixels.data[i + 1] = 255 - pixels.data[i + 1];
    pixels.data[i + 2] = 255 - pixels.data[i + 2];
  }
  context.putImageData(pixels, 0, 0);
  return canvas.toBuffer('image/png');
}

async function createAdaptiveBinarizedImage(sourceBytes, options = {}) {
  const checkCancelled = () => {
    if (options.isCancelled?.()) throw new Error('OPERATION_CANCELLED');
  };
  const image = await loadImage(sourceBytes);
  checkCancelled();
  const { width, height } = getSafeOcrRenderDimensions(image.width, image.height);
  const maxPixels = Math.max(1, Math.min(OCR_ADAPTIVE_THRESHOLD_MAX_PIXELS, Number(options.maxPixels) || OCR_ADAPTIVE_THRESHOLD_MAX_PIXELS));
  if (width * height > maxPixels) return null;

  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(image, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height);
  const stride = width + 1;
  // At the 4 MP cap the total luminance is below 2^32, so the summed-area
  // table stays exact in Uint32 and uses bounded memory.
  const integral = new Uint32Array(stride * (height + 1));
  for (let y = 0; y < height; y += 1) {
    if (y % 32 === 0) {
      checkCancelled();
      if (y > 0) await new Promise((resolve) => setImmediate(resolve));
    }
    let rowSum = 0;
    const rowOffset = y * width;
    const integralRow = (y + 1) * stride;
    const previousIntegralRow = y * stride;
    for (let x = 0; x < width; x += 1) {
      const pixelOffset = (rowOffset + x) * 4;
      rowSum += Math.round(0.2126 * pixels.data[pixelOffset] + 0.7152 * pixels.data[pixelOffset + 1] + 0.0722 * pixels.data[pixelOffset + 2]);
      integral[integralRow + x + 1] = integral[previousIntegralRow + x + 1] + rowSum;
    }
  }

  const radius = Math.max(8, Math.min(28, Math.round(Math.min(width, height) * 0.04)));
  const thresholdOffset = Math.max(4, Math.min(18, Number(options.thresholdOffset) || 12));
  for (let y = 0; y < height; y += 1) {
    if (y % 32 === 0) {
      checkCancelled();
      if (y > 0) await new Promise((resolve) => setImmediate(resolve));
    }
    const top = Math.max(0, y - radius);
    const bottom = Math.min(height - 1, y + radius);
    for (let x = 0; x < width; x += 1) {
      const left = Math.max(0, x - radius);
      const right = Math.min(width - 1, x + radius);
      const area = (right - left + 1) * (bottom - top + 1);
      const sum = integral[(bottom + 1) * stride + right + 1]
        - integral[top * stride + right + 1]
        - integral[(bottom + 1) * stride + left]
        + integral[top * stride + left];
      const localThreshold = (sum / area) - thresholdOffset;
      const pixelOffset = (y * width + x) * 4;
      const luminance = 0.2126 * pixels.data[pixelOffset] + 0.7152 * pixels.data[pixelOffset + 1] + 0.0722 * pixels.data[pixelOffset + 2];
      const value = luminance < localThreshold ? 0 : 255;
      pixels.data[pixelOffset] = value;
      pixels.data[pixelOffset + 1] = value;
      pixels.data[pixelOffset + 2] = value;
      pixels.data[pixelOffset + 3] = 255;
    }
  }
  checkCancelled();
  context.putImageData(pixels, 0, 0);
  return canvas.toBuffer('image/png');
}

async function createIsolatedNoiseReducedImage(sourceBytes, options = {}) {
  const checkCancelled = () => {
    if (options.isCancelled?.()) throw new Error('OPERATION_CANCELLED');
  };
  const image = await loadImage(sourceBytes);
  checkCancelled();
  const { width, height } = getSafeOcrRenderDimensions(image.width, image.height);
  const maxPixels = Math.max(1, Math.min(
    OCR_ISOLATED_NOISE_MAX_PIXELS,
    Number(options.maxPixels) || OCR_ISOLATED_NOISE_MAX_PIXELS
  ));
  if (width * height > maxPixels || width < 3 || height < 3) return null;

  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(image, 0, 0, width, height);
  const imageData = context.getImageData(0, 0, width, height);
  const source = new Uint8ClampedArray(imageData.data);
  const neighbors = new Uint8Array(8);
  let changedPixels = 0;
  const luminanceAt = (pixelOffset) => Math.round(
    0.2126 * source[pixelOffset]
    + 0.7152 * source[pixelOffset + 1]
    + 0.0722 * source[pixelOffset + 2]
  );

  for (let y = 1; y < height - 1; y += 1) {
    if (y % 16 === 0) {
      checkCancelled();
      await new Promise((resolve) => setImmediate(resolve));
    }
    for (let x = 1; x < width - 1; x += 1) {
      let neighborIndex = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          neighbors[neighborIndex] = luminanceAt(((y + dy) * width + x + dx) * 4);
          neighborIndex += 1;
        }
      }
      // Insertion-sort the fixed 8-pixel neighborhood to obtain its median
      // without allocating per pixel or retaining another full-size buffer.
      for (let index = 1; index < neighbors.length; index += 1) {
        const value = neighbors[index];
        let cursor = index - 1;
        while (cursor >= 0 && neighbors[cursor] > value) {
          neighbors[cursor + 1] = neighbors[cursor];
          cursor -= 1;
        }
        neighbors[cursor + 1] = value;
      }

      const neighborhoodMedian = Math.round((neighbors[3] + neighbors[4]) / 2);
      const middleRange = neighbors[5] - neighbors[2];
      const centerOffset = (y * width + x) * 4;
      const centerLuminance = luminanceAt(centerOffset);
      // Only replace a strong isolated outlier in a locally uniform area.
      // Edges, strokes, and textured regions are left untouched.
      if (Math.abs(centerLuminance - neighborhoodMedian) < 100 || middleRange > 40) continue;
      imageData.data[centerOffset] = neighborhoodMedian;
      imageData.data[centerOffset + 1] = neighborhoodMedian;
      imageData.data[centerOffset + 2] = neighborhoodMedian;
      changedPixels += 1;
    }
  }
  checkCancelled();
  if (changedPixels === 0) return null;
  context.putImageData(imageData, 0, 0);
  return canvas.toBuffer('image/png');
}

async function createMarginTrimmedImage(sourceBytes, options = {}) {
  const checkCancelled = () => {
    if (options.isCancelled?.()) throw new Error('OPERATION_CANCELLED');
  };
  const image = await loadImage(sourceBytes);
  checkCancelled();
  const maxDimension = Math.max(256, Math.min(1600, Number(options.maxDimension) || 1200));
  const sampleScale = Math.min(1, maxDimension / Math.max(image.width, image.height));
  const sampleWidth = Math.max(1, Math.round(image.width * sampleScale));
  const sampleHeight = Math.max(1, Math.round(image.height * sampleScale));
  const sampleCanvas = createCanvas(sampleWidth, sampleHeight);
  const sampleContext = sampleCanvas.getContext('2d', { willReadFrequently: true });
  sampleContext.fillStyle = '#ffffff';
  sampleContext.fillRect(0, 0, sampleWidth, sampleHeight);
  sampleContext.drawImage(image, 0, 0, sampleWidth, sampleHeight);
  const pixels = sampleContext.getImageData(0, 0, sampleWidth, sampleHeight).data;
  const rowCounts = new Uint32Array(sampleHeight);
  const columnCounts = new Uint32Array(sampleWidth);
  try {
    for (let y = 0; y < sampleHeight; y += 1) {
      if (y % 48 === 0) {
        checkCancelled();
        await new Promise((resolve) => setImmediate(resolve));
      }
      for (let x = 0; x < sampleWidth; x += 1) {
        const offset = (y * sampleWidth + x) * 4;
        if (pixels[offset + 3] < 32) continue;
        const luminance = 0.2126 * pixels[offset] + 0.7152 * pixels[offset + 1] + 0.0722 * pixels[offset + 2];
        if (luminance < 245) {
          rowCounts[y] += 1;
          columnCounts[x] += 1;
        }
      }
    }
  } finally {
    sampleCanvas.width = 0;
    sampleCanvas.height = 0;
  }

  const rowThreshold = Math.max(3, Math.ceil(sampleWidth * 0.001));
  const columnThreshold = Math.max(3, Math.ceil(sampleHeight * 0.001));
  let top = rowCounts.findIndex((count) => count >= rowThreshold);
  let left = columnCounts.findIndex((count) => count >= columnThreshold);
  let bottom = rowCounts.length - 1;
  let right = columnCounts.length - 1;
  while (bottom > top && rowCounts[bottom] < rowThreshold) bottom -= 1;
  while (right > left && columnCounts[right] < columnThreshold) right -= 1;
  if (top < 0 || left < 0 || bottom <= top || right <= left) return null;

  const paddingX = Math.ceil(sampleWidth * 0.025);
  const paddingY = Math.ceil(sampleHeight * 0.025);
  left = Math.max(0, left - paddingX);
  right = Math.min(sampleWidth - 1, right + paddingX);
  top = Math.max(0, top - paddingY);
  bottom = Math.min(sampleHeight - 1, bottom + paddingY);
  const croppedWidthRatio = (right - left + 1) / sampleWidth;
  const croppedHeightRatio = (bottom - top + 1) / sampleHeight;
  if (croppedWidthRatio < 0.2 || croppedHeightRatio < 0.2
    || croppedWidthRatio * croppedHeightRatio >= 0.82) return null;

  const scaleX = image.width / sampleWidth;
  const scaleY = image.height / sampleHeight;
  const cropX = Math.max(0, Math.floor(left * scaleX));
  const cropY = Math.max(0, Math.floor(top * scaleY));
  const cropWidth = Math.min(image.width - cropX, Math.ceil((right - left + 1) * scaleX));
  const cropHeight = Math.min(image.height - cropY, Math.ceil((bottom - top + 1) * scaleY));
  if (cropWidth < 3 || cropHeight < 3 || cropWidth * cropHeight > OCR_ADAPTIVE_THRESHOLD_MAX_PIXELS) return null;

  checkCancelled();
  const cropCanvas = createCanvas(cropWidth, cropHeight);
  let bytes;
  try {
    const cropContext = cropCanvas.getContext('2d');
    cropContext.fillStyle = '#ffffff';
    cropContext.fillRect(0, 0, cropWidth, cropHeight);
    cropContext.drawImage(image, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
    bytes = cropCanvas.toBuffer('image/png');
  } finally {
    cropCanvas.width = 0;
    cropCanvas.height = 0;
  }
  return { bytes, cropOffset: { x: cropX, y: cropY }, width: cropWidth, height: cropHeight };
}

async function estimateSmallSkewCorrection(sourceBytes, options = {}) {
  const checkCancelled = () => {
    if (options.isCancelled?.()) throw new Error('OPERATION_CANCELLED');
  };
  const image = await loadImage(sourceBytes);
  checkCancelled();
  const maxDimension = Math.max(256, Math.min(1200, Number(options.maxDimension) || 900));
  const scale = Math.min(1, maxDimension / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height).data;
  const step = width * height > 650_000 ? 2 : 1;
  const sampleWidth = Math.ceil(width / step);
  const sampleHeight = Math.ceil(height / step);
  // Store packed pixel offsets in one bounded buffer instead of allocating a
  // JavaScript array and coordinate pair for every dark pixel on noisy scans.
  const darkPixels = new Uint32Array(sampleWidth * sampleHeight);
  let darkPixelCount = 0;
  for (let y = 0; y < height; y += step) {
    if (y % 32 === 0) {
      checkCancelled();
      if (y > 0) await new Promise((resolve) => setImmediate(resolve));
    }
    for (let x = 0; x < width; x += step) {
      const offset = (y * width + x) * 4;
      const luminance = 0.2126 * pixels[offset] + 0.7152 * pixels[offset + 1] + 0.0722 * pixels[offset + 2];
      if (luminance < 210) darkPixels[darkPixelCount++] = y * width + x;
    }
  }
  canvas.width = 0;
  canvas.height = 0;
  if (darkPixelCount < 80) return 0;

  const maxAngle = Math.max(0.5, Math.min(4, Number(options.maxAngleDegrees) || 3));
  const angleStep = 0.25;
  let bestAngle = 0;
  let bestScore = -Infinity;
  const rowCount = Math.ceil(Math.hypot(width, height)) + 4;
  for (let angle = -maxAngle; angle <= maxAngle + 1e-6; angle += angleStep) {
    checkCancelled();
    if (Math.abs(angle) < 0.25) continue;
    const radians = angle * Math.PI / 180;
    const sine = Math.sin(radians);
    const cosine = Math.cos(radians);
    const projection = new Uint32Array(rowCount);
    for (let pointIndex = 0; pointIndex < darkPixelCount; pointIndex += 1) {
      if (pointIndex > 0 && pointIndex % 16_384 === 0) {
        checkCancelled();
        await new Promise((resolve) => setImmediate(resolve));
      }
      const packedPoint = darkPixels[pointIndex];
      const x = (packedPoint % width) - width / 2;
      const y = Math.floor(packedPoint / width) - height / 2;
      const row = Math.round(sine * x + cosine * y + rowCount / 2);
      if (row >= 0 && row < rowCount) projection[row] += 1;
    }
    let score = 0;
    for (let row = 0; row < rowCount; row += 1) {
      score += projection[row] * projection[row];
    }
    if (score > bestScore) {
      bestScore = score;
      bestAngle = angle;
    }
  }
  checkCancelled();
  return Math.abs(bestAngle) < 0.25 ? 0 : Math.round(bestAngle * 100) / 100;
}

async function recognizeWithAdaptiveOrientation(sourceBytes, worker, options = {}, isCancelled = () => false, progress = () => {}) {
  const source = await loadImage(sourceBytes);
  const { width: originalWidth, height: originalHeight } = source;
  const initial = await worker.recognize(sourceBytes, {}, { text: true, blocks: true, pdf: false });
  let best = { data: initial.data || {}, bytes: sourceBytes, angle: 0, width: originalWidth, height: originalHeight, preprocessingApplied: false };
  let bestScore = scoreOcrResult(best.data);
  const attemptedAngles = new Set();
  const recognizeCandidate = async (angle) => {
    const normalizedAngle = ((angle % 360) + 360) % 360;
    if (attemptedAngles.has(normalizedAngle)) return;
    attemptedAngles.add(normalizedAngle);
    if (isCancelled()) throw new Error('OPERATION_CANCELLED');
    const rotated = await rotateImageBytes(sourceBytes, angle);
    const result = await worker.recognize(rotated.bytes, {}, { text: true, blocks: true, pdf: false });
    const score = scoreOcrResult(result.data || {});
    progress({ stage: 'orientation-check', angleDegrees: angle, qualityScore: Math.round(score) });
    const correctsVerticalBaseline = hasVerticalOcrLine(best.data)
      && !hasVerticalOcrLine(result.data || {})
      && score >= bestScore - 5;
    if (score > bestScore + 1.5 || correctsVerticalBaseline) {
      best = { data: result.data || {}, bytes: rotated.bytes, angle, width: rotated.width, height: rotated.height };
      bestScore = score;
    }
  };

  if (options.autoRotate !== false) {
    const baselineCorrection = estimateBaselineSkewCorrection(best.data);
    if (baselineCorrection) {
      const direction = Math.sign(baselineCorrection);
      for (const angle of [baselineCorrection, baselineCorrection - direction * 0.5, baselineCorrection + direction * 0.5]) {
        try {
          await recognizeCandidate(angle);
        } catch (error) {
          if (isCancelled() || error?.message === 'OPERATION_CANCELLED') throw error;
          if (!/grande demais para o OCR/i.test(error?.message || '')) throw error;
        }
      }
    }
  }

  const orientationMayBeWrong = hasVerticalOcrLine(best.data);
  const shouldAttemptOrientation = options.autoRotate !== false && !(bestScore >= 78 && !orientationMayBeWrong);

  if (shouldAttemptOrientation) {
    for (const angle of [90, -90, 180]) {
      try {
        await recognizeCandidate(angle);
      } catch (error) {
        if (isCancelled() || error?.message === 'OPERATION_CANCELLED') throw error;
        if (!/grande demais para o OCR/i.test(error?.message || '')) throw error;
      }
      // Test every right-angle candidate once orientation analysis is already
      // warranted. An intermediate 90-degree rotation can produce confident
      // but wrong text for a page that is actually upside down; stopping at a
      // generic confidence threshold would prevent the correct 180-degree
      // candidate from being evaluated.
    }
    if (bestScore < 78 && bestScore >= 0) {
      const estimatedSkew = await estimateSmallSkewCorrection(best.bytes, { isCancelled });
      const cumulativeSkewAngle = best.angle + estimatedSkew;
      const skewCandidates = estimatedSkew
        ? [cumulativeSkewAngle, cumulativeSkewAngle - Math.sign(estimatedSkew) * 0.5, cumulativeSkewAngle + Math.sign(estimatedSkew) * 0.5]
        : [];
      for (const angle of skewCandidates) {
        try {
          await recognizeCandidate(angle);
        } catch (error) {
          if (isCancelled() || error?.message === 'OPERATION_CANCELLED') throw error;
          if (!/grande demais para o OCR/i.test(error?.message || '')) throw error;
        }
        if (bestScore >= 78) break;
      }
    }
  }
  if (options.imageEnhancement !== false && bestScore < 65 && !isCancelled()) {
    const marginTrimmed = await createMarginTrimmedImage(best.bytes, { isCancelled });
    if (marginTrimmed && !isCancelled()) {
      const trimmed = await worker.recognize(marginTrimmed.bytes, {}, { text: true, blocks: true, pdf: false });
      const trimmedScore = scoreOcrResult(trimmed.data || {});
      if (trimmedScore > bestScore + 1.5) {
        best = { ...best, data: trimmed.data || {}, bytes: marginTrimmed.bytes, cropOffset: marginTrimmed.cropOffset, preprocessingApplied: true };
        bestScore = trimmedScore;
        progress({ stage: 'preprocessing-check', method: 'trim-empty-margins', qualityScore: Math.round(trimmedScore) });
      }
    }
  }
  if (options.imageEnhancement !== false && bestScore < 65) {
    const denoisedBytes = await createIsolatedNoiseReducedImage(best.bytes, { isCancelled });
    if (denoisedBytes && !isCancelled()) {
      const denoised = await worker.recognize(denoisedBytes, {}, { text: true, blocks: true, pdf: false });
      const denoisedScore = scoreOcrResult(denoised.data || {});
      if (denoisedScore > bestScore + 1.5) {
        best = { ...best, data: denoised.data || {}, bytes: denoisedBytes, preprocessingApplied: true };
        bestScore = denoisedScore;
        progress({ stage: 'preprocessing-check', method: 'isolated-noise-reduction', qualityScore: Math.round(denoisedScore) });
      }
    }
  }
  if (options.imageEnhancement !== false && bestScore < 65 && !isCancelled()) {
    const invertedBytes = await createInvertedImage(best.bytes);
    if (invertedBytes && !isCancelled()) {
      const inverted = await worker.recognize(invertedBytes, {}, { text: true, blocks: true, pdf: false });
      const invertedScore = scoreOcrResult(inverted.data || {});
      if (invertedScore > bestScore + 1.5) {
        best = { ...best, data: inverted.data || {}, bytes: invertedBytes, preprocessingApplied: true };
        bestScore = invertedScore;
        progress({ stage: 'preprocessing-check', method: 'invert-polarity', qualityScore: Math.round(invertedScore) });
      }
    }
  }
  if (options.imageEnhancement !== false && bestScore < 65) {
    const enhancedBytes = await createContrastEnhancedImage(best.bytes);
    if (enhancedBytes && !isCancelled()) {
      const enhanced = await worker.recognize(enhancedBytes, {}, { text: true, blocks: true, pdf: false });
      const enhancedScore = scoreOcrResult(enhanced.data || {});
      if (enhancedScore > bestScore + 1.5) {
        best = { ...best, data: enhanced.data || {}, bytes: enhancedBytes, preprocessingApplied: true };
        bestScore = enhancedScore;
      }
    }
  }
  if (options.imageEnhancement !== false && bestScore < 65 && best.width * best.height <= OCR_ADAPTIVE_THRESHOLD_MAX_PIXELS && !isCancelled()) {
    const binarizedBytes = await createAdaptiveBinarizedImage(best.bytes, { isCancelled });
    if (binarizedBytes && !isCancelled()) {
      const binarized = await worker.recognize(binarizedBytes, {}, { text: true, blocks: true, pdf: false });
      const binarizedScore = scoreOcrResult(binarized.data || {});
      if (binarizedScore > bestScore + 1.5) {
        best = { ...best, data: binarized.data || {}, bytes: binarizedBytes, preprocessingApplied: true };
        bestScore = binarizedScore;
        progress({ stage: 'preprocessing-check', method: 'adaptive-threshold', qualityScore: Math.round(binarizedScore) });
      }
    }
  }
  mapOcrBoxesToOriginal(best.data, best.angle, originalWidth, originalHeight, best.width, best.height, best.cropOffset);
  return { ...best, qualityScore: bestScore };
}

async function recognizePdfArea(inputPath, pageNumber, selection, options = {}, progress = () => {}, isCancelled = () => false) {
  const inspection = inspectPdfFile(inputPath, PDF_LIMITS.maxSupportedBytes);
  if (!inspection.ok) throw new Error(`Não foi possível abrir o PDF para reconhecimento: ${path.basename(inputPath)}.`);
  if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) throw new Error('Selecione uma página válida para reconhecer.');
  let rect = selection && typeof selection === 'object' ? {
    x: Number(selection.x), y: Number(selection.y), width: Number(selection.width), height: Number(selection.height)
  } : null;
  if (!rect || Object.values(rect).some((value) => !Number.isFinite(value))
    || rect.x < -0.01 || rect.y < -0.01 || rect.width <= 0 || rect.height <= 0
    || rect.x + rect.width > 1.05 || rect.y + rect.height > 1.05
    || rect.width < 0.005 || rect.height < 0.005) {
    throw new Error('Selecione uma área válida da página antes de reconhecer.');
  }
  const safeX = Math.max(0, Math.min(0.999, rect.x));
  const safeY = Math.max(0, Math.min(0.999, rect.y));
  const safeWidth = Math.max(0.005, Math.min(1 - safeX, rect.width));
  const safeHeight = Math.max(0.005, Math.min(1 - safeY, rect.height));
  rect = { x: safeX, y: safeY, width: safeWidth, height: safeHeight };
  if (isCancelled()) throw new Error('OPERATION_CANCELLED');
  const language = normalizeLanguages(options.language);
  const sourceStats = await fs.promises.stat(inputPath);
  const sourceFingerprint = getSourceFingerprint(sourceStats);
  const pdfjs = await loadPdfJs();
  const fileDocument = await openPdfJsDocumentFromFile(pdfjs, inputPath, {
    CanvasFactory: OcrCanvasFactory,
    standardFontDataUrl: PDFJS_STANDARD_FONTS,
    isEvalSupported: false,
    useWorkerFetch: false,
    stopAtErrors: true
  }, isCancelled);
  const loadingTask = fileDocument.loadingTask;
  let worker;
  let activePage;
  let activeRenderedCanvas;
  let activeCropCanvas;
  let result;
  let operationError;
  try {
    const pdfDocument = await loadingTask.promise;
    if (isCancelled()) throw new Error('OPERATION_CANCELLED');
    if (pageNumber > pdfDocument.numPages) throw new Error(`O documento tem apenas ${pdfDocument.numPages} página(s).`);
    activePage = await pdfDocument.getPage(pageNumber);
    if (isCancelled()) throw new Error('OPERATION_CANCELLED');

    const textContent = await activePage.getTextContent();
    if (isCancelled()) throw new Error('OPERATION_CANCELLED');
    const pageViewport = activePage.getViewport({ scale: 1 });
    const nativeText = extractNativeTextInRect(textContent, pageViewport, rect);
    const cleanedNative = cleanRedundantText(nativeText);

    if (cleanedNative && cleanedNative.length > 0) {
      activePage.cleanup();
      activePage = null;
      result = {
        text: cleanedNative.slice(0, 20_000),
        truncated: cleanedNative.length > 20_000,
        confidence: 100,
        orientationCorrectionDegrees: 0,
        preprocessingApplied: false,
        pageNumber,
        recognized: true,
        source: 'native'
      };
    } else {
      const rendered = await renderPdfPage(activePage, OCR_RENDER_SCALE, { retainCanvas: true });
      activeRenderedCanvas = rendered.canvas;
      if (isCancelled()) throw new Error('OPERATION_CANCELLED');
      const sourceX = Math.max(0, Math.floor(rect.x * rendered.width));
      const sourceY = Math.max(0, Math.floor(rect.y * rendered.height));
      const sourceWidth = Math.min(rendered.width - sourceX, Math.ceil(rect.width * rendered.width));
      const sourceHeight = Math.min(rendered.height - sourceY, Math.ceil(rect.height * rendered.height));
      if (sourceWidth < 8 || sourceHeight < 8) throw new Error('A área selecionada é pequena demais para reconhecer. Selecione uma região maior.');
      activeCropCanvas = createCanvas(sourceWidth, sourceHeight);
      activeCropCanvas.getContext('2d').drawImage(rendered.canvas, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, sourceWidth, sourceHeight);
      const cropBytes = activeCropCanvas.toBuffer('image/png');
      releaseOcrCanvas(activeRenderedCanvas);
      activeRenderedCanvas = null;
      releaseOcrCanvas(activeCropCanvas);
      activeCropCanvas = null;
      activePage.cleanup();
      activePage = null;
      worker = await createOcrWorker(language, (message) => progress({ stage: 'motor', ...message }));
      const ocrOptions = { autoRotate: false, ...options };
      const ocrResult = await recognizeWithAdaptiveOrientation(cropBytes, worker, ocrOptions, isCancelled, progress);
      if (isCancelled()) throw new Error('OPERATION_CANCELLED');
      const rawText = cleanRedundantText(normalizeText(ocrResult.data?.text || ''));
      result = {
        text: rawText.slice(0, 20_000),
        truncated: rawText.length > 20_000,
        confidence: Number(ocrResult.data?.confidence || 0),
        orientationCorrectionDegrees: ocrResult.angle,
        preprocessingApplied: ocrResult.preprocessingApplied,
        pageNumber,
        recognized: Boolean(rawText)
      };
    }
  } catch (error) {
    operationError = error;
  } finally {
    releaseOcrCanvas(activeRenderedCanvas);
    releaseOcrCanvas(activeCropCanvas);
    activePage?.cleanup();
    await Promise.resolve(worker?.terminate?.()).catch(() => {});
    await Promise.resolve(loadingTask.destroy?.()).catch(() => {});
    await fileDocument.close();
  }
  if (operationError) {
    if (isCancelled() || operationError.message === 'OPERATION_CANCELLED') throw new Error('OPERATION_CANCELLED');
    const readError = fileDocument.getReadError();
    if (readError) throw normalizeOcrReadError(readError, 'OCR da área');
    throw normalizeOcrDocumentError(operationError);
  }
  const finalStats = await fs.promises.stat(inputPath);
  if (getSourceFingerprint(finalStats) !== sourceFingerprint) {
    throw new Error('O PDF foi alterado durante o reconhecimento. Adicione o arquivo novamente; nenhum conteúdo foi modificado.');
  }
  return result;
}

function getPageContentReferences(page) {
  const contents = page.node.Contents();
  if (contents instanceof PDFArray) return contents.asArray().filter((item) => item instanceof PDFRef);
  const contentsEntry = page.node.get(PDFName.of('Contents'));
  return contentsEntry instanceof PDFRef ? [contentsEntry] : [];
}

function drawInvisibleText(pdfDocument, page, font, ocrData, imageWidth, imageHeight, existingTextBoxes = [], orientationCorrectionDegrees = 0, transformedWidth = imageWidth, transformedHeight = imageHeight) {
  const { width: pageWidth, height: pageHeight } = page.getSize();
  const originalContentReferences = new Set(getPageContentReferences(page).map((ref) => ref.toString()));
  const words = getOcrWords(ocrData);
  const usableWords = words.filter((word) => word?.text && Number.isFinite(word?.bbox?.x0));
  if (!usableWords.length && ocrData?.text && existingTextBoxes.length === 0) {
    page.drawText(normalizeText(ocrData.text), { x: 1, y: 1, size: 1, font, color: rgb(1, 1, 1), opacity: 0 });
    return getCreatedOcrLayer(pdfDocument, page, originalContentReferences);
  }
  const lineForWord = new Map();
  for (const block of ocrData?.blocks || []) {
    for (const paragraph of block.paragraphs || []) {
      for (const line of paragraph.lines || []) {
        const lineBottom = Number(line.baseline?.y0 ?? line.baseline?.y1 ?? line.bbox?.y1);
        const lineHeight = Number(line.rowAttributes?.rowHeight)
          || Number(line.bbox?.y1) - Number(line.bbox?.y0);
        for (const word of line.words || []) {
          if (Number.isFinite(lineBottom)) lineForWord.set(word, {
            bottom: lineBottom,
            height: Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : null,
            baseline: {
              x0: Number(line.baseline?.x0),
              y0: Number(line.baseline?.y0),
              x1: Number(line.baseline?.x1),
              y1: Number(line.baseline?.y1)
            }
          });
        }
      }
    }
  }
  for (const word of usableWords) {
    const text = normalizeText(word.text);
    if (!text) continue;
    const wordBox = {
      x0: Number(word.bbox.x0) / imageWidth,
      y0: Number(word.bbox.y0) / imageHeight,
      x1: Number(word.bbox.x1) / imageWidth,
      y1: Number(word.bbox.y1) / imageHeight
    };
    const wordArea = Math.max(0, wordBox.x1 - wordBox.x0) * Math.max(0, wordBox.y1 - wordBox.y0);
    const duplicatesExistingText = wordArea > 0 && existingTextBoxes.some((existing) => {
      const overlapWidth = Math.max(0, Math.min(wordBox.x1, existing.x1) - Math.max(wordBox.x0, existing.x0));
      const overlapHeight = Math.max(0, Math.min(wordBox.y1, existing.y1) - Math.max(wordBox.y0, existing.y0));
      return overlapWidth * overlapHeight / wordArea >= 0.35;
    });
    if (duplicatesExistingText) continue;
    const line = lineForWord.get(word);
    const wordHeight = Number(word.bbox.y1) - Number(word.bbox.y0);
    const height = Math.max(2, ((line?.height || wordHeight) / imageHeight) * pageHeight);
    const baseline = line?.bottom ?? Number(word.bbox.y1);
    const hasRotatedBaseline = orientationCorrectionDegrees !== 0
      && [line?.baseline?.x0, line?.baseline?.y0].every(Number.isFinite);
    const baselinePoint = hasRotatedBaseline
      ? mapPointToOriginal(line.baseline.x0, line.baseline.y0, orientationCorrectionDegrees, imageWidth, imageHeight, transformedWidth, transformedHeight)
      : { x: Number(word.bbox.x0), y: baseline };
    const x = Math.max(0, Math.min(pageWidth - 1, (baselinePoint.x / imageWidth) * pageWidth));
    const y = Math.max(0, Math.min(pageHeight - height, pageHeight - (baselinePoint.y / imageHeight) * pageHeight));
    page.drawText(text, {
      x,
      y,
      size: Math.max(2, Math.min(18, height)),
      rotate: hasRotatedBaseline ? degrees(orientationCorrectionDegrees) : undefined,
      font,
      color: rgb(1, 1, 1),
      opacity: 0
    });
  }
  return getCreatedOcrLayer(pdfDocument, page, originalContentReferences);
}

function getCreatedOcrLayer(pdfDocument, page, previousReferences) {
  const addedReferences = getPageContentReferences(page).filter((ref) => !previousReferences.has(ref.toString()));
  const textStreams = addedReferences.filter((ref) => {
    const stream = pdfDocument.context.lookupMaybe(ref, PDFStream);
    return Boolean(stream && /\bT[Jj]\b/.test(stream.getContentsString()));
  });
  if (textStreams.length !== 1) return null;
  const [contentRef] = textStreams;
  const stream = pdfDocument.context.lookupMaybe(contentRef, PDFStream);
  if (!stream) return null;
  stream.dict.set(OCR_LAYER_STREAM_KEY, PDFBool.True);
  return contentRef;
}

function storeOcrLayerMetadata(page, contentRef, nativeTextBoxes) {
  const serialized = JSON.stringify(nativeTextBoxes);
  if (Buffer.byteLength(serialized, 'utf8') <= OCR_NATIVE_BOXES_MAX_BYTES) {
    page.node.set(OCR_NATIVE_BOXES_KEY, PDFHexString.fromText(serialized));
  } else {
    page.node.delete(OCR_NATIVE_BOXES_KEY);
  }
  if (contentRef instanceof PDFRef) {
    page.node.set(OCR_LAYER_CONTENTS_KEY, contentRef);
    page.node.delete(OCR_LAYER_ABSENT_KEY);
  } else {
    // A page with searchable native text can be marked as processed without
    // adding a new OCR stream. Track that safe no-layer state explicitly so
    // redo can rerun recognition without guessing which native streams to remove.
    page.node.delete(OCR_LAYER_CONTENTS_KEY);
    page.node.set(OCR_LAYER_ABSENT_KEY, PDFBool.True);
  }
}

function readOcrLayerMetadata(pdfDocument, page) {
  const contentRef = page.node.get(OCR_LAYER_CONTENTS_KEY);
  const absentValue = page.node.get(OCR_LAYER_ABSENT_KEY);
  const nativeBoxesValue = page.node.get(OCR_NATIVE_BOXES_KEY);
  if (!(nativeBoxesValue instanceof PDFHexString)) return null;
  const layerAbsent = absentValue === PDFBool.True;
  if (layerAbsent) {
    if (contentRef instanceof PDFRef) return null;
  } else {
    if (!(contentRef instanceof PDFRef)) return null;
    const stream = pdfDocument.context.lookupMaybe(contentRef, PDFStream);
    if (!stream || stream.dict.get(OCR_LAYER_STREAM_KEY) !== PDFBool.True) return null;
    const contentReferences = getPageContentReferences(page);
    if (!contentReferences.some((ref) => ref.toString() === contentRef.toString())) return null;
  }
  try {
    const nativeTextBoxes = JSON.parse(nativeBoxesValue.decodeText());
    if (!Array.isArray(nativeTextBoxes) || nativeTextBoxes.some((box) => !box
      || !['x0', 'y0', 'x1', 'y1'].every((key) => Number.isFinite(box[key]) && box[key] >= 0 && box[key] <= 1)
      || box.x1 < box.x0 || box.y1 < box.y0)) return null;
    return { contentRef: layerAbsent ? null : contentRef, layerAbsent, nativeTextBoxes };
  } catch {
    return null;
  }
}

function removeOcrLayer(pdfDocument, page, metadata) {
  if (metadata.layerAbsent) {
    page.node.delete(OCR_LAYER_CONTENTS_KEY);
    page.node.delete(OCR_LAYER_ABSENT_KEY);
    page.node.delete(OCR_NATIVE_BOXES_KEY);
    page.node.delete(OCR_PROCESSED_PAGE_KEY);
    return true;
  }
  const contents = page.node.Contents();
  if (!(contents instanceof PDFArray)) return false;
  const index = contents.asArray().findIndex((ref) => ref instanceof PDFRef && ref.toString() === metadata.contentRef.toString());
  if (index < 0) return false;
  contents.remove(index);
  page.node.delete(OCR_LAYER_CONTENTS_KEY);
  page.node.delete(OCR_LAYER_ABSENT_KEY);
  page.node.delete(OCR_NATIVE_BOXES_KEY);
  page.node.delete(OCR_PROCESSED_PAGE_KEY);
  return true;
}

function getOcrProcessedPages(pdfDocument) {
  return new Set(pdfDocument.getPages().flatMap((page, index) => {
    const marker = page.node.get(OCR_PROCESSED_PAGE_KEY);
    return marker && typeof marker.asBoolean === 'function' && marker.asBoolean() ? [index + 1] : [];
  }));
}

function markOcrProcessedPages(pdfDocument, pageNumbers) {
  for (const pageNumber of new Set(pageNumbers)) {
    if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > pdfDocument.getPageCount()) continue;
    pdfDocument.getPage(pageNumber - 1).node.set(OCR_PROCESSED_PAGE_KEY, PDFBool.True);
  }
}

function createRedactionSearchPattern(value) {
  const query = String(value || '').trim();
  if (!query || query.length > 120) throw new Error('Informe um termo de busca com até 120 caracteres.');
  if (query === 'CPF') return /\b\d{3}[.\s-]?\d{3}[.\s-]?\d{3}[.\s-]?\d{2}\b/gi;
  if (query === 'CNPJ') return /\b\d{2}[.\s-]?\d{3}[.\s-]?\d{3}[/.\s-]?\d{4}[.\s-]?\d{2}\b/gi;
  if (query === 'TELEFONE') return /(?:\(?\d{2}\)?\s?)?\d{4,5}[\s-]?\d{4}/g;
  if (query === 'EMAIL') return /[a-zA-Z0-9._%+-]+\s?@\s?[a-zA-Z0-9.-]+\s?\.\s?[a-zA-Z]{2,}/gi;
  if (query === 'DATA') return /\b(?:(?:0?[1-9]|[12]\d|3[01])[./-](?:0?[1-9]|1[0-2])[./-](?:19|20)\d{2}|(?:19|20)\d{2}[./-](?:0?[1-9]|1[0-2])[./-](?:0?[1-9]|[12]\d|3[01]))\b/g;
  const escaped = query.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(escaped, 'gi');
}

function normalizeSearchText(value = '') {
  return normalizeText(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

function getSearchMatches(text, query, spans, pageNumber, source, dimensions, limit) {
  const normalizedText = normalizeSearchText(text);
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedText || !normalizedQuery) return [];
  const results = [];
  let start = 0;
  while (results.length < limit) {
    const matchAt = normalizedText.indexOf(normalizedQuery, start);
    if (matchAt < 0) break;
    const matchEnd = matchAt + normalizedQuery.length;
    const matchedSpans = spans.filter((span) => span.start < matchEnd && span.end > matchAt);
    if (matchedSpans.length) {
      const boxes = matchedSpans.map((span) => span.box).filter(Boolean);
      if (boxes.length) {
        const left = Math.max(0, Math.min(...boxes.map((box) => box.x0)));
        const top = Math.max(0, Math.min(...boxes.map((box) => box.y0)));
        const right = Math.min(dimensions.width, Math.max(...boxes.map((box) => box.x1)));
        const bottom = Math.min(dimensions.height, Math.max(...boxes.map((box) => box.y1)));
        if (right > left && bottom > top) {
          results.push({
            pageNumber,
            source,
            xRatio: left / dimensions.width,
            yRatio: top / dimensions.height,
            widthRatio: (right - left) / dimensions.width,
            heightRatio: (bottom - top) / dimensions.height
          });
        }
      }
    }
    start = matchAt + Math.max(1, normalizedQuery.length);
  }
  return results;
}

function getNativeTextSpans(textContent, viewport) {
  const spans = [];
  let text = '';
  for (const item of textContent.items || []) {
    const itemText = typeof item.str === 'string' ? item.str : '';
    if (!itemText.trim()) continue;
    if (text) text += ' ';
    const start = normalizeSearchText(text).length;
    text += itemText;
    const end = normalizeSearchText(text).length;
    const transform = item.transform || [];
    if (transform.length < 6) continue;
    const x0 = Number(transform[4]);
    const y0 = Number(transform[5]);
    const width = Number(item.width) || 0;
    const height = Number(item.height) || Math.hypot(Number(transform[2]) || 0, Number(transform[3]) || 0);
    if (![x0, y0, width, height].every(Number.isFinite) || width <= 0 || height <= 0) continue;
    const firstPoint = viewport.convertToViewportPoint(x0, y0 - height * 0.2);
    const secondPoint = viewport.convertToViewportPoint(x0 + width, y0 + height * 0.8);
    spans.push({ start, end, box: { x0: Math.min(firstPoint[0], secondPoint[0]), y0: Math.min(firstPoint[1], secondPoint[1]), x1: Math.max(firstPoint[0], secondPoint[0]), y1: Math.max(firstPoint[1], secondPoint[1]) } });
  }
  return { text, spans };
}

function extractTopHeadingLines(textContent, viewport, source = 'texto do PDF') {
  const items = [];
  for (const item of textContent.items || []) {
    const text = String(item.str || '').replace(/\s+/g, ' ').trim();
    const transform = item.transform || [];
    if (!text || transform.length < 6) continue;
    const x = Number(transform[4]);
    const y = Number(transform[5]);
    const height = Number(item.height) || Math.hypot(Number(transform[2]) || 0, Number(transform[3]) || 0);
    if (![x, y, height].every(Number.isFinite) || height <= 0) continue;
    const point = viewport.convertToViewportPoint(x, y);
    const yRatio = point[1] / viewport.height;
    if (yRatio < 0 || yRatio > 0.36) continue;
    items.push({ text, x: point[0], y: point[1], height, yRatio, source });
  }
  items.sort((left, right) => left.y - right.y || left.x - right.x);
  const lines = [];
  for (const item of items) {
    let line = lines.find((candidate) => Math.abs(candidate.y - item.y) <= Math.max(3, Math.min(candidate.height, item.height) * 0.65));
    if (!line) {
      line = { y: item.y, height: item.height, yRatio: item.yRatio, source, items: [] };
      lines.push(line);
    }
    line.items.push(item);
    line.y = line.items.reduce((sum, part) => sum + part.y, 0) / line.items.length;
    line.height = Math.max(line.height, item.height);
    line.yRatio = line.y / viewport.height;
  }
  return lines
    .sort((left, right) => left.y - right.y)
    .map((line) => ({
      text: line.items.sort((left, right) => left.x - right.x).map((item) => item.text).join(' ').trim(),
      yRatio: line.yRatio,
      source
    }));
}

async function renderPdfTopBand(pdfPage, bandRatio = 0.36) {
  const viewport = pdfPage.getViewport({ scale: 1.35 });
  const dimensions = getSafeOcrRenderDimensions(viewport.width, viewport.height);
  const width = dimensions.width;
  const fullHeight = dimensions.height;
  const height = Math.max(1, Math.min(fullHeight, Math.ceil(fullHeight * bandRatio)));
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  try {
    await pdfPage.render({ canvasContext: context, viewport }).promise;
      return { bytes: canvas.toBuffer('image/png'), width, height, fullHeight };
  } finally {
    releaseOcrCanvas(canvas);
  }
}

function extractTopHeadingLinesFromOcr(ocrData, width, bandHeight, pageHeight = bandHeight) {
  const words = getOcrWords(ocrData)
    .filter((word) => normalizeText(word?.text || '') && word?.bbox
      && [word.bbox.x0, word.bbox.y0, word.bbox.x1, word.bbox.y1].every(Number.isFinite))
    .map((word) => ({
      text: normalizeText(word.text),
      x: Number(word.bbox.x0),
      y: (Number(word.bbox.y0) + Number(word.bbox.y1)) / 2,
      height: Math.max(1, Number(word.bbox.y1) - Number(word.bbox.y0))
    }))
    .filter((word) => word.y >= 0 && word.y <= bandHeight && word.x >= 0 && word.x <= width)
    .sort((left, right) => left.y - right.y || left.x - right.x);
  const lines = [];
  for (const word of words) {
    let line = lines.find((candidate) => Math.abs(candidate.y - word.y) <= Math.max(3, Math.min(candidate.height, word.height) * 0.75));
    if (!line) {
      line = { y: word.y, height: word.height, words: [] };
      lines.push(line);
    }
    line.words.push(word);
    line.y = line.words.reduce((sum, item) => sum + item.y, 0) / line.words.length;
    line.height = Math.max(line.height, word.height);
  }
  return lines
    .filter((line) => line.y <= bandHeight * 0.9)
    .sort((left, right) => left.y - right.y)
    .map((line) => ({
      text: line.words.sort((left, right) => left.x - right.x).map((word) => word.text).join(' ').trim(),
        yRatio: line.y / Math.max(1, pageHeight),
      source: 'OCR'
    }));
}

async function suggestPdfSplitStarts(inputPath, options = {}, progress = () => {}, isCancelled = () => false) {
  const inspection = inspectPdfFile(inputPath, PDF_LIMITS.maxSupportedBytes);
  if (!inspection.ok) throw new Error('Não foi possível analisar este PDF. Verifique se o arquivo está acessível e tente novamente.');
  const language = normalizeLanguages(options.language);
  const pdfjs = await loadPdfJs();
  const fileDocument = await openPdfJsDocumentFromFile(pdfjs, inputPath, {
    CanvasFactory: OcrCanvasFactory,
    standardFontDataUrl: PDFJS_STANDARD_FONTS,
    isEvalSupported: false,
    useWorkerFetch: false,
    stopAtErrors: true
  }, isCancelled);
  const { loadingTask } = fileDocument;
  let pdfDocument;
  let worker;
  const pageHeadings = [];
  try {
    try {
      pdfDocument = await loadingTask.promise;
    } catch (error) {
      const readError = fileDocument.getReadError();
      if (isCancelled() || error?.message === 'OPERATION_CANCELLED') throw new Error('OPERATION_CANCELLED', { cause: error });
      if (readError) throw normalizeOcrReadError(readError, 'análise de separação');
      throw normalizeOcrDocumentError(error);
    }
    const maxPages = 500;
    if (pdfDocument.numPages > maxPages) {
      throw new Error(`A sugestão automática de títulos aceita até ${maxPages} páginas por análise. Para documentos maiores, use a busca por palavra ou frase.`);
    }
    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
      if (isCancelled()) throw new Error('OPERATION_CANCELLED');
      const page = await pdfDocument.getPage(pageNumber);
      try {
        const viewport = page.getViewport({ scale: 1 });
        const textContent = await page.getTextContent();
        const native = getNativeTextSpans(textContent, viewport);
        let lines = extractTopHeadingLines(textContent, viewport);
        const needsOcr = await pdfPageNeedsOcr(page, native.text, pdfjs.OPS);
        if (needsOcr) {
          const rendered = await renderPdfTopBand(page);
          if (isCancelled()) throw new Error('OPERATION_CANCELLED');
          if (!worker) worker = await createOcrWorker(language, (message) => progress({ stage: 'motor', ...message }));
          const result = await worker.recognize(rendered.bytes, {}, { text: true, blocks: true, pdf: false });
          const ocrLines = extractTopHeadingLinesFromOcr(result.data || {}, rendered.width, rendered.height, rendered.fullHeight);
          if (ocrLines.length) lines = ocrLines;
        }
        pageHeadings.push({ pageNumber, lines });
      } finally {
        page.cleanup();
      }
      progress({ progress: Math.round((pageNumber / pdfDocument.numPages) * 100), page: pageNumber, totalPages: pdfDocument.numPages, status: 'analyzed' });
    }
    return suggestSplitStarts(pageHeadings, { totalPages: pdfDocument.numPages, maxSuggestions: 199 });
  } finally {
    await worker?.terminate();
    await loadingTask.destroy?.();
    await fileDocument.close();
  }
}

async function searchPdfDocument(inputPath, query, options = {}, progress = () => {}, isCancelled = () => false) {
  const inspection = inspectPdfFile(inputPath, PDF_LIMITS.maxSupportedBytes);
  if (!inspection.ok) throw new Error(`Não foi possível abrir o PDF para pesquisa: ${path.basename(inputPath)}.`);
  const normalizedQuery = String(query || '').trim();
  if (!normalizedQuery || normalizedQuery.length > 120) throw new Error('Digite um termo ou uma frase de até 120 caracteres.');
  const language = normalizeLanguages(options.language);
  const pdfjs = await loadPdfJs();
  const fileDocument = await openPdfJsDocumentFromFile(pdfjs, inputPath, {
    CanvasFactory: OcrCanvasFactory,
    standardFontDataUrl: PDFJS_STANDARD_FONTS,
    isEvalSupported: false,
    useWorkerFetch: false,
    stopAtErrors: true
  }, isCancelled);
  const { loadingTask } = fileDocument;
  let worker;
  const matches = [];
  let scannedPages = 0;
  let ocrPages = 0;
  let nativePages = 0;
  let truncated = false;
  const maxMatches = 200;
  try {
    let pdfDocument;
    try {
      pdfDocument = await loadingTask.promise;
    } catch (error) {
      if (isCancelled() || error?.message === 'OPERATION_CANCELLED'
        || fileDocument.getReadError()?.message === 'OPERATION_CANCELLED') throw new Error('OPERATION_CANCELLED', { cause: error });
      const readError = fileDocument.getReadError();
      if (readError) throw normalizeOcrReadError(readError, 'pesquisa');
      throw normalizeOcrDocumentError(error);
    }
    const selectedPages = parsePageRange(options.pageRange, pdfDocument.numPages);
    const totalToSearch = selectedPages?.size || pdfDocument.numPages;
    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
      if (isCancelled()) throw new Error('OPERATION_CANCELLED');
      if (selectedPages && !selectedPages.has(pageNumber)) continue;
      scannedPages += 1;
      const page = await pdfDocument.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const textContent = await page.getTextContent();
      const native = getNativeTextSpans(textContent, viewport);
      const pageNativeMatches = getSearchMatches(native.text, normalizedQuery, native.spans, pageNumber, 'texto', viewport, maxMatches - matches.length);
      if (pageNativeMatches.length) nativePages += 1;
      matches.push(...pageNativeMatches);

      if (await pdfPageNeedsOcr(page, native.text, pdfjs.OPS) && matches.length < maxMatches) {
        ocrPages += 1;
        const rendered = await renderPdfPage(page);
        if (isCancelled()) throw new Error('OPERATION_CANCELLED');
        if (!worker) worker = await createOcrWorker(language, (message) => progress({ stage: 'motor', ...message }));
        const result = await recognizeWithAdaptiveOrientation(rendered.bytes, worker, options, isCancelled, progress);
        const words = getOcrWords(result.data).filter((word) => normalizeText(word.text) && word.bbox
          && [word.bbox.x0, word.bbox.y0, word.bbox.x1, word.bbox.y1].every(Number.isFinite));
        let ocrText = '';
        const ocrSpans = [];
        for (const word of words) {
          const wordText = normalizeText(word.text);
          if (!wordText) continue;
          if (ocrText) ocrText += ' ';
          const start = normalizeSearchText(ocrText).length;
          ocrText += wordText;
          const end = normalizeSearchText(ocrText).length;
          ocrSpans.push({ start, end, box: word.bbox });
        }
        const ocrMatches = getSearchMatches(ocrText, normalizedQuery, ocrSpans, pageNumber, 'OCR', rendered, maxMatches - matches.length);
        matches.push(...ocrMatches.filter((candidate) => !pageNativeMatches.some((nativeMatch) => {
          const overlapX = Math.max(0, Math.min(candidate.xRatio + candidate.widthRatio, nativeMatch.xRatio + nativeMatch.widthRatio) - Math.max(candidate.xRatio, nativeMatch.xRatio));
          const overlapY = Math.max(0, Math.min(candidate.yRatio + candidate.heightRatio, nativeMatch.yRatio + nativeMatch.heightRatio) - Math.max(candidate.yRatio, nativeMatch.yRatio));
          const candidateArea = candidate.widthRatio * candidate.heightRatio;
          return candidate.pageNumber === nativeMatch.pageNumber && candidateArea > 0 && overlapX * overlapY / candidateArea >= 0.5;
        })));
      }
      if (matches.length >= maxMatches) {
        // Atingir o teto significa que a lista foi limitada, mesmo que ocorra
        // na última página; não se pode inferir que o total seja exatamente 200.
        truncated = true;
        page.cleanup();
        break;
      }
      progress({ progress: Math.round((scannedPages / totalToSearch) * 100), page: pageNumber, totalPages: pdfDocument.numPages, status: 'analyzed' });
      page.cleanup();
    }
    return { query: normalizedQuery, matches, scannedPages, ocrPages, nativePages, truncated, totalPages: pdfDocument.numPages };
  } finally {
    await worker?.terminate();
    await loadingTask.destroy?.();
    await fileDocument.close();
  }
}

async function findOcrRedactionCandidates(inputPath, query, options = {}, progress = () => {}, isCancelled = () => false, workerFactory = createOcrWorker) {
  const inspection = inspectPdfFile(inputPath, PDF_LIMITS.maxSupportedBytes);
  if (!inspection.ok) throw new Error(`Não foi possível abrir o PDF para reconhecimento: ${path.basename(inputPath)}.`);
  const pattern = createRedactionSearchPattern(query);
  const language = normalizeLanguages(options.language);
  const initialStats = await fs.promises.stat(inputPath);
  const sourceFingerprint = getSourceFingerprint(initialStats);
  const pdfjs = await loadPdfJs();
  const fileDocument = await openPdfJsDocumentFromFile(pdfjs, inputPath, {
    CanvasFactory: OcrCanvasFactory,
    standardFontDataUrl: PDFJS_STANDARD_FONTS,
    isEvalSupported: false,
    useWorkerFetch: false,
    stopAtErrors: true
  }, isCancelled);
  const { loadingTask } = fileDocument;
  let sourcePdf;
  let pdfDocument = null;
  let processedOcrPages = new Set();
  let worker = null;
  const candidates = [];
  let scannedPages = 0;
  let skippedPages = 0;
  let lowConfidenceMatches = 0;
  let totalMatches = 0;
  let truncated = false;
  try {
    try {
      sourcePdf = await loadingTask.promise;
    } catch (error) {
      const readError = fileDocument.getReadError();
      if (isCancelled() || error?.message === 'OPERATION_CANCELLED' || readError?.message === 'OPERATION_CANCELLED') {
        throw new Error('OPERATION_CANCELLED', { cause: error });
      }
      if (readError) throw normalizeOcrReadError(readError, 'análise');
      throw error;
    }
    for (let pageIndex = 0; pageIndex < sourcePdf.numPages; pageIndex += 1) {
      if (isCancelled()) throw new Error('OPERATION_CANCELLED');
      const page = await sourcePdf.getPage(pageIndex + 1);
      const textContent = await page.getTextContent();
      const existingText = normalizeText((textContent.items || []).map((item) => item.str || '').join(' '));
      let shouldScan = await pdfPageNeedsOcr(page, existingText, pdfjs.OPS);
      if (shouldScan && !pdfDocument) {
        const sourceBytes = await fs.promises.readFile(inputPath);
        pdfDocument = await PDFDocument.load(sourceBytes, { ignoreEncryption: false });
        processedOcrPages = getOcrProcessedPages(pdfDocument);
      }
      if (processedOcrPages.has(pageIndex + 1)) shouldScan = false;
      if (!shouldScan) {
        skippedPages += 1;
        progress({ progress: Math.round(((pageIndex + 1) / sourcePdf.numPages) * 100), page: pageIndex + 1, totalPages: sourcePdf.numPages, status: 'skipped' });
        page.cleanup();
        continue;
      }

      scannedPages += 1;
      const rendered = await renderPdfPage(page);
      if (!worker) worker = await workerFactory(language, (message) => progress({ stage: 'motor', ...message }));
      const result = await recognizeWithAdaptiveOrientation(rendered.bytes, worker, options, isCancelled, progress);
      const words = getOcrWords(result.data)
        .filter((word) => normalizeText(word.text) && Number.isFinite(Number(word.confidence)) && word.bbox
          && [word.bbox.x0, word.bbox.y0, word.bbox.x1, word.bbox.y1].every(Number.isFinite));
      let joinedText = '';
      const spans = [];
      for (const word of words) {
        const value = normalizeText(word.text);
        const start = joinedText.length;
        joinedText += value;
        spans.push({ start, end: joinedText.length, word });
        joinedText += ' ';
      }

      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(joinedText)) !== null) {
        if (!match[0]) continue;
        totalMatches += 1;
        const matchedWords = spans.filter((span) => span.start < match.index + match[0].length && span.end > match.index);
        if (!matchedWords.length) continue;
        const confidence = matchedWords.reduce((sum, span) => sum + Number(span.word.confidence), 0) / matchedWords.length;
        if (confidence < OCR_REDACTION_MIN_CONFIDENCE) {
          lowConfidenceMatches += 1;
          continue;
        }
        if (candidates.length >= OCR_REDACTION_MAX_CANDIDATES) {
          truncated = true;
          continue;
        }
        const x0 = Math.max(0, Math.min(...matchedWords.map((span) => span.word.bbox.x0)));
        const y0 = Math.max(0, Math.min(...matchedWords.map((span) => span.word.bbox.y0)));
        const x1 = Math.min(rendered.width, Math.max(...matchedWords.map((span) => span.word.bbox.x1)));
        const y1 = Math.min(rendered.height, Math.max(...matchedWords.map((span) => span.word.bbox.y1)));
        if (x1 <= x0 || y1 <= y0) continue;
        candidates.push({
          pageIndex,
          xRatio: x0 / rendered.width,
          yRatio: y0 / rendered.height,
          widthRatio: (x1 - x0) / rendered.width,
          heightRatio: (y1 - y0) / rendered.height,
          confidence: Math.round(confidence)
        });
      }
      progress({ progress: Math.round(((pageIndex + 1) / sourcePdf.numPages) * 100), page: pageIndex + 1, totalPages: sourcePdf.numPages, status: 'analyzed', confidence: Number(result.data?.confidence || 0) });
      page.cleanup();
    }
  } finally {
    await worker?.terminate();
    await loadingTask.destroy?.();
    await fileDocument.close();
  }
  const finalStats = await fs.promises.stat(inputPath);
  if (getSourceFingerprint(finalStats) !== sourceFingerprint) {
    throw new Error('O arquivo foi alterado durante a análise. Adicione-o novamente e tente outra vez; nenhuma alteração foi aplicada.');
  }
  return { candidates, scannedPages, skippedPages, totalMatches, lowConfidenceMatches, truncated, minimumConfidence: OCR_REDACTION_MIN_CONFIDENCE };
}

async function recognizePdf(inputPath, options = {}, progress = () => {}, isCancelled = () => false, workerFactory = createOcrWorker, workerSession = null) {
  const inspection = inspectPdfFile(inputPath, PDF_LIMITS.maxSupportedBytes);
  if (!inspection.ok) throw new Error(`Não foi possível abrir o PDF para reconhecimento: ${path.basename(inputPath)}.`);
  const language = normalizeLanguages(options.language);
  const mode = normalizeOcrMode(options.mode);
  const includePageText = options.format === 'text';
  let sourceBytes = mode === 'auto' ? null : await fs.promises.readFile(inputPath);
  const initialStats = await fs.promises.stat(inputPath);
  const sourceFingerprint = getSourceFingerprint(initialStats);
  const pdfjs = await loadPdfJs();
  const fileDocument = sourceBytes ? null : await openPdfJsDocumentFromFile(pdfjs, inputPath, {
    CanvasFactory: OcrCanvasFactory,
    standardFontDataUrl: PDFJS_STANDARD_FONTS,
    isEvalSupported: false,
    useWorkerFetch: false,
    stopAtErrors: true
  }, isCancelled);
  const loadingTask = fileDocument?.loadingTask || getOcrPdfDocument(pdfjs, {
    data: new Uint8Array(sourceBytes),
    standardFontDataUrl: PDFJS_STANDARD_FONTS,
    isEvalSupported: false,
    useWorkerFetch: false,
    stopAtErrors: true,
    disableWorker: true
  });
  let sourcePdf;
  let selectedPages;
  let outputPdf;
  try {
    sourcePdf = await loadingTask.promise;
    selectedPages = parsePageRange(options.pageRange, sourcePdf.numPages);
    outputPdf = mode === 'auto' ? null : await PDFDocument.load(sourceBytes, { ignoreEncryption: false });
  } catch (error) {
    const readError = fileDocument?.getReadError();
    await loadingTask.destroy?.();
    await fileDocument?.close();
    if (isCancelled() || error?.message === 'OPERATION_CANCELLED' || readError?.message === 'OPERATION_CANCELLED') {
      throw new Error('OPERATION_CANCELLED', { cause: error });
    }
    if (readError) throw normalizeOcrReadError(readError, 'OCR');
    throw normalizeOcrDocumentError(error);
  }
  let processedOcrPages = outputPdf ? getOcrProcessedPages(outputPdf) : new Set();
  const redoNativeBoxes = new Map();
  let modifiedOutput = false;
  if (mode === 'redo') {
    const selectedPageNumbers = selectedPages
      ? [...selectedPages]
      : Array.from({ length: outputPdf.getPageCount() }, (_, index) => index + 1);
    const pagesToReplace = selectedPageNumbers.filter((pageNumber) => processedOcrPages.has(pageNumber));
    modifiedOutput = pagesToReplace.length > 0;
    const replacementMetadata = pagesToReplace.map((pageNumber) => ({
      pageNumber,
      metadata: readOcrLayerMetadata(outputPdf, outputPdf.getPage(pageNumber - 1))
    }));
    const unsupportedPage = replacementMetadata.find((entry) => !entry.metadata);
    if (unsupportedPage) {
      const error = new Error(`Não é possível refazer o OCR da página ${unsupportedPage.pageNumber}: a camada anterior não pode ser identificada com segurança. O arquivo original foi mantido.`);
      error.safeUserMessage = error.message;
      throw error;
    }
    for (const { pageNumber, metadata } of replacementMetadata) {
      const page = outputPdf.getPage(pageNumber - 1);
      if (!removeOcrLayer(outputPdf, page, metadata)) {
        const error = new Error(`Não foi possível substituir a camada OCR da página ${pageNumber}. O arquivo original foi mantido.`);
        error.safeUserMessage = error.message;
        throw error;
      }
      redoNativeBoxes.set(pageNumber, metadata.nativeTextBoxes);
      processedOcrPages.delete(pageNumber);
    }
  }
  let font = null;
  let worker = null;
  const pageResults = [];
  try {
    for (let index = 0; index < sourcePdf.numPages; index += 1) {
      if (isCancelled()) throw new Error('OPERATION_CANCELLED');
      const page = await sourcePdf.getPage(index + 1);
      const textContent = await page.getTextContent();
      const existingText = normalizeText((textContent.items || []).map((item) => item.str || '').join(' '));
      if (selectedPages && !selectedPages.has(index + 1)) {
        // A PDF result still preserves every visual/native page, but TXT is a
        // page-range export: including native text from pages outside the
        // requested range would silently leak unselected content into it.
        pageResults.push({ pageNumber: index + 1, status: 'out-of-range', textLength: 0, ...(includePageText ? { text: '' } : {}) });
        progress({ progress: Math.round(((index + 1) / sourcePdf.numPages) * 100), page: index + 1, totalPages: sourcePdf.numPages, status: 'out-of-range' });
        page.cleanup();
        continue;
      }
      let shouldProcess = mode === 'complete' || (mode === 'redo' && redoNativeBoxes.has(index + 1));
      if (!shouldProcess && mode === 'auto' && !processedOcrPages.has(index + 1)) {
        shouldProcess = await pdfPageNeedsOcr(page, existingText, pdfjs.OPS);
      }
      if (shouldProcess && !outputPdf) {
        sourceBytes ??= await fs.promises.readFile(inputPath);
        outputPdf = await PDFDocument.load(sourceBytes, { ignoreEncryption: false });
        processedOcrPages = getOcrProcessedPages(outputPdf);
        if (processedOcrPages.has(index + 1)) shouldProcess = false;
      }
      if (!shouldProcess) {
        pageResults.push({ pageNumber: index + 1, status: 'skipped', textLength: existingText.length, ...(includePageText ? { text: existingText } : {}) });
        progress({ progress: Math.round(((index + 1) / sourcePdf.numPages) * 100), page: index + 1, totalPages: sourcePdf.numPages, status: 'skipped' });
        page.cleanup();
        continue;
      }
      const rendered = await renderPdfPage(page);
      if (!worker) {
        worker = workerSession
          ? await workerSession.getWorker((message) => progress({ stage: 'motor', ...message }))
          : await workerFactory(language, (message) => progress({ stage: 'motor', ...message }));
      }
      if (!font) font = await outputPdf.embedFont(StandardFonts.Helvetica);
      const result = await recognizeWithAdaptiveOrientation(rendered.bytes, worker, options, isCancelled, progress);
      const recognizedText = normalizeText(result.data?.text || '');
      const pageViewport = page.getViewport({ scale: 1 });
      const existingTextBoxes = redoNativeBoxes.get(index + 1) || getNativeTextSpans(textContent, pageViewport).spans.map(({ box }) => ({
        x0: box.x0 / pageViewport.width,
        y0: box.y0 / pageViewport.height,
        x1: box.x1 / pageViewport.width,
        y1: box.y1 / pageViewport.height
      }));
      const outputPage = outputPdf.getPage(index);
      const ocrLayerPage = PDFPage.of(outputPage.node, outputPage.ref, outputPdf);
      const ocrLayerRef = drawInvisibleText(outputPdf, ocrLayerPage, font, result.data, rendered.width, rendered.height, existingTextBoxes, result.angle, result.width, result.height);
      if (recognizedText) {
        modifiedOutput = true;
        processedOcrPages.add(index + 1);
        if (ocrLayerRef instanceof PDFRef || !readOcrLayerMetadata(outputPdf, outputPage)) {
          storeOcrLayerMetadata(outputPage, ocrLayerRef, existingTextBoxes);
        }
      }
      const status = recognizedText ? 'recognized' : 'no-text';
      pageResults.push({ pageNumber: index + 1, status, textLength: recognizedText.length, confidence: Number(result.data?.confidence || 0), orientationCorrectionDegrees: result.angle, preprocessingApplied: result.preprocessingApplied, ...(includePageText ? { text: recognizedText } : {}) });
      progress({ progress: Math.round(((index + 1) / sourcePdf.numPages) * 100), page: index + 1, totalPages: sourcePdf.numPages, status, confidence: Number(result.data?.confidence || 0) });
      page.cleanup();
    }
  } finally {
    if (!workerSession) await worker?.terminate();
    await loadingTask.destroy?.();
    await fileDocument?.close();
  }
  const finalStats = await fs.promises.stat(inputPath);
  if (getSourceFingerprint(finalStats) !== sourceFingerprint) {
    const error = new Error('O arquivo foi alterado durante a análise. Adicione-o novamente e tente outra vez; a origem não foi modificada pelo OCR.');
    if (process.env.CENTRAL_PDF_OCR_TEST_DIAGNOSTICS === '1') {
      error.testDiagnostic = `fingerprint inicial ${sourceFingerprint}; final ${finalStats.size}:${finalStats.mtimeMs}:${finalStats.ctimeMs}`;
    }
    throw error;
  }
  if (mode === 'auto' && !modifiedOutput && options.format !== 'text') {
    return { copyOriginal: true, pageResults, pageCount: sourcePdf.numPages, recognizedPages: 0, skippedPages: pageResults.filter((item) => item.status === 'skipped').length, language };
  }
  const pdfBytes = modifiedOutput && outputPdf
    ? (markOcrProcessedPages(outputPdf, [...processedOcrPages]), await outputPdf.save({ useObjectStreams: true }))
    : sourceBytes;
  return { pdfBytes, pageResults, pageCount: sourcePdf.numPages, recognizedPages: pageResults.filter((item) => item.status === 'recognized').length, skippedPages: pageResults.filter((item) => item.status === 'skipped').length, language };
}

async function recognizeImage(inputPath, options = {}, progress = () => {}, isCancelled = () => false, workerSession = null) {
  if (isCancelled()) throw new Error('OPERATION_CANCELLED');
  const includePageText = options.format === 'text';
  if (/\.(png|jpe?g)$/i.test(inputPath)) parsePageRange(options.pageRange, 1);
  const { bytes: imageBytes, ifds: tiffIfds, pageDimensions: tiffPageDimensions, sourceFingerprint } = await readOcrImage(inputPath);
  if (/\.tiff?$/i.test(inputPath)) {
    const bytes = getTiffArrayBuffer(imageBytes);
    const ifds = tiffIfds;
    const pageDimensions = tiffPageDimensions;
    const selectedPages = parsePageRange(options.pageRange, ifds.length);
    const outputPdf = await PDFDocument.create();
    const font = await outputPdf.embedFont(StandardFonts.Helvetica);
    let worker = null;
    const pageResults = [];
    try {
      for (let index = 0; index < ifds.length; index += 1) {
        if (isCancelled()) throw new Error('OPERATION_CANCELLED');
        const ifd = ifds[index];
        const { width, height } = pageDimensions[index];
        const pngBytes = decodeTiffPageToPng(bytes, ifd, { width, height });
        const page = outputPdf.addPage([width, height]);
        const embedded = await outputPdf.embedPng(pngBytes);
        page.drawImage(embedded, { x: 0, y: 0, width, height });
        if (selectedPages && !selectedPages.has(index + 1)) {
          pageResults.push({ pageNumber: index + 1, status: 'out-of-range', textLength: 0, ...(includePageText ? { text: '' } : {}) });
          progress({ progress: Math.round(((index + 1) / ifds.length) * 100), page: index + 1, totalPages: ifds.length, status: 'out-of-range' });
          continue;
        }
        if (!worker) {
          worker = workerSession
            ? await workerSession.getWorker((message) => progress({ stage: 'motor', ...message }))
            : await createOcrWorker(options.language, (message) => progress({ stage: 'motor', ...message }));
        }
        const result = await recognizeWithAdaptiveOrientation(pngBytes, worker, options, isCancelled, progress);
        const ocrLayerPage = PDFPage.of(page.node, page.ref, outputPdf);
        const ocrLayerRef = drawInvisibleText(outputPdf, ocrLayerPage, font, result.data, width, height, [], result.angle, result.width, result.height);
        const text = normalizeText(result.data?.text || '');
        if (text) storeOcrLayerMetadata(page, ocrLayerRef, []);
        const status = text ? 'recognized' : 'no-text';
        pageResults.push({ pageNumber: index + 1, status, textLength: text.length, confidence: Number(result.data?.confidence || 0), orientationCorrectionDegrees: result.angle, preprocessingApplied: result.preprocessingApplied, ...(includePageText ? { text } : {}) });
        progress({ progress: Math.round(((index + 1) / ifds.length) * 100), page: index + 1, totalPages: ifds.length, status, confidence: Number(result.data?.confidence || 0) });
      }
    } finally {
      if (!workerSession) await worker?.terminate();
    }
    const finalStats = await fs.promises.stat(inputPath);
    if (getSourceFingerprint(finalStats) !== sourceFingerprint) {
      const error = new Error('O arquivo foi alterado durante o reconhecimento. Adicione-o novamente; o original não foi modificado pelo OCR.');
      error.safeUserMessage = error.message;
      throw error;
    }
    markOcrProcessedPages(outputPdf, pageResults.filter((page) => page.status === 'recognized').map((page) => page.pageNumber));
    return { pdfBytes: await outputPdf.save({ useObjectStreams: true }), pageResults, pageCount: ifds.length, recognizedPages: pageResults.filter((page) => page.status === 'recognized').length, skippedPages: 0, language: normalizeLanguages(options.language) };
  }
  const image = await loadImage(imageBytes);
  const worker = workerSession
    ? await workerSession.getWorker((message) => progress({ stage: 'motor', ...message }))
    : await createOcrWorker(options.language, (message) => progress({ stage: 'motor', ...message }));
  try {
    const result = await recognizeWithAdaptiveOrientation(imageBytes, worker, options, isCancelled, progress);
    const outputPdf = await PDFDocument.create();
    const page = outputPdf.addPage([image.width, image.height]);
    const embedded = /\.png$/i.test(inputPath)
      ? await outputPdf.embedPng(imageBytes)
      : await outputPdf.embedJpg(getExactByteView(imageBytes));
    page.drawImage(embedded, { x: 0, y: 0, width: image.width, height: image.height });
    const font = await outputPdf.embedFont(StandardFonts.Helvetica);
    const ocrLayerPage = PDFPage.of(page.node, page.ref, outputPdf);
    const ocrLayerRef = drawInvisibleText(outputPdf, ocrLayerPage, font, result.data, image.width, image.height, [], result.angle, result.width, result.height);
    const recognizedText = normalizeText(result.data?.text || '');
    if (recognizedText) storeOcrLayerMetadata(page, ocrLayerRef, []);
    markOcrProcessedPages(outputPdf, recognizedText ? [1] : []);
    const status = recognizedText ? 'recognized' : 'no-text';
    progress({ progress: 100, page: 1, totalPages: 1, status, confidence: Number(result.data?.confidence || 0) });
    const finalStats = await fs.promises.stat(inputPath);
    if (getSourceFingerprint(finalStats) !== sourceFingerprint) {
      const error = new Error('O arquivo foi alterado durante o reconhecimento. Adicione-o novamente; o original não foi modificado pelo OCR.');
      error.safeUserMessage = error.message;
      throw error;
    }
    return { pdfBytes: await outputPdf.save({ useObjectStreams: true }), pageResults: [{ pageNumber: 1, status, textLength: recognizedText.length, confidence: Number(result.data?.confidence || 0), orientationCorrectionDegrees: result.angle, preprocessingApplied: result.preprocessingApplied, ...(includePageText ? { text: recognizedText } : {}) }], pageCount: 1, recognizedPages: recognizedText ? 1 : 0, skippedPages: 0, language: normalizeLanguages(options.language) };
  } finally { if (!workerSession) await worker.terminate(); }
}

async function writeOcrOutput(result, inputPath, outputDir, options = {}, fileSystem = fs.promises) {
  await fileSystem.mkdir(outputDir, { recursive: true });
  const base = sanitizeFilename(options.outputName || `${path.parse(inputPath).name}_pesquisavel`).replace(/\.(pdf|txt)$/i, '');
  const outputPath = resolveUniqueOutputPath(path.join(outputDir, `${base}.${options.format === 'text' ? 'txt' : 'pdf'}`));
  const tempPath = path.join(outputDir, `.${path.basename(outputPath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    if (options.format === 'text') {
      await fileSystem.writeFile(tempPath, result.pageResults.map((page) => page.text || '').join('\n\n'), { encoding: 'utf8', flag: 'wx' });
    } else if (result.copyOriginal === true) {
      await fileSystem.copyFile(inputPath, tempPath, fs.constants.COPYFILE_EXCL);
    } else {
      let validatedPdf;
      try {
        validatedPdf = await PDFDocument.load(result.pdfBytes, { ignoreEncryption: false });
      } catch (error) {
        throw new Error('O PDF produzido pelo reconhecimento não passou na verificação de integridade. O arquivo final não foi publicado.', { cause: error });
      }
      const expectedPageCount = Number(result.pageCount);
      if (!validatedPdf.getPageCount() || (Number.isInteger(expectedPageCount) && expectedPageCount > 0 && validatedPdf.getPageCount() !== expectedPageCount)) {
        throw new Error('O PDF produzido pelo reconhecimento não passou na verificação de páginas. O arquivo final não foi publicado.');
      }
      await fileSystem.writeFile(tempPath, result.pdfBytes, { flag: 'wx' });
    }
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fileSystem.rename(tempPath, outputPath);
        break;
      } catch (error) {
        const transientWindowsLock = ['EPERM', 'EACCES', 'EBUSY'].includes(error?.code);
        if (!transientWindowsLock || attempt >= 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25 * (2 ** attempt)));
      }
    }
  } catch (error) {
    await fileSystem.unlink(tempPath).catch(() => {});
    try {
      const outputStats = await fileSystem.stat(outputPath);
      if (outputStats.isFile() && outputStats.size === 0) await fileSystem.unlink(outputPath);
    } catch {}
    throw error;
  }
  return outputPath;
}

module.exports = { createInvertedImage, extractNativeTextInRect, cleanRedundantText, OCR_LANGUAGES, OCR_DEFAULT_LANGUAGE, OCR_DEFAULT_MODE, OCR_REDACTION_MIN_CONFIDENCE, OCR_MAX_RENDER_PIXELS, OCR_ADAPTIVE_THRESHOLD_MAX_PIXELS, OCR_ISOLATED_NOISE_MAX_PIXELS, getSafeOcrRenderDimensions, validateTiffPages, decodeTiffPageToPng, getTiffArrayBuffer, getExactByteView, createOcrWorkerSession, normalizeLanguages, normalizeOcrMode, normalizeOcrDocumentError, normalizeOcrReadError, pageNeedsOcr, analyzePdfOcrNeed, parsePageRange, createRedactionSearchPattern, scoreOcrResult, createContrastEnhancedImage, createAdaptiveBinarizedImage, createIsolatedNoiseReducedImage, createMarginTrimmedImage, estimateSmallSkewCorrection, estimateBaselineSkewCorrection, renderPdfPage, releaseOcrCanvas, recognizeWithAdaptiveOrientation, recognizeImage, searchPdfDocument, suggestPdfSplitStarts, findOcrRedactionCandidates, recognizePdfArea, recognizePdf, writeOcrOutput };
