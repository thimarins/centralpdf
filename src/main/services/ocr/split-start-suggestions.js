const MAX_HEADING_LENGTH = 100;
const MAX_HEADINGS_PER_PAGE = 4;

function normalizeHeading(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(?:pagina|page)\s*\d+(?:\s*(?:de|of)\s*\d+)?\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function prepareHeadings(page) {
  const lines = Array.isArray(page?.lines) ? page.lines : [];
  const seen = new Set();
  const prepared = [];
  for (const line of lines) {
    const text = String(line?.text || '').replace(/\s+/g, ' ').trim();
    const normalized = normalizeHeading(text);
    const yRatio = Number(line?.yRatio);
    const words = normalized.split(' ').filter(Boolean);
    if (!Number.isFinite(yRatio) || yRatio > 0.34 || yRatio < 0 || text.length < 5 || text.length > MAX_HEADING_LENGTH
      || words.length < 2 || words.length > 14 || !/\p{L}/u.test(normalized)
      || /^(?:\d{1,4}|\d{1,2}[./-]\d{1,2}[./-]\d{2,4})$/.test(normalized)
      || seen.has(normalized)) continue;
    seen.add(normalized);
    prepared.push({ text, normalized, yRatio, source: line?.source === 'OCR' ? 'OCR' : 'texto do PDF' });
    if (prepared.length >= MAX_HEADINGS_PER_PAGE) break;
  }
  return prepared;
}

function suggestSplitStarts(pageHeadings, options = {}) {
  const totalPages = Math.max(0, Math.floor(Number(options.totalPages) || pageHeadings.length));
  const maxSuggestions = Math.min(199, Math.max(1, Math.floor(Number(options.maxSuggestions) || 100)));
  const byPage = new Map();
  const occurrences = new Map();
  for (const page of pageHeadings) {
    const pageNumber = Math.floor(Number(page?.pageNumber));
    if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > totalPages) continue;
    const headings = prepareHeadings(page);
    byPage.set(pageNumber, headings);
    for (const heading of headings) {
      if (!occurrences.has(heading.normalized)) occurrences.set(heading.normalized, { text: heading.text, pages: [], source: heading.source });
      occurrences.get(heading.normalized).pages.push(pageNumber);
    }
  }

  const candidatesByPage = new Map();
  for (const [normalized, entry] of occurrences) {
    const pages = [...new Set(entry.pages)].sort((left, right) => left - right);
    const frequency = pages.length / Math.max(1, totalPages);
    // Very common running headers are not useful document-boundary hints.
    if (pages.length < 2 || frequency > 0.8) continue;
    const pageSet = new Set(pages);
    for (const pageNumber of pages) {
      if (pageNumber === 1 || pageSet.has(pageNumber - 1)) continue;
      const heading = byPage.get(pageNumber)?.find((item) => item.normalized === normalized);
      if (!heading) continue;
      const candidate = {
        pageNumber,
        heading: heading.text,
        source: heading.source,
        repeatedOnPages: pages.length,
        frequency: Number(frequency.toFixed(2))
      };
      const existing = candidatesByPage.get(pageNumber);
      if (!existing || heading.yRatio < existing.yRatio || pages.length > existing.repeatedOnPages) {
        candidatesByPage.set(pageNumber, { ...candidate, yRatio: heading.yRatio });
      }
    }
  }

  const suggestions = [...candidatesByPage.values()]
    .sort((left, right) => left.pageNumber - right.pageNumber || left.yRatio - right.yRatio)
    .slice(0, maxSuggestions)
    .map(({ pageNumber, heading, source, repeatedOnPages, frequency }) => ({
      pageNumber, heading, source, repeatedOnPages, frequency
    }));
  return {
    suggestions,
    scannedPages: byPage.size,
    totalPages,
    truncated: candidatesByPage.size > suggestions.length
  };
}

module.exports = { normalizeHeading, prepareHeadings, suggestSplitStarts };
