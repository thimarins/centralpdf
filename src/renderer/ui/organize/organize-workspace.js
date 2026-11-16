import { normalizeBinaryData, downsampleImageAsBase64 as downsampleImageAsBase64Shared } from '../pdf-preview-utils.js';
import { addPulseTemporarily } from '../animations/motion.js';
import { formatDocumentMeta } from '../document-info.js';
import { normalizeOrganizeLoadReason } from './organize-errors.mjs';

export function createOrganizeWorkspaceController(deps) {
  const {
    pdfjsLib,
    state,
    dom,
    document,
    icon,
    notify,
    showFeedbackBanner,
    buildFeedbackMessage,
    toneIcon,
    formatBytes,
    showCustomConfirmModal,
    showCustomPromptModal
  } = deps;

  let organizeThumbnailPrefetchTimer = null;
  let organizeUiBindingsReady = false;
  let organizeLoadToken = 0;
  let organizeHadPendingChanges = false;
  let organizeHoldZoomState = null;
  const organizeFailureLastLoggedAt = new Map();
  let activeOrganizeSearchRequestId = '';
  let currentOrganizeSearchJobId = '';
  let organizeSearchCancelled = false;
  const organizeZoomRenderCache = new Map();
  const organizeGridViews = ['small', 'medium', 'large'];
  const organizeGridViewStorageKey = 'central-pdf.organize-grid-view';
  let organizeGridView = 'auto';

  function setOrganizeGridView(view, persist = true) {
    organizeGridView = organizeGridViews.includes(view) ? view : 'auto';
    const pageCount = state.organizePages?.length || 0;
    const automaticView = pageCount <= 4
      ? 'large'
      : pageCount <= 12
        ? 'medium'
        : 'small';
    const selectedView = organizeGridView === 'auto' ? automaticView : organizeGridView;
    if (dom.organizeGrid) {
      dom.organizeGrid.classList.remove(...organizeGridViews.map((size) => `pages-grid--${size}`));
      dom.organizeGrid.classList.add(`pages-grid--${selectedView}`);
      dom.organizeGrid.classList.toggle('pages-grid--auto', organizeGridView === 'auto');
      if (organizeGridView === 'auto') {
        const compactingProgress = Math.min(1, Math.max(0, (pageCount - 4) / 28));
        dom.organizeGrid.style.setProperty('--organize-page-column-min', `${Math.round(260 - compactingProgress * 128)}px`);
        dom.organizeGrid.style.setProperty('--organize-page-card-min-height', `${Math.round(340 - compactingProgress * 116)}px`);
        dom.organizeGrid.style.setProperty('--organize-page-thumb-min-height', `${Math.round(244 - compactingProgress * 108)}px`);
      } else {
        dom.organizeGrid.style.removeProperty('--organize-page-column-min');
        dom.organizeGrid.style.removeProperty('--organize-page-card-min-height');
        dom.organizeGrid.style.removeProperty('--organize-page-thumb-min-height');
      }
    }
    document.querySelectorAll('[data-organize-view]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.organizeView === selectedView));
    });
    if (persist) {
      try {
        window.localStorage.setItem(organizeGridViewStorageKey, organizeGridView);
      } catch {
        // The view control still works when browser storage is unavailable.
      }
    }
  }

  if (!Array.isArray(state.organizeTempPaths)) {
    state.organizeTempPaths = [];
  }

  function getPrimaryOrganizeFile() {
    return state.organizeFiles[0] || null;
  }

  function getPrimaryOrganizePdfDoc() {
    return state.organizePdfDocs[0] || null;
  }

  function cancelOrganizeDocumentSearch({ invalidate = false } = {}) {
    if (!activeOrganizeSearchRequestId) return;
    window.api.cancelPdfTextSearch?.(currentOrganizeSearchJobId || activeOrganizeSearchRequestId);
    organizeSearchCancelled = true;
    if (invalidate) {
      activeOrganizeSearchRequestId = '';
      currentOrganizeSearchJobId = '';
      const searchButton = document.getElementById('btn-organize-document-search');
      const cancelButton = document.getElementById('btn-organize-document-search-cancel');
      if (searchButton) searchButton.disabled = false;
      cancelButton?.classList.add('hidden');
      if (cancelButton) cancelButton.disabled = false;
    } else {
      const status = document.getElementById('organize-document-search-status');
      if (status) status.textContent = 'Cancelando a pesquisa…';
      const cancelButton = document.getElementById('btn-organize-document-search-cancel');
      if (cancelButton) cancelButton.disabled = true;
    }
  }

  async function searchOrganizeDocument() {
    if (activeOrganizeSearchRequestId) return;
    const input = document.getElementById('organize-document-search-input');
    const status = document.getElementById('organize-document-search-status');
    const resultsList = document.getElementById('organize-document-search-results');
    const searchButton = document.getElementById('btn-organize-document-search');
    const cancelButton = document.getElementById('btn-organize-document-search-cancel');
    const query = String(input?.value || '').trim();
    if (!query) {
      if (status) { status.textContent = 'Digite uma palavra ou frase para localizar.'; status.dataset.tone = 'warning'; }
      input?.focus();
      return;
    }
    const sources = state.organizeFiles.map((file, fileIndex) => ({ file, fileIndex, document: state.organizePdfDocs[fileIndex] }))
      .filter(({ file, document: pdfDocument }) => file?.path && pdfDocument);
    if (!sources.length) {
      if (status) { status.textContent = 'Adicione um documento para pesquisar.'; status.dataset.tone = 'warning'; }
      return;
    }

    const requestId = crypto.randomUUID();
    const loadToken = organizeLoadToken;
    activeOrganizeSearchRequestId = requestId;
    organizeSearchCancelled = false;
    if (searchButton) searchButton.disabled = true;
    cancelButton?.classList.remove('hidden');
    if (cancelButton) cancelButton.disabled = false;
    if (resultsList) resultsList.replaceChildren();
    if (status) { status.textContent = `Pesquisando em ${sources.length} arquivo(s) carregado(s)…`; status.dataset.tone = 'info'; }
    const matches = [];
    let scannedPages = 0;
    let truncated = false;
    try {
      for (const { file, fileIndex } of sources) {
        if (organizeSearchCancelled || loadToken !== organizeLoadToken || matches.length >= 200) break;
        const itemRequestId = `${requestId}-${fileIndex}`;
        currentOrganizeSearchJobId = itemRequestId;
        const removeProgress = window.api.onOcrSearchProgress?.((payload) => {
          if (payload?.requestId !== itemRequestId || activeOrganizeSearchRequestId !== requestId) return;
          if (status) status.textContent = `Pesquisando ${file.name}: página ${payload.page || 0} de ${payload.totalPages || 0}…`;
        });
        try {
          const result = await window.api.searchPdfText({ requestId: itemRequestId, filePath: file.path, query, language: 'por+eng' });
          if (result?.cancelled) { organizeSearchCancelled = true; break; }
          scannedPages += Number(result?.scannedPages) || 0;
          if (result?.truncated || matches.length + (result?.matches?.length || 0) > 200) truncated = true;
          for (const match of (Array.isArray(result?.matches) ? result.matches : [])) {
            if (matches.length >= 200) { truncated = true; break; }
            matches.push({ ...match, fileIndex, fileName: file.name });
          }
        } finally {
          removeProgress?.();
          if (currentOrganizeSearchJobId === itemRequestId) currentOrganizeSearchJobId = '';
        }
      }
      if (activeOrganizeSearchRequestId !== requestId || loadToken !== organizeLoadToken) return;
      if (organizeSearchCancelled) {
        if (status) { status.textContent = 'Pesquisa cancelada. O documento continua sem alterações.'; status.dataset.tone = 'info'; }
        return;
      }
      if (resultsList) {
        matches.forEach((match) => {
          const item = document.createElement('li');
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'organize-document-search-result';
          button.textContent = `${match.fileName} · página ${match.pageNumber} · ${match.source === 'OCR' ? 'texto reconhecido' : 'texto do PDF'}`;
          button.addEventListener('click', () => {
            const page = state.organizePages.find((candidate) => candidate.fileIndex === match.fileIndex && candidate.sourceIndex === match.pageNumber - 1);
            const card = page && [...(dom.organizeGrid?.querySelectorAll('.page-card') || [])].find((candidate) => candidate.getAttribute('data-page-id') === page.id);
            if (!card) {
              if (status) { status.textContent = 'Essa página não está mais na organização atual. Pesquise novamente para atualizar os resultados.'; status.dataset.tone = 'warning'; }
              return;
            }
            document.querySelectorAll('.page-card.is-search-result-focus').forEach((element) => element.classList.remove('is-search-result-focus'));
            card.classList.add('is-search-result-focus');
            card.scrollIntoView({ behavior: 'smooth', block: 'center' });
            window.setTimeout(() => card.classList.remove('is-search-result-focus'), 2600);
          });
          item.append(button);
          resultsList.append(item);
        });
      }
      if (status) {
        status.textContent = matches.length
          ? `${matches.length}${truncated ? '+' : ''} resultado(s) em ${scannedPages} página(s)${truncated ? '. Exibindo os primeiros 200.' : '.'}`
          : `Nenhum resultado para “${query}” nas ${scannedPages} página(s) analisadas.`;
        status.dataset.tone = matches.length ? 'success' : 'warning';
      }
    } catch (error) {
      if (activeOrganizeSearchRequestId === requestId && status) {
        status.textContent = `Não foi possível pesquisar os documentos: ${normalizeOrganizeLoadReason(error)}.`;
        status.dataset.tone = 'error';
        reportOrganizeFailure('ORGANIZE_DOCUMENT_SEARCH_FAILED');
      }
    } finally {
      if (activeOrganizeSearchRequestId === requestId) {
        activeOrganizeSearchRequestId = '';
        currentOrganizeSearchJobId = '';
        if (searchButton) searchButton.disabled = false;
        cancelButton?.classList.add('hidden');
        if (cancelButton) cancelButton.disabled = false;
      }
    }
  }

  function isOrganizeImageFile(file) {
    const name = String(file?.name || "").toLowerCase();
    return /\.(jpg|jpeg|png)$/i.test(name);
  }

  function isOrganizePdfFile(file) {
    const name = String(file?.name || "").toLowerCase();
    return name.endsWith(".pdf");
  }

  function reportOrganizeFailure(failureCode) {
    const now = Date.now();
    if (now - (organizeFailureLastLoggedAt.get(failureCode) || 0) < 5000) return;
    organizeFailureLastLoggedAt.set(failureCode, now);
    window.api?.logRendererError?.({
      scope: 'organize-workspace',
      errorName: 'Error',
      errorCode: failureCode
    }).catch(() => {});
  }

  async function readFileAsBase64(fileObject) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (event) => {
        const result = String(event.target?.result || "");
        const commaIndex = result.indexOf(",");
        resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
      };
      reader.onerror = (error) => reject(error);
      reader.readAsDataURL(fileObject);
    });
  }

  async function downsampleImageAsBase64(fileObject, maxDimension = 2200, quality = 0.82) {
    return downsampleImageAsBase64Shared(fileObject, maxDimension, quality, 'Não foi possível preparar a imagem para organização.');
  }

  async function ensureTempImagePath(file) {
    if (typeof file?.path === 'string' && file.path.trim()) {
      return file.path;
    }

    const fileObject = file?.fileObject || file;
    const base64Data = await downsampleImageAsBase64(fileObject, 2200, 0.82);
    const savedPath = await window.api.saveTempFile({ base64Data, extension: 'jpg' });
    if (savedPath) {
      state.organizeTempPaths.push(savedPath);
    }
    return savedPath;
  }

  async function ensureOrganizePdfPath(file) {
    if (typeof file?.path === 'string' && file.path.trim()) {
      return file.path;
    }

    const fileObject = file?.fileObject || file;
    if (!fileObject || typeof fileObject.arrayBuffer !== 'function') {
      return '';
    }

    const base64Data = await readFileAsBase64(fileObject);
    const savedPath = await window.api.saveTempFile({ base64Data, extension: 'pdf' });
    if (savedPath) {
      state.organizeTempPaths.push(savedPath);
    }
    return savedPath;
  }

  async function convertImageToOrganizePdf(file) {
    const imagePath = await ensureTempImagePath(file);
    if (!imagePath) {
      throw new Error('Não foi possível preparar a imagem para a organização.');
    }

    const tempPdfPath = await window.api.convertImageToTempPdf(imagePath);
    if (!tempPdfPath) {
      throw new Error('Não foi possível converter a imagem em PDF temporário.');
    }

    state.organizeTempPaths.push(tempPdfPath);
    return tempPdfPath;
  }

  function isProtectedPdfError(error) {
    const message = String(error?.message || error || '').toLowerCase();
    return error?.name === 'PasswordException'
      || message.includes('password')
      || message.includes('senha')
      || message.includes('encrypted')
      || message.includes('incorrect password')
      || message.includes('missing pdf');
  }

  function requestProtectedPdfPassword(fileName, invalidPassword = false) {
    const modal = document.getElementById('password-prompt-modal');
    const titleEl = document.getElementById('password-prompt-title');
    const messageEl = document.getElementById('password-prompt-message');
    const fileEl = document.getElementById('password-prompt-file');
    const inputEl = document.getElementById('password-prompt-input');
    const toggleEl = document.getElementById('password-prompt-toggle');
    const cancelEl = document.getElementById('password-prompt-btn-cancel');
    const okEl = document.getElementById('password-prompt-btn-ok');

    if (!modal || !titleEl || !messageEl || !fileEl || !inputEl || !cancelEl || !okEl) {
      return Promise.resolve(null);
    }

    titleEl.textContent = 'PDF protegido';
    messageEl.textContent = invalidPassword
      ? 'A senha não confere. Digite a senha correta para continuar.'
      : 'Este PDF está protegido por senha. Digite a senha para continuar.';
    fileEl.textContent = fileName ? `Arquivo: ${fileName}` : '';
    inputEl.value = '';
    inputEl.type = 'password';
    inputEl.placeholder = 'Digite a senha do PDF';
    inputEl.classList.toggle('input-invalid', Boolean(invalidPassword));
    if (toggleEl) {
      toggleEl.setAttribute('aria-pressed', 'false');
      toggleEl.setAttribute('title', 'Mostrar senha');
      toggleEl.setAttribute('aria-label', 'Mostrar senha');
      toggleEl.classList.remove('is-visible');
    }
    modal.classList.remove('hidden');

    return new Promise((resolve) => {
      let finished = false;

      const finish = (value) => {
        if (finished) return;
        finished = true;
        modal.classList.add('hidden');
        inputEl.classList.remove('input-invalid');
        cancelEl.removeEventListener('click', handleCancel);
        okEl.removeEventListener('click', handleOk);
        modal.removeEventListener('click', handleBackdrop);
        inputEl.removeEventListener('keydown', handleKeydown);
        resolve(value);
      };

      const handleCancel = () => finish(null);
      const handleOk = () => finish(String(inputEl.value || '').trim());
      const handleBackdrop = (event) => {
        if (event.target === modal) {
          finish(null);
        }
      };
      const handleKeydown = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          finish(null);
          return;
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          handleOk();
        }
      };

      cancelEl.addEventListener('click', handleCancel);
      okEl.addEventListener('click', handleOk);
      modal.addEventListener('click', handleBackdrop);
      inputEl.addEventListener('keydown', handleKeydown);

      window.setTimeout(() => {
        inputEl.focus({ preventScroll: true });
      }, 0);
    });
  }

  async function loadProtectedAwarePdfDocument(file, rawBytes) {
    let password = null;
    let invalidPassword = false;
    const fileName = String(file?.name || 'documento.pdf');

    while (true) {
      try {
        return await pdfjsLib.getDocument({
          data: normalizeBinaryData(rawBytes),
          ...(password ? { password } : {})
        }).promise;
      } catch (error) {
        if (!isProtectedPdfError(error)) {
          throw error;
        }

        const nextPassword = await requestProtectedPdfPassword(fileName, invalidPassword);
        if (!nextPassword) {
          throw new Error('PDF protegido sem senha informada.', { cause: error });
        }
        password = nextPassword;
        invalidPassword = true;
      }
    }
  }

  function registerOrganizeSourceFile(file, sourcePath, kind) {
    return {
      name: file.name,
      size: file.size,
      lastModified: file.lastModified || Date.now(),
      path: sourcePath,
      kind,
      sourceKind: kind,
      originalName: file.name,
      fileObject: file
    };
  }

  function ensureOrganizeHoldZoomOverlay() {
    let overlay = document.getElementById('organize-hold-zoom-overlay');
    if (overlay) return overlay;

    overlay = document.createElement('div');
    overlay.id = 'organize-hold-zoom-overlay';
    overlay.className = 'organize-hold-zoom-overlay hidden';
    overlay.innerHTML = `
      <div class="organize-hold-zoom-backdrop"></div>
      <div class="organize-hold-zoom-frame">
        <div class="organize-hold-zoom-status">Carregando visualização em alta qualidade...</div>
        <img class="organize-hold-zoom-image" alt="Ampliação rápida da página">
      </div>
    `;
    document.body.appendChild(overlay);
    return overlay;
  }

  function hideOrganizeHoldZoom() {
    if (organizeHoldZoomState?.timer) {
      clearTimeout(organizeHoldZoomState.timer);
    }
    organizeHoldZoomState = null;
    const overlay = document.getElementById('organize-hold-zoom-overlay');
    if (!overlay) return;
    const status = overlay.querySelector('.organize-hold-zoom-status');
    const image = overlay.querySelector('.organize-hold-zoom-image');
    if (status) {
      status.textContent = 'Carregando visualização em alta qualidade...';
      status.classList.remove('hidden');
    }
    if (image) {
      image.removeAttribute('src');
      image.classList.remove('organize-hold-zoom-image--ready');
    }
    overlay.classList.add('hidden');
    overlay.classList.remove('visible');
  }

  async function renderOrganizeZoomPreview(page) {
    const cached = organizeZoomRenderCache.get(page.id);
    if (cached) {
      return cached;
    }

    const promise = (async () => {
      const fileIdx = page.fileIndex || 0;
      const doc = state.organizePdfDocs[fileIdx];
      if (!doc) {
        return page.thumbnailDataUrl || '';
      }

      const pdfPage = await doc.getPage(page.sourceIndex + 1);
      const baseViewport = pdfPage.getViewport({ scale: 1 });
      const maxLongEdge = 2200;
      const longestSide = Math.max(baseViewport.width, baseViewport.height) || 1;
      const scale = Math.max(1.8, Math.min(3.2, maxLongEdge / longestSide));
      const viewport = pdfPage.getViewport({ scale });
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) {
        return page.thumbnailDataUrl || '';
      }

      canvas.width = Math.max(1, Math.round(viewport.width));
      canvas.height = Math.max(1, Math.round(viewport.height));
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      await pdfPage.render({ canvasContext: context, viewport }).promise;
      return canvas.toDataURL('image/png');
    })();

    organizeZoomRenderCache.set(page.id, promise);
    try {
      const result = await promise;
      return result;
    } catch (error) {
      organizeZoomRenderCache.delete(page.id);
      throw error;
    }
  }

  async function showOrganizeHoldZoom(page) {
    if (!page?.thumbnailDataUrl) return;
    const overlay = ensureOrganizeHoldZoomOverlay();
    const image = overlay.querySelector('.organize-hold-zoom-image');
    const status = overlay.querySelector('.organize-hold-zoom-status');
    if (!image) return;
    const requestId = `${page.id}-${Date.now()}`;
    organizeHoldZoomState = { requestId };

    image.src = page.thumbnailDataUrl;
    image.style.transform = page.rotation ? `rotate(${page.rotation}deg)` : 'none';
    image.classList.remove('organize-hold-zoom-image--ready');
    if (status) {
      status.textContent = 'Carregando visualização em alta qualidade...';
      status.classList.remove('hidden');
    }
    overlay.classList.remove('hidden');
    overlay.classList.add('visible');

    try {
      const highResDataUrl = await renderOrganizeZoomPreview(page);
      if (!organizeHoldZoomState || organizeHoldZoomState.requestId !== requestId) return;
      if (highResDataUrl) {
        image.src = highResDataUrl;
      }
      image.classList.add('organize-hold-zoom-image--ready');
      if (status) {
        status.classList.add('hidden');
      }
    } catch {
      if (!organizeHoldZoomState || organizeHoldZoomState.requestId !== requestId) return;
      if (status) {
        status.textContent = 'Não foi possível melhorar a visualização desta página.';
      }
      reportOrganizeFailure('ORGANIZE_ZOOM_RENDER_FAILED');
    }
  }

  function bindOrganizeHoldZoom(card, page) {
    const pageThumb = card.querySelector('.page-thumb');
    if (!pageThumb) return;

    pageThumb.addEventListener('click', async (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      if (event.target.closest('.page-selection-control, [data-action]')) return;
      if (!page.thumbnailDataUrl) return;
      await showOrganizeHoldZoom(page);
    });

    pageThumb.addEventListener('dragstart', hideOrganizeHoldZoom);
  }

  function bindOrganizeHoldZoomGlobalDismiss() {
    if (document.body.dataset.organizeHoldZoomReady === 'true') return;
    document.body.dataset.organizeHoldZoomReady = 'true';
    const overlay = ensureOrganizeHoldZoomOverlay();
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay || event.target.closest('.organize-hold-zoom-backdrop')) {
        hideOrganizeHoldZoom();
      }
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        hideOrganizeHoldZoom();
      }
    });
    window.addEventListener('scroll', hideOrganizeHoldZoom, true);
    window.addEventListener('blur', hideOrganizeHoldZoom);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) hideOrganizeHoldZoom();
    });
  }

  async function cleanupOrganizeTempPaths() {
    if (!state.organizeTempPaths || state.organizeTempPaths.length === 0) return;
    const paths = [...new Set(state.organizeTempPaths.filter((item) => typeof item === 'string' && item.trim()))];
    state.organizeTempPaths = [];
    try {
      await window.api.deleteTempPaths(paths);
    } catch {
      reportOrganizeFailure('ORGANIZE_TEMP_CLEANUP_FAILED');
    }
  }

  const ORGANIZE_CONTEXTUAL_LABELS = {
    'btn-organize-rotate-selected': 'Rotacionar',
    'btn-organize-duplicate-selected': 'Duplicar',
    'btn-organize-delete-selected': 'Excluir',
    'btn-organize-extract-selected': 'Extrair Páginas',
    'btn-organize-export-images': 'Exportar Imagem'
  };

  function updateOrganizeToolbarContext(count) {
    const toolbarActions = document.getElementById('organize-toolbar-actions');
    if (toolbarActions) {
      toolbarActions.dataset.selection = count === 0 ? 'none' : (count === 1 ? 'single' : 'multi');
    }

    const suffix = count > 1 ? ` (${count})` : '';
    Object.entries(ORGANIZE_CONTEXTUAL_LABELS).forEach(([buttonId, baseLabel]) => {
      const button = document.getElementById(buttonId);
      const labelSlot = button?.querySelector('span');
      if (labelSlot) {
        labelSlot.textContent = `${baseLabel}${suffix}`;
      }
      if (button) {
        button.title = `${baseLabel}${suffix}`;
        button.setAttribute('aria-label', `${baseLabel}${suffix}`);
      }
    });
  }

  function updateOrganizeMeta() {
    const fileMeta = document.getElementById('organize-file-meta');
    const selectionMeta = document.getElementById('organize-selection-meta');
    const count = state.organizeSelection.size;
    if (fileMeta) {
      const primaryFile = state.organizeFiles?.[0];
      fileMeta.textContent = formatDocumentMeta(formatBytes, {
        name: primaryFile?.name,
        size: primaryFile?.size,
        pages: state.organizePages.length
      });
    }
    if (selectionMeta) {
      selectionMeta.textContent = count === 1 ? '1 selecionada' : `${count} selecionadas`;
    }
    const selectAllButton = document.getElementById('btn-organize-select-all');
    const clearSelectionButton = document.getElementById('btn-organize-clear-selection');
    if (selectAllButton) {
      selectAllButton.disabled = state.organizePages.length === 0 || count === state.organizePages.length;
    }
    if (clearSelectionButton) {
      clearSelectionButton.disabled = count === 0;
    }
    updateOrganizeToolbarContext(count);
  }

  function buildPlaceholderCard() {
    const placeholder = document.createElement('div');
    placeholder.className = 'page-placeholder';
    placeholder.addEventListener('dragover', (event) => {
      event.preventDefault();
    });
    placeholder.addEventListener('drop', handleOrganizeDrop);
    return placeholder;
  }

  function getOrganizeThumbnailScale() {
    return state.organizeLowMemoryMode
      ? (state.appConfig?.organizeLowMemoryThumbnailScale || 0.2)
      : (state.appConfig?.organizeThumbnailScale || 0.35);
  }

  function getSelectedPages() {
    return state.organizePages.filter((page) => state.organizeSelection.has(page.id));
  }

  function buildOrganizeSnapshot() {
    return {
      pages: state.organizePages.map((page) => ({
        id: page.id,
        fileIndex: page.fileIndex,
        sourceIndex: page.sourceIndex,
        rotation: page.rotation,
        thumbnailDataUrl: "",
        zoomPreviewDataUrl: "",
        renderStatus: "idle"
      })),
      bookmarks: JSON.parse(JSON.stringify(state.organizeBookmarks || [])),
      selection: [...state.organizeSelection],
      lastSelectedId: state.organizeLastSelectedId
    };
  }

  function applyOrganizeSnapshot(snapshot) {
    state.organizePages = snapshot.pages.map((page) => ({
      ...page,
      thumbnailDataUrl: "",
      zoomPreviewDataUrl: "",
      renderStatus: "idle"
    }));
    state.organizeBookmarks = JSON.parse(JSON.stringify(snapshot.bookmarks || []));
    state.organizeSelection = new Set(snapshot.selection || []);
    state.organizeLastSelectedId = snapshot.lastSelectedId || null;
    state.organizeRenderedPageIds = [];
    state.organizeDrag = { ids: [], sourceId: null, placeholderIndex: null };
    renderOrganizeGrid();
  }

  function captureUndoState() {
    state.organizeUndoStack.push(buildOrganizeSnapshot());
    if (state.organizeUndoStack.length > 12) {
      state.organizeUndoStack.shift();
    }
    state.organizeRedoStack = [];
  }

  function updateUndoRedoButtons() {
    const undoButton = document.getElementById("btn-organize-undo-action");
    if (undoButton) {
      undoButton.disabled = state.organizeUndoStack.length === 0;
      undoButton.title = state.organizeUndoStack.length === 0
        ? "Nada para desfazer"
        : "Desfaz a última alteração na organização";
    }

    const redoButton = document.getElementById("btn-organize-redo-action");
    if (redoButton) {
      redoButton.disabled = !state.organizeRedoStack || state.organizeRedoStack.length === 0;
      redoButton.title = redoButton.disabled
        ? "Nada para refazer"
        : "Refaz a última alteração desfeita";
    }

    updateOrganizeSaveButton();
  }

  function updateOrganizeSaveButton() {
    const button = document.getElementById("btn-run-organize");
    if (!button) return;

    const pendingCount = state.organizeUndoStack.length;
    const labelSlot = button.querySelector("span");
    if (labelSlot) {
      labelSlot.textContent = pendingCount > 0 ? `Salvar Alterações (${pendingCount})` : "Salvar Alterações";
    }
    button.classList.toggle("has-pending-changes", pendingCount > 0);

    if (pendingCount > 0 && !organizeHadPendingChanges) {
      addPulseTemporarily(button);
    }
    organizeHadPendingChanges = pendingCount > 0;
  }

  function restoreUndoState() {
    const snapshot = state.organizeUndoStack.pop();
    if (!snapshot) return;

    if (!state.organizeRedoStack) state.organizeRedoStack = [];
    state.organizeRedoStack.push(buildOrganizeSnapshot());
    if (state.organizeRedoStack.length > 12) {
      state.organizeRedoStack.shift();
    }

    applyOrganizeSnapshot(snapshot);
  }

  function redoOrganizeState() {
    if (!state.organizeRedoStack || state.organizeRedoStack.length === 0) return;
    const snapshot = state.organizeRedoStack.pop();
    if (!snapshot) return;

    state.organizeUndoStack.push(buildOrganizeSnapshot());
    if (state.organizeUndoStack.length > 12) {
      state.organizeUndoStack.shift();
    }

    applyOrganizeSnapshot(snapshot);
  }

  function selectSinglePageIfNeeded(pageId) {
    if (state.organizeSelection.has(pageId) && state.organizeSelection.size === 1) return;
    state.organizeSelection = new Set([pageId]);
    state.organizeLastSelectedId = pageId;
    renderOrganizeGrid();
  }

  function handlePageSelection(pageId, event) {
    const currentIndex = state.organizePages.findIndex((item) => item.id === pageId);
    if (currentIndex === -1) return;

    if (event.shiftKey && state.organizeLastSelectedId) {
      const lastIndex = state.organizePages.findIndex((item) => item.id === state.organizeLastSelectedId);
      if (lastIndex !== -1) {
        const [start, end] = [lastIndex, currentIndex].sort((a, b) => a - b);
        const range = state.organizePages.slice(start, end + 1).map((item) => item.id);
        state.organizeSelection = new Set(range);
      }
    } else if (event.ctrlKey || event.metaKey) {
      if (state.organizeSelection.has(pageId)) {
        state.organizeSelection.delete(pageId);
      } else {
        state.organizeSelection.add(pageId);
      }
      state.organizeLastSelectedId = pageId;
    } else {
      state.organizeSelection = new Set([pageId]);
      state.organizeLastSelectedId = pageId;
    }

    renderOrganizeGrid();
  }

  function togglePageSelection(pageId, event = {}) {
    const currentIndex = state.organizePages.findIndex((item) => item.id === pageId);
    if (currentIndex === -1) return;

    if (event.shiftKey && state.organizeLastSelectedId) {
      const lastIndex = state.organizePages.findIndex((item) => item.id === state.organizeLastSelectedId);
      if (lastIndex !== -1) {
        const [start, end] = [lastIndex, currentIndex].sort((a, b) => a - b);
        state.organizeSelection = new Set(state.organizePages.slice(start, end + 1).map((item) => item.id));
      }
    } else if (state.organizeSelection.has(pageId)) {
      state.organizeSelection.delete(pageId);
    } else {
      state.organizeSelection.add(pageId);
    }

    state.organizeLastSelectedId = pageId;
    renderOrganizeGrid();
  }

  function selectAllOrganizePages() {
    if (state.organizePages.length === 0) return;
    state.organizeSelection = new Set(state.organizePages.map((page) => page.id));
    state.organizeLastSelectedId = state.organizePages[state.organizePages.length - 1]?.id || null;
    renderOrganizeGrid();
  }

  function clearOrganizeSelection() {
    if (state.organizeSelection.size === 0) return;
    state.organizeSelection.clear();
    state.organizeLastSelectedId = null;
    renderOrganizeGrid();
  }

  function getOrganizeContextMenuActions() {
    const buttonIds = [
      'btn-organize-rotate-selected',
      'btn-organize-duplicate-selected',
      'btn-organize-extract-selected',
      'btn-organize-export-images',
      'btn-organize-delete-selected'
    ];
    return buttonIds
      .map((id) => document.getElementById(id))
      .filter((button) => button && !button.disabled);
  }

  function closeOrganizeContextMenu() {
    const menu = document.getElementById('organize-context-menu');
    if (menu) menu.classList.add('hidden');
  }

  function openOrganizeContextMenu(pageId, clientX, clientY) {
    const menu = document.getElementById('organize-context-menu');
    if (!menu) return;

    if (!state.organizeSelection.has(pageId)) {
      state.organizeSelection = new Set([pageId]);
      state.organizeLastSelectedId = pageId;
      renderOrganizeGrid();
    }

    const actionButtons = getOrganizeContextMenuActions();
    menu.innerHTML = '';

    if (actionButtons.length === 0) {
      menu.innerHTML = '<div class="command-palette-empty">Nenhuma ação disponível.</div>';
    } else {
      actionButtons.forEach((sourceButton) => {
        const label = sourceButton.querySelector('span')?.textContent || sourceButton.textContent.trim();
        const menuItem = document.createElement('button');
        menuItem.type = 'button';
        menuItem.className = 'command-palette-item';
        menuItem.innerHTML = `${sourceButton.querySelector('svg')?.outerHTML || ''}<span>${label}</span>`;
        menuItem.addEventListener('click', () => {
          closeOrganizeContextMenu();
          sourceButton.click();
        });
        menu.appendChild(menuItem);
      });
    }

    menu.classList.remove('hidden');
    const menuRect = menu.getBoundingClientRect();
    const maxLeft = window.innerWidth - menuRect.width - 8;
    const maxTop = window.innerHeight - menuRect.height - 8;
    menu.style.left = `${Math.max(8, Math.min(clientX, maxLeft))}px`;
    menu.style.top = `${Math.max(8, Math.min(clientY, maxTop))}px`;
  }

  function rotateSelectedPages() {
    if (state.organizeSelection.size === 0) return;
    captureUndoState();
    state.organizePages = state.organizePages.map((page) => {
      if (!state.organizeSelection.has(page.id)) return page;
      return { ...page, rotation: (page.rotation + 90) % 360 };
    });
    renderOrganizeGrid();
  }

  function duplicateSelectedPages() {
    const selectedIds = [...state.organizeSelection];
    if (selectedIds.length === 0) return;
    captureUndoState();

    const duplicates = [];
    state.organizePages.forEach((page) => {
      if (selectedIds.includes(page.id)) {
        duplicates.push({
          ...page,
          id: `page_${page.sourceIndex}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
        });
      }
    });

    const lastSelectedIndex = state.organizePages.findIndex((page) => page.id === selectedIds[selectedIds.length - 1]);
    state.organizePages.splice(lastSelectedIndex + 1, 0, ...duplicates);
    state.organizeSelection = new Set(duplicates.map((page) => page.id));
    state.organizeLastSelectedId = duplicates[duplicates.length - 1]?.id || null;
    renderOrganizeGrid();
  }

  function deleteSelectedPages() {
    if (state.organizeSelection.size === 0) return;
    captureUndoState();
    state.organizePages = state.organizePages.filter((page) => !state.organizeSelection.has(page.id));
    state.organizeSelection.clear();
    state.organizeLastSelectedId = null;
    renderOrganizeGrid();
  }

  function reverseOrganizeOrder() {
    captureUndoState();
    state.organizePages.reverse();
    renderOrganizeGrid();
  }

  function reorderSelectedAtIndex(targetIndex) {
    const selectedIds = state.organizePages
      .filter((page) => state.organizeSelection.has(page.id))
      .map((page) => page.id);
    if (selectedIds.length === 0) return;
    captureUndoState();

    const movingPages = state.organizePages.filter((page) => selectedIds.includes(page.id));
    const stationaryPages = state.organizePages.filter((page) => !selectedIds.includes(page.id));
    const clampedIndex = Math.max(0, Math.min(targetIndex, stationaryPages.length));
    stationaryPages.splice(clampedIndex, 0, ...movingPages);
    state.organizePages = stationaryPages;
    state.organizeSelection = new Set(selectedIds);
    state.organizeLastSelectedId = selectedIds[selectedIds.length - 1] || null;
    renderOrganizeGrid();
  }

  function moveSelectedPages(direction) {
    if (state.organizeSelection.size === 0) return;
    const selectedIds = state.organizePages
      .filter((page) => state.organizeSelection.has(page.id))
      .map((page) => page.id);
    if (selectedIds.length === 0) return;

    if (direction === 'up') {
      const firstSelectedIndex = state.organizePages.findIndex((page) => selectedIds.includes(page.id));
      if (firstSelectedIndex <= 0) return;
      reorderSelectedAtIndex(firstSelectedIndex - 1);
      return;
    } else if (direction === 'down') {
      const lastSelectedIndex = state.organizePages.length - 1 - [...state.organizePages].reverse().findIndex((page) => selectedIds.includes(page.id));
      if (lastSelectedIndex >= state.organizePages.length - 1) return;
      const selectedStartIndex = state.organizePages.findIndex((page) => selectedIds.includes(page.id));
      reorderSelectedAtIndex(selectedStartIndex + 1);
      return;
    } else if (direction === 'first') {
      reorderSelectedAtIndex(0);
      return;
    } else if (direction === 'last') {
      reorderSelectedAtIndex(state.organizePages.length);
      return;
    } else {
      return;
    }
  }

  function handleOrganizeDragStart(event, pageId) {
    if (!state.organizeSelection.has(pageId)) {
      state.organizeSelection = new Set([pageId]);
      state.organizeLastSelectedId = pageId;
      updateOrganizeMeta();
    }

    state.organizeDrag.ids = state.organizePages
      .filter((page) => state.organizeSelection.has(page.id))
      .map((page) => page.id);
    state.organizeDrag.sourceId = pageId;
    state.organizeDrag.placeholderIndex = state.organizePages.findIndex((page) => page.id === pageId);

    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', pageId);
    event.currentTarget.classList.add('drag-origin');
  }

  function autoScrollOrganizeViewport(event) {
    const viewport = document.querySelector('.pages-grid-container');
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    const threshold = 56;
    if (event.clientY < rect.top + threshold) {
      viewport.scrollTop -= 24;
    } else if (event.clientY > rect.bottom - threshold) {
      viewport.scrollTop += 24;
    }
  }

  function handleOrganizeDragOver(event, targetPageId) {
    event.preventDefault();
    const targetCard = event.currentTarget;
    const targetIndex = state.organizePages.findIndex((page) => page.id === targetPageId);
    if (targetIndex === -1) return;

    const rect = targetCard.getBoundingClientRect();
    const insertAfter = event.clientY - rect.top > rect.height / 2;
    let placeholderIndex = insertAfter ? targetIndex + 1 : targetIndex;

    const draggedPagesBeforeTarget = state.organizeDrag.ids.filter((id) => {
      const pageIndex = state.organizePages.findIndex((page) => page.id === id);
      return pageIndex < placeholderIndex;
    }).length;

    placeholderIndex -= draggedPagesBeforeTarget;
    placeholderIndex = Math.max(0, Math.min(state.organizePages.length, placeholderIndex));

    if (state.organizeDrag.placeholderIndex !== placeholderIndex) {
      state.organizeDrag.placeholderIndex = placeholderIndex;
      renderOrganizeGrid();
    }

    targetCard.classList.add('drag-hover');
    autoScrollOrganizeViewport(event);
  }

  function handleOrganizeDrop(event) {
    event.preventDefault();
    event.stopPropagation();
    
    const files = event.dataTransfer.files;
    if (files && files.length > 0) {
      const acceptedFiles = [...files].filter((file) => isOrganizePdfFile(file) || isOrganizeImageFile(file));
      if (acceptedFiles.length > 0) {
        (async () => {
          await addOrganizeFiles(acceptedFiles);
        })();
        handleOrganizeDragEnd();
        return;
      }
    }

    const placeholderIndex = state.organizeDrag.placeholderIndex;
    const selectedIds = [...state.organizeDrag.ids];
    if (selectedIds.length === 0 || placeholderIndex === null) return;

    reorderSelectedAtIndex(placeholderIndex);

    handleOrganizeDragEnd();
  }

  function handleOrganizeDragEnd() {
    state.organizeDrag = { ids: [], sourceId: null, placeholderIndex: null };
    document.querySelectorAll('.page-card').forEach((card) => card.classList.remove('drag-origin', 'drag-hover'));
    renderOrganizeGrid();
  }

  function buildPageCard(page, index) {
    const selected = state.organizeSelection.has(page.id);
    const card = document.createElement('article');
    card.className = `page-card${selected ? ' selected' : ''}`;
    card.dataset.pageId = page.id;
    card.tabIndex = 0;
    card.setAttribute('role', 'option');
    card.setAttribute('aria-selected', selected ? 'true' : 'false');
    card.setAttribute('aria-label', `Página ${index + 1}. Use Delete para excluir.`);
    card.draggable = true;
    card.innerHTML = `
      <div class="page-thumb">
        ${page.thumbnailDataUrl ? `<img src="${page.thumbnailDataUrl}" alt="Pré-visualização da página ${index + 1}">` : `<div class="page-thumb-loading">Miniatura sob demanda</div>`}
        <label class="page-selection-control" title="${selected ? 'Remover página da seleção' : 'Selecionar página'}">
          <input type="checkbox" data-action="toggle-selection" ${selected ? 'checked' : ''} aria-label="${selected ? 'Remover' : 'Adicionar'} página ${index + 1} da seleção">
          <span aria-hidden="true"></span>
        </label>
      </div>
      <div class="page-card-meta">
        <span class="page-index">Página ${index + 1}</span>
        <span class="page-state">${page.rotation ? `${page.rotation} graus` : '0 graus'}</span>
      </div>
      <div class="page-card-actions">
        <button class="btn-icon" type="button" data-action="move-up" title="Mover para esquerda">${icon('chevronLeft')}</button>
        <button class="btn-icon" type="button" data-action="move-down" title="Mover para direita">${icon('chevronRight')}</button>
        <button class="btn-icon" type="button" data-action="rotate" title="Rotacionar">${icon('rotate-cw')}</button>
        <button class="btn-icon btn-critical" type="button" data-action="delete" title="Excluir">${icon('trash')}</button>
      </div>
    `;

    const pageThumb = card.querySelector('.page-thumb');
    if (page.thumbnailDataUrl) {
      const image = pageThumb.querySelector('img');
      if (image && page.rotation) {
        image.style.transform = `rotate(${page.rotation}deg)`;
      }
    }

    card.addEventListener('click', (event) => {
      if (event.target.closest('[data-action]')) return;
      handlePageSelection(page.id, event);
    });

    card.addEventListener('keydown', (event) => {
      if (event.target.closest('button, input, select, textarea')) return;
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        selectSinglePageIfNeeded(page.id);
        deleteSelectedPages();
        return;
      }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        handlePageSelection(page.id, event);
      }
    });

    card.querySelector('[data-action="move-up"]').addEventListener('click', (event) => {
      event.stopPropagation();
      selectSinglePageIfNeeded(page.id);
      moveSelectedPages('up');
    });

    card.querySelector('[data-action="move-down"]').addEventListener('click', (event) => {
      event.stopPropagation();
      selectSinglePageIfNeeded(page.id);
      moveSelectedPages('down');
    });

    card.querySelector('[data-action="rotate"]').addEventListener('click', (event) => {
      event.stopPropagation();
      selectSinglePageIfNeeded(page.id);
      rotateSelectedPages();
    });

    card.querySelector('[data-action="delete"]').addEventListener('click', (event) => {
      event.stopPropagation();
      selectSinglePageIfNeeded(page.id);
      deleteSelectedPages();
    });

    const selectionControl = card.querySelector('.page-selection-control');
    selectionControl.addEventListener('click', (event) => {
      event.stopPropagation();
    });
    selectionControl.addEventListener('pointerdown', (event) => {
      event.stopPropagation();
    });

    card.querySelector('[data-action="toggle-selection"]').addEventListener('click', (event) => {
      event.stopPropagation();
      togglePageSelection(page.id, event);
    });

    card.addEventListener('dragstart', (event) => handleOrganizeDragStart(event, page.id));
    card.addEventListener('dragover', (event) => handleOrganizeDragOver(event, page.id));
    card.addEventListener('dragleave', () => card.classList.remove('drag-hover'));
    card.addEventListener('drop', handleOrganizeDrop);
    card.addEventListener('dragend', handleOrganizeDragEnd);
    bindOrganizeHoldZoom(card, page);

    return card;
  }

  function setupOrganizeObserver() {
    if (state.organizeObserver) {
      state.organizeObserver.disconnect();
    }

    state.organizeObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          const pageId = entry.target.getAttribute('data-page-id');
          renderOrganizeThumbnail(pageId);
        }
      });
    }, {
      root: document.querySelector('.pages-grid-container'),
      rootMargin: '320px 0px',
      threshold: 0.01
    });

    document.querySelectorAll('.page-card').forEach((card) => state.organizeObserver.observe(card));
  }

  function renderVisibleOrganizeThumbnails() {
    const viewport = document.querySelector('.pages-grid-container');
    if (!viewport) return;

    const viewportRect = viewport.getBoundingClientRect();
    const buffer = 240;

    document.querySelectorAll('.page-card').forEach((card) => {
      const rect = card.getBoundingClientRect();
      const isVisible = rect.bottom >= viewportRect.top - buffer && rect.top <= viewportRect.bottom + buffer;
      if (!isVisible) return;
      renderOrganizeThumbnail(card.getAttribute('data-page-id'));
    });
  }

  function scheduleOrganizeThumbnailPrefetch() {
    if (organizeThumbnailPrefetchTimer) {
      clearTimeout(organizeThumbnailPrefetchTimer);
      organizeThumbnailPrefetchTimer = null;
    }

    const renderNextBatch = () => {
      const pendingPages = state.organizePages.filter((page) => !page.thumbnailDataUrl && page.renderStatus === 'idle');
      if (pendingPages.length === 0) {
        organizeThumbnailPrefetchTimer = null;
        return;
      }

      const batchSize = state.organizeLowMemoryMode ? 4 : 12;
      pendingPages.slice(0, batchSize).forEach((page) => {
        renderOrganizeThumbnail(page.id);
      });

      if (pendingPages.length > batchSize) {
        organizeThumbnailPrefetchTimer = setTimeout(renderNextBatch, state.organizeLowMemoryMode ? 180 : 120);
      } else {
        organizeThumbnailPrefetchTimer = null;
      }
    };

    renderNextBatch();
  }

  async function renderOrganizeThumbnail(pageId) {
    const page = state.organizePages.find((item) => item.id === pageId);
    if (!page || page.renderStatus === 'rendering' || page.renderStatus === 'done') return;
    const fileIdx = page.fileIndex || 0;
    const doc = state.organizePdfDocs[fileIdx];
    if (!doc) return;

    page.renderStatus = 'rendering';
    try {
      const pdfPage = await doc.getPage(page.sourceIndex + 1);
      const viewport = pdfPage.getViewport({ scale: getOrganizeThumbnailScale() });
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      const renderCanvas = document.createElement('canvas');
      const renderContext = renderCanvas.getContext('2d');
      if (!context) throw new Error('Não foi possível preparar a miniatura da página.');
      if (!renderContext) throw new Error('Não foi possível renderizar a miniatura da página.');

      canvas.width = viewport.width;
      canvas.height = viewport.height;
      renderCanvas.width = viewport.width;
      renderCanvas.height = viewport.height;
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      renderContext.fillStyle = '#ffffff';
      renderContext.fillRect(0, 0, renderCanvas.width, renderCanvas.height);
      await pdfPage.render({ canvasContext: renderContext, viewport }).promise;
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(renderCanvas, 0, 0);

      page.thumbnailDataUrl = canvas.toDataURL('image/jpeg', 0.82);
      page.renderStatus = 'done';

      const thumb = dom.organizeGrid.querySelector(`[data-page-id="${pageId}"] .page-thumb`);
      if (thumb) {
        const image = document.createElement('img');
        image.src = page.thumbnailDataUrl;
        image.alt = `Pré-visualização da página ${page.sourceIndex + 1}`;
        if (page.rotation) {
          image.style.transform = `rotate(${page.rotation}deg)`;
        }
        const loading = thumb.querySelector('.page-thumb-loading');
        if (loading) {
          loading.replaceWith(image);
        } else if (!thumb.querySelector('img')) {
          thumb.prepend(image);
        }
      }

      state.organizeRenderedPageIds.push(pageId);
    } catch {
      reportOrganizeFailure('ORGANIZE_THUMBNAIL_RENDER_FAILED');
      page.renderStatus = 'idle';
    }
  }

  function renderOrganizeGrid() {
    setOrganizeGridView(organizeGridView, false);
    if (state.organizePages.length === 0) {
      dom.organizeGrid.innerHTML = '<div class="empty-state">Nenhuma página restante. Selecione outro arquivo para continuar.</div>';
      updateOrganizeMeta();
      return;
    }

    const fragment = document.createDocumentFragment();
    const placeholderIndex = state.organizeDrag.placeholderIndex;

    state.organizePages.forEach((page, index) => {
      if (placeholderIndex === index) {
        fragment.appendChild(buildPlaceholderCard());
      }
      fragment.appendChild(buildPageCard(page, index));
    });

    if (placeholderIndex === state.organizePages.length) {
      fragment.appendChild(buildPlaceholderCard());
    }

    dom.organizeGrid.innerHTML = '';
    dom.organizeGrid.appendChild(fragment);
    dom.organizeGrid.ondragover = (event) => {
      event.preventDefault();
    };
    dom.organizeGrid.ondrop = handleOrganizeDrop;
    updateOrganizeMeta();
    bindOrganizeHoldZoomGlobalDismiss();
    setupOrganizeObserver();
    const eagerThumbnailBatch = state.organizeLowMemoryMode ? 4 : 8;
    state.organizePages.slice(0, eagerThumbnailBatch).forEach((page) => {
      renderOrganizeThumbnail(page.id);
    });
    requestAnimationFrame(() => renderVisibleOrganizeThumbnails());
    scheduleOrganizeThumbnailPrefetch();
    renderBookmarksTree();
    updateUndoRedoButtons();
  }

  async function loadBookmarksFromDoc(doc, fileIndex) {
    try {
      const outline = await doc.getOutline();
      if (!outline) return [];
      
      let bookmarkCounter = 0;

      async function parseItems(items) {
        const parsed = [];
        for (const item of items) {
          let pageIndex = -1;
          let dest = item.dest;
          
          if (typeof dest === 'string') {
            dest = await doc.getDestination(dest);
          }
          
          if (Array.isArray(dest)) {
            const pageRef = dest[0];
            if (pageRef && typeof pageRef === 'object') {
              try {
                pageIndex = await doc.getPageIndex(pageRef);
              } catch (e) {
                console.warn("Failed to get page index:", e);
              }
            }
          }

          const children = item.items && item.items.length > 0 ? await parseItems(item.items) : [];
          parsed.push({
            id: `bm_${Date.now()}_${fileIndex}_${bookmarkCounter++}`,
            title: item.title || '',
            fileIndex,
            sourceIndex: pageIndex,
            children
          });
        }
        return parsed;
      }

      return await parseItems(outline);
    } catch {
      reportOrganizeFailure('ORGANIZE_OUTLINE_LOAD_FAILED');
      return [];
    }
  }

  function renderBookmarksTree() {
    const container = document.getElementById('bookmarks-tree-container');
    if (!container) return;

    if (!state.organizeBookmarks || state.organizeBookmarks.length === 0) {
      container.innerHTML = '<div class="empty-state" style="font-size: 0.78rem; padding: 16px;">Nenhum sumário encontrado. Crie um tópico acima para começar.</div>';
      return;
    }

    function buildNodeHtml(node, depth) {
      const pageIdx = state.organizePages.findIndex(p => p.fileIndex === node.fileIndex && p.sourceIndex === node.sourceIndex);
      const pageLabel = pageIdx >= 0 ? `Pág. ${pageIdx + 1}` : 'Excluída';
      let html = `
        <div class="bookmark-node-row" data-id="${node.id}" style="margin-left: ${depth * 14}px; display: flex; flex-direction: column; gap: 4px; padding: 8px; border-radius: 8px; background: var(--bg-card); border: 1px solid var(--border-color); margin-bottom: 6px; box-sizing: border-box;">
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 6px; width: 100%;">
            <span class="bookmark-title" style="font-size: 0.82rem; font-weight: 600; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1;" title="${node.title}">${node.title}</span>
            <span style="font-size: 0.72rem; color: var(--text-secondary); background: var(--bg-muted); padding: 2px 6px; border-radius: 4px; white-space: nowrap;">${pageLabel}</span>
          </div>
          <div style="display: flex; align-items: center; justify-content: flex-end; gap: 4px; margin-top: 2px; flex-wrap: wrap;">
            <button type="button" class="btn-secondary" data-bm-action="rename" style="font-size: 0.72rem; min-height: 24px; height: 24px; padding: 0 6px;" title="Renomear">Renomear</button>
            <button type="button" class="btn-secondary" data-bm-action="change-page" style="font-size: 0.72rem; min-height: 24px; height: 24px; padding: 0 6px;" title="Definir para pág. atual">Definir Pág.</button>
            <button type="button" class="btn-secondary" data-bm-action="add-child" style="font-size: 0.72rem; min-height: 24px; height: 24px; padding: 0 6px;" title="Adicionar sub-tópico">+ Sub</button>
            <button type="button" class="btn-secondary" data-bm-action="move-up" style="font-size: 0.72rem; min-height: 24px; height: 24px; padding: 0 4px;" title="Mover para cima">↑</button>
            <button type="button" class="btn-secondary" data-bm-action="move-down" style="font-size: 0.72rem; min-height: 24px; height: 24px; padding: 0 4px;" title="Mover para baixo">↓</button>
            <button type="button" class="btn-secondary btn-danger-text" data-bm-action="delete" style="font-size: 0.72rem; min-height: 24px; height: 24px; padding: 0 4px;" title="Excluir">Excluir</button>
          </div>
        </div>
      `;

      if (node.children && node.children.length > 0) {
        node.children.forEach(child => {
          html += buildNodeHtml(child, depth + 1);
        });
      }
      return html;
    }

    let html = '';
    state.organizeBookmarks.forEach(node => {
      html += buildNodeHtml(node, 0);
    });

    container.innerHTML = html;

    container.querySelectorAll('[data-bm-action]').forEach(btn => {
      const action = btn.getAttribute('data-bm-action');
      const row = btn.closest('.bookmark-node-row');
      const id = row.getAttribute('data-id');

      btn.addEventListener('click', async () => {
        await handleBookmarkAction(action, id);
      });
    });
  }

  async function handleBookmarkAction(action, id) {
    function findNodeAndParent(nodes, targetId, parentList = null) {
      for (let i = 0; i < nodes.length; i++) {
        if (nodes[i].id === targetId) {
          return { node: nodes[i], list: nodes, index: i, parentList };
        }
        if (nodes[i].children) {
          const res = findNodeAndParent(nodes[i].children, targetId, nodes[i]);
          if (res) return res;
        }
      }
      return null;
    }

    const match = findNodeAndParent(state.organizeBookmarks, id);
    if (!match) return;

    const { node, list, index } = match;

    if (action === 'delete') {
      list.splice(index, 1);
      renderBookmarksTree();
    } else if (action === 'rename') {
      const newTitle = await showCustomPromptModal?.('Renomear tópico', 'Informe o novo nome para este tópico.', {
        initialValue: node.title,
        confirmLabel: 'Renomear'
      });
      if (newTitle && newTitle.trim()) {
        node.title = newTitle.trim();
        renderBookmarksTree();
      }
    } else if (action === 'change-page') {
      let activePageIndex = 0;
      if (state.organizeSelection && state.organizeSelection.size > 0) {
        const selectedId = [...state.organizeSelection][0];
        const pageIdx = state.organizePages.findIndex(p => p.id === selectedId);
        if (pageIdx !== -1) activePageIndex = pageIdx;
      }
      const selectedPage = state.organizePages[activePageIndex];
      if (selectedPage) {
        node.fileIndex = selectedPage.fileIndex || 0;
        node.sourceIndex = selectedPage.sourceIndex;
      }
      renderBookmarksTree();
    } else if (action === 'add-child') {
      const title = await showCustomPromptModal?.('Novo sub-tópico', 'Informe o nome do sub-tópico.', {
        confirmLabel: 'Adicionar'
      });
      if (title && title.trim()) {
        if (!node.children) node.children = [];
        let activePageIndex = 0;
        if (state.organizeSelection && state.organizeSelection.size > 0) {
          const selectedId = [...state.organizeSelection][0];
          const pageIdx = state.organizePages.findIndex(p => p.id === selectedId);
          if (pageIdx !== -1) activePageIndex = pageIdx;
        }
        const selectedPage = state.organizePages[activePageIndex];
        node.children.push({
          id: `bm_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
          title: title.trim(),
          fileIndex: selectedPage ? (selectedPage.fileIndex || 0) : 0,
          sourceIndex: selectedPage ? selectedPage.sourceIndex : 0,
          children: []
        });
        renderBookmarksTree();
      }
    } else if (action === 'move-up') {
      if (index > 0) {
        [list[index], list[index - 1]] = [list[index - 1], list[index]];
        renderBookmarksTree();
      }
    } else if (action === 'move-down') {
      if (index < list.length - 1) {
        [list[index], list[index + 1]] = [list[index + 1], list[index]];
        renderBookmarksTree();
      }
    }
  }

  async function handleOrganizeFile(file) {
    const loadToken = ++organizeLoadToken;
    const isImage = isOrganizeImageFile(file);
    const isPdf = isOrganizePdfFile(file);
    if (!isImage && !isPdf) {
      notify({ tone: 'warning', title: 'Organizar Páginas', message: 'Selecione um PDF ou uma imagem suportada para começar.' });
      return;
    }

    state.organizeTempPaths = [];
    organizeZoomRenderCache.clear();
    const sourcePath = isImage ? await convertImageToOrganizePdf(file) : await ensureOrganizePdfPath(file);
    if (loadToken !== organizeLoadToken) return;
    const sourceFile = registerOrganizeSourceFile(file, sourcePath || file.path || '', isImage ? 'image' : 'pdf');
    state.organizeFiles = [sourceFile];
    state.organizeLowMemoryMode = file.size >= (state.appConfig?.organizePreviewThresholdBytes || 200 * 1024 * 1024);
    state.organizeRenderedPageIds = [];
    state.organizeUndoStack = [];
    state.organizeRedoStack = [];
    organizeHadPendingChanges = false;
    state.organizeSelection.clear();
    state.organizeLastSelectedId = null;
    if (organizeThumbnailPrefetchTimer) {
      clearTimeout(organizeThumbnailPrefetchTimer);
      organizeThumbnailPrefetchTimer = null;
    }
    updateUndoRedoButtons();
    document.getElementById('organize-file-name').textContent = file.name;
    document.getElementById('organize-file-name').title = file.name;
    document.getElementById('organize-output-name').value = `${file.name.replace(/\.(pdf|jpg|jpeg|png)$/i, '')}_organizado.pdf`;

    dom.organizeDropzone.classList.add('hidden');
    dom.organizeWorkspace.classList.remove('hidden');
    dom.organizeGrid.innerHTML = '<div class="empty-state">Lendo documento e preparando miniaturas...</div>';

    if (state.organizeObserver) {
      state.organizeObserver.disconnect();
    }

    if (state.organizeLowMemoryMode) {
      notify({
        tone: 'info',
        title: 'Modo otimizado',
        message: buildFeedbackMessage('giantPdf', { seed: file.name })
      });
      showFeedbackBanner({
        mode: 'warning',
        tone: 'info',
        title: 'Documento grande detectado',
        message: buildFeedbackMessage('safeMode', { seed: file.name }),
        detail: 'Miniaturas menores e cache reduzido foram ativados para proteger a interface.',
        icon: toneIcon('info', 18)
      });
    }

    try {
        const arrayBuffer = (isImage || sourcePath)
          ? await window.api.readFileBytes(sourcePath)
          : await file.arrayBuffer();
      const primaryPdfDoc = isPdf
        ? await loadProtectedAwarePdfDocument(file, arrayBuffer)
        : await pdfjsLib.getDocument({ data: normalizeBinaryData(arrayBuffer) }).promise;
      if (loadToken !== organizeLoadToken) {
        void Promise.resolve(primaryPdfDoc?.destroy?.()).catch(() => {});
        return;
      }
      state.organizePdfDocs = [primaryPdfDoc];
      state.organizePages = Array.from({ length: primaryPdfDoc.numPages }, (_, index) => ({
        id: `page_0_${index}_${Date.now()}`,
        fileIndex: 0,
        sourceIndex: index,
        rotation: 0,
        renderStatus: 'idle',
        thumbnailDataUrl: ''
        ,zoomPreviewDataUrl: ''
      }));

      state.organizeBookmarks = await loadBookmarksFromDoc(primaryPdfDoc, 0);

      updateOrganizeMeta();
      renderOrganizeGrid();
    } catch (error) {
      if (loadToken !== organizeLoadToken) return;
      reportOrganizeFailure('ORGANIZE_PDF_LOAD_FAILED');
      if (String(error?.message || "").includes('PDF protegido sem senha informada.')) {
        clearOrganizeWorkspace();
        return;
      }
      const message = isPdf
        ? 'Não foi possível abrir este PDF para organização. O arquivo pode estar corrompido ou protegido.'
        : 'Não foi possível preparar esta imagem para organizar as páginas.';
      notify({ tone: 'error', title: 'Organizar Páginas', message, important: true });
      clearOrganizeWorkspace();
    }
  }

  async function addOrganizeFile(file, options = {}) {
    const silentNotifications = Boolean(options.silentNotifications);

    const isImage = isOrganizeImageFile(file);
    const isPdf = isOrganizePdfFile(file);
    if (!isImage && !isPdf) {
      if (!silentNotifications) {
        notify({ tone: 'warning', title: 'Adicionar arquivo', message: 'Selecione um PDF ou uma imagem suportada.' });
      }
      return { success: false, kind: 'invalid', fileName: file?.name || '', pageCount: 0 };
    }

    let storedFile;
    if (isImage) {
      const tempPdfPath = await convertImageToOrganizePdf(file);
      storedFile = registerOrganizeSourceFile(file, tempPdfPath, 'image');
    } else {
      const pdfPath = await ensureOrganizePdfPath(file);
      storedFile = registerOrganizeSourceFile(file, pdfPath || file.path || '', 'pdf');
    }

    state.organizeFiles.push(storedFile);
    const fileIndex = state.organizeFiles.length - 1;
    const toastId = `organize-add-${fileIndex}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const loadingDelayMs = Number.isFinite(options.loadingDelayMs) ? Math.max(0, options.loadingDelayMs) : 420;
    let loadingTimer = null;

    if (!silentNotifications) {
      loadingTimer = window.setTimeout(() => {
        notify({
          id: toastId,
          tone: 'info',
          title: isImage ? 'Adicionando imagem' : 'Adicionando PDF',
          message: `Carregando páginas de ${file.name}...`,
          duration: 6200
        });
      }, loadingDelayMs);
    }

    try {
        const arrayBuffer = (isImage || storedFile.path)
          ? await window.api.readFileBytes(storedFile.path)
          : await file.arrayBuffer();
      const doc = isPdf
        ? await loadProtectedAwarePdfDocument(file, arrayBuffer)
        : await pdfjsLib.getDocument({ data: normalizeBinaryData(arrayBuffer) }).promise;
      state.organizePdfDocs.push(doc);

      const newPages = Array.from({ length: doc.numPages }, (_, index) => ({
        id: `page_${fileIndex}_${index}_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
        fileIndex,
        sourceIndex: index,
        rotation: 0,
        renderStatus: 'idle',
        thumbnailDataUrl: ''
        ,zoomPreviewDataUrl: ''
      }));

      const offset = state.organizePages.length;
      const fileBookmarks = await loadBookmarksFromDoc(doc, fileIndex);
      fileBookmarks.forEach((item) => {
        if (item.pageIndex >= 0) item.pageIndex += offset;
        const remap = (nodes) => {
          nodes.forEach((node) => {
            if (node.pageIndex >= 0) node.pageIndex += offset;
            if (node.children) remap(node.children);
          });
        };
        if (item.children) remap(item.children);
      });
      state.organizeBookmarks = [...(state.organizeBookmarks || []), ...fileBookmarks];

      state.organizePages = [...state.organizePages, ...newPages];

      const names = state.organizeFiles.map((item) => item.name).join(', ');
      const nameEl = document.getElementById('organize-file-name');
      if (nameEl) {
        nameEl.textContent = names;
        nameEl.title = names;
      }

      updateOrganizeMeta();
      renderOrganizeGrid();

      if (!silentNotifications) {
        if (loadingTimer) {
          window.clearTimeout(loadingTimer);
        }
        notify({
          id: toastId,
          tone: 'success',
          title: isImage ? 'Imagem adicionada' : 'PDF adicionado',
          message: `${doc.numPages} página${doc.numPages === 1 ? '' : 's'} carregada${doc.numPages === 1 ? '' : 's'} de ${file.name}.`,
          duration: 4200
        });
      }

      return {
        success: true,
        kind: isImage ? 'image' : 'pdf',
        fileName: file.name,
        pageCount: doc.numPages,
        fileIndex,
        storedFile,
        doc
      };
    } catch (error) {
      reportOrganizeFailure('ORGANIZE_FILE_ADD_FAILED');
      if (loadingTimer) {
        window.clearTimeout(loadingTimer);
      }
      if (Array.isArray(state.organizeFiles) && state.organizeFiles[fileIndex] === storedFile) {
        state.organizeFiles.splice(fileIndex, 1);
      }
      const names = state.organizeFiles.map((item) => item.name).join(', ');
      const nameEl = document.getElementById('organize-file-name');
      if (nameEl) {
        nameEl.textContent = names;
        nameEl.title = names;
      }
      updateOrganizeMeta();
      if (String(error?.message || '').includes('PDF protegido sem senha informada.')) {
        return {
          success: false,
          kind: isImage ? 'image' : 'pdf',
          fileName: file.name,
          pageCount: 0,
          cancelled: true,
          error
        };
      }
      if (!silentNotifications) {
        notify({
          id: toastId,
          tone: 'error',
          title: isImage ? 'Adicionar imagem' : 'Adicionar PDF',
          message: `${file.name}: ${normalizeOrganizeLoadReason(error)}.`,
          important: true,
          duration: 6200
        });
      }
      return {
        success: false,
        kind: isImage ? 'image' : 'pdf',
        fileName: file.name,
        pageCount: 0,
        error
      };
    }
  }

  async function addOrganizeFiles(files, options = {}) {
    let acceptedFiles = [...(files || [])].filter((file) => isOrganizePdfFile(file) || isOrganizeImageFile(file));
    if (acceptedFiles.length === 0) {
      notify({ tone: 'warning', title: 'Adicionar arquivo', message: 'Selecione um PDF ou uma imagem suportada.' });
      return { success: false, added: 0, failed: 0, totalPages: 0 };
    }

    // If the first file of a batch fails, the remaining files must still be
    // able to establish the workspace. Previously they were appended to an
    // empty state while the dropzone stayed visible, producing contradictory
    // error/success feedback without opening the editor.
    if (state.organizePages.length === 0 && state.organizeFiles.length === 0) {
      let initialized = false;
      while (acceptedFiles.length > 0 && !initialized) {
        const candidate = acceptedFiles.shift();
        await handleOrganizeFile(candidate);
        initialized = state.organizePages.length > 0;
      }
      if (!initialized) {
        return { success: false, added: 0, failed: 0, totalPages: 0 };
      }
    }

    const batchId = `organize-batch-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const loadingDelayMs = Number.isFinite(options.loadingDelayMs) ? Math.max(0, options.loadingDelayMs) : 380;
    let loadingTimer = null;
    const summary = {
      success: true,
      added: 0,
      failed: 0,
      failures: [],
      totalPages: 0,
      images: 0,
      pdfs: 0
    };

    const formatBatchSummary = () => {
      const pieces = [];
      if (summary.pdfs > 0) {
        pieces.push(`${summary.pdfs} PDF${summary.pdfs > 1 ? 's' : ''}`);
      }
      if (summary.images > 0) {
        pieces.push(`${summary.images} imagem${summary.images > 1 ? 's' : ''}`);
      }

      const typeLabel = pieces.length > 0
        ? pieces.join(' e ')
        : `${summary.added} arquivo${summary.added > 1 ? 's' : ''}`;

      const pageLabel = summary.totalPages > 0
        ? `, totalizando ${summary.totalPages} página${summary.totalPages > 1 ? 's' : ''}`
        : '';

      return `${typeLabel} carregado${summary.added > 1 ? 's' : ''}${pageLabel}.`;
    };

    if (!options.silentNotifications) {
      loadingTimer = window.setTimeout(() => {
        notify({
          id: batchId,
          tone: 'info',
          title: acceptedFiles.length > 1 ? 'Adicionando arquivos' : 'Adicionando arquivo',
          message: acceptedFiles.length > 1
            ? `${acceptedFiles.length} itens em processamento...`
            : `Carregando páginas de ${acceptedFiles[0].name}...`,
          duration: 6200
        });
      }, loadingDelayMs);
    }

    for (const file of acceptedFiles) {
      const result = await addOrganizeFile(file, { silentNotifications: true });
      if (result.success) {
        summary.added += 1;
        summary.totalPages += Number(result.pageCount || 0);
        if (result.kind === 'image') summary.images += 1;
        if (result.kind === 'pdf') summary.pdfs += 1;
      } else {
        summary.failed += 1;
        summary.success = false;
        const rawReason = result.error?.message || String(result.error || 'não foi possível carregar o arquivo');
        const reason = rawReason.length > 180 ? `${rawReason.slice(0, 177)}...` : rawReason;
        summary.failures.push({
          fileName: result.fileName || file.name,
          reason
        });
      }
    }

    if (loadingTimer) {
      window.clearTimeout(loadingTimer);
    }

    if (!options.silentNotifications) {
      const tone = summary.failed > 0 ? 'warning' : 'success';
      const title = summary.failed > 0
        ? (summary.added > 0 ? 'Alguns arquivos não foram adicionados' : 'Nenhum arquivo foi adicionado')
        : (summary.added > 1 ? 'Arquivos adicionados' : 'Arquivo adicionado');
      const groupedFailures = [...summary.failures.reduce((groups, failure) => {
        const reason = normalizeOrganizeLoadReason(failure.reason);
        const fileNames = groups.get(reason) || [];
        fileNames.push(failure.fileName);
        groups.set(reason, fileNames);
        return groups;
      }, new Map())].map(([reason, fileNames]) => ({ reason, fileNames }));
      const visibleFailureGroups = groupedFailures.slice(0, 8);
      const failureDetails = visibleFailureGroups
        .map(({ fileNames, reason }) => `${fileNames.slice(0, 4).join(', ')}${fileNames.length > 4 ? ` e mais ${fileNames.length - 4}` : ''}: ${reason}`)
        .join(' | ');
      const remainingFailures = groupedFailures.length - visibleFailureGroups.length;
      const detail = summary.failed > 0
        ? `${summary.added} de ${acceptedFiles.length} arquivos foram adicionados. Problemas: ${failureDetails}${remainingFailures > 0 ? ` | e mais ${remainingFailures} arquivo(s)` : ''}`
        : formatBatchSummary();

      notify({
        id: batchId,
        tone,
        title,
        message: detail,
        duration: 5200,
        important: summary.failed > 0
      });
    }

    return summary;
  }

  function clearOrganizeWorkspace() {
    organizeLoadToken += 1;
    cancelOrganizeDocumentSearch({ invalidate: true });
    cleanupOrganizeTempPaths();
    organizeZoomRenderCache.clear();
    const organizeDocuments = [...new Set(state.organizePdfDocs.filter(Boolean))];
    organizeDocuments.forEach((doc) => {
      void Promise.resolve(doc.destroy?.()).catch(() => {});
    });
    state.organizeFiles = [];
    state.organizePdfDocs = [];
    state.organizePages = [];
    state.organizeBookmarks = [];
    state.organizeRenderedPageIds = [];
    state.organizeLowMemoryMode = false;
    state.organizeUndoStack = [];
    state.organizeRedoStack = [];
    organizeHadPendingChanges = false;
    state.organizeSelection.clear();
    state.organizeLastSelectedId = null;
    state.organizeTempPaths = [];
    if (organizeThumbnailPrefetchTimer) {
      clearTimeout(organizeThumbnailPrefetchTimer);
      organizeThumbnailPrefetchTimer = null;
    }
    updateUndoRedoButtons();
    handleOrganizeDragEnd();
    if (state.organizeObserver) {
      state.organizeObserver.disconnect();
      state.organizeObserver = null;
    }
    dom.organizeGrid.innerHTML = '';
    dom.organizeWorkspace.classList.add('hidden');
    dom.organizeDropzone.classList.remove('hidden');
  }

  function setBookmarksPanelCollapsed(collapsed) {
    const layout = document.querySelector('.organize-workspace-layout');
    const panel = document.getElementById('organize-bookmarks-panel');
    const toggle = document.getElementById('btn-organize-bookmarks-toggle');
    const content = document.getElementById('organize-bookmarks-content');

    if (layout) {
      layout.classList.toggle('organize-workspace-layout--bookmarks-collapsed', collapsed);
    }
    if (panel) {
      panel.classList.toggle('organize-bookmarks-panel--collapsed', collapsed);
    }
    if (toggle) {
      toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      toggle.setAttribute('title', collapsed ? 'Abrir sumário' : 'Fechar sumário');
    }
    if (content) {
      content.setAttribute('aria-hidden', collapsed ? 'true' : 'false');
    }
  }

  function setupOrganizeAdaptiveToolbar() {
    const bar = document.querySelector('.organize-command-bar');
    if (!bar) return;
    bar.dataset.toolbarMode = 'compact';
  }

  function bindOrganizeUiOnce() {
    if (organizeUiBindingsReady) return;
    organizeUiBindingsReady = true;

    setupOrganizeAdaptiveToolbar();

    let savedGridView = 'auto';
    try {
      savedGridView = window.localStorage.getItem(organizeGridViewStorageKey) || 'auto';
    } catch {
      // Keep the default size when browser storage is unavailable.
    }
    setOrganizeGridView(savedGridView, false);
    document.querySelectorAll('[data-organize-view]').forEach((button) => {
      button.addEventListener('click', () => setOrganizeGridView(button.dataset.organizeView));
    });

    const organizeSearchButton = document.getElementById('btn-organize-document-search');
    const organizeSearchInput = document.getElementById('organize-document-search-input');
    const organizeSearchCancel = document.getElementById('btn-organize-document-search-cancel');
    organizeSearchButton?.addEventListener('click', searchOrganizeDocument);
    organizeSearchInput?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); searchOrganizeDocument(); }
    });
    organizeSearchCancel?.addEventListener('click', () => cancelOrganizeDocumentSearch());

    const container = dom.organizeGrid?.closest(".pages-grid-container");
    if (container) {
      container.ondragover = (event) => {
        if (event.dataTransfer?.types?.includes("Files")) {
          event.preventDefault();
          container.classList.add("drag-over");
        }
      };
      container.ondragleave = () => {
        container.classList.remove("drag-over");
      };
      container.ondrop = async (event) => {
        container.classList.remove("drag-over");
        const files = event.dataTransfer?.files;
        if (!files || files.length === 0) return;
        const pdfFiles = [...files].filter((file) => file.name.toLowerCase().endsWith(".pdf"));
        const imageFiles = [...files].filter((file) => /\.(jpg|jpeg|png)$/i.test(file.name));
        const acceptedFiles = [...pdfFiles, ...imageFiles];
        if (acceptedFiles.length === 0) return;
        event.preventDefault();
        event.stopPropagation();
        await addOrganizeFiles(acceptedFiles);
      };
    }

    if (dom.organizeGrid) {
      dom.organizeGrid.addEventListener('contextmenu', (event) => {
        const card = event.target.closest('.page-card');
        if (!card) return;
        event.preventDefault();
        const pageId = card.getAttribute('data-page-id');
        if (pageId) openOrganizeContextMenu(pageId, event.clientX, event.clientY);
      });
    }

    document.addEventListener('click', (event) => {
      const menu = document.getElementById('organize-context-menu');
      if (!menu || menu.classList.contains('hidden')) return;
      if (!menu.contains(event.target)) closeOrganizeContextMenu();
    });

    const btnAddRoot = document.getElementById('btn-bookmark-add-root');
    const btnClearAll = document.getElementById('btn-bookmark-clear-all');
    const btnUndoAction = document.getElementById('btn-organize-undo-action');
    const btnRedoAction = document.getElementById('btn-organize-redo-action');
    const btnSelectAll = document.getElementById('btn-organize-select-all');
    const btnClearSelection = document.getElementById('btn-organize-clear-selection');
    const btnBookmarksToggle = document.getElementById('btn-organize-bookmarks-toggle');
    const btnBookmarksClose = document.getElementById('btn-organize-bookmarks-close');

    if (btnBookmarksToggle) {
      btnBookmarksToggle.onclick = () => {
        const panel = document.getElementById('organize-bookmarks-panel');
        const collapsed = panel?.classList.contains('organize-bookmarks-panel--collapsed');
        setBookmarksPanelCollapsed(!collapsed);
      };
    }
    if (btnBookmarksClose) {
      btnBookmarksClose.onclick = () => {
        setBookmarksPanelCollapsed(true);
      };
    }

    if (btnAddRoot) {
      btnAddRoot.onclick = async () => {
        const title = await showCustomPromptModal?.('Novo tópico principal', 'Informe o nome do tópico principal.', {
          confirmLabel: 'Adicionar'
        });
        if (!title || !title.trim()) return;
        let activePageIndex = 0;
        if (state.organizeSelection && state.organizeSelection.size > 0) {
          const selectedId = [...state.organizeSelection][0];
          const pageIdx = state.organizePages.findIndex((p) => p.id === selectedId);
          if (pageIdx !== -1) activePageIndex = pageIdx;
        }
        const selectedPage = state.organizePages[activePageIndex];
        state.organizeBookmarks.push({
          id: `bm_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
          title: title.trim(),
          fileIndex: selectedPage ? (selectedPage.fileIndex || 0) : 0,
          sourceIndex: selectedPage ? selectedPage.sourceIndex : 0,
          children: []
        });
        renderBookmarksTree();
      };
    }

    if (btnClearAll) {
      btnClearAll.onclick = () => {
        if (typeof showCustomConfirmModal !== 'function') return;
        showCustomConfirmModal(
          'Limpar sumário',
          'Deseja realmente remover todos os tópicos do sumário deste documento?',
          () => {
            state.organizeBookmarks = [];
            renderBookmarksTree();
          },
          undefined,
          { confirmLabel: 'Limpar sumário', cancelLabel: 'Cancelar' }
        );
      };
    }

    if (btnUndoAction) {
      btnUndoAction.onclick = restoreUndoState;
    }
    if (btnRedoAction) {
      btnRedoAction.onclick = redoOrganizeState;
    }
    updateUndoRedoButtons();
    if (btnSelectAll) {
      btnSelectAll.onclick = selectAllOrganizePages;
    }
    if (btnClearSelection) {
      btnClearSelection.onclick = clearOrganizeSelection;
    }

    document.addEventListener('keydown', (event) => {
      const tab = document.getElementById('tab-organize');
      if (!tab || !tab.classList.contains('active')) return;
      if (!state.organizePages || state.organizePages.length === 0) return;

      const target = event.target;
      const isEditableTarget = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (isEditableTarget) return;

      if (event.key === 'Escape') {
        closeOrganizeContextMenu();
        return;
      }

      const ctrlOrCmd = event.ctrlKey || event.metaKey;
      if (!ctrlOrCmd) return;

      const key = event.key.toLowerCase();

      if (key === 'z' && event.shiftKey) {
        event.preventDefault();
        redoOrganizeState();
        return;
      }

      if (key === 'z') {
        event.preventDefault();
        restoreUndoState();
        return;
      }

      if (key === 'y') {
        event.preventDefault();
        redoOrganizeState();
        return;
      }

      if (key === 'a') {
        event.preventDefault();
        selectAllOrganizePages();
      }
    });

    const btnShowDetails = document.getElementById('btn-organize-show-details');
    const modalDetails = document.getElementById('document-details-modal');
    const modalDetailsClose = document.getElementById('document-details-btn-close');
    if (btnShowDetails && modalDetails && modalDetailsClose) {
      btnShowDetails.onclick = async () => {
        const primaryFile = getPrimaryOrganizeFile();
        const primaryPdfDoc = getPrimaryOrganizePdfDoc();
        if (!primaryFile) return;

        document.getElementById('detail-doc-name').textContent = primaryFile.name;
        document.getElementById('detail-doc-size').textContent = formatBytes(primaryFile.size);
        document.getElementById('detail-doc-pages').textContent = state.organizePages.length;

        let author = 'Desconhecido';
        let created = 'Desconhecida';
        let isEncrypted = 'Não';

        try {
          if (primaryPdfDoc) {
            const metadata = await primaryPdfDoc.getMetadata();
            if (metadata && metadata.info) {
              author = metadata.info.Author || metadata.info.Creator || 'Desconhecido';
              created = metadata.info.CreationDate ? parsePdfDate(metadata.info.CreationDate) : 'Desconhecida';
            }
          }
        } catch {
          reportOrganizeFailure('ORGANIZE_METADATA_READ_FAILED');
        }

        document.getElementById('detail-doc-author').textContent = author;
        document.getElementById('detail-doc-created').textContent = created;

        const isProtectedEl = document.getElementById('detail-doc-protected');
        isProtectedEl.textContent = isEncrypted;
        isProtectedEl.style.background = 'var(--bg-muted)';
        isProtectedEl.style.color = 'var(--text-secondary)';

        modalDetails.classList.remove('hidden');
        window.setTimeout(() => modalDetailsClose.focus({ preventScroll: true }), 0);
      };

      const closeDetailsModal = () => {
        modalDetails.classList.add('hidden');
        btnShowDetails.focus({ preventScroll: true });
      };

      modalDetailsClose.onclick = closeDetailsModal;
      modalDetails.addEventListener('click', (event) => {
        if (event.target === modalDetails) closeDetailsModal();
      });
      modalDetails.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          closeDetailsModal();
        }
      });
    }

    const btnExtract = document.getElementById('btn-organize-extract-selected');
    if (btnExtract) {
      btnExtract.onclick = async () => {
        const selectedPages = getSelectedPages();
        if (selectedPages.length === 0) {
          notify({ tone: 'warning', title: 'Organizar Páginas', message: 'Selecione pelo menos uma página para extrair.' });
          return;
        }

        const primaryFile = getPrimaryOrganizeFile();
        if (!primaryFile) return;
        const cleanName = primaryFile.name.replace(/\.pdf$/i, '');
        const outputName = `${cleanName}_extraido.pdf`;
        const filesArray = [];
        // Resolve paths sequentially so a large workspace does not create a
        // burst of IPC/base64 work in the renderer.
        for (const file of state.organizeFiles) {
          const resolvedPath = await ensureOrganizePdfPath(file);
          if (typeof resolvedPath === 'string' && resolvedPath.trim()) filesArray.push(resolvedPath);
          if (filesArray.length % 4 === 0) {
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
        }

        if (filesArray.length === 0) {
          notify({ tone: 'error', title: 'Extrair Páginas', message: 'Não foi possível preparar o arquivo de origem para extração.', important: true });
          return;
        }

        notify({ tone: 'info', title: 'Extrair Páginas', message: 'Enviando extração sequencial para a fila...' });

        const result = await window.api.queueOperation({
          type: 'organize',
          files: filesArray,
          options: {
            outputName,
            pageActions: selectedPages.map((page) => ({
              fileIndex: page.fileIndex || 0,
              sourceIndex: page.sourceIndex,
              rotation: page.rotation
            })),
            zipResults: false
          }
        });

        if (result?.success) {
          notify({ tone: 'success', title: 'Extrair Páginas', message: `Extração enviada para a fila. Saída: ${outputName}` });
        } else {
          notify({ tone: 'error', title: 'Extrair Páginas', message: `Falha ao extrair: ${result?.error || 'erro desconhecido'}` });
        }
      };
    }

    const btnExportImages = document.getElementById('btn-organize-export-images');
    if (btnExportImages) {
      btnExportImages.onclick = async () => {
        const selectedPages = getSelectedPages();
        if (selectedPages.length === 0) {
          notify({ tone: 'warning', title: 'Organizar Páginas', message: 'Selecione pelo menos uma página para exportar como imagem.' });
          return;
        }

        notify({ tone: 'info', title: 'Exportar Imagem', message: 'Renderizando páginas selecionadas...' });

        try {
          const exportList = [];
          for (let idx = 0; idx < selectedPages.length; idx += 1) {
            const page = selectedPages[idx];
            const fileIdx = page.fileIndex || 0;
            const doc = state.organizePdfDocs[fileIdx];
            if (!doc) continue;

            const pdfPage = await doc.getPage(page.sourceIndex + 1);
            const viewport = pdfPage.getViewport({ scale: 2.0 });
            const canvas = document.createElement('canvas');
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            const ctx = canvas.getContext('2d');
            if (!ctx) continue;

            await pdfPage.render({ canvasContext: ctx, viewport }).promise;

            const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
            const base64Data = dataUrl.split(',')[1];
            exportList.push({
              base64Data,
              name: `${getPrimaryOrganizeFile()?.name.replace(/\.pdf$/i, '') || 'pagina'}_pagina_${page.sourceIndex + 1}.jpg`
            });
          }

          let successCount = 0;
          for (const item of exportList) {
            const savedPath = await window.api.saveTempFile({ base64Data: item.base64Data, extension: 'jpg' });
            if (savedPath) {
              const primaryFile = getPrimaryOrganizeFile();
              const sourcePath = primaryFile?.path || primaryFile?.fileObject?.path || '';
              const separatorIndex = Math.max(String(sourcePath).lastIndexOf('\\'), String(sourcePath).lastIndexOf('/'));
              const outputDir = separatorIndex > 0 ? String(sourcePath).slice(0, separatorIndex) : '';
              await window.api.moveTempFileToDest({ tempPath: savedPath, targetName: item.name, outputDir });
              successCount += 1;
            }
          }

          notify({ tone: 'success', title: 'Exportar Imagem', message: `Exportadas ${successCount} páginas com sucesso.` });
        } catch {
          reportOrganizeFailure('ORGANIZE_PAGE_EXPORT_FAILED');
          notify({ tone: 'error', title: 'Exportar Imagem', message: 'Erro ao renderizar e salvar imagens das páginas.' });
        }
      };
    }
  }

  bindOrganizeUiOnce();

  function parsePdfDate(pdfDateStr) {
    try {
      // PDF date strings typically look like "D:20260611143202Z" or "D:20260611143202-03'00'"
      if (pdfDateStr.startsWith('D:')) {
        const year = pdfDateStr.substring(2, 6);
        const month = pdfDateStr.substring(6, 8);
        const day = pdfDateStr.substring(8, 10);
        const hour = pdfDateStr.substring(10, 12);
        const min = pdfDateStr.substring(12, 14);
        return `${day}/${month}/${year} às ${hour}:${min}`;
      }
      return pdfDateStr;
    } catch (e) {
      return pdfDateStr;
    }
  }

  return {
    handleOrganizeFile,
    addOrganizeFile,
    addOrganizeFiles,
    clearOrganizeWorkspace,
    rotateSelectedPages,
    duplicateSelectedPages,
    deleteSelectedPages,
    selectAllOrganizePages,
    clearOrganizeSelection,
    reverseOrganizeOrder,
    moveSelectedPages
  };
}
