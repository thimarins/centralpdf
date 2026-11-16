import { normalizeBinaryData, clamp, downsampleImageAsBase64 as downsampleImageAsBase64Shared } from '../pdf-preview-utils.js';
import { formatDocumentMeta } from '../document-info.js';

export function createRedactWorkspaceController(deps) {
  const {
    pdfjsLib,
    state,
    document,
    icon,
    notify,
    clearFeedbackBanner,
    formatBytes,
    showValidationMessage
  } = deps;

  let renderToken = 0;
  let loadToken = 0;
  let pdfLoadingTask = null;
  let dragState = null;
  let resizeState = null;
  let panState = null;
  let smartSearchToken = 0;
  let smartSearchLoadingTask = null;
  let pageRenderQueue = Promise.resolve();
  let activePageRenderTask = null;
  let keyboardBindingsReady = false;
  let previewZoom = 100;

  function downsampleImageAsBase64(fileObject, maxDimension = 2200, quality = 0.82) {
    return downsampleImageAsBase64Shared(fileObject, maxDimension, quality, 'Falha ao preparar a imagem para ocultação.');
  }

  function normalizeRedactErrorMessage(error, fallback) {
    const rawMessage = String(error?.message || error || "").trim();
    const normalized = rawMessage.toLowerCase();

    if (!rawMessage) return fallback;
    if (normalized.includes('corromp') || normalized.includes('incomplet') || normalized.includes('invalid pdf path') || normalized.includes('não foi possível abrir')) {
      return 'Não foi possível abrir este documento para ocultação.';
    }
    if (normalized.includes('pdf') && normalized.includes('preview') && normalized.includes('failed')) {
      return 'Não foi possível carregar a prévia do documento.';
    }
    if (normalized.includes('imagem') && normalized.includes('tempor') && normalized.includes('falha')) {
      return 'Não foi possível preparar a imagem para ocultação.';
    }
    return fallback || 'Não foi possível concluir a ocultação.';
  }

  // Ensure redact state properties exist
  if (!state.redactBoxes) state.redactBoxes = [];
  if (state.redactCurrentPageIndex === undefined) state.redactCurrentPageIndex = 0;
  if (!state.redactSelectedBoxId) state.redactSelectedBoxId = '';

  function getCanvas() {
    return document.getElementById('redact-preview-canvas');
  }

  function getOverlayLayer() {
    return document.getElementById('redact-overlay-layer');
  }

  function syncPreviewZoom() {
    const canvas = getCanvas();
    const shell = document.getElementById('redact-preview-shell');
    const range = document.getElementById('redact-zoom-range');
    const value = document.getElementById('redact-zoom-value');
    if (!canvas || !shell) return;

    previewZoom = clamp(Number(previewZoom) || 100, 50, 250);
    if (range) {
      range.value = String(previewZoom);
      range.setAttribute('aria-valuenow', String(previewZoom));
    }
    if (value) value.textContent = `${previewZoom}%`;

    canvas.classList.toggle('redact-preview-canvas--zoomed', previewZoom !== 100);
    if (canvas.width && canvas.height) {
      canvas.style.width = `${Math.round(canvas.width * previewZoom / 100)}px`;
      canvas.style.height = `${Math.round(canvas.height * previewZoom / 100)}px`;
    }
    shell.classList.toggle('redact-preview-shell--zoomed', previewZoom !== 100);
    renderOverlayLayer();
    if (previewZoom > 100) {
      window.requestAnimationFrame?.(() => centerPreviewScroll());
    }
  }

  function setPreviewZoom(value) {
    previewZoom = clamp(Math.round(Number(value) / 10) * 10, 50, 250);
    syncPreviewZoom();
  }

  function resetPreviewScroll() {
    const shell = document.getElementById('redact-preview-shell');
    if (!shell) return;
    shell.scrollLeft = 0;
    shell.scrollTop = 0;
  }

  function cancelActivePageRender() {
    try {
      activePageRenderTask?.cancel?.();
    } catch {}
    activePageRenderTask = null;
  }

  function centerPreviewScroll() {
    const shell = document.getElementById('redact-preview-shell');
    if (!shell) return;
    if (previewZoom <= 100) {
      shell.scrollLeft = 0;
      shell.scrollTop = 0;
      return;
    }
    shell.scrollLeft = Math.max(0, (shell.scrollWidth - shell.clientWidth) / 2);
    shell.scrollTop = Math.max(0, (shell.scrollHeight - shell.clientHeight) / 2);
  }

  function syncVisibility() {
    const hasFile = !!state.redactFile;
    document.getElementById('redact-dropzone').classList.toggle('hidden', hasFile);
    document.getElementById('redact-workspace').classList.toggle('hidden', !hasFile);
  }

  function getCurrentPageBoxes() {
    return state.redactBoxes.filter((box) => box.pageIndex === state.redactCurrentPageIndex);
  }

  function ensureSelectedBox() {
    if (state.redactSelectedBoxId && !state.redactBoxes.some((box) => box.id === state.redactSelectedBoxId)) {
      state.redactSelectedBoxId = '';
    }
  }

  function removeBox(boxId) {
    if (!boxId || !state.redactBoxes.some((box) => box.id === boxId)) return;
    dragState = null;
    resizeState = null;
    panState = null;
    state.redactBoxes = state.redactBoxes.filter((box) => box.id !== boxId);
    if (state.redactSelectedBoxId === boxId) {
      state.redactSelectedBoxId = '';
    }
    renderOverlayLayer();
    renderBoxList();
  }

  function updateFileMeta() {
    document.getElementById('redact-file-name').textContent = state.redactFile?.name || 'arquivo.pdf';
    document.getElementById('redact-file-meta').textContent = state.redactFile
      ? formatDocumentMeta(formatBytes, { ...state.redactFile, pages: state.redactPageCount })
      : '';
    document.getElementById('redact-page-label').textContent = state.redactPageCount
      ? `Página ${state.redactCurrentPageIndex + 1} de ${state.redactPageCount}`
      : 'Página 0 de 0';
  }

  function renderBoxList() {
    const editor = document.getElementById('redact-field-editor');
    if (!editor) return;

    if (state.redactBoxes.length === 0) {
      editor.innerHTML = '<div class="empty-state">Nenhuma tarja adicionada. Use “Adicionar Tarja” ou a busca inteligente.</div>';
      return;
    }

    const pageGroups = new Map();
    state.redactBoxes.forEach((box) => {
      const pageIndex = Math.max(0, Number(box.pageIndex) || 0);
      if (!pageGroups.has(pageIndex)) pageGroups.set(pageIndex, []);
      pageGroups.get(pageIndex).push(box);
    });

    editor.innerHTML = [...pageGroups.entries()].sort(([left], [right]) => left - right).map(([pageIndex, boxes]) => `
      <section class="redact-page-group ${pageIndex === state.redactCurrentPageIndex ? 'current' : ''}">
        <button type="button" class="redact-page-group-heading" data-redact-page="${pageIndex}" aria-current="${pageIndex === state.redactCurrentPageIndex ? 'page' : 'false'}">
          <span>Página ${pageIndex + 1}</span><span class="redact-page-count">${boxes.length} ${boxes.length === 1 ? 'tarja' : 'tarjas'}</span>
        </button>
        <div class="redact-page-group-items">${boxes.map((box, index) => {
      const isSelected = box.id === state.redactSelectedBoxId;
      const sourceLabel = box.source === 'ocr'
        ? `<small>Encontrada por OCR · confiança ${Math.round(Number(box.confidence) || 0)}% · revise antes de aplicar</small>`
        : '';
      return `
        <div class="redact-field-item ${isSelected ? 'selected' : ''}" data-box-id="${box.id}" role="option" tabindex="0" aria-selected="${isSelected ? 'true' : 'false'}" style="cursor: pointer; ${isSelected ? 'border-color: var(--accent-color);' : ''}">
          <span>Tarja #${index + 1}${sourceLabel}</span>
          <button class="btn-danger-text btn-sm btn-icon" data-remove-box="${box.id}" title="Remover esta tarja">${icon('remove')}</button>
        </div>
      `;
    }).join('')}</div>
      </section>
    `).join('');

    editor.querySelectorAll('[data-redact-page]').forEach((button) => {
      button.addEventListener('click', async () => {
        const pageIndex = Number(button.getAttribute('data-redact-page'));
        if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= state.redactPageCount) return;
        if (pageIndex !== state.redactCurrentPageIndex) {
          state.redactCurrentPageIndex = pageIndex;
          state.redactSelectedBoxId = '';
          updateFileMeta();
          resetPreviewScroll();
          try {
            await renderCurrentPage();
          } catch (error) {
            notify({ tone: 'error', title: 'Preview do PDF', message: error.message || 'Não foi possível atualizar a página.' });
          }
        }
      });
    });

    editor.querySelectorAll('[data-box-id]').forEach((item) => {
      const boxId = item.getAttribute('data-box-id');
      item.addEventListener('click', (event) => {
        if (event.target.closest('[data-remove-box]')) return;
        const selectedBox = state.redactBoxes.find((box) => box.id === boxId);
        if (selectedBox && selectedBox.pageIndex !== state.redactCurrentPageIndex) {
          state.redactCurrentPageIndex = selectedBox.pageIndex;
          state.redactSelectedBoxId = boxId;
          updateFileMeta();
          resetPreviewScroll();
          void renderCurrentPage().catch((error) => notify({ tone: 'error', title: 'Preview do PDF', message: error.message || 'Não foi possível atualizar a página.' }));
          return;
        }
        state.redactSelectedBoxId = boxId;
        renderOverlayLayer();
        renderBoxList();
      });
      item.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          state.redactSelectedBoxId = boxId;
          renderOverlayLayer();
          renderBoxList();
          return;
        }
        if (event.key === 'Delete' || event.key === 'Backspace') {
          event.preventDefault();
          removeBox(boxId);
        }
      });
    });

    editor.querySelectorAll('[data-remove-box]').forEach((button) => {
      const boxId = button.getAttribute('data-remove-box');
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        removeBox(boxId);
      });
    });
  }

  function renderOverlayLayer() {
    const overlay = getOverlayLayer();
    const shell = document.getElementById('redact-preview-shell');
    const canvas = getCanvas();
    if (!overlay || !shell) return;
    ensureSelectedBox();

    const shellWidth = canvas?.clientWidth || shell.clientWidth || 1;
    const shellHeight = canvas?.clientHeight || shell.clientHeight || 1;
    overlay.style.width = `${shellWidth}px`;
    overlay.style.height = `${shellHeight}px`;
    overlay.style.left = `${canvas?.offsetLeft || 16}px`;
    overlay.style.top = `${canvas?.offsetTop || 16}px`;

    const redactColorSelect = document.getElementById('redact-box-color');

    const boxes = getCurrentPageBoxes();
    overlay.innerHTML = boxes.map((box) => {
      const left = box.xRatio * shellWidth;
      const top = box.yRatio * shellHeight;
      const width = box.widthRatio * shellWidth;
      const height = box.heightRatio * shellHeight;
      const selected = box.id === state.redactSelectedBoxId;
      const color = box.color || '#000000';

      if (selected && redactColorSelect) {
        redactColorSelect.value = color;
      }

      const borderStyle = color === '#ffffff' ? `border: 2px dashed ${selected ? '#ffcc00' : '#000000'};` : `border: 2px solid ${selected ? '#ffcc00' : '#ff3b30'};`;
      const bgOpacity = color === '#ffffff' ? 'rgba(255, 255, 255, 0.75)' : color === '#7f7f7f' ? 'rgba(127, 127, 127, 0.75)' : 'rgba(0, 0, 0, 0.55)';
      const style = `left:${left}px;top:${top}px;width:${width}px;height:${height}px;background:${bgOpacity};${borderStyle}`;

      return `
        <button type="button" class="redact-box-chip${selected ? ' selected' : ''}" data-redact-box-id="${box.id}" aria-label="Tarja preta ${selected ? 'selecionada' : 'não selecionada'}. Use Delete para remover." aria-pressed="${selected ? 'true' : 'false'}" style="${style}">
          <span class="redact-box-resize-handle" data-redact-resize-handle="${box.id}" style="${color === '#ffffff' ? 'background:#ffcc00;border:1px solid #000000;' : ''}" aria-hidden="true"></span>
        </button>
      `;
    }).join('');

    overlay.querySelectorAll('[data-redact-box-id]').forEach((element) => {
      const boxId = element.getAttribute('data-redact-box-id');

      element.addEventListener('click', (event) => {
        event.preventDefault();
        state.redactSelectedBoxId = boxId;
        renderOverlayLayer();
        renderBoxList();
      });

      element.addEventListener('keydown', (event) => {
        if (event.key === 'Delete' || event.key === 'Backspace') {
          event.preventDefault();
          event.stopPropagation();
          removeBox(boxId);
          return;
        }

        const box = state.redactBoxes.find((b) => b.id === boxId);
        if (!box || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        const step = event.shiftKey ? 0.05 : 0.01;
        if (event.key === 'ArrowLeft') box.xRatio = clamp(box.xRatio - step, 0, 0.92);
        if (event.key === 'ArrowRight') box.xRatio = clamp(box.xRatio + step, 0, 0.92);
        if (event.key === 'ArrowUp') box.yRatio = clamp(box.yRatio - step, 0, 0.92);
        if (event.key === 'ArrowDown') box.yRatio = clamp(box.yRatio + step, 0, 0.92);
        state.redactSelectedBoxId = boxId;
        renderOverlayLayer();
      });

      element.addEventListener('pointerdown', (event) => {
        if (event.target.closest('[data-redact-resize-handle]')) return;
        event.preventDefault();
        const box = state.redactBoxes.find((b) => b.id === boxId);
        if (!box) return;
        state.redactSelectedBoxId = boxId;
        renderOverlayLayer();
        renderBoxList();

        dragState = {
          id: boxId,
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          startBoxX: box.xRatio,
          startBoxY: box.yRatio
        };
      });

      const resizeHandle = element.querySelector('[data-redact-resize-handle]');
      if (resizeHandle) {
        resizeHandle.addEventListener('pointerdown', (event) => {
          event.preventDefault();
          event.stopPropagation();
          const box = state.redactBoxes.find((b) => b.id === boxId);
          if (!box) return;
          state.redactSelectedBoxId = boxId;
          renderOverlayLayer();
          renderBoxList();

          resizeState = {
            id: boxId,
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            startWidth: box.widthRatio,
            startHeight: box.heightRatio
          };
        });
      }
    });
  }

  async function renderCurrentPageInternal(pageIndex) {
    let pdfDoc = state.redactPdfDoc;
    if (!pdfDoc) return;
    const token = ++renderToken;
    const canvas = getCanvas();
    let page;
    try {
      page = await getPageWithRetry(pdfDoc, pageIndex + 1, 'preview');
    } catch (error) {
      // A troca/limpeza do arquivo pode destruir o PDF enquanto a navegação aguarda.
      // Esse trabalho antigo não deve escapar como unhandled rejection.
      if (token !== renderToken || pdfDoc !== state.redactPdfDoc || state.redactCurrentPageIndex !== pageIndex) {
        return;
      }
      notify({ id: 'redact-preview-recovery', tone: 'info', title: 'Atualizando prévia', message: 'O visualizador encontrou uma instabilidade e está reabrindo esta página.' });
      pdfDoc = await reloadPreviewDocument(pdfDoc);
      page = await getPageWithRetry(pdfDoc, pageIndex + 1, 'preview');
    }
    const viewport = page.getViewport({ scale: 1.25 });
    const ratio = Math.min(1, 700 / viewport.width);
    const scaledViewport = page.getViewport({ scale: 1.25 * ratio });
    canvas.width = scaledViewport.width;
    canvas.height = scaledViewport.height;
    canvas.style.width = '';
    canvas.style.height = '';
    const context = canvas.getContext('2d');
    if (!context) return;
    const renderCanvas = document.createElement('canvas');
    renderCanvas.width = Math.max(1, Math.round(scaledViewport.width));
    renderCanvas.height = Math.max(1, Math.round(scaledViewport.height));
    const renderContext = renderCanvas.getContext('2d');
    if (!renderContext) return;
    renderContext.fillStyle = '#ffffff';
    renderContext.fillRect(0, 0, renderCanvas.width, renderCanvas.height);
    let renderTask = null;
    try {
      renderTask = page.render({ canvasContext: renderContext, viewport: scaledViewport });
      activePageRenderTask = renderTask;
      await Promise.race([
        renderTask.promise,
        new Promise((_, reject) => window.setTimeout(() => reject(new Error('Timeout ao renderizar a página do preview.')), 15000))
      ]);
    } catch (error) {
      try {
        renderTask?.cancel?.();
      } catch {}
      if (token !== renderToken || pdfDoc !== state.redactPdfDoc || state.redactCurrentPageIndex !== pageIndex) return;
      throw error;
    } finally {
      activePageRenderTask = null;
    }
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(renderCanvas, 0, 0);
    if (token !== renderToken || pdfDoc !== state.redactPdfDoc || state.redactCurrentPageIndex !== pageIndex) return;
    updateFileMeta();
    syncPreviewZoom();
    renderOverlayLayer();
    renderBoxList();
  }

  function renderCurrentPage() {
    const requestedPageIndex = state.redactCurrentPageIndex;
    cancelActivePageRender();
    const renderTask = pageRenderQueue.then(() => renderCurrentPageInternal(requestedPageIndex));
    pageRenderQueue = renderTask.catch(() => {});
    return renderTask;
  }

  async function loadPdfPreview(file) {
    const currentLoadToken = ++loadToken;
      let pdfBytes;
      if (file?.path) {
        pdfBytes = await window.api.readFileBytes(file.path);
      } else if (file && typeof file.arrayBuffer === 'function') {
        pdfBytes = await file.arrayBuffer();
      } else {
        throw new Error('Não foi possível ler o arquivo selecionado.');
      }
    const normalizedPdfBytes = normalizeBinaryData(pdfBytes);
    state.redactPdfBytes = normalizedPdfBytes.slice();
    const loadingTask = pdfjsLib.getDocument({ data: normalizedPdfBytes });
    pdfLoadingTask = loadingTask;
    const pdfDoc = await Promise.race([
      loadingTask.promise,
      new Promise((_, reject) => setTimeout(() => {
        try {
          loadingTask.destroy?.();
        } catch {}
        reject(new Error('Timeout ao carregar a prévia do PDF.'));
      }, 20000))
    ]);
    if (currentLoadToken !== loadToken || state.redactFile?.path !== file?.path) {
      void Promise.resolve(pdfDoc.destroy?.()).catch(() => {});
      return;
    }
    state.redactPdfDoc = pdfDoc;
    pdfLoadingTask = null;
    state.redactPageCount = pdfDoc.numPages;
    state.redactCurrentPageIndex = 0;
    previewZoom = 100;
    resetPreviewScroll();
    await renderCurrentPage();
  }

  async function handleRedactFile(file) {
    const isImage = /\.(jpg|jpeg|png)$/i.test(file.name);
    let fileToLoad = file;
    let originalName = file.name;
    let originalSize = file.size;

    if (isImage) {
      document.getElementById('redact-field-editor').innerHTML = '<div class="empty-state">Convertendo imagem para PDF temporário...</div>';
      try {
        let imagePath = file.path || '';
        if (!imagePath && typeof file.arrayBuffer === 'function') {
          imagePath = await new Promise((resolve, reject) => {
            downsampleImageAsBase64(file, 2200, 0.82)
              .then((base64Data) => window.api.saveTempFile({ base64Data, extension: 'jpg' }))
              .then(resolve)
              .catch(reject);
          });
          state.redactTempPaths = [...(state.redactTempPaths || []), imagePath];
        }
        const tempPdfPath = await window.api.convertImageToTempPdf(imagePath);
        state.redactTempPaths = [...(state.redactTempPaths || []), tempPdfPath];
        fileToLoad = {
          name: file.name,
          path: tempPdfPath,
          size: file.size
        };
      } catch {
        notify({ tone: 'error', title: 'Ocultar Dados', message: 'Não foi possível preparar a imagem para ocultação.', important: true });
        clearWorkspace();
        return;
      }
    }

    state.redactFile = { name: originalName, size: originalSize, path: fileToLoad.path || '', fileObject: file };
    state.redactBoxes = [];
    state.redactSelectedBoxId = '';
    syncVisibility();
    const cleanName = originalName.replace(/\.(pdf|jpg|jpeg|png)$/i, '');
    document.getElementById('redact-output-name').value = `${cleanName}_oculto.pdf`;
    document.getElementById('redact-file-name').textContent = originalName;
    document.getElementById('redact-file-meta').textContent = formatDocumentMeta(formatBytes, { name: originalName, size: originalSize });
    document.getElementById('redact-field-editor').innerHTML = '<div class="empty-state">Carregando preview do documento...</div>';
    try {
      await loadPdfPreview(fileToLoad);
    } catch (error) {
      console.error('Redact PDF preview failed (PDF_PREVIEW_LOAD_FAILED).');
      const message = normalizeRedactErrorMessage(
        error,
        isImage
          ? 'Não foi possível abrir a imagem para ocultação no editor.'
          : 'Não foi possível abrir este PDF para ocultação.'
      );
      notify({ tone: 'error', title: 'Ocultar Dados', message, important: true });
      clearWorkspace();
    }
  }

  function addRedactBox() {
    if (!state.redactFile) return;
    const color = document.getElementById('redact-box-color')?.value || '#000000';
    const box = {
      id: `redact_box_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      pageIndex: state.redactCurrentPageIndex,
      xRatio: 0.35,
      yRatio: 0.35,
      widthRatio: 0.3,
      heightRatio: 0.08,
      color
    };
    state.redactBoxes.push(box);
    state.redactSelectedBoxId = box.id;
    renderOverlayLayer();
    renderBoxList();
  }

  function clearWorkspace({ preserveTemp = false } = {}) {
    loadToken += 1;
    renderToken += 1;
    cancelActivePageRender();
    smartSearchToken += 1;
    void Promise.resolve(smartSearchLoadingTask?.destroy?.()).catch(() => {});
    smartSearchLoadingTask = null;
    void Promise.resolve(pdfLoadingTask?.destroy?.()).catch(() => {});
    pdfLoadingTask = null;
    void Promise.resolve(state.redactPdfDoc?.destroy?.()).catch(() => {});
    const tempPaths = [...new Set(state.redactTempPaths || [])];
    state.redactTempPaths = [];
    if (!preserveTemp && tempPaths.length > 0) {
      void window.api.deleteTempPaths?.(tempPaths).catch?.(() => {});
    }
    state.redactFile = null;
    state.redactPdfDoc = null;
    state.redactPdfBytes = null;
    state.redactPageCount = 0;
    state.redactCurrentPageIndex = 0;
    previewZoom = 100;
    panState = null;
    document.getElementById('redact-preview-shell')?.classList.remove('redact-preview-shell--panning');
    resetPreviewScroll();
    state.redactBoxes = [];
    state.redactSelectedBoxId = '';
    clearFeedbackBanner('redact');
    syncVisibility();
    const canvas = getCanvas();
    const context = canvas?.getContext('2d');
    if (context && canvas) {
      context.clearRect(0, 0, canvas.width, canvas.height);
    }
    const overlay = getOverlayLayer();
    if (overlay) overlay.innerHTML = '';
    document.getElementById('redact-field-editor').innerHTML = '<div class="empty-state">Adicione uma tarja para começar.</div>';

    const searchInput = document.getElementById('redact-search-input');
    if (searchInput) searchInput.value = '';
    const searchStatus = document.getElementById('redact-search-status');
    if (searchStatus) searchStatus.textContent = '';
  }

  function waitForQueuedTask(taskId, timeoutMs = 30 * 60 * 1000) {
    return new Promise((resolve, reject) => {
      let unsubscribe = () => {};
      let timeoutHandle;
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        unsubscribe();
        if (error) reject(error);
        else resolve(result);
      };
      const inspect = (tasks) => {
        const task = Array.isArray(tasks) ? tasks.find((item) => item.id === taskId) : null;
        if (!task) return;
        if (task.status === 'completed') return finish(null, task.result || {});
        if (['failed', 'timeout', 'cancelled', 'interrupted'].includes(task.status)) {
          return finish(new Error(task.error || (task.status === 'cancelled' ? 'A análise OCR foi cancelada.' : 'Não foi possível concluir a análise OCR.')));
        }
      };
      unsubscribe = window.api?.onQueueUpdate?.(inspect) || (() => {});
      timeoutHandle = window.setTimeout(() => {
        void window.api?.cancelOperation?.(taskId).catch(() => {});
        finish(new Error('A análise OCR demorou mais do que o esperado e foi cancelada.'));
      }, timeoutMs);
      Promise.resolve(window.api?.getQueueStatus?.()).then(inspect).catch((error) => finish(error));
    });
  }

  async function performSmartRedaction(term) {
    if (!state.redactPdfDoc) return;
    if (smartSearchLoadingTask) {
      notify({ tone: 'info', title: 'Busca Inteligente', message: 'A busca atual ainda está em andamento.' });
      return;
    }
    const searchStatus = document.getElementById('redact-search-status');
    const searchButton = document.getElementById('btn-redact-search');
    const searchToken = ++smartSearchToken;
    const previewPdfDoc = state.redactPdfDoc;
    if (searchStatus) searchStatus.textContent = 'Buscando ocorrências...';

    let regex;
    if (term === 'CPF') {
      regex = /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b|\b\d{11}\b/g;
    } else if (term === 'CNPJ') {
      regex = /\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b|\b\d{14}\b/g;
    } else if (term === 'TELEFONE') {
      regex = /(?:\(?\d{2}\)?\s?)?\d{4,5}[- ]?\d{4}/g;
    } else if (term === 'EMAIL') {
      regex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    } else if (term === 'DATA') {
      regex = /\b(?:(?:0?[1-9]|[12]\d|3[01])[./-](?:0?[1-9]|1[0-2])[./-](?:19|20)\d{2}|(?:19|20)\d{2}[./-](?:0?[1-9]|1[0-2])[./-](?:0?[1-9]|[12]\d|3[01]))\b/g;
    } else {
      if (!term.trim()) {
        notify({ tone: 'warning', title: 'Ocultar Dados', message: 'Digite um termo para busca.' });
        if (searchStatus) searchStatus.textContent = '';
        return;
      }
      const escaped = term.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
      regex = new RegExp(escaped, 'gi');
    }

    let totalFound = 0;
    const newBoxes = [];
    let textLayerFound = false;
    let pagesNeedingOcr = 0;
    let ocrSearchResult = null;
    let ocrSearchError = '';

    notify({
      id: 'redact-smart-search',
      tone: 'info',
      title: 'Busca Inteligente',
      message: `Analisando todas as ${state.redactPageCount} páginas do documento...`,
      delayMs: 350
    });

    if (searchButton) searchButton.disabled = true;
    document.querySelectorAll('[data-redact-preset]').forEach((button) => { button.disabled = true; });

    let searchPdfDoc = null;
    try {
      const sourceBytes = state.redactPdfBytes instanceof Uint8Array
        ? state.redactPdfBytes.slice()
        : null;
      if (!sourceBytes || sourceBytes.length === 0) {
        throw new Error('Não foi possível acessar os dados do documento para a busca.');
      }

      smartSearchLoadingTask = pdfjsLib.getDocument({ data: sourceBytes });
      searchPdfDoc = await smartSearchLoadingTask.promise;
      const pageCount = Math.min(state.redactPageCount, searchPdfDoc.numPages || state.redactPageCount);

      for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
        if (searchToken !== smartSearchToken || state.redactPdfDoc !== previewPdfDoc) return;
        let page;
        try {
          page = await searchPdfDoc.getPage(pageIndex + 1);
        } catch {
          console.warn(`Busca Inteligente: página ${pageIndex + 1} não pôde ser analisada (PDF_PAGE_UNAVAILABLE).`);
          continue;
        }
        let textContent;
        try {
          textContent = await page.getTextContent();
        } catch {
          console.warn(`Busca Inteligente: texto da página ${pageIndex + 1} não pôde ser lido (PDF_TEXT_UNAVAILABLE).`);
          continue;
        }
        const viewport = page.getViewport({ scale: 1.0 });

        const pageText = textContent.items.map((item) => item.str || '').join(' ').trim();
        const compactPageText = pageText.replace(/\s/g, '');
        if (textContent.items.length > 0) textLayerFound = true;
        if (compactPageText.length < 20) pagesNeedingOcr += 1;

        let fullText = '';
        const charMap = [];

        textContent.items.forEach((item, itemIdx) => {
          const str = item.str;
          for (let i = 0; i < str.length; i++) {
            charMap.push({ itemIdx, charIdx: i });
          }
          fullText += str;
          fullText += ' ';
          charMap.push(null);
        });

        let match;
        regex.lastIndex = 0;
        while ((match = regex.exec(fullText)) !== null) {
          if (match[0].length === 0) continue;
          const matchStart = match.index;
          const matchEnd = match.index + match[0].length;

          const uniqueItemIndices = new Set();
          for (let i = matchStart; i < matchEnd; i++) {
            const map = charMap[i];
            if (map) {
              uniqueItemIndices.add(map.itemIdx);
            }
          }

          uniqueItemIndices.forEach((itemIdx) => {
            const item = textContent.items[itemIdx];
            const pdfX = item.transform[4];
            const pdfY = item.transform[5];
            const w = item.width;
            const h = item.height || Math.abs(item.transform[0]) || Math.abs(item.transform[3]) || 12;

            const [left, top] = viewport.convertToViewportPoint(pdfX, pdfY + h);
            const [right, bottom] = viewport.convertToViewportPoint(pdfX + w, pdfY);

            const xRatio = Math.max(0, left / viewport.width);
            const yRatio = Math.max(0, top / viewport.height);
            const widthRatio = Math.min(1, (right - left) / viewport.width);
            const heightRatio = Math.min(1, (bottom - top) / viewport.height);

            const isDuplicate = state.redactBoxes.some(b => 
              b.pageIndex === pageIndex && 
              Math.abs(b.xRatio - xRatio) < 0.01 && 
              Math.abs(b.yRatio - yRatio) < 0.01 &&
              Math.abs(b.widthRatio - widthRatio) < 0.01 &&
              Math.abs(b.heightRatio - heightRatio) < 0.01
            ) || newBoxes.some(b => 
              b.pageIndex === pageIndex && 
              Math.abs(b.xRatio - xRatio) < 0.01 && 
              Math.abs(b.yRatio - yRatio) < 0.01 &&
              Math.abs(b.widthRatio - widthRatio) < 0.01 &&
              Math.abs(b.heightRatio - heightRatio) < 0.01
            );

            if (!isDuplicate) {
              const color = document.getElementById('redact-box-color')?.value || '#000000';
              newBoxes.push({
                id: `redact_box_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                pageIndex,
                xRatio,
                yRatio,
                widthRatio,
                heightRatio,
                color
              });
            }
          });

          totalFound++;
        }

        // Entrega o controle ao navegador entre páginas para manter navegação,
        // zoom e cancelamento responsivos em documentos longos.
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      }

      if (searchToken !== smartSearchToken || state.redactPdfDoc !== previewPdfDoc) return;

      if (pagesNeedingOcr > 0 && state.redactFile?.path && /\.pdf$/i.test(state.redactFile.path)) {
        if (searchStatus) searchStatus.textContent = `Reconhecendo até ${pagesNeedingOcr} página(s) digitalizada(s); acompanhe o progresso na fila.`;
        notify({ id: 'redact-smart-search', tone: 'info', title: 'Reconhecendo páginas digitalizadas', message: 'A análise OCR local está na fila. As sugestões serão adicionadas à prévia para sua revisão.' });
        try {
          const queued = await window.api.queueOperation({
            type: 'redact-ocr-search',
            files: [state.redactFile.path],
            options: { query: term, language: 'por+eng' }
          });
          if (!queued?.success || !queued.taskId) throw new Error(queued?.error || 'Não foi possível iniciar a análise OCR.');
          ocrSearchResult = await waitForQueuedTask(queued.taskId);
          if (searchToken !== smartSearchToken || state.redactPdfDoc !== previewPdfDoc) return;
          const color = document.getElementById('redact-box-color')?.value || '#000000';
          (ocrSearchResult.candidates || []).forEach((candidate) => {
            const isDuplicate = [...state.redactBoxes, ...newBoxes].some((box) => (
              box.pageIndex === candidate.pageIndex
              && Math.abs(box.xRatio - candidate.xRatio) < 0.01
              && Math.abs(box.yRatio - candidate.yRatio) < 0.01
              && Math.abs(box.widthRatio - candidate.widthRatio) < 0.01
              && Math.abs(box.heightRatio - candidate.heightRatio) < 0.01
            ));
            if (isDuplicate) return;
            newBoxes.push({
              id: `redact_ocr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
              pageIndex: candidate.pageIndex,
              xRatio: candidate.xRatio,
              yRatio: candidate.yRatio,
              widthRatio: candidate.widthRatio,
              heightRatio: candidate.heightRatio,
              color,
              source: 'ocr',
              confidence: candidate.confidence
            });
          });
          totalFound += Number(ocrSearchResult.totalMatches) || 0;
        } catch (error) {
          ocrSearchError = 'O reconhecimento não terminou. O original não foi alterado; tente novamente ou adicione as tarjas manualmente.';
        }
      }

      if (newBoxes.length > 0) {
        state.redactBoxes = [...state.redactBoxes, ...newBoxes];
        notify({
          id: 'redact-smart-search',
          tone: newBoxes.some((box) => box.source === 'ocr') ? 'warning' : 'success',
          title: newBoxes.some((box) => box.source === 'ocr') ? 'Sugestões de tarja para revisar' : 'Tarjas encontradas',
          message: `${newBoxes.length} sugestão(ões) adicionada(s) à prévia sobre ${totalFound} ocorrência(s). Revise cada tarja antes de aplicar.`,
          detail: [
            ocrSearchResult?.candidates?.length ? `${ocrSearchResult.candidates.length} sugestão(ões) foram localizadas por OCR com confiança mínima de ${ocrSearchResult.minimumConfidence}%.` : '',
            ocrSearchResult?.lowConfidenceMatches ? `${ocrSearchResult.lowConfidenceMatches} ocorrência(s) com confiança baixa foram omitidas.` : '',
            ocrSearchResult?.truncated ? 'O limite de 500 sugestões foi atingido; revise e repita a busca para continuar.' : '',
            ocrSearchError ? `OCR não concluído: ${ocrSearchError}` : ''
          ].filter(Boolean).join(' ')
        });
        await renderCurrentPage();
      } else if (!textLayerFound || pagesNeedingOcr > 0) {
        const message = ocrSearchError
          ? `Não foi possível concluir a busca OCR. ${ocrSearchError}`
          : ocrSearchResult?.lowConfidenceMatches
            ? `Nenhuma sugestão confiável foi adicionada. ${ocrSearchResult.lowConfidenceMatches} ocorrência(s) de baixa confiança foram omitidas; confira visualmente o documento.`
            : 'Não foram encontradas ocorrências com confiança suficiente nas páginas digitalizadas. Revise visualmente antes de concluir a ocultação.';
        notify({ id: 'redact-smart-search', tone: 'warning', title: 'Revise o documento', message });
      } else {
        notify({
          id: 'redact-smart-search',
          tone: 'info',
          title: 'Nenhuma ocorrência',
          message: 'Nenhum padrão ou palavra correspondente foi encontrado no documento.'
        });
      }

      if (searchStatus) {
        searchStatus.textContent = `${totalFound} ocorrência(s) encontrada(s); revise as tarjas antes de aplicar.`;
      }
    } catch (err) {
      console.error('Smart redaction failed (PDF_ANALYSIS_FAILED).');
      notify({
        id: 'redact-smart-search',
        tone: 'error',
        title: 'Busca Inteligente',
        message: normalizeRedactErrorMessage(err, 'Não foi possível analisar este PDF. Confira se o arquivo está íntegro e tente novamente.')
      });
      if (searchStatus) searchStatus.textContent = 'Erro na busca.';
    } finally {
      await Promise.resolve(searchPdfDoc?.destroy?.()).catch(() => {});
      smartSearchLoadingTask = null;
      if (searchButton) searchButton.disabled = false;
      document.querySelectorAll('[data-redact-preset]').forEach((button) => { button.disabled = false; });
    }
  }

  function getPendingMessage() {
    if (state.redactFile || state.redactBoxes.length > 0) {
      return 'Há um documento ou tarjas configuradas em Ocultar Dados. Se sairmos agora, esse andamento será perdido.';
    }
    return '';
  }

  async function getPageWithRetry(pdfDoc, pageNumber, operationLabel) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await pdfDoc.getPage(pageNumber);
      } catch {
        if (attempt < 2) {
          await new Promise((resolve) => window.setTimeout(resolve, 80 * (attempt + 1)));
        }
      }
    }
    throw new Error(`Não foi possível preparar a página ${pageNumber} para ${operationLabel}. Carregue o arquivo novamente.`);
  }

  async function reloadPreviewDocument(previousDoc) {
    if (!(state.redactPdfBytes instanceof Uint8Array) || state.redactPdfBytes.length === 0) {
      throw new Error('A prévia do documento foi encerrada. Carregue o arquivo novamente.');
    }
    const loadingTask = pdfjsLib.getDocument({ data: state.redactPdfBytes.slice() });
    const replacementDoc = await loadingTask.promise;
    if (state.redactPdfDoc !== previousDoc) {
      await Promise.resolve(replacementDoc.destroy?.()).catch(() => {});
      return state.redactPdfDoc;
    }
    state.redactPdfDoc = replacementDoc;
    state.redactPageCount = replacementDoc.numPages;
    await Promise.resolve(previousDoc?.destroy?.()).catch(() => {});
    updateFileMeta();
    return replacementDoc;
  }

  async function generateRedactedPagesPayload() {
    const pagesWithBoxes = {};
    for (const box of state.redactBoxes) {
      if (!pagesWithBoxes[box.pageIndex]) {
        pagesWithBoxes[box.pageIndex] = [];
      }
      pagesWithBoxes[box.pageIndex].push(box);
    }

    const redactedPages = [];
    const pageIndices = Object.keys(pagesWithBoxes).map(Number).sort((a, b) => a - b);

    if (!state.redactPdfDoc || !(state.redactPdfBytes instanceof Uint8Array) || state.redactPdfBytes.length === 0) {
      throw new Error('A prévia do documento foi encerrada. Carregue o arquivo novamente.');
    }

    const generationLoadingTask = pdfjsLib.getDocument({ data: state.redactPdfBytes.slice() });
    let generationPdfDoc = null;
    try {
      generationPdfDoc = await generationLoadingTask.promise;

      for (const pageIndex of pageIndices) {
        const page = await getPageWithRetry(generationPdfDoc, pageIndex + 1, 'ocultação');
      const viewport = page.getViewport({ scale: 2.0 });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error(`Não foi possível criar contexto Canvas para a página ${pageIndex + 1}.`);

      try {
        const generationRenderTask = page.render({ canvasContext: context, viewport });
        await Promise.race([
          generationRenderTask.promise,
          new Promise((_, reject) => window.setTimeout(() => reject(new Error('Timeout ao preparar a página para ocultação.')), 20000))
        ]);
      } catch {
        throw new Error(`Não foi possível renderizar a página ${pageIndex + 1} para ocultação.`);
      }

      const boxes = pagesWithBoxes[pageIndex];
      for (const box of boxes) {
        context.fillStyle = box.color || '#000000';
        const x = box.xRatio * canvas.width;
        const y = box.yRatio * canvas.height;
        const w = box.widthRatio * canvas.width;
        const h = box.heightRatio * canvas.height;
        context.fillRect(x, y, w, h);
      }

      // Keep redacted pixels lossless: lossy JPEG can introduce ringing around
      // covered text and is inappropriate for irreversible redaction output.
      const dataUrl = canvas.toDataURL('image/png');
      const base64Data = dataUrl.split(',')[1];
      const tempPath = await window.api.saveTempFile({ base64Data, extension: 'png' });
      if (!tempPath) {
        throw new Error(`Não foi possível preparar a imagem temporária da página ${pageIndex + 1}.`);
      }
      state.redactTempPaths = [...new Set([...(state.redactTempPaths || []), tempPath])];

      redactedPages.push({
        pageIndex,
        imagePath: tempPath
      });
      }
    } finally {
      await Promise.resolve(generationPdfDoc?.destroy?.()).catch(() => {});
      await Promise.resolve(generationLoadingTask?.destroy?.()).catch(() => {});
    }

    return redactedPages;
  }

  function validateBeforeQueue() {
    if (!state.redactFile) {
      showValidationMessage('Selecione um arquivo PDF.');
      return false;
    }
    if (state.redactBoxes.length === 0) {
      showValidationMessage('Adicione pelo menos uma tarja preta.');
      return false;
    }
    const outputName = document.getElementById('redact-output-name').value.trim();
    if (!outputName) {
      showValidationMessage('Informe o nome do arquivo final.');
      return false;
    }
    return true;
  }

  function setup() {
    if (!keyboardBindingsReady) {
      keyboardBindingsReady = true;
      document.addEventListener('keydown', (event) => {
        const tab = document.getElementById('tab-redact');
        if (!tab?.classList.contains('active') || !state.redactSelectedBoxId) return;

        const target = event.target;
        const isEditableTarget = target && (
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable
        );
        if (isEditableTarget) return;

        if (event.key === 'Delete' || event.key === 'Backspace') {
          event.preventDefault();
          removeBox(state.redactSelectedBoxId);
          return;
        }

        if (event.key === 'Escape') {
          event.preventDefault();
          state.redactSelectedBoxId = '';
          renderOverlayLayer();
          renderBoxList();
        }
      });
    }

    window.addEventListener('resize', () => {
      if (state.redactFile) {
        renderOverlayLayer();
      }
    });

    document.getElementById('btn-redact-prev-page')?.addEventListener('click', async () => {
      if (!state.redactPdfDoc || state.redactCurrentPageIndex <= 0) return;
      state.redactCurrentPageIndex -= 1;
      updateFileMeta();
      resetPreviewScroll();
      try {
        await renderCurrentPage();
      } catch (error) {
        notify({ tone: 'error', title: 'Preview do PDF', message: error.message || 'Não foi possível atualizar a página.' });
      }
    });

    document.getElementById('btn-redact-next-page')?.addEventListener('click', async () => {
      if (!state.redactPdfDoc || state.redactCurrentPageIndex >= state.redactPageCount - 1) return;
      state.redactCurrentPageIndex += 1;
      updateFileMeta();
      resetPreviewScroll();
      try {
        await renderCurrentPage();
      } catch (error) {
        notify({ tone: 'error', title: 'Preview do PDF', message: error.message || 'Não foi possível atualizar a página.' });
      }
    });

    document.getElementById('btn-redact-zoom-out')?.addEventListener('click', () => {
      setPreviewZoom(previewZoom - 10);
    });

    document.getElementById('btn-redact-zoom-in')?.addEventListener('click', () => {
      setPreviewZoom(previewZoom + 10);
    });

    document.getElementById('btn-redact-zoom-reset')?.addEventListener('click', () => {
      setPreviewZoom(100);
    });

    document.getElementById('redact-zoom-range')?.addEventListener('input', (event) => {
      setPreviewZoom(event.target.value);
    });

    document.getElementById('btn-redact-change-file')?.addEventListener('click', () => {
      document.getElementById('redact-file-input')?.click();
    });

    document.getElementById('btn-redact-clear-file')?.addEventListener('click', clearWorkspace);
    document.getElementById('btn-add-redact-box')?.addEventListener('click', addRedactBox);

    document.getElementById('redact-preview-shell')?.addEventListener('pointerdown', (event) => {
      if (previewZoom <= 100 || event.button !== 0 || event.target.closest('[data-redact-box-id]')) return;
      const shell = event.currentTarget;
      panState = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startScrollLeft: shell.scrollLeft,
        startScrollTop: shell.scrollTop
      };
      shell.classList.add('redact-preview-shell--panning');
      shell.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    });

    document.getElementById('redact-preview-shell')?.addEventListener('wheel', (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      setPreviewZoom(previewZoom + (event.deltaY < 0 ? 10 : -10));
    }, { passive: false });

    window.addEventListener('pointermove', (event) => {
      if (panState) {
        const shell = document.getElementById('redact-preview-shell');
        if (!shell) return;
        shell.scrollLeft = panState.startScrollLeft - (event.clientX - panState.startX);
        shell.scrollTop = panState.startScrollTop - (event.clientY - panState.startY);
        return;
      }
      if (!dragState && !resizeState) return;

      const overlay = getOverlayLayer();
      const shell = document.getElementById('redact-preview-shell');
      if (!overlay || !shell) return;
      const canvas = getCanvas();
      const shellWidth = canvas?.clientWidth || shell.clientWidth || 1;
      const shellHeight = canvas?.clientHeight || shell.clientHeight || 1;

      if (dragState) {
        const box = state.redactBoxes.find((b) => b.id === dragState.id);
        if (!box) return;

        const deltaX = event.clientX - dragState.startX;
        const deltaY = event.clientY - dragState.startY;
        const maxX = 1 - box.widthRatio;
        const maxY = 1 - box.heightRatio;
        box.xRatio = clamp(dragState.startBoxX + (deltaX / shellWidth), 0, Math.max(0, maxX));
        box.yRatio = clamp(dragState.startBoxY + (deltaY / shellHeight), 0, Math.max(0, maxY));
        
        const element = overlay.querySelector(`[data-redact-box-id="${box.id}"]`);
        if (element) {
          element.style.left = `${box.xRatio * shellWidth}px`;
          element.style.top = `${box.yRatio * shellHeight}px`;
        }
      } else if (resizeState) {
        const box = state.redactBoxes.find((b) => b.id === resizeState.id);
        if (!box) return;

        const deltaX = event.clientX - resizeState.startX;
        const deltaY = event.clientY - resizeState.startY;
        box.widthRatio = clamp(resizeState.startWidth + (deltaX / shellWidth), 0.02, 0.98);
        box.heightRatio = clamp(resizeState.startHeight + (deltaY / shellHeight), 0.02, 0.98);
        box.xRatio = clamp(box.xRatio, 0, Math.max(0, 1 - box.widthRatio));
        box.yRatio = clamp(box.yRatio, 0, Math.max(0, 1 - box.heightRatio));
        
        const element = overlay.querySelector(`[data-redact-box-id="${box.id}"]`);
        if (element) {
          element.style.width = `${box.widthRatio * shellWidth}px`;
          element.style.height = `${box.heightRatio * shellHeight}px`;
          element.style.left = `${box.xRatio * shellWidth}px`;
          element.style.top = `${box.yRatio * shellHeight}px`;
        }
      }
    });

    const endDrag = () => {
      dragState = null;
      resizeState = null;
      const shell = document.getElementById('redact-preview-shell');
      if (shell && panState) shell.classList.remove('redact-preview-shell--panning');
      panState = null;
    };
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);

    const searchInput = document.getElementById('redact-search-input');
    const searchBtn = document.getElementById('btn-redact-search');
    if (searchBtn && searchInput) {
      searchBtn.addEventListener('click', async () => {
        const term = searchInput.value;
        await performSmartRedaction(term);
      });
      searchInput.addEventListener('keydown', async (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          const term = searchInput.value;
          await performSmartRedaction(term);
        }
      });
    }

    document.querySelectorAll('[data-redact-preset]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const preset = btn.getAttribute('data-redact-preset');
        if (searchInput) searchInput.value = preset;
        await performSmartRedaction(preset);
      });
    });

    const redactColorSelect = document.getElementById('redact-box-color');
    if (redactColorSelect) {
      redactColorSelect.addEventListener('change', () => {
        if (state.redactSelectedBoxId) {
          const box = state.redactBoxes.find((b) => b.id === state.redactSelectedBoxId);
          if (box) {
            box.color = redactColorSelect.value;
            renderOverlayLayer();
          }
        }
      });
    }

    syncVisibility();
  }

  return {
    setup,
    handleRedactFile,
    clearWorkspace,
    getPendingMessage,
    validateBeforeQueue,
    generateRedactedPagesPayload
  };
}
