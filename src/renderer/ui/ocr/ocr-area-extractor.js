export function createOcrAreaExtractor(deps) {
  const { pdfjsLib, windowApi, document, notify, getLanguage } = deps;
  const panel = document.getElementById('ocr-area-card');
  const fileSelect = document.getElementById('ocr-area-file');
  const canvas = document.getElementById('ocr-area-canvas');
  const viewport = document.getElementById('ocr-area-viewport');
  const selectionBox = document.getElementById('ocr-area-selection');
  const pageLabel = document.getElementById('ocr-area-page-label');
  const firstButton = document.getElementById('btn-ocr-area-first');
  const previousButton = document.getElementById('btn-ocr-area-prev');
  const nextButton = document.getElementById('btn-ocr-area-next');
  const lastButton = document.getElementById('btn-ocr-area-last');
  const filePrevButton = document.getElementById('btn-ocr-area-file-prev');
  const fileNextButton = document.getElementById('btn-ocr-area-file-next');
  const drawButton = document.getElementById('btn-ocr-area-draw');
  const pageButton = document.getElementById('btn-ocr-area-page');
  const extractButton = document.getElementById('btn-ocr-area-extract');
  const cancelButton = document.getElementById('btn-ocr-area-cancel');
  const copyButton = document.getElementById('btn-ocr-area-copy');
  const saveTxtButton = document.getElementById('btn-ocr-area-save-txt');
  const status = document.getElementById('ocr-area-status');
  const textOutput = document.getElementById('ocr-area-text');
  const drawHint = document.getElementById('ocr-area-draw-hint');
  const searchInput = document.getElementById('ocr-document-search-input');
  const searchButton = document.getElementById('btn-ocr-document-search');
  const searchCancelButton = document.getElementById('btn-ocr-document-search-cancel');
  const searchStatus = document.getElementById('ocr-document-search-status');
  const searchResultsList = document.getElementById('ocr-document-search-results');
  const searchHighlights = document.getElementById('ocr-area-search-highlights');
  const zoomOutButton = document.getElementById('btn-ocr-area-zoom-out');
  const zoomInButton = document.getElementById('btn-ocr-area-zoom-in');
  const zoomResetButton = document.getElementById('btn-ocr-area-zoom-reset');
  const zoomRange = document.getElementById('ocr-area-zoom-range');
  const zoomValue = document.getElementById('ocr-area-zoom-value');
  const previewScroll = document.getElementById('ocr-area-preview-scroll') || (typeof document.querySelector === 'function' ? document.querySelector('.ocr-area-preview-scroll') : null);

  let files = [];
  let loadingTask = null;
  let previewSessionId = '';
  let pdfDocument = null;
  let sourceToken = 0;
  let pageNumber = 1;
  let renderTask = null;
  let renderToken = 0;
  let dragStart = null;
  let selection = null;
  let activeRequestId = '';
  let removeProgressListener = null;
  let activeSearchRequestId = '';
  let removeSearchProgressListener = null;
  let searchResults = [];
  let previewZoom = 100;
  let baseCanvasWidth = 0;
  let baseCanvasHeight = 0;
  let autoExtractTimer = null;

  function cancelAutoExtractTimer() {
    if (autoExtractTimer) {
      clearTimeout(autoExtractTimer);
      autoExtractTimer = null;
    }
  }

  function scheduleAutoExtract(delay = 150) {
    cancelAutoExtractTimer();
    autoExtractTimer = setTimeout(() => {
      autoExtractTimer = null;
      if (selection && pdfDocument && !activeRequestId) {
        extractText();
      }
    }, delay);
  }

  function setStatus(message, tone = 'info') {
    if (!status) return;
    status.textContent = message;
    status.dataset.tone = tone;
  }

  function clearSelection() {
    cancelAutoExtractTimer();
    selection = null;
    dragStart = null;
    selectionBox?.classList.add('hidden');
    if (extractButton) extractButton.disabled = true;
    if (drawHint) drawHint.textContent = 'Arraste sobre a página para selecionar uma região.';
  }

  function syncPreviewZoom() {
    previewZoom = Math.max(50, Math.min(250, Number(previewZoom) || 100));
    if (zoomRange) {
      zoomRange.value = String(previewZoom);
      zoomRange.setAttribute('aria-valuenow', String(previewZoom));
    }
    if (zoomValue) zoomValue.textContent = `${previewZoom}%`;
    if (baseCanvasWidth && baseCanvasHeight && canvas && viewport) {
      const scale = previewZoom / 100;
      const w = Math.round(baseCanvasWidth * scale);
      const h = Math.round(baseCanvasHeight * scale);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      viewport.style.width = `${w}px`;
      viewport.style.height = `${h}px`;
    }
    renderSearchHighlights();
  }

  function setPreviewZoom(val) {
    previewZoom = Math.max(50, Math.min(250, Math.round(Number(val) / 10) * 10));
    syncPreviewZoom();
  }

  function updateNavigation() {
    const pageCount = pdfDocument?.numPages || 0;
    if (pageLabel) pageLabel.textContent = pageCount ? `Página ${pageNumber} de ${pageCount}` : 'Sem página';
    if (firstButton) firstButton.disabled = !pdfDocument || pageNumber <= 1;
    if (previousButton) previousButton.disabled = !pdfDocument || pageNumber <= 1;
    if (nextButton) nextButton.disabled = !pdfDocument || pageNumber >= pageCount;
    if (lastButton) lastButton.disabled = !pdfDocument || pageNumber >= pageCount;

    const currentIndex = Number(fileSelect?.value) || 0;
    if (filePrevButton) filePrevButton.disabled = files.length <= 1 || currentIndex <= 0;
    if (fileNextButton) fileNextButton.disabled = files.length <= 1 || currentIndex >= files.length - 1;
  }

  function setSearchStatus(message, tone = 'info') {
    if (!searchStatus) return;
    searchStatus.textContent = message;
    searchStatus.dataset.tone = tone;
  }

  function renderSearchHighlights() {
    if (!searchHighlights || !viewport || !canvas) return;
    searchHighlights.replaceChildren();
    searchResults.filter((match) => match.pageNumber === pageNumber).forEach((match) => {
      const highlight = document.createElement('div');
      highlight.className = `ocr-area-search-highlight${match.source === 'OCR' ? ' ocr-area-search-highlight--ocr' : ''}`;
      highlight.style.left = `${match.xRatio * 100}%`;
      highlight.style.top = `${match.yRatio * 100}%`;
      highlight.style.width = `${match.widthRatio * 100}%`;
      highlight.style.height = `${match.heightRatio * 100}%`;
      searchHighlights.append(highlight);
    });
  }

  function renderSearchResults() {
    if (!searchResultsList) return;
    searchResultsList.replaceChildren();
    searchResults.forEach((match, index) => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ocr-document-search-result';
      button.textContent = `Página ${match.pageNumber} · ${match.source === 'OCR' ? 'texto reconhecido' : 'texto do PDF'} · resultado ${index + 1}`;
      button.addEventListener('click', () => {
        if (!pdfDocument || match.pageNumber < 1 || match.pageNumber > pdfDocument.numPages) return;
        pageNumber = match.pageNumber;
        renderPage().then(renderSearchHighlights);
      });
      item.append(button);
      searchResultsList.append(item);
    });
  }

  function cancelActiveSearch({ invalidate = false } = {}) {
    if (!activeSearchRequestId) return;
    const requestId = activeSearchRequestId;
    windowApi.cancelPdfTextSearch?.(requestId);
    if (invalidate) {
      activeSearchRequestId = '';
      removeSearchProgressListener?.();
      removeSearchProgressListener = null;
      searchCancelButton?.classList.add('hidden');
      if (searchCancelButton) searchCancelButton.disabled = false;
      if (searchButton) searchButton.disabled = !pdfDocument;
    }
    if (!invalidate) {
      if (searchCancelButton) searchCancelButton.disabled = true;
      if (searchButton) searchButton.disabled = true;
      setSearchStatus('Cancelando a pesquisa…');
    }
  }

  function cancelActiveRequest({ invalidate: _invalidate = true } = {}) {
    cancelAutoExtractTimer();
    if (!activeRequestId) return;
    const requestId = activeRequestId;
    activeRequestId = '';
    removeProgressListener?.();
    removeProgressListener = null;
    cancelButton?.classList.add('hidden');
    if (cancelButton) cancelButton.disabled = false;
    if (extractButton) extractButton.disabled = !selection;
    setStatus('Reconhecimento cancelado. Você pode tentar novamente quando quiser.', 'info');
    return Promise.resolve(windowApi.cancelOcrAreaExtraction?.(requestId))
      .then((result) => {
        if (!result?.accepted) {
          setStatus('Não foi possível confirmar o cancelamento. Aguarde o reconhecimento terminar.', 'warning');
        }
        return result;
      })
      .catch(() => {
        setStatus('Não foi possível confirmar o cancelamento. Aguarde o reconhecimento terminar.', 'warning');
        return { accepted: false };
      });
  }

  async function destroyDocument() {
    renderToken += 1;
    renderTask?.cancel?.();
    renderTask = null;
    viewport?.classList.add('is-empty');
    if (canvas) { canvas.width = 0; canvas.height = 0; }
    const activeLoadingTask = loadingTask;
    const activeDocument = pdfDocument;
    loadingTask = null;
    pdfDocument = null;
    if (activeLoadingTask) await Promise.resolve(activeLoadingTask.destroy?.()).catch(() => {});
    else await Promise.resolve(activeDocument?.destroy?.()).catch(() => {});
    const sessionId = previewSessionId;
    previewSessionId = '';
    if (sessionId) await Promise.resolve(windowApi.closePdfPreviewRangeSession?.(sessionId)).catch(() => {});
  }

  async function renderPage() {
    if (!pdfDocument || !canvas) return;
    const token = ++renderToken;
    renderTask?.cancel?.();
    clearSelection();
    setStatus('Carregando página…');
    try {
      const page = await pdfDocument.getPage(pageNumber);
      if (token !== renderToken) return;
      const base = page.getViewport({ scale: 1 });
      const targetWidth = Math.min(820, Math.max(500, (previewScroll?.clientWidth || 740) - 36));
      const scale = Math.max(0.85, Math.min(1.8, targetWidth / base.width));
      const pageViewport = page.getViewport({ scale });
      baseCanvasWidth = Math.max(1, Math.ceil(pageViewport.width));
      baseCanvasHeight = Math.max(1, Math.ceil(pageViewport.height));
      canvas.width = baseCanvasWidth;
      canvas.height = baseCanvasHeight;
      syncPreviewZoom();
      viewport?.classList.remove('is-empty');
      const context = canvas.getContext('2d', { alpha: false });
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      renderTask = page.render({ canvasContext: context, viewport: pageViewport });
      await renderTask.promise;
      if (token !== renderToken) return;
      renderTask = null;
      updateNavigation();
      renderSearchHighlights();
      setStatus('Página pronta. Selecione uma região para reconhecer somente aquele trecho.');
    } catch (error) {
      if (error?.name === 'RenderingCancelledException') return;
      setStatus('Não foi possível mostrar esta página. Tente outra página ou carregue o PDF novamente.', 'error');
    }
  }

  async function loadSelectedFile() {
    const token = ++sourceToken;
    const entry = files[Number(fileSelect?.value)];
    cancelActiveRequest({ invalidate: true });
    cancelActiveSearch({ invalidate: true });
    searchResults = [];
    renderSearchResults();
    renderSearchHighlights();
    await destroyDocument();
    if (token !== sourceToken) return;
    if (textOutput) textOutput.value = '';
    if (copyButton) copyButton.disabled = true;
    if (saveTxtButton) saveTxtButton.disabled = true;
    clearSelection();
    pageNumber = 1;
    updateNavigation();
    if (!entry) return;
    setStatus('Abrindo PDF localmente…');
    viewport?.classList.add('is-empty');
    let ownedSessionId = '';
    let ownedTask = null;
    try {
      let loadedDoc = null;

      if (windowApi.openPdfPreviewRangeSession) {
        try {
          const preview = await windowApi.openPdfPreviewRangeSession(entry.path);
          ownedSessionId = preview?.sessionId || '';
          if (token !== sourceToken) {
            if (ownedSessionId) await windowApi.closePdfPreviewRangeSession?.(ownedSessionId);
            return;
          }
          if (preview?.sessionId && Number.isSafeInteger(preview.length) && preview.length > 0 && preview.initialData) {
            previewSessionId = ownedSessionId;
            const sessionId = ownedSessionId;
            const initialData = preview.initialData instanceof Uint8Array
              ? preview.initialData
              : new Uint8Array(preview.initialData);
            let rangeAborted = false;
            let activeTask = null;

            class LocalPdfRangeTransport extends pdfjsLib.PDFDataRangeTransport {
              constructor() {
                super(preview.length, initialData, initialData.byteLength === preview.length, preview.fileName || entry.name);
              }

              requestDataRange(begin, end) {
                if (rangeAborted || token !== sourceToken) return;
                const CHUNK_SIZE = 64 * 1024;
                (async () => {
                  try {
                    const total = end - begin;
                    const combined = new Uint8Array(total);
                    let offset = 0;
                    while (offset < total) {
                      if (rangeAborted || token !== sourceToken || loadingTask !== activeTask) return;
                      const chunkBegin = begin + offset;
                      const chunkEnd = Math.min(end, chunkBegin + CHUNK_SIZE);
                      const chunk = await windowApi.readPdfPreviewRange({ sessionId, begin: chunkBegin, end: chunkEnd });
                      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
                      if (bytes.byteLength !== chunkEnd - chunkBegin) {
                        throw new Error('O trecho recebido do PDF está incompleto.');
                      }
                      combined.set(bytes, offset);
                      offset += bytes.byteLength;
                    }
                    if (rangeAborted || token !== sourceToken || loadingTask !== activeTask) return;
                    this.onDataRange(begin, combined);
                  } catch {
                    if (rangeAborted || token !== sourceToken || loadingTask !== activeTask) return;
                    rangeAborted = true;
                    void Promise.resolve(activeTask?.destroy?.()).catch(() => {});
                  }
                })();
              }

              abort() {
                rangeAborted = true;
              }
            }

            loadingTask = pdfjsLib.getDocument({
              range: new LocalPdfRangeTransport(),
              rangeChunkSize: 64 * 1024,
              disableStream: true,
              disableAutoFetch: true,
              isEvalSupported: false,
              useWorkerFetch: false
            });
            const task = loadingTask;
            ownedTask = task;
            activeTask = task;

            loadedDoc = await Promise.race([
              task.promise,
              new Promise((_, reject) => setTimeout(() => reject(new Error('RANGE_TIMEOUT')), 5000))
            ]);
          }
        } catch {
          if (ownedTask) {
            void Promise.resolve(ownedTask.destroy?.()).catch(() => {});
            ownedTask = null;
            loadingTask = null;
          }
          if (ownedSessionId) {
            void Promise.resolve(windowApi.closePdfPreviewRangeSession?.(ownedSessionId)).catch(() => {});
            ownedSessionId = '';
            previewSessionId = '';
          }
        }
      }

      // Fallback: If range loading didn't produce a document, load file bytes directly
      if (!loadedDoc && token === sourceToken) {
        let pdfBytes = null;
        if (entry.fileObject && typeof entry.fileObject.arrayBuffer === 'function') {
          pdfBytes = await entry.fileObject.arrayBuffer();
        } else if (windowApi.readFileBytes && entry.path) {
          pdfBytes = await windowApi.readFileBytes(entry.path);
        }
        if (pdfBytes && token === sourceToken) {
          const raw = pdfBytes instanceof Uint8Array ? pdfBytes : new Uint8Array(pdfBytes);
          loadingTask = pdfjsLib.getDocument({ data: raw });
          const fallbackTask = loadingTask;
          ownedTask = fallbackTask;
          loadedDoc = await fallbackTask.promise;
        }
      }

      if (!loadedDoc) {
        throw new Error('Não foi possível carregar o documento PDF.');
      }

      if (token !== sourceToken) {
        void Promise.resolve(loadedDoc.destroy?.()).catch(() => {});
        return;
      }

      pdfDocument = loadedDoc;
      if (loadingTask !== ownedTask || token !== sourceToken) return;
      updateNavigation();
      await renderPage();
    } catch {
      if (token !== sourceToken) {
        await Promise.resolve(ownedTask?.destroy?.()).catch(() => {});
        if (ownedSessionId) await Promise.resolve(windowApi.closePdfPreviewRangeSession?.(ownedSessionId)).catch(() => {});
        return;
      }
      await Promise.resolve(ownedTask?.destroy?.()).catch(() => {});
      if (previewSessionId === ownedSessionId) previewSessionId = '';
      if (ownedSessionId) await Promise.resolve(windowApi.closePdfPreviewRangeSession?.(ownedSessionId)).catch(() => {});
      pdfDocument = null;
      if (loadingTask === ownedTask) loadingTask = null;
      viewport?.classList.add('is-empty');
      updateNavigation();
      setStatus('Não foi possível abrir este PDF para selecionar uma área. Ele pode estar corrompido, protegido, inacessível ou ter sido alterado durante a leitura.', 'error');
    }
  }

  function setFiles(entries = []) {
    sourceToken += 1;
    cancelActiveRequest({ invalidate: true });
    cancelActiveSearch({ invalidate: true });
    files = Array.isArray(entries) ? entries.filter((entry) => entry?.validation?.status === 'valid' && /\.pdf$/i.test(entry.name || '')) : [];
    fileSelect.replaceChildren();
    files.forEach((entry, index) => {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = entry.name;
      fileSelect.append(option);
    });
    panel?.classList.toggle('hidden', files.length === 0);
    searchResults = [];
    renderSearchResults();
    renderSearchHighlights();
    if (searchInput) searchInput.value = '';
    setSearchStatus('Pesquisa texto nativo e, quando necessário, reconhece páginas escaneadas localmente.');
    if (!files.length) {
      destroyDocument();
      viewport?.classList.add('is-empty');
      if (canvas) canvas.width = canvas.height = 0;
      if (textOutput) textOutput.value = '';
      if (copyButton) copyButton.disabled = true;
      if (saveTxtButton) saveTxtButton.disabled = true;
      setStatus('Adicione um PDF válido para extrair texto de uma região.');
      updateNavigation();
      return;
    }
    fileSelect.value = '0';
    loadSelectedFile();
  }

  function onPointerDown(event) {
    if (!pdfDocument || event.button !== 0) return;
    const bounds = canvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    event.preventDefault();
    dragStart = {
      x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
      bounds
    };
    selection = null;
    if (extractButton) extractButton.disabled = true;
    try { canvas.setPointerCapture?.(event.pointerId); } catch {}
    selectionBox?.classList.remove('hidden');
    selectionBox.style.left = `${dragStart.x * 100}%`;
    selectionBox.style.top = `${dragStart.y * 100}%`;
    selectionBox.style.width = '0%';
    selectionBox.style.height = '0%';
  }

  function onPointerMove(event) {
    if (!dragStart) return;
    event.preventDefault();
    const bounds = dragStart.bounds || canvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const currentX = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    const currentY = Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height));
    const left = Math.min(dragStart.x, currentX);
    const top = Math.min(dragStart.y, currentY);
    const width = Math.abs(currentX - dragStart.x);
    const height = Math.abs(currentY - dragStart.y);
    selectionBox.style.left = `${left * 100}%`;
    selectionBox.style.top = `${top * 100}%`;
    selectionBox.style.width = `${width * 100}%`;
    selectionBox.style.height = `${height * 100}%`;
  }

  function onPointerUp(event) {
    if (!dragStart) return;
    onPointerMove(event);
    const bounds = dragStart.bounds || canvas.getBoundingClientRect();
    const endX = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    const endY = Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height));
    const rawLeft = Math.min(dragStart.x, endX);
    const rawTop = Math.min(dragStart.y, endY);
    const rawWidth = Math.abs(endX - dragStart.x);
    const rawHeight = Math.abs(endY - dragStart.y);
    dragStart = null;
    try { canvas.releasePointerCapture?.(event.pointerId); } catch {}

    if (rawWidth < 0.01 || rawHeight < 0.01) {
      if (drawHint) drawHint.textContent = 'Clique e arraste sobre o texto para marcar a região desejada.';
      setStatus('Clique e arraste para desenhar o retângulo sobre o texto.');
      return;
    }
    drawButton?.classList.add('is-active');

    const x = Math.max(0, Math.min(0.995, rawLeft));
    const y = Math.max(0, Math.min(0.995, rawTop));
    const width = Math.max(0.005, Math.min(1 - x, rawWidth));
    const height = Math.max(0.005, Math.min(1 - y, rawHeight));
    selection = {
      x: Number(x.toFixed(4)),
      y: Number(y.toFixed(4)),
      width: Number(width.toFixed(4)),
      height: Number(height.toFixed(4))
    };
    selectionBox.style.left = `${selection.x * 100}%`;
    selectionBox.style.top = `${selection.y * 100}%`;
    selectionBox.style.width = `${selection.width * 100}%`;
    selectionBox.style.height = `${selection.height * 100}%`;
    selectionBox?.classList.remove('hidden');

    if (extractButton) extractButton.disabled = false;
    if (drawHint) drawHint.textContent = 'Região selecionada. O reconhecimento foi iniciado automaticamente.';
    setStatus('Região selecionada. Reconhecendo automaticamente…');
    scheduleAutoExtract(150);
  }

  function selectEntirePage() {
    if (!pdfDocument) return;
    selection = { x: 0, y: 0, width: 1, height: 1 };
    if (selectionBox) {
      selectionBox.style.left = '0%';
      selectionBox.style.top = '0%';
      selectionBox.style.width = '100%';
      selectionBox.style.height = '100%';
      selectionBox.classList.remove('hidden');
    }
    drawButton?.classList.add('is-active');
    if (extractButton) extractButton.disabled = false;
    if (drawHint) drawHint.textContent = 'Página inteira selecionada. O reconhecimento foi iniciado automaticamente.';
    setStatus('Página inteira selecionada. Reconhecendo automaticamente…');
    scheduleAutoExtract(50);
  }

  function saveTextAsTxt() {
    const text = textOutput?.value || '';
    if (!text) return;
    const entry = files[Number(fileSelect?.value)];
    const baseName = entry?.name ? entry.name.replace(/\.[^/.]+$/, '') : 'texto-ocr';
    const fileName = `${baseName}_pag${pageNumber}_reconhecido.txt`;
    try {
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      (document.body || document.documentElement).appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      notify({ tone: 'success', title: 'Texto salvo', message: `O texto foi exportado como “${fileName}”.` });
    } catch {
      setStatus('Não foi possível salvar o arquivo automaticamente. Use o botão Copiar texto.', 'warning');
    }
  }

  async function extractText() {
    cancelAutoExtractTimer();
    if (!selection || !pdfDocument) return;
    if (activeRequestId) {
      cancelActiveRequest({ invalidate: true });
    }
    const entry = files[Number(fileSelect?.value)];
    if (!entry) return;
    const requestId = crypto.randomUUID();
    activeRequestId = requestId;
    extractButton.disabled = true;
    if (textOutput) textOutput.value = '';
    if (copyButton) copyButton.disabled = true;
    if (saveTxtButton) saveTxtButton.disabled = true;
    cancelButton?.classList.remove('hidden');
    if (cancelButton) cancelButton.disabled = false;
    setStatus('Reconhecendo o trecho selecionado…');
    const unsubscribeProgress = windowApi.onOcrAreaProgress?.((payload) => {
      if (payload?.requestId !== requestId || activeRequestId !== requestId) return;
      const progress = Math.max(0, Math.min(100, Number(payload.progress) || 0));
      const stageName = payload.stageName || (progress > 5 ? `${progress}%` : 'Preparando OCR…');
      setStatus(`Reconhecendo trecho: ${stageName}`);
    });
    let progressListenerActive = typeof unsubscribeProgress === 'function';
    const releaseProgressListener = () => {
      if (!progressListenerActive) return;
      progressListenerActive = false;
      unsubscribeProgress();
      if (removeProgressListener === releaseProgressListener) removeProgressListener = null;
    };
    removeProgressListener = releaseProgressListener;
    try {
      const result = await windowApi.extractOcrTextFromArea({
        requestId,
        filePath: entry.path,
        pageNumber,
        selection,
        language: getLanguage()
      });
      if (activeRequestId !== requestId) return;
      if (result?.cancelled) {
        setStatus('Reconhecimento cancelado. Você pode tentar novamente quando quiser.', 'info');
        return;
      }
      textOutput.value = result?.text || '';
      const copyReady = Boolean(textOutput.value);
      if (copyButton) copyButton.disabled = !copyReady;
      if (saveTxtButton) saveTxtButton.disabled = !copyReady;
      if (!copyReady) {
        setStatus('Nenhum texto foi reconhecido nesta área. Tente selecionar uma região maior ou revisar o idioma.', 'warning');
      } else if (result?.source === 'native') {
        setStatus(`${result.truncated ? 'Texto do PDF extraído (resultado limitado a 20.000 caracteres).' : 'Texto do PDF extraído com sucesso.'} Confiança: 100% (leitura nativa).`, 'success');
      } else {
        setStatus(`${result.truncated ? 'Texto reconhecido (resultado limitado a 20.000 caracteres).' : 'Texto reconhecido.'} Confiança estimada: ${Math.round(Number(result.confidence) || 0)}%. Revise antes de usar.`, 'success');
      }
    } catch (error) {
      if (activeRequestId === requestId) setStatus(error?.message || 'Não foi possível reconhecer a região. Tente novamente.', 'error');
    } finally {
      releaseProgressListener();
      if (activeRequestId === requestId) {
        activeRequestId = '';
        cancelButton?.classList.add('hidden');
        if (cancelButton) cancelButton.disabled = false;
        if (extractButton) extractButton.disabled = !selection;
      }
    }
  }

  async function searchDocument() {
    if (!pdfDocument || activeSearchRequestId) return;
    const entry = files[Number(fileSelect?.value)];
    const query = searchInput?.value.trim() || '';
    if (!entry) return;
    if (!query) {
      setSearchStatus('Digite uma palavra ou frase para pesquisar.', 'warning');
      searchInput?.focus();
      return;
    }
    const requestId = crypto.randomUUID();
    activeSearchRequestId = requestId;
    searchResults = [];
    renderSearchResults();
    renderSearchHighlights();
    if (searchButton) searchButton.disabled = true;
    searchCancelButton?.classList.remove('hidden');
    setSearchStatus('Pesquisando texto nativo e páginas digitalizadas…');
    const unsubscribeSearchProgress = windowApi.onOcrSearchProgress?.((payload) => {
      if (payload?.requestId !== requestId) return;
      const progress = Math.max(0, Math.min(100, Number(payload.progress) || 0));
      const pageCount = Number(payload.totalPages) || pdfDocument?.numPages || 0;
      const currentPage = Number(payload.page) || 0;
      setSearchStatus(currentPage && pageCount ? `Pesquisando página ${currentPage} de ${pageCount}… ${progress}%` : 'Preparando a pesquisa local…');
    });
    let searchProgressListenerActive = typeof unsubscribeSearchProgress === 'function';
    const releaseSearchProgressListener = () => {
      if (!searchProgressListenerActive) return;
      searchProgressListenerActive = false;
      unsubscribeSearchProgress();
      if (removeSearchProgressListener === releaseSearchProgressListener) removeSearchProgressListener = null;
    };
    removeSearchProgressListener = releaseSearchProgressListener;
    try {
      const result = await windowApi.searchPdfText({ requestId, filePath: entry.path, query, language: getLanguage() });
      if (activeSearchRequestId !== requestId) return;
      if (result?.cancelled) {
        setSearchStatus('Pesquisa cancelada. Você pode tentar novamente quando quiser.');
        return;
      }
      searchResults = Array.isArray(result?.matches) ? result.matches : [];
      renderSearchResults();
      renderSearchHighlights();
      if (!searchResults.length) {
        setSearchStatus(`Nenhum resultado para “${query}”.`, 'warning');
        return;
      }
      const firstPage = searchResults[0].pageNumber;
      if (firstPage !== pageNumber) {
        pageNumber = firstPage;
        await renderPage();
        renderSearchHighlights();
      }
      const sourceSummary = [result.nativePages ? `${result.nativePages} com texto do PDF` : '', result.ocrPages ? `${result.ocrPages} analisadas por OCR` : ''].filter(Boolean).join('; ');
      setSearchStatus(`${searchResults.length} resultado(s) exibido(s) em ${result.scannedPages} página(s)${sourceSummary ? ` · ${sourceSummary}` : ''}${result.truncated ? '. Limite de 200 resultados atingido; resultados adicionais podem não estar listados.' : '.'}`, 'success');
    } catch (error) {
      if (activeSearchRequestId === requestId) setSearchStatus(error?.message || 'Não foi possível pesquisar este PDF. Tente novamente.', 'error');
    } finally {
      releaseSearchProgressListener();
      if (activeSearchRequestId === requestId) {
        activeSearchRequestId = '';
        searchCancelButton?.classList.add('hidden');
        if (searchCancelButton) searchCancelButton.disabled = false;
        if (searchButton) searchButton.disabled = !pdfDocument;
      }
    }
  }

  function bindEvents() {
    fileSelect?.addEventListener('change', loadSelectedFile);

    filePrevButton?.addEventListener('click', () => {
      const current = Number(fileSelect?.value) || 0;
      if (current > 0) {
        fileSelect.value = String(current - 1);
        loadSelectedFile();
      }
    });

    fileNextButton?.addEventListener('click', () => {
      const current = Number(fileSelect?.value) || 0;
      if (current < files.length - 1) {
        fileSelect.value = String(current + 1);
        loadSelectedFile();
      }
    });

    firstButton?.addEventListener('click', () => {
      if (pageNumber > 1) {
        cancelActiveRequest({ invalidate: true });
        pageNumber = 1;
        renderPage();
      }
    });

    previousButton?.addEventListener('click', () => {
      if (pageNumber > 1) {
        cancelActiveRequest({ invalidate: true });
        pageNumber -= 1;
        renderPage();
      }
    });

    nextButton?.addEventListener('click', () => {
      if (pdfDocument && pageNumber < pdfDocument.numPages) {
        cancelActiveRequest({ invalidate: true });
        pageNumber += 1;
        renderPage();
      }
    });

    lastButton?.addEventListener('click', () => {
      if (pdfDocument && pageNumber < pdfDocument.numPages) {
        cancelActiveRequest({ invalidate: true });
        pageNumber = pdfDocument.numPages;
        renderPage();
      }
    });

    zoomOutButton?.addEventListener('click', () => setPreviewZoom(previewZoom - 10));
    zoomInButton?.addEventListener('click', () => setPreviewZoom(previewZoom + 10));
    zoomResetButton?.addEventListener('click', () => setPreviewZoom(100));
    zoomRange?.addEventListener('input', (e) => setPreviewZoom(e.target.value));

    previewScroll?.addEventListener('wheel', (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      setPreviewZoom(previewZoom + (event.deltaY < 0 ? 10 : -10));
    }, { passive: false });

    drawButton?.addEventListener('click', () => {
      drawButton.classList.add('is-active');
      clearSelection();
      if (drawHint) drawHint.textContent = 'Arraste o cursor sobre o texto que deseja reconhecer.';
      setStatus('Arraste para marcar a região do documento.');
    });

    pageButton?.addEventListener('click', selectEntirePage);
    saveTxtButton?.addEventListener('click', saveTextAsTxt);

    canvas?.addEventListener('pointerdown', onPointerDown);
    canvas?.addEventListener('pointermove', onPointerMove);
    canvas?.addEventListener('pointerup', onPointerUp);
    canvas?.addEventListener('pointercancel', () => { dragStart = null; clearSelection(); });
    extractButton?.addEventListener('click', extractText);
    cancelButton?.addEventListener('click', cancelActiveRequest);
    searchButton?.addEventListener('click', searchDocument);
    searchInput?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); searchDocument(); }
    });
    searchCancelButton?.addEventListener('click', cancelActiveSearch);
    copyButton?.addEventListener('click', async () => {
      if (!textOutput?.value) return;
      try {
        await windowApi.copyText(textOutput.value);
        notify({ tone: 'success', title: 'Texto copiado', message: 'O texto reconhecido foi copiado para a área de transferência.' });
      } catch {
        setStatus('Não foi possível copiar automaticamente. Selecione o texto e copie manualmente.', 'warning');
      }
    });
    window.addEventListener('beforeunload', cancelActiveRequest);
  }

  bindEvents();
  return {
    setFiles,
    cancel: cancelActiveRequest,
    cancelAll: () => { cancelAutoExtractTimer(); cancelActiveRequest(); cancelActiveSearch(); },
    destroy: async () => { cancelAutoExtractTimer(); cancelActiveRequest(); cancelActiveSearch(); await destroyDocument(); },
    getState: () => ({ pageNumber, pageCount: pdfDocument?.numPages || 0, hasSelection: Boolean(selection), hasText: Boolean(textOutput?.value), busy: Boolean(activeRequestId), searching: Boolean(activeSearchRequestId), searchResults: searchResults.length })
  };
}
