export function getPendingTabMessage(tabId, state, helpers = {}) {
  const {
    getWatermarkPendingMessage = () => "",
    getImagePendingMessage = () => "",
    getSignaturePendingMessage = () => "",
    getPdfToWordPendingMessage = () => "",
    getProtectPendingMessage = () => "",
    getUnlockPendingMessage = () => "",
    getRedactPendingMessage = () => ""
  } = helpers;

  if (tabId === "images-to-pdf") {
    return getImagePendingMessage() || "";
  }

  if (tabId === "signature") {
    return getSignaturePendingMessage() || "";
  }

  if (tabId === "pdf-to-word") {
    return getPdfToWordPendingMessage() || "";
  }

  if (tabId === "merge" && state.mergeFiles.length > 0) {
    return "Há arquivos anexados em Mesclar. Se sairmos agora, essa seleção será perdida.";
  }

  if (tabId === "split" && state.selectedSplitFile) {
    return "Há um arquivo carregado em Separar PDFs. Se sairmos agora, essa seleção será perdida.";
  }

  if (tabId === "compress" && state.selectedCompressFile) {
    return "Há um arquivo carregado em Reduzir tamanho. Se sairmos agora, essa seleção será perdida.";
  }

  if (tabId === "watermark") {
    return getWatermarkPendingMessage() || "";
  }

  if (tabId === "organize" && (state.organizeFile || state.organizePages.length > 0)) {
    return "Há páginas carregadas em Organizar Páginas. Se sairmos agora, essa preparação será perdida.";
  }

  if (tabId === "protect") {
    return getProtectPendingMessage() || "";
  }

  if (tabId === "unlock") {
    return getUnlockPendingMessage() || "";
  }

  if (tabId === "redact") {
    return getRedactPendingMessage() || "";
  }

  return "";
}

export function hasAnyPendingTabWork(state, helpers = {}) {
  return ["images-to-pdf", "signature", "pdf-to-word", "merge", "split", "compress", "watermark", "organize", "protect", "unlock", "redact"]
    .some((tabId) => Boolean(getPendingTabMessage(tabId, state, helpers)));
}

