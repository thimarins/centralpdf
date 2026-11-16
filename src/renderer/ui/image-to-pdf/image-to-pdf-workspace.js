import {
  createImagePreviewUrl,
  getImagePreviewLimit,
  revokeImagePreviewUrl,
  shouldUseOptimizedImageMode
} from "./thumbnail-service.js";
import { formatDocumentMeta } from '../document-info.js';

const SUPPORTED_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".docx", ".xlsx"]);

function getFileExtension(fileName = "") {
  const match = String(fileName).toLowerCase().match(/(\.[^.]+)$/);
  return match?.[1] || "";
}

export function createImageToPdfWorkspaceController(deps) {
  const {
    state,
    document,
    notify,
    icon,
    showFeedbackBanner,
    clearFeedbackBanner,
    buildFeedbackMessage,
    toneIcon,
    formatBytes
  } = deps;
  let keyboardBindingsReady = false;

  function isSupportedInputFile(file) {
    return SUPPORTED_EXTENSIONS.has(getFileExtension(file?.name || ""));
  }

  function isOfficeDocument(file) {
    return /\.(docx|xlsx)$/i.test(file?.name || "");
  }

  function captureUndoState() {
    state.imagePdfUndoStack.push({
      files: state.imagePdfFiles.map((file) => ({
        id: file.id,
        name: file.name,
        size: file.size,
        path: file.path,
          fileObject: file.fileObject || null,
        rotation: Number(file.rotation) || 0,
        validationStatus: file.validationStatus || "valid",
        validationMessage: file.validationMessage || "Pronto para conversão."
      })),
      outputName: document.getElementById("images-pdf-output-name")?.value || ""
    });
    if (state.imagePdfUndoStack.length > 12) {
      state.imagePdfUndoStack.shift();
    }
  }

  function updateUndoButton() {
    const button = document.getElementById("btn-images-pdf-undo");
    if (button) {
      button.disabled = state.imagePdfUndoStack.length === 0;
      button.title = state.imagePdfUndoStack.length === 0
        ? "Nada para desfazer"
        : "Desfaz a última alteração na lista de imagens";
    }
  }

  function restoreUndoState() {
    const snapshot = state.imagePdfUndoStack.pop();
    if (!snapshot) return;

    state.imagePdfFiles.forEach((file) => revokeImagePreviewUrl(file.previewUrl));
    state.imagePdfFiles = snapshot.files.map((file) => ({
      ...file,
      previewUrl: file.fileObject ? createImagePreviewUrl(file.fileObject) : "",
      fileObject: file.fileObject || null
    }));
    state.imagePdfDragIndex = null;
    state.imagePdfSelectedIndex = null;
    const outputInput = document.getElementById("images-pdf-output-name");
    if (outputInput) outputInput.value = snapshot.outputName || "";
    renderImageList();
  }

  function buildImageItem(file, index, previewEnabled) {
    return `
      <li class="action-file-item action-file-item-image${state.imagePdfSelectedIndex === index ? ' active' : ''}" draggable="true" tabindex="0" role="listitem" aria-selected="${state.imagePdfSelectedIndex === index ? 'true' : 'false'}" aria-label="Arquivo ${index + 1}: ${file.name}. Use Delete para remover." data-image-index="${index}">
        <div class="action-file-info">
          <div class="image-thumb-shell">
            ${previewEnabled && file.previewUrl && !isOfficeDocument(file)
              ? `<img src="${file.previewUrl}" alt="Pré-visualização de ${file.name}" loading="lazy" class="image-thumb-preview" style="transform: rotate(${Number(file.rotation) || 0}deg)">`
              : `<div class="image-thumb-placeholder">${icon(isOfficeDocument(file) ? "document" : "file-image", { size: 22 })}</div>`}
          </div>
          <div class="selected-file-meta">
            <span class="action-file-name" title="${file.path}">${file.name}</span>
            <span class="file-validation-status file-validation-${file.validationStatus || 'valid'}" title="${file.validationMessage || ''}">${({ pending: "Verificando…", valid: "Pronto", protected: "Protegido", invalid: "Com problema" })[file.validationStatus || 'valid'] || "Pronto"}</span>
            <span class="action-file-size">${formatDocumentMeta(formatBytes, file)}</span>
          </div>
        </div>
        <div class="action-file-controls">
          ${isOfficeDocument(file) ? "" : `
            <button class="btn-secondary btn-sm btn-icon rotate-left-icon" data-image-rotate-left="${index}" title="Girar esta imagem 90 graus para a esquerda" aria-label="Girar ${file.name} para a esquerda">${icon("rotate-cw")}</button>
            <button class="btn-secondary btn-sm btn-icon" data-image-rotate-right="${index}" title="Girar esta imagem 90 graus para a direita" aria-label="Girar ${file.name} para a direita">${icon("rotate-cw")}</button>
          `}
          <button class="btn-secondary btn-sm btn-icon" data-image-move-up="${index}" title="Mover este arquivo uma posição para cima" ${index === 0 ? "disabled" : ""}>${icon("chevronUp")}</button>
          <button class="btn-secondary btn-sm btn-icon" data-image-move-down="${index}" title="Mover este arquivo uma posição para baixo" ${index === state.imagePdfFiles.length - 1 ? "disabled" : ""}>${icon("chevronDown")}</button>
          <button class="btn-danger-text btn-sm btn-icon" data-image-remove="${index}" title="Remover este arquivo da fila">${icon("remove")}</button>
        </div>
      </li>
    `;
  }

  function updateModeHints() {
    const optimizeInput = document.getElementById("images-pdf-optimize");
    const hasOfficeDocument = state.imagePdfFiles.some((file) => isOfficeDocument(file));
    if (optimizeInput) {
      optimizeInput.disabled = hasOfficeDocument;
      if (hasOfficeDocument) optimizeInput.checked = false;
      optimizeInput.title = hasOfficeDocument
        ? "Disponível somente quando a lista contém apenas imagens."
        : "Otimiza imagens antes da conversão.";
      optimizeInput.closest(".toggle")?.classList.toggle("is-disabled", hasOfficeDocument);
    }

    const optimized = shouldUseOptimizedImageMode(state.imagePdfFiles);
    state.imagePdfOptimizedMode = optimized;
    const banner = document.getElementById("images-pdf-optimized-hint");
    if (!banner) return;

    banner.classList.toggle("hidden", !optimized);
    if (optimized) {
      banner.innerHTML = `
        ${toneIcon("info", 18)}
        <div>
          <strong>Muitas imagens detectadas.</strong>
          <span>Processando em modo otimizado para manter estabilidade.</span>
        </div>
      `;
      showFeedbackBanner({
        mode: "image-batch",
        tone: "info",
        title: "Modo otimizado",
        message: buildFeedbackMessage("safeMode", { seed: `images-${state.imagePdfFiles.length}` }),
        detail: "Pré-visualizações menores e processamento mais conservador foram ativados.",
        icon: toneIcon("info", 18)
      });
    } else {
      clearFeedbackBanner("image-batch");
    }
  }

  function syncDropzoneVisibility() {
    const hasFiles = state.imagePdfFiles.length > 0;
    document.getElementById("images-pdf-dropzone").classList.toggle("hidden", hasFiles);
    document.getElementById("images-pdf-workspace").classList.toggle("hidden", !hasFiles);
  }

  function renderImageList() {
    syncDropzoneVisibility();
    const list = document.getElementById("images-pdf-list");
    if (!list) return;

    if (state.imagePdfFiles.length === 0) {
      list.innerHTML = "";
      updateModeHints();
      return;
    }

    const previewLimit = getImagePreviewLimit(state.imagePdfFiles);
    list.innerHTML = state.imagePdfFiles
      .map((file, index) => buildImageItem(file, index, index < previewLimit))
      .join("");

    list.querySelectorAll("[data-image-remove]").forEach((button) => {
      button.addEventListener("click", () => removeImageAtIndex(Number(button.getAttribute("data-image-remove"))));
    });

    list.querySelectorAll("[data-image-move-up]").forEach((button) => {
      button.addEventListener("click", () => moveImage(Number(button.getAttribute("data-image-move-up")), -1));
    });

    list.querySelectorAll("[data-image-move-down]").forEach((button) => {
      button.addEventListener("click", () => moveImage(Number(button.getAttribute("data-image-move-down")), 1));
    });

    list.querySelectorAll("[data-image-rotate-left]").forEach((button) => {
      button.addEventListener("click", () => rotateImage(Number(button.getAttribute("data-image-rotate-left")), -90));
    });

    list.querySelectorAll("[data-image-rotate-right]").forEach((button) => {
      button.addEventListener("click", () => rotateImage(Number(button.getAttribute("data-image-rotate-right")), 90));
    });

    list.querySelectorAll("[data-image-index]").forEach((item) => {
      item.addEventListener("click", (event) => {
        if (event.target.closest("button")) return;
        state.imagePdfSelectedIndex = Number(item.getAttribute("data-image-index"));
        renderImageList();
      });

      item.addEventListener("keydown", (event) => {
        if (event.target.closest("button, input, select, textarea")) return;
        const index = Number(item.getAttribute("data-image-index"));
        if (event.key === "Delete" || event.key === "Backspace") {
          event.preventDefault();
          removeImageAtIndex(index);
          return;
        }
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          state.imagePdfSelectedIndex = index;
          renderImageList();
        }
      });

      item.addEventListener("dragstart", (event) => {
        const index = Number(item.getAttribute("data-image-index"));
        state.imagePdfDragIndex = index;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", String(index));
        item.classList.add("drag-origin");
      });

      item.addEventListener("dragover", (event) => {
        event.preventDefault();
        item.classList.add("drag-hover");
      });

      item.addEventListener("dragleave", () => {
        item.classList.remove("drag-hover");
      });

      item.addEventListener("drop", (event) => {
        event.preventDefault();
        item.classList.remove("drag-hover");
        const targetIndex = Number(item.getAttribute("data-image-index"));
        reorderImageByDrag(targetIndex);
      });

      item.addEventListener("dragend", () => {
        state.imagePdfDragIndex = null;
        list.querySelectorAll(".action-file-item-image").forEach((row) => row.classList.remove("drag-origin", "drag-hover"));
      });
    });

    updateModeHints();
    updateUndoButton();
  }

  function setSuggestedOutputName() {
    const outputInput = document.getElementById("images-pdf-output-name");
    if (!outputInput || state.imagePdfFiles.length === 0 || outputInput.value.trim()) return;

    const firstName = state.imagePdfFiles[0].name.replace(/\.(jpg|jpeg|png|docx|xlsx)$/i, "");
    outputInput.value = state.imagePdfFiles.length === 1 ? `${firstName}.pdf` : `${firstName}_arquivos.pdf`;
  }

  function addImageFiles(files) {
    const acceptedFiles = files.filter(isSupportedInputFile);
    const newEntries = [];

    acceptedFiles.forEach((file) => {
      const fileKey = file?.path || `${file?.name || "file"}:${file?.size || 0}`;
      if (!fileKey || state.imagePdfFiles.some((existing) => (existing.path || `${existing.name || "file"}:${existing.size || 0}`) === fileKey)) return;
      newEntries.push({
        id: `image_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: file.name,
        size: file.size,
        path: file.path || "",
        previewUrl: isOfficeDocument(file) ? "" : createImagePreviewUrl(file),
        fileObject: file,
        rotation: 0,
        validationStatus: file.path ? "pending" : "valid",
        validationMessage: file.path ? "Verificando arquivo…" : "Pronto para conversão local."
      });
    });

    if (newEntries.length === 0) return;
    captureUndoState();
    state.imagePdfFiles.push(...newEntries);
    setSuggestedOutputName();
    renderImageList();
    if (window.api?.preflightBatchFiles) {
      const paths = newEntries.map((file) => file.path).filter(Boolean);
      if (paths.length > 0) {
        window.api.preflightBatchFiles({ type: "files-to-pdf", files: paths })
          .then((result) => {
            const byPath = new Map((result.results || []).map((item) => [item.path, item]));
            state.imagePdfFiles.forEach((file) => {
              const validation = byPath.get(file.path);
              if (!validation) return;
              file.validationStatus = validation.status;
              file.validationMessage = validation.message;
            });
            renderImageList();
            const validations = result.results || [];
            const invalid = validations.filter((item) => item.status !== "valid");
            const valid = validations.length - invalid.length;
            if (invalid.length > 0) {
              notify({
                tone: "warning",
                title: "Arquivos adicionados com atenção",
                message: `${valid} arquivo(s) pronto(s); ${invalid.length} arquivo(s) precisam ser revisado(s).`,
                detail: invalid.slice(0, 3).map((item) => `${item.name}: ${item.message}`).join(" • "),
                important: true
              });
            } else if (valid > 0) {
              notify({ tone: "success", title: "Arquivos adicionados", message: `${valid} arquivo(s) verificado(s) e pronto(s) para conversão.` });
            }
          })
          .catch(() => {
            state.imagePdfFiles.forEach((file) => {
              if (file.validationStatus === "pending") {
                file.validationStatus = "invalid";
                file.validationMessage = "Não foi possível verificar este arquivo.";
              }
            });
            renderImageList();
          });
      }
    }
  }

  function moveImage(index, delta) {
    const targetIndex = index + delta;
    if (targetIndex < 0 || targetIndex >= state.imagePdfFiles.length) return;
    captureUndoState();
    [state.imagePdfFiles[index], state.imagePdfFiles[targetIndex]] = [state.imagePdfFiles[targetIndex], state.imagePdfFiles[index]];
    renderImageList();
  }

  function rotateImage(index, delta) {
    const item = state.imagePdfFiles[index];
    if (!item || isOfficeDocument(item)) return;
    captureUndoState();
    item.rotation = (((Number(item.rotation) || 0) + delta) % 360 + 360) % 360;
    state.imagePdfSelectedIndex = index;
    renderImageList();
  }

  function reorderImageByDrag(targetIndex) {
    const sourceIndex = state.imagePdfDragIndex;
    if (!Number.isInteger(sourceIndex) || sourceIndex === targetIndex || sourceIndex < 0 || targetIndex < 0) return;
    captureUndoState();
    const [moving] = state.imagePdfFiles.splice(sourceIndex, 1);
    state.imagePdfFiles.splice(targetIndex, 0, moving);
    renderImageList();
  }

  function removeImageAtIndex(index) {
    captureUndoState();
    const [removed] = state.imagePdfFiles.splice(index, 1);
    revokeImagePreviewUrl(removed?.previewUrl);
    if (state.imagePdfSelectedIndex === index) {
      state.imagePdfSelectedIndex = Math.min(index, state.imagePdfFiles.length - 1);
    } else if (state.imagePdfSelectedIndex > index) {
      state.imagePdfSelectedIndex -= 1;
    }
    if (state.imagePdfFiles.length === 0) {
      document.getElementById("images-pdf-output-name").value = "";
    }
    renderImageList();
  }

  function clearWorkspace({ preserveUndo = false } = {}) {
    if (preserveUndo) captureUndoState();
    state.imagePdfFiles.forEach((file) => revokeImagePreviewUrl(file.previewUrl));
    state.imagePdfFiles = [];
    state.imagePdfDragIndex = null;
    state.imagePdfOptimizedMode = false;
    if (!preserveUndo) state.imagePdfUndoStack = [];
    const outputInput = document.getElementById("images-pdf-output-name");
    if (outputInput) outputInput.value = "";
    clearFeedbackBanner("image-batch");
    renderImageList();
  }

  function getPendingMessage() {
    const outputName = document.getElementById("images-pdf-output-name")?.value?.trim() || "";
    if (state.imagePdfFiles.length > 0) {
      return "Há arquivos carregados em Converter para PDF. Se sairmos agora, essa seleção será perdida.";
    }
    if (outputName && outputName !== "imagens.pdf") {
      return "Há um nome de saída ajustado em Converter para PDF. Se sairmos agora, essa configuração será perdida.";
    }
    return "";
  }

  function setup() {
    document.getElementById("btn-images-pdf-clear")?.addEventListener("click", () => clearWorkspace({ preserveUndo: true }));
    document.getElementById("btn-images-pdf-undo")?.addEventListener("click", restoreUndoState);
    if (!keyboardBindingsReady) {
      keyboardBindingsReady = true;
      document.addEventListener("keydown", (event) => {
        const tab = document.getElementById("tab-images-to-pdf");
        if (!tab?.classList.contains("active") || state.imagePdfFiles.length === 0) return;

        const target = event.target;
        const isEditableTarget = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
        if (isEditableTarget) return;

        if (event.key === "Escape" && state.imagePdfSelectedIndex !== null) {
          event.preventDefault();
          state.imagePdfSelectedIndex = null;
          renderImageList();
          return;
        }

        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z" && !event.shiftKey) {
          event.preventDefault();
          restoreUndoState();
        }
      });
    }
    updateUndoButton();
  }

  return {
    setup,
    addImageFiles,
    rotateImage,
    clearWorkspace,
    getPendingMessage
  };
}
