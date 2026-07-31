const fs = require('fs');

async function loadPdfJs() {
  return import('pdfjs-dist/legacy/build/pdf.mjs');
}

function normalizeWhitespace(value = '') {
  return String(value).replace(/\s+/g, ' ').trim();
}

function groupTextItems(items = []) {
  const rows = [];
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
    const lastRow = rows[rows.length - 1];
    if (!lastRow || Math.abs(lastRow.y - y) > 3) {
      rows.push({ y, parts: [{ x, text }] });
      return;
    }
    lastRow.parts.push({ x, text });
  });

  return rows
    .map((row) => row.parts.sort((a, b) => a.x - b.x).map((part) => part.text).join(' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

async function extractStructuredText(pdfPath, progress = () => {}, isCancelled = () => false) {
  const pdfjs = await loadPdfJs();
  const bytes = await fs.promises.readFile(pdfPath);
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    useWorkerFetch: false,
    useSystemFonts: true,
    stopAtErrors: true,
    disableAutoFetch: true,
    disableStream: false,
    disableRange: false
  });
  const pdf = await loadingTask.promise;
  const pages = [];
  let totalTextLength = 0;

  for (let pageIndex = 1; pageIndex <= pdf.numPages; pageIndex += 1) {
    if (isCancelled()) throw new Error('OPERATION_CANCELLED');
    const page = await pdf.getPage(pageIndex);
    const textContent = await page.getTextContent();
    const lines = groupTextItems(textContent.items || []);
    const pageText = lines.join('\n').trim();
    totalTextLength += pageText.length;
    pages.push({ pageNumber: pageIndex, lines, text: pageText });
    progress({
      progress: Math.min(92, Math.round((pageIndex / pdf.numPages) * 92)),
      itemProgress: Math.round((pageIndex / pdf.numPages) * 100),
      currentItem: 1,
      totalItems: 1,
      currentItemName: require('path').basename(pdfPath)
    });
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
