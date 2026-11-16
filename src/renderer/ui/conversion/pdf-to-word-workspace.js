import { formatDocumentMeta } from '../document-info.js';

export function createPdfToWordWorkspaceController(deps) {
  const {
    state,
    document,
    toneIcon,
    clearFeedbackBanner,
    formatBytes,
    analyzePdfForOcr,
    cancelPdfForOcrAnalysis
  } = deps;

  let analysisGeneration = 0;
  let analysisRequestId = '';
  let analysisState = { status: 'idle', totalPages: 0, sampledPages: 0, pagesLikelyScanned: [] };

  function getStatusBanner() {
    return document.getElementById('pdf-to-word-status');
  }

  function syncVisibility() {
    const hasFile = !!state.pdfToWordFile;
    document.getElementById('pdf-to-word-dropzone')?.classList.toggle('hidden', hasFile);
    document.getElementById('pdf-to-word-settings-container')?.classList.toggle('hidden', !hasFile);
  }

  function getFormat() {
    return document.querySelector('input[name="pdf-to-word-format"]:checked').value || 'docx';
  }

  function getAnalysisState() {
    return { ...analysisState, pagesLikelyScanned: [...analysisState.pagesLikelyScanned] };
  }

  function makeRequestId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `word-ocr-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  }

  function cancelCurrentAnalysis() {
    analysisGeneration += 1;
    if (analysisRequestId) cancelPdfForOcrAnalysis?.(analysisRequestId);
    analysisRequestId = '';
  }

  function formatPageSamples(pages = []) {
    return pages.slice(0, 5).join(', ') + (pages.length > 5 ? '…' : '');
  }

  async function analyzeForOcr(file, generation) {
    const filePath = file.path || file.fileObject?.path || '';
    if (!filePath || typeof analyzePdfForOcr !== 'function') {
      analysisState = { status: 'inconclusive', totalPages: 0, sampledPages: 0, pagesLikelyScanned: [] };
      showStatus({ tone: 'info', title: 'Análise automática indisponível', message: 'Se o documento tiver páginas digitalizadas, marque a opção de OCR antes de converter.' });
      return;
    }
    const requestId = makeRequestId();
    analysisRequestId = requestId;
    analysisState = { status: 'analyzing', totalPages: 0, sampledPages: 0, pagesLikelyScanned: [] };
    showStatus({ tone: 'info', title: 'Verificando o documento', message: 'Analisamos uma amostra de páginas para verificar se o OCR pode ajudar. Nenhum texto é reconhecido nesta etapa.' });
    try {
      const result = await analyzePdfForOcr({ requestId, filePath });
      const currentPath = state.pdfToWordFile?.path || state.pdfToWordFile?.fileObject?.path || '';
      if (generation !== analysisGeneration || currentPath !== filePath) return;
      analysisState = {
        status: ['scanned', 'native', 'skipped-large'].includes(result?.status) ? result.status : 'inconclusive',
        totalPages: Math.max(0, Number(result?.totalPages) || 0),
        sampledPages: Math.max(0, Number(result?.sampledPages) || 0),
        pagesLikelyScanned: Array.isArray(result?.pagesLikelyScanned)
          ? result.pagesLikelyScanned.filter((page) => Number.isSafeInteger(page) && page > 0).slice(0, 16)
          : []
      };
      if (analysisState.status === 'scanned') {
        const pages = formatPageSamples(analysisState.pagesLikelyScanned);
        showStatus({ tone: 'warning', title: 'Possíveis páginas digitalizadas', message: `Encontramos pouco texto selecionável em ${analysisState.pagesLikelyScanned.length} página(s) da amostra (${pages}). Marque “Reconhecer páginas digitalizadas antes de converter” para tentar extrair esse conteúdo.` });
      } else if (analysisState.status === 'native') {
        showStatus({ tone: 'success', title: 'Texto digital detectado', message: `As ${analysisState.sampledPages} página(s) verificadas parecem conter texto selecionável. O OCR provavelmente não é necessário.` });
      } else if (analysisState.status === 'skipped-large') {
        showStatus({ tone: 'info', title: 'Análise automática ignorada', message: 'O arquivo é grande; para evitar uma leitura extra, não verificamos as páginas. Se for digitalizado, você ainda pode marcar a opção de OCR.' });
      } else {
        showStatus({ tone: 'info', title: 'Não foi possível avaliar o texto', message: 'A análise automática não foi conclusiva. Se o documento tiver páginas digitalizadas, marque a opção de OCR.' });
      }
    } catch {
      if (generation !== analysisGeneration) return;
      analysisState = { status: 'inconclusive', totalPages: 0, sampledPages: 0, pagesLikelyScanned: [] };
      showStatus({ tone: 'info', title: 'Não foi possível avaliar o texto', message: 'A análise automática não foi conclusiva. Se o documento tiver páginas digitalizadas, marque a opção de OCR.' });
    } finally {
      if (analysisRequestId === requestId) analysisRequestId = '';
    }
  }

  function updateOutputName() {
    if (!state.pdfToWordFile) return;
    const format = getFormat();
    const extension = format === 'text' ? '.txt' : '.docx';
    const outputInput = document.getElementById('pdf-to-word-output-name');
    if (outputInput) {
      outputInput.value = `${state.pdfToWordFile.name.replace(/\.pdf$/i, '')}_convertido${extension}`;
    }
  }

  function handleFile(file) {
    cancelCurrentAnalysis();
    clearStatus();
    analysisState = { status: 'analyzing', totalPages: 0, sampledPages: 0, pagesLikelyScanned: [] };
    state.pdfToWordFile = {
      name: file.name,
      size: file.size,
      path: file.path || "",
      fileObject: file
    };
    const fileName = document.getElementById('pdf-to-word-file-name');
    const fileMeta = document.getElementById('pdf-to-word-file-meta');
    if (fileName) fileName.textContent = file.name;
    if (fileMeta) fileMeta.textContent = formatDocumentMeta(formatBytes, file);
    syncVisibility();
    updateOutputName();
    void analyzeForOcr(file, analysisGeneration);
  }

  function clearWorkspace() {
    cancelCurrentAnalysis();
    analysisState = { status: 'idle', totalPages: 0, sampledPages: 0, pagesLikelyScanned: [] };
    state.pdfToWordFile = null;
    clearFeedbackBanner('pdf-to-word');
    clearStatus();
    syncVisibility();
  }

  function clearStatus() {
    const banner = getStatusBanner();
    if (!banner) return;
    banner.classList.add('hidden');
    banner.innerHTML = '';
  }

  function showStatus({ tone = 'info', title = '', message = '' } = {}) {
    const banner = getStatusBanner();
    if (!banner) return;
    banner.className = 'inline-optimized-hint pdf-to-word-status';
    banner.dataset.tone = tone;
    banner.innerHTML = `
      <span aria-hidden="true">${toneIcon(tone, 18)}</span>
      <div>
        <strong>${title}</strong>
        <span>${message}</span>
      </div>
    `;
    banner.classList.remove('hidden');
  }

  function getPendingMessage() {
    if (state.pdfToWordFile) {
      return 'Há um PDF carregado em PDF para Word. Se sairmos agora, essa preparação será perdida.';
    }
    return '';
  }

  function getQueuePayload() {
    const resolvedPath = state.pdfToWordFile.path || state.pdfToWordFile.fileObject.path || '';
    return {
      type: 'pdf-to-word',
      files: [resolvedPath],
      options: {
        format: getFormat(),
        outputName: document.getElementById('pdf-to-word-output-name').value.trim()
      }
    };
  }

  function setup() {
    document.getElementById('btn-pdf-to-word-change-file')?.addEventListener('click', clearWorkspace);
    document.querySelectorAll('input[name="pdf-to-word-format"]').forEach((radio) => {
      radio.addEventListener('change', updateOutputName);
    });
  }

  return {
    setup,
    handleFile,
    clearWorkspace,
    getPendingMessage,
    getQueuePayload,
    showStatus,
    clearStatus,
    getAnalysisState
  };
}
