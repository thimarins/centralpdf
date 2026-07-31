import { normalizeBinaryData, clamp } from '../pdf-preview-utils.js';

const SIGNATURE_FIELD_DEFAULTS = {
  signature: { widthRatio: 0.3, heightRatio: 0.08, color: '#000000', fontFamily: 'SegoeScript', opacity: 100, rotation: 0 },
  drawn: { widthRatio: 0.32, heightRatio: 0.11, color: '#000000', fontFamily: 'SegoeScript', opacity: 100, rotation: 0 },
  initials: { widthRatio: 0.14, heightRatio: 0.08, color: '#000000', fontFamily: 'SegoeScript', opacity: 100, rotation: 0 },
  date: { widthRatio: 0.2, heightRatio: 0.06, color: '#000000', fontFamily: 'CorporateSans', opacity: 100, rotation: 0 },
  text: { widthRatio: 0.28, heightRatio: 0.08, color: '#000000', fontFamily: 'CorporateSans', opacity: 100, rotation: 0 },
  seal: { widthRatio: 0.22, heightRatio: 0.12, color: '#000000', fontFamily: 'CorporateSans', opacity: 100, rotation: 0 }
};

const SIGNATURE_FONT_STACKS = {
  SegoeScript: '"Segoe Script", "Lucida Handwriting", cursive',
  LucidaHandwriting: '"Lucida Handwriting", "Segoe Script", cursive',
  MonotypeCorsiva: '"Monotype Corsiva", "Lucida Handwriting", "Segoe Script", cursive',
  SegoePrint: '"Segoe Print", "Segoe Script", cursive',
  BrushScript: '"Brush Script MT", "Segoe Script", cursive',
  CorporateSans: '"Segoe UI Variable Text", "Segoe UI", sans-serif',
  CorporateSerif: 'Georgia, "Times New Roman", serif',
  Monospace: 'Consolas, "Courier New", monospace'
};

function formatDisplayDate(value) {
  if (!value) return new Date().toLocaleDateString('pt-BR');
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString('pt-BR');
}

function isRasterizedSignatureField(field) {
  return !!field && (field.type === 'drawn' || field.type === 'seal' || (field.type === 'signature' && String(field.value || '').trim().length > 0));
}

function computePreviewFontSize(field, width, height) {
  const baseFromHeight = height * 0.52;
  const valueLength = Math.max(String(field?.value || '').trim().length, 1);
  const baseFromWidth = width / Math.min(Math.max(valueLength * 0.7, 5), 24);
  return Math.round(clamp(Math.min(baseFromHeight, baseFromWidth), 10, 56));
}

