const OCR_LOW_CONFIDENCE_THRESHOLD = 60;
const OCR_LOW_CONFIDENCE_PAGE_SAMPLE = 5;

function getSafeFileLabel(value) {
  const fileName = [...String(value || '')]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? ' ' : character;
    })
    .join('')
    .trim();
  return (fileName || 'arquivo sem nome').slice(0, 120);
}

function createLowConfidenceWarnings(pageResults, threshold = OCR_LOW_CONFIDENCE_THRESHOLD) {
  if (!Array.isArray(pageResults)) return [];
  const safeThreshold = Number.isFinite(threshold) ? Math.max(0, Math.min(100, threshold)) : OCR_LOW_CONFIDENCE_THRESHOLD;
  const pagesByFile = new Map();

  for (const page of pageResults) {
    if (page?.status !== 'recognized' || !Number.isFinite(page.confidence) || page.confidence >= safeThreshold) continue;
    const fileName = getSafeFileLabel(page.fileName);
    const summary = pagesByFile.get(fileName) || { count: 0, pages: [] };
    summary.count += 1;
    const pageNumber = Number.isSafeInteger(page.pageNumber) && page.pageNumber > 0 ? page.pageNumber : null;
    if (pageNumber !== null) summary.pages.push(pageNumber);
    pagesByFile.set(fileName, summary);
  }

  return [...pagesByFile.entries()].map(([fileName, summary]) => {
    const { count, pages } = summary;
    const sample = pages.slice(0, OCR_LOW_CONFIDENCE_PAGE_SAMPLE).join(', ');
    const suffix = count > OCR_LOW_CONFIDENCE_PAGE_SAMPLE
      ? ` e mais ${count - OCR_LOW_CONFIDENCE_PAGE_SAMPLE}`
      : '';
    const pageDetails = sample ? ` (páginas ${sample}${suffix})` : '';
    return `Arquivo "${fileName}": confiança estimada baixa (abaixo de ${safeThreshold}%) em ${count} página(s)${pageDetails}. Revise o texto com o documento original.`;
  });
}

module.exports = { OCR_LOW_CONFIDENCE_THRESHOLD, createLowConfidenceWarnings };
