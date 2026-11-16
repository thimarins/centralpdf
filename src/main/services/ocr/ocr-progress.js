const TESSERACT_STAGE_LABELS = Object.freeze([
  [/loading tesseract core/i, 'Preparando o mecanismo de OCR'],
  [/loading language traineddata/i, 'Carregando os idiomas'],
  [/initializing tesseract/i, 'Inicializando o reconhecimento'],
  [/initializing api/i, 'Preparando a página'],
  [/recognizing text/i, 'Reconhecendo texto'],
  [/loading image/i, 'Preparando a imagem'],
  [/recognizing.*orientation/i, 'Verificando a orientação']
]);

function normalizeOcrProgressPercent(value, isTesseractFraction = false) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  const percent = isTesseractFraction && numeric >= 0 && numeric <= 1 ? numeric * 100 : numeric;
  return Math.round(Math.max(0, Math.min(100, percent)));
}

function getOcrStageLabel(status = '') {
  const value = String(status || '').trim();
  const match = TESSERACT_STAGE_LABELS.find(([pattern]) => pattern.test(value));
  return match ? match[1] : '';
}

function createOcrProgressUpdate(item = {}, {
  fileIndex = 0,
  fileCount = 1,
  fileName = '',
  currentItem = fileIndex + 1,
  progressStart = 0,
  progressSpan = 100
} = {}) {
  const safeFileCount = Number.isSafeInteger(fileCount) && fileCount > 0 ? fileCount : 1;
  const safeFileIndex = Number.isSafeInteger(fileIndex) ? Math.max(0, Math.min(safeFileCount - 1, fileIndex)) : 0;
  const itemProgress = normalizeOcrProgressPercent(item.progress, item.stage === 'motor');
  const overallRatio = (safeFileIndex + itemProgress / 100) / safeFileCount;
  const stageLabel = getOcrStageLabel(item.status);
  const label = String(fileName || '').trim();

  return {
    ...item,
    progress: Math.max(0, Math.min(98, Math.round(progressStart + overallRatio * progressSpan))),
    itemProgress,
    currentItem,
    totalItems: safeFileCount,
    currentItemName: [label, stageLabel].filter(Boolean).join(' — ') || stageLabel || 'Reconhecendo texto'
  };
}

module.exports = { normalizeOcrProgressPercent, getOcrStageLabel, createOcrProgressUpdate };
