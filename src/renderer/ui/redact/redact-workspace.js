function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

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

  function downsampleImageAsBase64(fileObject, maxDimension = 2200, quality = 0.82) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (event) => {
        const image = new Image();
        image.onload = () => {
          let width = image.width;
          let height = image.height;
          if (width > maxDimension || height > maxDimension) {
            if (width > height) {
              height = Math.round((height * maxDimension) / width);
              width = maxDimension;
            } else {
              width = Math.round((width * maxDimension) / height);
              height = maxDimension;
            }
          }
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const context = canvas.getContext('2d');
          if (!context) {
            reject(new Error('Falha ao preparar a imagem para ocultação.'));
            return;
          }
          context.fillStyle = '#ffffff';
          context.fillRect(0, 0, width, height);
          context.drawImage(image, 0, 0, width, height);
          const dataUrl = canvas.toDataURL('image/jpeg', quality);
          const commaIndex = dataUrl.indexOf(',');
          resolve(commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl);
        };
        image.onerror = (error) => reject(error);
        image.src = String(event.target?.result || '');
      };
      reader.onerror = (error) => reject(error);
      reader.readAsDataURL(fileObject);
    });
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

  function syncVisibility() {
    const hasFile = !!state.redactFile;
    document.getElementById('redact-dropzone').classList.toggle('hidden', hasFile);
    document.getElementById('redact-workspace').classList.toggle('hidden', !hasFile);
  }

  function getCurrentPageBoxes() {
    return state.redactBoxes.filter((box) => box.pageIndex === state.redactCurrentPageIndex);
  }

  function ensureSelectedBox() {
    const pageBoxes = getCurrentPageBoxes();
    if (pageBoxes.length > 0 && !pageBoxes.some((box) => box.id === state.redactSelectedBoxId)) {
      state.redactSelectedBoxId = pageBoxes[0].id;
    } else if (pageBoxes.length === 0) {
      state.redactSelectedBoxId = '';
    }
  }

  function updateFileMeta() {
    document.getElementById('redact-file-name').textContent = state.redactFile?.name || 'arquivo.pdf';
    document.getElementById('redact-file-meta').textContent = state.redactFile
      ? `${formatBytes(state.redactFile.size)} • ${state.redactPageCount || 0} páginas`
      : '';
    document.getElementById('redact-page-label').textContent = state.redactPageCount
      ? `Página ${state.redactCurrentPageIndex + 1} de ${state.redactPageCount}`
      : 'Página 0 de 0';
  }

  function renderBoxList() {
    const editor = document.getElementById('redact-field-editor');
    if (!editor) return;

    const pageBoxes = getCurrentPageBoxes();
    if (pageBoxes.length === 0) {
      editor.innerHTML = '<div class="empty-state">Nenhuma tarja preta adicionada nesta página.</div>';
      return;
    }

    editor.innerHTML = pageBoxes.map((box, index) => {
      const isSelected = box.id === state.redactSelectedBoxId;
      return `
        <div class="redact-field-item ${isSelected ? 'selected' : ''}" data-box-id="${box.id}" style="cursor: pointer; ${isSelected ? 'border-color: var(--accent-color);' : ''}">
          <span>Tarja Preta #${index + 1}</span>
          <button class="btn-danger-text btn-sm btn-icon" data-remove-box="${box.id}" title="Remover esta tarja">${icon('remove')}</button>
        </div>
      `;
    }).join('');

    editor.querySelectorAll('[data-box-id]').forEach((item) => {
      const boxId = item.getAttribute('data-box-id');
      item.addEventListener('click', (event) => {
        if (event.target.closest('[data-remove-box]')) return;
        state.redactSelectedBoxId = boxId;
        renderOverlayLayer();
        renderBoxList();
      });
    });

    editor.querySelectorAll('[data-remove-box]').forEach((button) => {
      const boxId = button.getAttribute('data-remove-box');
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        state.redactBoxes = state.redactBoxes.filter((box) => box.id !== boxId);
        if (state.redactSelectedBoxId === boxId) {
          state.redactSelectedBoxId = '';
        }
        renderOverlayLayer();
        renderBoxList();
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
        <div class="redact-box-chip${selected ? ' selected' : ''}" data-redact-box-id="${box.id}" style="${style}">
          <span class="redact-box-resize-handle" data-redact-resize-handle="${box.id}" style="${color === '#ffffff' ? 'background:#ffcc00;border:1px solid #000000;' : ''}" aria-hidden="true"></span>
        </div>
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

function normalizeBinaryData(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return new Uint8Array(data);
  if (data?.buffer instanceof ArrayBuffer) {
    return new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength || data.buffer.byteLength);
  }
  return new Uint8Array();
}

  async function renderCurrentPage() {
    const pdfDoc = state.redactPdfDoc;
    if (!pdfDoc) return;
    const token = ++renderToken;
    const canvas = getCanvas();
    const page = await pdfDoc.getPage(state.redactCurrentPageIndex + 1);
    const viewport = page.getViewport({ scale: 1.25 });
    const ratio = Math.min(1, 700 / viewport.width);
    const scaledViewport = page.getViewport({ scale: 1.25 * ratio });
    canvas.width = scaledViewport.width;
    canvas.height = scaledViewport.height;
    const context = canvas.getContext('2d');
    if (!context) return;
    const renderCanvas = document.createElement('canvas');
    renderCanvas.width = Math.max(1, Math.round(scaledViewport.width));
    renderCanvas.height = Math.max(1, Math.round(scaledViewport.height));
    const renderContext = renderCanvas.getContext('2d');
    if (!renderContext) return;
    renderContext.fillStyle = '#ffffff';
    renderContext.fillRect(0, 0, renderCanvas.width, renderCanvas.height);
    try {
      await page.render({ canvasContext: renderContext, viewport: scaledViewport }).promise;
    } catch (error) {
      if (token !== renderToken || pdfDoc !== state.redactPdfDoc) return;
      throw error;
    }
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(renderCanvas, 0, 0);
    if (token !== renderToken || pdfDoc !== state.redactPdfDoc) return;
    updateFileMeta();
    renderOverlayLayer();
    renderBoxList();
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
    const loadingTask = pdfjsLib.getDocument({ data: normalizeBinaryData(pdfBytes) });
    pdfLoadingTask = loadingTask;
    const pdfDoc = await Promise.race([
      loadingTask.promise,
      new Promise((_, reject) => setTimeout(() => {
        try {
          loadingTask.destroy?.();
        } catch (_) {}
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
      } catch (error) {
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
    document.getElementById('redact-file-meta').textContent = formatBytes(originalSize);
    document.getElementById('redact-field-editor').innerHTML = '<div class="empty-state">Carregando preview do documento...</div>';
    try {
      await loadPdfPreview(fileToLoad);
    } catch (error) {
      console.error("Failed to load PDF preview in redact workspace:", error);
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
    state.redactPageCount = 0;
    state.redactCurrentPageIndex = 0;
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

  async function performSmartRedaction(term) {
    if (!state.redactPdfDoc) return;
    const searchStatus = document.getElementById('redact-search-status');
    if (searchStatus) searchStatus.textContent = 'Buscando ocorrências...';

    let regex;
    const isPreset = ['CPF', 'CNPJ', 'TELEFONE', 'EMAIL'].includes(term);
    if (term === 'CPF') {
      regex = /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b|\b\d{11}\b/g;
    } else if (term === 'CNPJ') {
      regex = /\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b|\b\d{14}\b/g;
    } else if (term === 'TELEFONE') {
      regex = /(?:\(?\d{2}\)?\s?)?\d{4,5}[- ]?\d{4}/g;
    } else if (term === 'EMAIL') {
      regex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    } else {
      if (!term.trim()) {
        notify({ tone: 'warning', title: 'Ocultar Dados', message: 'Digite um termo para busca.' });
        if (searchStatus) searchStatus.textContent = '';
        return;
      }
      const escaped = term.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
      regex = new RegExp(escaped, 'gi');
    }

    let totalFound = 0;
    const newBoxes = [];

    notify({
      tone: 'info',
      title: 'Busca Inteligente',
      message: `Analisando todas as ${state.redactPageCount} páginas do documento...`,
      delayMs: 350
    });

    try {
      for (let pageIndex = 0; pageIndex < state.redactPageCount; pageIndex++) {
        const page = await state.redactPdfDoc.getPage(pageIndex + 1);
        const textContent = await page.getTextContent();
        const viewport = page.getViewport({ scale: 1.0 });

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
      }

      if (newBoxes.length > 0) {
        state.redactBoxes = [...state.redactBoxes, ...newBoxes];
        notify({
          tone: 'success',
          title: 'Tarjas Aplicadas',
          message: `${newBoxes.length} novas tarjas aplicadas sobre ${totalFound} ocorrências.`
        });
        await renderCurrentPage();
      } else {
        notify({
          tone: 'info',
          title: 'Nenhuma ocorrência',
          message: 'Nenhum padrão ou palavra correspondente foi encontrado no documento.'
        });
      }

      if (searchStatus) {
        searchStatus.textContent = `${totalFound} ocorrências encontradas.`;
      }
    } catch (err) {
      console.error("Smart redaction failed:", err);
      notify({ tone: 'error', title: 'Busca Inteligente', message: 'Não foi possível analisar este PDF no momento.' });
      if (searchStatus) searchStatus.textContent = 'Erro na busca.';
    }
  }

  function getPendingMessage() {
    if (state.redactFile || state.redactBoxes.length > 0) {
      return 'Há um documento ou tarjas configuradas em Ocultar Dados. Se sairmos agora, esse andamento será perdido.';
    }
    return '';
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

    for (const pageIndex of pageIndices) {
      const page = await state.redactPdfDoc.getPage(pageIndex + 1);
      const viewport = page.getViewport({ scale: 2.0 });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error(`Não foi possível criar contexto Canvas para a página ${pageIndex + 1}.`);

      await page.render({ canvasContext: context, viewport }).promise;

      const boxes = pagesWithBoxes[pageIndex];
      for (const box of boxes) {
        context.fillStyle = box.color || '#000000';
        const x = box.xRatio * canvas.width;
        const y = box.yRatio * canvas.height;
        const w = box.widthRatio * canvas.width;
        const h = box.heightRatio * canvas.height;
        context.fillRect(x, y, w, h);
      }

      const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
      const base64Data = dataUrl.split(',')[1];
      const tempPath = await window.api.saveTempFile({ base64Data, extension: 'jpg' });

      redactedPages.push({
        pageIndex,
        imagePath: tempPath
      });
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
    window.addEventListener('resize', () => {
      if (state.redactFile) {
        renderOverlayLayer();
      }
    });

    document.getElementById('btn-redact-prev-page')?.addEventListener('click', async () => {
      if (!state.redactPdfDoc || state.redactCurrentPageIndex <= 0) return;
      state.redactCurrentPageIndex -= 1;
      await renderCurrentPage();
    });

    document.getElementById('btn-redact-next-page')?.addEventListener('click', async () => {
      if (!state.redactPdfDoc || state.redactCurrentPageIndex >= state.redactPageCount - 1) return;
      state.redactCurrentPageIndex += 1;
      await renderCurrentPage();
    });

    document.getElementById('btn-redact-change-file')?.addEventListener('click', () => {
      document.getElementById('redact-file-input')?.click();
    });

    document.getElementById('btn-redact-clear-file')?.addEventListener('click', clearWorkspace);
    document.getElementById('btn-add-redact-box')?.addEventListener('click', addRedactBox);

    window.addEventListener('pointermove', (event) => {
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