function createFieldId() {
  return `signature_field_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

export function createSignatureWorkspaceController(deps) {
  const {
    pdfjsLib,
    state,
    document,
    icon,
    notify,
    clearFeedbackBanner,
    formatBytes
  } = deps;

  let renderToken = 0;
  let loadToken = 0;
  let pdfLoadingTask = null;
  let dragState = null;
  let resizeState = null;
  let drawPadState = null;

  function getCanvas() {
    return document.getElementById('signature-preview-canvas');
  }

  function getOverlayLayer() {
    return document.getElementById('signature-overlay-layer');
  }

  function getDrawCanvas() {
    return document.getElementById('signature-draw-canvas');
  }

  function syncVisibility() {
    const hasFile = !!state.signatureFile;
    document.getElementById('signature-dropzone')?.classList.toggle('hidden', hasFile);
    document.getElementById('signature-workspace')?.classList.toggle('hidden', !hasFile);
  }

  function getCurrentPageFields() {
    return state.signatureFields.filter((field) => field.pageIndex === state.signatureCurrentPageIndex);
  }

  function ensureSelectedField() {
    if (!state.signatureFields.some((field) => field.id === state.signatureSelectedFieldId)) {
      state.signatureSelectedFieldId = state.signatureFields[0]?.id || '';
    }
  }

  function getSelectedField() {
    ensureSelectedField();
    return state.signatureFields.find((field) => field.id === state.signatureSelectedFieldId) || null;
  }

  function hasSelectedSealAsset() {
    const sealInput = document.getElementById('signature-seal-input');
    const hasInputFile = Boolean(sealInput?.files?.length);
    const hasStateFile = Boolean(state.signatureSealFile);
    const hasPreview = typeof state.signatureSealPreviewUrl === 'string' && state.signatureSealPreviewUrl.trim().length > 0;
    return hasInputFile || hasStateFile || hasPreview;
  }

  function updateFileMeta() {
    const fileName = document.getElementById('signature-file-name');
    const fileMeta = document.getElementById('signature-file-meta');
    const pageLabel = document.getElementById('signature-page-label');
    if (fileName) fileName.textContent = state.signatureFile?.name || 'arquivo.pdf';
    if (fileMeta) {
      fileMeta.textContent = state.signatureFile
        ? `${formatBytes(state.signatureFile.size)} • ${state.signaturePageCount || 0} páginas`
        : '';
    }
    if (pageLabel) {
      pageLabel.textContent = state.signaturePageCount
        ? `Página ${state.signatureCurrentPageIndex + 1} de ${state.signaturePageCount}`
        : 'Página 0 de 0';
    }

    const firstPageButton = document.getElementById('btn-signature-first-page');
    const previousPageButton = document.getElementById('btn-signature-prev-page');
    const nextPageButton = document.getElementById('btn-signature-next-page');
    const lastPageButton = document.getElementById('btn-signature-last-page');
    const hasPages = state.signaturePageCount > 0;
    const isFirstPage = !hasPages || state.signatureCurrentPageIndex <= 0;
    const isLastPage = !hasPages || state.signatureCurrentPageIndex >= state.signaturePageCount - 1;
    if (firstPageButton) firstPageButton.disabled = isFirstPage;
    if (previousPageButton) previousPageButton.disabled = isFirstPage;
    if (nextPageButton) nextPageButton.disabled = isLastPage;
    if (lastPageButton) lastPageButton.disabled = isLastPage;
  }

  function updateDrawMeta(message) {
    const meta = document.getElementById('signature-draw-meta');
    if (meta) meta.textContent = message;
  }

  function prepareDrawCanvas() {
    const canvas = getDrawCanvas();
    if (!canvas) return null;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = '#000000';
    context.lineWidth = 4;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    return { canvas, context };
  }

  function buildRasterizedSignatureDataUrl(field) {
    if (!field || !String(field.value || '').trim()) return '';
    const canvas = document.createElement('canvas');
    const width = 1400;
    const aspectRatio = clamp(field.heightRatio / Math.max(field.widthRatio, 0.05), 0.18, 0.6);
    const height = Math.max(240, Math.round(width * aspectRatio));
    const paddingX = Math.round(width * 0.08);
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext('2d');
    if (!context) return '';

    const fontStack = SIGNATURE_FONT_STACKS[field.fontFamily] || SIGNATURE_FONT_STACKS.SegoeScript;
    const fontWeight = ['MonotypeCorsiva', 'BrushScript'].includes(field.fontFamily) ? 600 : 500;
    const text = String(field.value || '').trim();
    let fontSize = Math.min(Math.round(height * 0.68), 190);

    for (; fontSize >= 34; fontSize -= 2) {
      context.font = `${fontWeight} ${fontSize}px ${fontStack}`;
      if (context.measureText(text).width <= (width - (paddingX * 2))) {
        break;
      }
    }

    context.clearRect(0, 0, width, height);
    context.font = `${fontWeight} ${fontSize}px ${fontStack}`;
    context.fillStyle = field.color || '#000000';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(text, width / 2, Math.round(height / 2) + 4);
    return canvas.toDataURL('image/png');
  }

  function syncFieldVisualAssets(field) {
    if (!field) return;
    if (field.type === 'drawn') {
      field.imagePreviewUrl = field.imageDataUrl || '';
      return;
    }
    if (field.type === 'seal') {
      field.imagePreviewUrl = field.imagePreviewUrl || field.imagePath || '';
      return;
    }
    if (isRasterizedSignatureField(field)) {
      const dataUrl = buildRasterizedSignatureDataUrl(field);
      field.imageDataUrl = dataUrl;
      field.imagePreviewUrl = dataUrl;
      return;
    }
    field.imageDataUrl = '';
    field.imagePreviewUrl = '';
  }

  function clearDrawCanvas() {
    const resources = prepareDrawCanvas();
    drawPadState = resources ? { ...resources, drawing: false, lastX: 0, lastY: 0 } : null;
    state.signatureDrawHasInk = false;
    updateDrawMeta(state.signatureDrawnDataUrl ? 'Assinatura desenhada pronta para uso.' : 'Nenhuma assinatura desenhada ainda.');
  }

  function ensureDrawPad() {
    const resources = prepareDrawCanvas();
    if (!resources) return;
    drawPadState = { ...resources, drawing: false, lastX: 0, lastY: 0 };

    const start = (event) => {
      drawPadState.drawing = true;
      const rect = drawPadState.canvas.getBoundingClientRect();
      drawPadState.lastX = (event.clientX - rect.left) * (drawPadState.canvas.width / rect.width);
      drawPadState.lastY = (event.clientY - rect.top) * (drawPadState.canvas.height / rect.height);
    };

    const move = (event) => {
      if (!drawPadState?.drawing) return;
      const rect = drawPadState.canvas.getBoundingClientRect();
      const x = (event.clientX - rect.left) * (drawPadState.canvas.width / rect.width);
      const y = (event.clientY - rect.top) * (drawPadState.canvas.height / rect.height);
      drawPadState.context.beginPath();
      drawPadState.context.moveTo(drawPadState.lastX, drawPadState.lastY);
      drawPadState.context.lineTo(x, y);
      drawPadState.context.stroke();
      drawPadState.lastX = x;
      drawPadState.lastY = y;
      state.signatureDrawHasInk = true;
      updateDrawMeta('Desenho em andamento. Clique em "Usar como assinatura" quando terminar.');
    };

    const end = () => {
      if (drawPadState) drawPadState.drawing = false;
    };

    drawPadState.canvas.onpointerdown = start;
    drawPadState.canvas.onpointermove = move;
    drawPadState.canvas.onpointerup = end;
    drawPadState.canvas.onpointerleave = end;
    drawPadState.canvas.onpointercancel = end;
  }

  function saveDrawnSignature() {
    const canvas = getDrawCanvas();
    if (!canvas || !state.signatureDrawHasInk) {
      notify({
        tone: 'warning',
        title: 'Assinatura desenhada',
        message: 'Desenhe uma assinatura antes de usar esse campo.'
      });
      return;
    }

    state.signatureDrawnDataUrl = canvas.toDataURL('image/png');
    updateDrawMeta('Assinatura desenhada salva e pronta para uso.');
    document.getElementById('signature-draw-panel').classList.add('hidden');
    addField('drawn');
  }

  function renderSelectedFieldInspector() {
    ensureSelectedField();
    const selected = getSelectedField();
    const editor = document.getElementById('signature-field-editor');
    if (!editor) return;

    if (!selected) {
      editor.innerHTML = '<div class="empty-state">Adicione um campo para começar.</div>';
      return;
    }

    const isImageField = ['seal', 'drawn'].includes(selected.type);
    editor.innerHTML = `
      <div class="settings-grid signature-field-grid">
        <div class="input-group">
          <label for="signature-field-value">Conteúdo</label>
          <input type="text" id="signature-field-value" value="${selected.type === 'date' ? formatDisplayDate(selected.value) : selected.value}" ${isImageField ? 'disabled' : ''}>
        </div>
        <div class="input-group">
          <label for="signature-field-font">Fonte</label>
          <select id="signature-field-font" ${isImageField ? 'disabled' : ''}>
            <option value="SegoeScript" ${selected.fontFamily === 'SegoeScript' ? 'selected' : ''}>Segoe Script</option>
            <option value="LucidaHandwriting" ${selected.fontFamily === 'LucidaHandwriting' ? 'selected' : ''}>Lucida Handwriting</option>
            <option value="MonotypeCorsiva" ${selected.fontFamily === 'MonotypeCorsiva' ? 'selected' : ''}>Monotype Corsiva</option>
            <option value="SegoePrint" ${selected.fontFamily === 'SegoePrint' ? 'selected' : ''}>Segoe Print</option>
            <option value="BrushScript" ${selected.fontFamily === 'BrushScript' ? 'selected' : ''}>Brush Script</option>
            <option value="CorporateSans" ${selected.fontFamily === 'CorporateSans' ? 'selected' : ''}>Corporativa limpa</option>
            <option value="CorporateSerif" ${selected.fontFamily === 'CorporateSerif' ? 'selected' : ''}>Corporativa serifada</option>
            <option value="Monospace" ${selected.fontFamily === 'Monospace' ? 'selected' : ''}>Monoespaçada</option>
          </select>
        </div>
        <div class="input-group">
          <label for="signature-field-color">Cor</label>
          <input type="color" id="signature-field-color" value="${selected.color}" ${isImageField ? 'disabled' : ''}>
        </div>
        <div class="input-group">
          <label for="signature-field-opacity">Opacidade (%)</label>
          <input type="number" id="signature-field-opacity" min="10" max="100" step="5" value="${selected.opacity}">
        </div>
        <div class="input-group">
          <label for="signature-field-width">Largura (%)</label>
          <input type="number" id="signature-field-width" min="5" max="90" step="1" value="${Math.round(selected.widthRatio * 100)}">
        </div>
        <div class="input-group">
          <label for="signature-field-height">Altura (%)</label>
          <input type="number" id="signature-field-height" min="3" max="45" step="1" value="${Math.round(selected.heightRatio * 100)}">
        </div>
        <div class="input-group">
          <label for="signature-field-rotation">Rotação (graus)</label>
          <input type="number" id="signature-field-rotation" min="-180" max="180" step="5" value="${selected.rotation}">
        </div>
        <div class="signature-editor-actions">
          <button type="button" class="btn-secondary btn-icon-label" id="btn-duplicate-signature-field" data-icon="copy">Duplicar campo</button>
          <button type="button" class="btn-secondary btn-icon-label" id="btn-apply-signature-field-all-pages" data-icon="rows-3">Aplicar em todas as páginas</button>
          <button type="button" class="btn-danger-text btn-icon-label" id="btn-remove-signature-field" data-icon="trash">Remover campo</button>
        </div>
      </div>
    `;

    document.getElementById('btn-duplicate-signature-field').innerHTML = `${icon('copy')}<span>Duplicar campo</span>`;
    document.getElementById('btn-apply-signature-field-all-pages').innerHTML = `${icon('rows-3')}<span>Aplicar em todas as páginas</span>`;
    document.getElementById('btn-remove-signature-field').innerHTML = `${icon('trash')}<span>Remover campo</span>`;

    const bind = (id, handler, eventName = 'input') => {
      const element = document.getElementById(id);
      if (!element) return;
      element.addEventListener(eventName, handler);
      if (eventName !== 'change') element.addEventListener('change', handler);
    };

    bind('signature-field-value', (event) => updateSelectedField({ value: event.target.value }));
    bind('signature-field-font', (event) => updateSelectedField({ fontFamily: event.target.value }), 'change');
    bind('signature-field-color', (event) => updateSelectedField({ color: event.target.value }));
    bind('signature-field-opacity', (event) => updateSelectedField({ opacity: clamp(Number(event.target.value) || 100, 10, 100) }));
    bind('signature-field-width', (event) => updateSelectedField({ widthRatio: clamp((Number(event.target.value) || 5) / 100, 0.05, 0.9) }));
    bind('signature-field-height', (event) => updateSelectedField({ heightRatio: clamp((Number(event.target.value) || 3) / 100, 0.03, 0.45) }));
    bind('signature-field-rotation', (event) => updateSelectedField({ rotation: clamp(Number(event.target.value) || 0, -180, 180) }));

    document.getElementById('btn-duplicate-signature-field')?.addEventListener('click', duplicateSelectedField);
    document.getElementById('btn-apply-signature-field-all-pages')?.addEventListener('click', applySelectedFieldToAllPages);
    document.getElementById('btn-remove-signature-field')?.addEventListener('click', removeSelectedField);
  }

  function updateSelectedField(patch) {
    const selected = getSelectedField();
    if (!selected) return;
    Object.assign(selected, patch);
    syncFieldVisualAssets(selected);
    renderOverlayLayer();
  }

  function duplicateSelectedField() {
    const selected = getSelectedField();
    if (!selected) return;
    const duplicate = {
      ...selected,
      id: createFieldId(),
      xRatio: clamp(selected.xRatio + 0.03, 0, 0.92)
    };
    syncFieldVisualAssets(duplicate);
    state.signatureFields.push(duplicate);
    state.signatureSelectedFieldId = duplicate.id;
    renderOverlayLayer();
  }

  function applySelectedFieldToAllPages() {
    const selected = getSelectedField();
    if (!selected || !state.signaturePageCount || state.signaturePageCount <= 1) {
      notify({
        tone: 'info',
        title: 'Assinar PDF',
        message: 'Esse documento tem apenas uma página. Não há outras páginas para replicar.'
      });
      return;
    }

    const templateId = selected.cloneSourceId || selected.id;
    state.signatureFields = state.signatureFields.filter((field) => {
      if (field.id === selected.id) return true;
      if ((field.cloneSourceId || field.id) !== templateId) return true;
      return field.pageIndex === selected.pageIndex;
    });

    for (let pageIndex = 0; pageIndex < state.signaturePageCount; pageIndex += 1) {
      if (pageIndex === selected.pageIndex) continue;
      const clone = {
        ...selected,
        id: createFieldId(),
        pageIndex,
        cloneSourceId: templateId
      };
      syncFieldVisualAssets(clone);
      state.signatureFields.push(clone);
    }

    state.signatureSelectedFieldId = selected.id;
    renderOverlayLayer();
    notify({
      tone: 'success',
      title: 'Assinatura replicada',
      message: `Campo aplicado nas ${state.signaturePageCount} páginas do documento.`
    });
  }

  function removeSelectedField() {
    const removedFieldId = state.signatureSelectedFieldId;
    if (!removedFieldId) return;
    // Cancelar qualquer interação que ainda esteja apontando para o campo removido.
    dragState = null;
    resizeState = null;
    state.signatureFields = state.signatureFields.filter((field) => field.id !== removedFieldId);
    state.signatureSelectedFieldId = state.signatureFields[0]?.id || '';
    renderOverlayLayer();
  }

  function createDefaultField(type) {
    const defaults = SIGNATURE_FIELD_DEFAULTS[type];
    const typedName = document.getElementById('signature-typed-name')?.value?.trim() || 'Assinatura';
    const initials = document.getElementById('signature-initials')?.value?.trim() || typedName.slice(0, 2).toUpperCase();
    const freeText = document.getElementById('signature-free-text')?.value?.trim() || 'Aprovado internamente';
    const dateValue = document.getElementById('signature-date-value')?.value || new Date().toISOString().slice(0, 10);

    const valueByType = {
      signature: typedName,
      drawn: '',
      initials,
      date: formatDisplayDate(dateValue),
      text: freeText,
      seal: ''
    };

    const field = {
      id: createFieldId(),
      type,
      pageIndex: state.signatureCurrentPageIndex,
      xRatio: 0.12,
      yRatio: 0.16,
      widthRatio: defaults.widthRatio,
      heightRatio: defaults.heightRatio,
      rotation: defaults.rotation,
      opacity: defaults.opacity,
      color: defaults.color,
      value: valueByType[type] || '',
      fontFamily: defaults.fontFamily,
      imagePath: type === 'seal' ? (state.signatureSealFile?.path || '') : '',
      imageDataUrl: type === 'seal'
        ? (state.signatureSealPreviewUrl || '')
        : (type === 'drawn' ? (state.signatureDrawnDataUrl || '') : ''),
      imagePreviewUrl: type === 'seal'
        ? (state.signatureSealPreviewUrl || '')
        : (type === 'drawn' ? (state.signatureDrawnDataUrl || '') : '')
    };

    syncFieldVisualAssets(field);
    return field;
  }

  function addField(type) {
    if (!state.signatureFile) return;

    if (type === 'seal' && !hasSelectedSealAsset()) {
      notify({
        tone: 'warning',
        title: 'Selo da empresa',
        message: 'Selecione primeiro uma imagem PNG ou JPG para usar como selo.'
      });
      return;
    }

    if (type === 'drawn' && !state.signatureDrawnDataUrl) {
      notify({
        tone: 'warning',
        title: 'Assinatura desenhada',
        message: 'Abra a área de desenho, assine e salve antes de adicionar esse campo.'
      });
      return;
    }

    const field = createDefaultField(type);
    state.signatureFields.push(field);
    state.signatureSelectedFieldId = field.id;
    renderOverlayLayer();
    notify({
      tone: 'success',
      title: 'Campo adicionado',
      message: 'O campo foi inserido no preview e está pronto para ajuste.'
    });
  }

  function selectField(fieldId) {
    state.signatureSelectedFieldId = fieldId;
    renderOverlayLayer();
  }

  function markSelectedFieldInOverlay() {
    const overlay = getOverlayLayer();
    if (!overlay) return;
    overlay.querySelectorAll('[data-signature-field-id]').forEach((element) => {
      element.classList.toggle('selected', element.getAttribute('data-signature-field-id') === state.signatureSelectedFieldId);
    });
  }

  function renderOverlayLayer() {
    const overlay = getOverlayLayer();
    const shell = document.getElementById('signature-preview-shell');
    const canvas = getCanvas();
    if (!overlay || !shell) return;
    ensureSelectedField();

    const shellWidth = canvas?.clientWidth || shell.clientWidth || 1;
    const shellHeight = canvas?.clientHeight || shell.clientHeight || 1;
    overlay.style.width = `${shellWidth}px`;
    overlay.style.height = `${shellHeight}px`;
    overlay.style.left = `${canvas?.offsetLeft || 16}px`;
    overlay.style.top = `${canvas?.offsetTop || 16}px`;
    const fields = getCurrentPageFields();
    overlay.innerHTML = fields.map((field) => {
      const left = field.xRatio * shellWidth;
      const top = field.yRatio * shellHeight;
      const width = field.widthRatio * shellWidth;
      const height = field.heightRatio * shellHeight;
      const selected = field.id === state.signatureSelectedFieldId;
      const commonStyle = `left:${left}px;top:${top}px;width:${width}px;height:${height}px;opacity:${field.opacity / 100};transform:rotate(${field.rotation}deg);`;
      const previewFontSize = computePreviewFontSize(field, width, height);
      const body = isRasterizedSignatureField(field) && field.imagePreviewUrl
        ? `<span class="signature-field-content"><img src="${field.imagePreviewUrl}" alt="Assinatura visual" class="signature-field-image"></span>`
        : `<span class="signature-field-content"><span class="signature-field-text signature-font-${field.fontFamily}" style="color:${field.color};font-size:${previewFontSize}px;">${field.value}</span></span>`;
      return `
        <button type="button" class="signature-field-chip${selected ? ' selected' : ''}" data-signature-field-id="${field.id}" aria-label="Campo ${field.type} ${selected ? 'selecionado' : 'não selecionado'}. Use Delete para remover." aria-pressed="${selected ? 'true' : 'false'}" style="${commonStyle}">
          ${body}
          <span class="signature-field-resize-handle" data-signature-resize-handle="${field.id}" aria-hidden="true"></span>
        </button>
      `;
    }).join('');

    overlay.querySelectorAll('[data-signature-field-id]').forEach((element) => {
      const fieldId = element.getAttribute('data-signature-field-id');
      element.addEventListener('click', (event) => {
        event.preventDefault();
        selectField(fieldId);
      });

      element.addEventListener('keydown', (event) => {
        if (event.key === 'Delete' || event.key === 'Backspace') {
          event.preventDefault();
          event.stopPropagation();
          selectField(fieldId);
          removeSelectedField();
          return;
        }

        const field = state.signatureFields.find((item) => item.id === fieldId);
        if (!field || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        const step = event.shiftKey ? 0.05 : 0.01;
        if (event.key === 'ArrowLeft') field.xRatio = clamp(field.xRatio - step, 0, 0.92);
        if (event.key === 'ArrowRight') field.xRatio = clamp(field.xRatio + step, 0, 0.92);
        if (event.key === 'ArrowUp') field.yRatio = clamp(field.yRatio - step, 0, 0.92);
        if (event.key === 'ArrowDown') field.yRatio = clamp(field.yRatio + step, 0, 0.92);
        state.signatureSelectedFieldId = fieldId;
        renderOverlayLayer();
      });

      element.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        const field = state.signatureFields.find((item) => item.id === fieldId);
        if (!field) return;
        state.signatureSelectedFieldId = fieldId;
        markSelectedFieldInOverlay();
        renderSelectedFieldInspector();
        dragState = {
          id: fieldId,
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          startFieldX: field.xRatio,
          startFieldY: field.yRatio
        };
      });

      const resizeHandle = element.querySelector('[data-signature-resize-handle]');
      if (resizeHandle) {
        resizeHandle.addEventListener('pointerdown', (event) => {
          event.preventDefault();
          event.stopPropagation();
          const field = state.signatureFields.find((item) => item.id === fieldId);
          if (!field) return;
          state.signatureSelectedFieldId = fieldId;
          markSelectedFieldInOverlay();
          renderSelectedFieldInspector();
          resizeState = {
            id: fieldId,
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            startWidth: field.widthRatio,
            startHeight: field.heightRatio
          };
        });
      }
    });

    renderSelectedFieldInspector();
  }

  async function renderCurrentPage() {
    const pdfDoc = state.signaturePdfDoc;
    if (!pdfDoc) return;
    const token = ++renderToken;
    const canvas = getCanvas();
    const shell = document.getElementById('signature-preview-shell');
    let page;
    try {
      page = await pdfDoc.getPage(state.signatureCurrentPageIndex + 1);
    } catch (error) {
      if (token !== renderToken || pdfDoc !== state.signaturePdfDoc) return;
      throw error;
    }
    const viewport = page.getViewport({ scale: 1.25 });
    const availableWidth = Math.max(320, (shell?.clientWidth || 720) - 32);
    const ratio = Math.min(1, availableWidth / viewport.width);
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
      if (token !== renderToken || pdfDoc !== state.signaturePdfDoc) return;
      throw error;
    }
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(renderCanvas, 0, 0);
    if (token !== renderToken || pdfDoc !== state.signaturePdfDoc) return;
    updateFileMeta();
    renderOverlayLayer();
  }

  async function loadPdfPreview(file) {
    const currentLoadToken = ++loadToken;
    const pdfBytes = file?.path
      ? await window.api.readFileBytes(file.path)
      : await file.arrayBuffer();
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
    if (currentLoadToken !== loadToken || state.signatureFile !== file) {
      void Promise.resolve(pdfDoc.destroy?.()).catch(() => {});
      return;
    }
    state.signaturePdfDoc = pdfDoc;
    pdfLoadingTask = null;
    state.signaturePageCount = pdfDoc.numPages;
    state.signatureCurrentPageIndex = 0;
    await renderCurrentPage();
  }

  async function handleSignatureFile(file) {
    state.signatureFile = file;
    state.signatureFields = [];
    state.signatureSelectedFieldId = '';
    syncVisibility();
    const outputName = document.getElementById('signature-output-name');
    const fileName = document.getElementById('signature-file-name');
    const fileMeta = document.getElementById('signature-file-meta');
    const fieldEditor = document.getElementById('signature-field-editor');
    if (outputName) outputName.value = `${file.name.replace(/\.pdf$/i, '')}_assinado.pdf`;
    if (fileName) fileName.textContent = file.name;
    if (fileMeta) fileMeta.textContent = formatBytes(file.size);
    if (fieldEditor) fieldEditor.innerHTML = '<div class="empty-state">Carregando preview do documento...</div>';
    try {
      await loadPdfPreview(file);
    } catch (error) {
      const message = /\.pdf$/i.test(file?.name || '')
        ? 'Não foi possível abrir este PDF para assinatura. O arquivo pode estar corrompido, incompleto ou bloqueado.'
        : 'Selecione um arquivo PDF válido para assinar.';
      notify({ tone: 'error', title: 'Assinar PDF', message, important: true });
      clearWorkspace();
    }
  }

  function clearWorkspace() {
    loadToken += 1;
    renderToken += 1;
    void Promise.resolve(pdfLoadingTask?.destroy?.()).catch(() => {});
    pdfLoadingTask = null;
    void Promise.resolve(state.signaturePdfDoc?.destroy?.()).catch(() => {});
    state.signatureFile = null;
    state.signaturePdfDoc = null;
    state.signaturePageCount = 0;
    state.signatureCurrentPageIndex = 0;
    state.signatureFields = [];
    state.signatureSelectedFieldId = '';
    state.signatureSealFile = null;
    state.signatureSealPreviewUrl = '';
    state.signatureDrawnDataUrl = '';
    state.signatureDrawHasInk = false;
    clearFeedbackBanner('signature');
    syncVisibility();
    const canvas = getCanvas();
    const context = canvas?.getContext('2d');
    if (context && canvas) {
      context.clearRect(0, 0, canvas.width, canvas.height);
    }
    const overlay = getOverlayLayer();
    if (overlay) overlay.innerHTML = '';
    const sealInput = document.getElementById('signature-seal-input');
    if (sealInput) sealInput.value = '';
    const fileInput = document.getElementById('signature-file-input');
    if (fileInput) fileInput.value = '';
    const sealFileName = document.getElementById('signature-seal-file-name');
    if (sealFileName) sealFileName.textContent = 'Nenhum arquivo selecionado.';
    const sealMeta = document.getElementById('signature-seal-meta');
    const fieldEditor = document.getElementById('signature-field-editor');
    const drawPanel = document.getElementById('signature-draw-panel');
    if (sealMeta) sealMeta.textContent = 'PNG ou JPG com fundo transparente quando possível.';
    if (fieldEditor) fieldEditor.innerHTML = '<div class="empty-state">Adicione um campo para começar.</div>';
    drawPanel?.classList.add('hidden');
    dragState = null;
    resizeState = null;
    updateFileMeta();
    updateDrawMeta('Nenhuma assinatura desenhada ainda.');
    clearDrawCanvas();
  }

  async function loadSealPreview(file) {
    if (!file) {
      state.signatureSealFile = null;
      state.signatureSealPreviewUrl = '';
      const sealFileName = document.getElementById('signature-seal-file-name');
      const sealMeta = document.getElementById('signature-seal-meta');
      if (sealFileName) sealFileName.textContent = 'Nenhum arquivo selecionado.';
      if (sealMeta) sealMeta.textContent = 'PNG ou JPG com fundo transparente quando possível.';
      return;
    }
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('Falha ao ler o selo da empresa.'));
      reader.readAsDataURL(file);
    });
    state.signatureSealFile = file;
    state.signatureSealPreviewUrl = dataUrl;
    const sealFileName = document.getElementById('signature-seal-file-name');
    const sealMeta = document.getElementById('signature-seal-meta');
    if (sealFileName) sealFileName.textContent = file.name;
    if (sealMeta) sealMeta.textContent = `${file.name} • ${formatBytes(file.size)}`;
  }

  function getPendingMessage() {
    if (state.signatureFile || state.signatureFields.length > 0 || state.signatureDrawnDataUrl) {
      return 'Há um documento ou campos configurados em Assinar PDF. Se sairmos agora, essa preparação será perdida.';
    }
    return '';
  }

  function getQueuePayload() {
    return {
      type: 'sign',
      files: [state.signatureFile.path],
      options: {
        outputName: document.getElementById('signature-output-name').value.trim(),
        outputSuffix: '_assinado',
        fields: state.signatureFields.map((field) => ({
          id: field.id,
          type: field.type,
          pageIndex: field.pageIndex,
          xRatio: field.xRatio,
          yRatio: field.yRatio,
          widthRatio: field.widthRatio,
          heightRatio: field.heightRatio,
          rotation: field.rotation,
          opacity: field.opacity,
          color: field.color,
          value: field.value,
          fontFamily: field.fontFamily,
          imagePath: field.imagePath,
          imageDataUrl: field.imageDataUrl
        }))
      }
    };
  }

  function setup() {
    const bindClick = (id, handler) => {
      const element = document.getElementById(id);
      if (!element) return;
      element.setAttribute('type', 'button');
      element.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        handler(event);
      });
    };

    window.addEventListener('resize', () => {
      if (state.signatureFile) {
        void renderCurrentPage().catch((error) => {
          notify({ tone: 'error', title: 'Assinar PDF', message: error.message || 'Não foi possível atualizar o preview.', important: true });
        });
      }
    });

    bindClick('btn-signature-prev-page', async () => {
      if (!state.signaturePdfDoc || state.signatureCurrentPageIndex <= 0) return;
      state.signatureCurrentPageIndex -= 1;
      try {
        await renderCurrentPage();
      } catch (error) {
        notify({ tone: 'error', title: 'Assinar PDF', message: error.message || 'Não foi possível atualizar o preview.', important: true });
      }
    });

    bindClick('btn-signature-next-page', async () => {
      if (!state.signaturePdfDoc || state.signatureCurrentPageIndex >= state.signaturePageCount - 1) return;
      state.signatureCurrentPageIndex += 1;
      try {
        await renderCurrentPage();
      } catch (error) {
        notify({ tone: 'error', title: 'Assinar PDF', message: error.message || 'Não foi possível atualizar o preview.', important: true });
      }
    });

    const goToPage = async (pageIndex) => {
      if (!state.signaturePdfDoc || !state.signaturePageCount) return;
      state.signatureCurrentPageIndex = Math.min(
        state.signaturePageCount - 1,
        Math.max(0, pageIndex)
      );
      try {
        await renderCurrentPage();
      } catch (error) {
        notify({ tone: 'error', title: 'Assinar PDF', message: error.message || 'Não foi possível atualizar o preview.', important: true });
      }
    };

    bindClick('btn-signature-first-page', () => goToPage(0));
    bindClick('btn-signature-last-page', () => goToPage(state.signaturePageCount - 1));

    bindClick('btn-signature-change-file', () => {
      clearWorkspace();
      document.getElementById('signature-file-input')?.click();
    });
    bindClick('btn-signature-clear-file', clearWorkspace);
    bindClick('btn-signature-seal-picker', () => {
      document.getElementById('signature-seal-input')?.click();
    });

    ['signature', 'drawn', 'initials', 'date', 'text', 'seal'].forEach((type) => {
      bindClick(`btn-add-${type}-field`, () => addField(type));
    });

    document.getElementById('signature-seal-input')?.addEventListener('change', async (event) => {
      try {
        await loadSealPreview(event.target.files?.[0] || null);
      } catch (error) {
        notify({ tone: 'error', title: 'Selo da empresa', message: error.message, important: true });
      }
    });

    const dateInput = document.getElementById('signature-date-value');
    if (dateInput) dateInput.value = new Date().toISOString().slice(0, 10);
    bindClick('btn-open-signature-draw', () => {
      document.getElementById('signature-draw-panel')?.classList.toggle('hidden');
      ensureDrawPad();
      if (!state.signatureDrawnDataUrl) {
        updateDrawMeta('Desenhe sua assinatura e clique em "Usar como assinatura".');
      }
    });
    bindClick('btn-clear-signature-draw', clearDrawCanvas);
    bindClick('btn-save-signature-draw', saveDrawnSignature);
    clearDrawCanvas();

    window.addEventListener('pointermove', (event) => {
      if (!dragState && !resizeState) return;
      const overlay = getOverlayLayer();
      const shell = document.getElementById('signature-preview-shell');
      const canvas = getCanvas();
      const shellWidth = canvas?.clientWidth || shell.clientWidth || 1;
      const shellHeight = canvas?.clientHeight || shell.clientHeight || 1;

      if (dragState) {
        const field = state.signatureFields.find((item) => item.id === dragState.id);
        if (!field) return;

        const deltaX = event.clientX - dragState.startX;
        const deltaY = event.clientY - dragState.startY;
        const maxX = 1 - field.widthRatio;
        const maxY = 1 - field.heightRatio;
        field.xRatio = clamp(dragState.startFieldX + (deltaX / shellWidth), 0.01, Math.max(0.01, maxX));
        field.yRatio = clamp(dragState.startFieldY + (deltaY / shellHeight), 0.01, Math.max(0.01, maxY));
        
        const element = overlay.querySelector(`[data-signature-field-id="${field.id}"]`);
        if (element) {
          element.style.left = `${field.xRatio * shellWidth}px`;
          element.style.top = `${field.yRatio * shellHeight}px`;
        }
      } else if (resizeState) {
        const field = state.signatureFields.find((item) => item.id === resizeState.id);
        if (!field) return;

        const deltaX = event.clientX - resizeState.startX;
        const deltaY = event.clientY - resizeState.startY;
        field.widthRatio = clamp(resizeState.startWidth + (deltaX / shellWidth), 0.05, 0.9);
        field.heightRatio = clamp(resizeState.startHeight + (deltaY / shellHeight), 0.03, 0.45);
        field.xRatio = clamp(field.xRatio, 0.01, Math.max(0.01, 1 - field.widthRatio));
        field.yRatio = clamp(field.yRatio, 0.01, Math.max(0.01, 1 - field.heightRatio));
        
        const element = overlay.querySelector(`[data-signature-field-id="${field.id}"]`);
        if (element) {
          element.style.width = `${field.widthRatio * shellWidth}px`;
          element.style.height = `${field.heightRatio * shellHeight}px`;
          element.style.left = `${field.xRatio * shellWidth}px`;
          element.style.top = `${field.yRatio * shellHeight}px`;
          
          const textNode = element.querySelector('.signature-field-text');
          if (textNode) {
            textNode.style.fontSize = `${computePreviewFontSize(field, field.widthRatio * shellWidth, field.heightRatio * shellHeight)}px`;
          }
          const widthInput = document.getElementById('signature-field-width');
          const heightInput = document.getElementById('signature-field-height');
          if (widthInput) widthInput.value = String(Math.round(field.widthRatio * 100));
          if (heightInput) heightInput.value = String(Math.round(field.heightRatio * 100));
        }
      }
    });

    const endDrag = () => {
      dragState = null;
      if (resizeState) {
        resizeState = null;
        renderSelectedFieldInspector();
      }
    };
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
  }

  return {
    setup,
    handleSignatureFile,
    clearWorkspace,
    getPendingMessage,
    getQueuePayload
  };
}
