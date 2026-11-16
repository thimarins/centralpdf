const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const PDFJS_STANDARD_FONTS = `${path.resolve(path.dirname(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')), '../../standard_fonts').replace(/\\/g, '/')}/`;
const PDFJS_WORKER_SOURCE = pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')).href;

async function loadPdfJs() {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_SOURCE;
  return pdfjs;
}

function normalizeWhitespace(value = '') {
  return String(value).replace(/\s+/g, ' ').trim();
}

function groupTextItems(items = [], pageWidth = 0) {
  const rows = [];
  const gapThreshold = Math.max(18, Number(pageWidth) * 0.035);
  const sorted = [...items].sort((a, b) => {
    const ay = Number(a.transform?.[5] || 0);
    const by = Number(b.transform?.[5] || 0);
    if (Math.abs(by - ay) > 2) return by - ay;
    return Number(a.transform?.[4] || 0) - Number(b.transform?.[4] || 0);
  });

  sorted.forEach((item) => {
    const text = normalizeWhitespace(item.str);
    if (!text) return;
    const y = Number(item.transform?.[5] || 0);
    const x = Number(item.transform?.[4] || 0);
    const width = Math.max(0, Number(item.width) || 0);
    const lastRow = rows[rows.length - 1];
    if (!lastRow || Math.abs(lastRow.y - y) > 3) {
      rows.push({ y, parts: [{ x, width, text }] });
      return;
    }
    lastRow.parts.push({ x, width, text });
  });

  const structuredRows = rows.map((row) => {
    const parts = row.parts.sort((a, b) => a.x - b.x);
    const cells = [];
    let currentCell = null;
    for (const part of parts) {
      const gap = currentCell ? part.x - currentCell.right : 0;
      if (!currentCell || gap > gapThreshold) {
        currentCell = { x: part.x, right: part.x + part.width, text: part.text };
        cells.push(currentCell);
      } else {
        currentCell.text = `${currentCell.text} ${part.text}`;
        currentCell.right = Math.max(currentCell.right, part.x + part.width);
      }
    }
    return {
      y: row.y,
      cells: cells.map(({ x, text }) => ({ x, text: normalizeWhitespace(text) })).filter((cell) => cell.text),
      text: normalizeWhitespace(parts.map((part) => part.text).join(' '))
    };
  }).filter((row) => row.text);

  const blocks = [];
  for (let rowIndex = 0; rowIndex < structuredRows.length;) {
    const first = structuredRows[rowIndex];
    if (first.cells.length < 2) {
      blocks.push({ type: 'paragraph', text: first.text });
      rowIndex += 1;
      continue;
    }

    const candidateRows = [first];
    let nextIndex = rowIndex + 1;
    while (nextIndex < structuredRows.length) {
      const candidate = structuredRows[nextIndex];
      const previous = candidateRows[candidateRows.length - 1];
      const aligned = candidate.cells.length === first.cells.length
        && candidate.cells.every((cell, index) => Math.abs(cell.x - first.cells[index].x) <= Math.max(10, Number(pageWidth) * 0.025));
      if (!aligned || candidate.y > previous.y) break;
      candidateRows.push(candidate);
      nextIndex += 1;
    }

    if (candidateRows.length >= 3) {
      blocks.push({ type: 'table', rows: candidateRows.map((row) => row.cells.map((cell) => cell.text)) });
      rowIndex = nextIndex;
    } else {
      blocks.push({ type: 'paragraph', text: first.text });
      rowIndex += 1;
    }
  }

  return { lines: structuredRows.map((row) => row.text), blocks };
}

async function extractStructuredText(pdfPath, progress = () => {}, isCancelled = () => false) {
  const pdfjs = await loadPdfJs();
  const isPdfBytes = Buffer.isBuffer(pdfPath) || pdfPath instanceof Uint8Array;
  const bytes = isPdfBytes ? pdfPath : await fs.promises.readFile(pdfPath);
  const sourceName = isPdfBytes ? 'Documento processado' : path.basename(pdfPath);
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    standardFontDataUrl: PDFJS_STANDARD_FONTS,
    isEvalSupported: false,
    useWorkerFetch: false,
    disableWorker: true,
    useSystemFonts: true,
    stopAtErrors: true,
    disableAutoFetch: true,
    disableStream: false,
    disableRange: false
  });
  const pdf = await loadingTask.promise;
  const pages = [];
  let totalTextLength = 0;

  try {
    for (let pageIndex = 1; pageIndex <= pdf.numPages; pageIndex += 1) {
      if (isCancelled()) throw new Error('OPERATION_CANCELLED');
      const page = await pdf.getPage(pageIndex);
      try {
        const textContent = await page.getTextContent();
        const viewport = page.getViewport({ scale: 1 });
        const layout = groupTextItems(textContent.items || [], viewport.width);
        const lines = layout.lines;
        const pageText = lines.join('\n').trim();
        totalTextLength += pageText.length;
        pages.push({ pageNumber: pageIndex, lines, blocks: layout.blocks, text: pageText });
        progress({
          progress: Math.min(92, Math.round((pageIndex / pdf.numPages) * 92)),
          itemProgress: Math.round((pageIndex / pdf.numPages) * 100),
          currentItem: 1,
          totalItems: 1,
          currentItemName: sourceName
        });
      } finally {
        page.cleanup();
      }
    }
  } finally {
    await loadingTask.destroy?.();
  }

  return {
    pageCount: pdf.numPages,
    pages,
    totalTextLength
  };
}

module.exports = {
  extractStructuredText
};
