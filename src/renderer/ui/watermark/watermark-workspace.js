import { WATERMARK_DEFAULTS } from "../constants.js";
import { normalizeBinaryData, clamp } from "../pdf-preview-utils.js";
import { formatDocumentMeta } from '../document-info.js';

const WATERMARK_PRESETS = {
  CONFIDENCIAL: { text: "CONFIDENCIAL", color: "#6e6e6e", opacity: 15, rotation: 35, position: "diagonal", fontSize: 76 },
  INTERNO: { text: "INTERNO", color: "#0f6cbd", opacity: 15, rotation: 35, position: "diagonal", fontSize: 76 },
  RASCUNHO: { text: "RASCUNHO", color: "#9a6700", opacity: 15, rotation: 35, position: "diagonal", fontSize: 76 },
  COPIA: { text: "COPIA", color: "#5b5fc7", opacity: 15, rotation: 35, position: "diagonal", fontSize: 76 }
};

const PREVIEW_MAX_DIMENSION = 960;

function normalizeQuarterTurn(value) {
  const normalized = ((Number(value) || 0) % 360 + 360) % 360;
  return [0, 90, 180, 270].includes(normalized) ? normalized : 0;
}

function mapPreviewFontFamily(fontFamily) {
  if (fontFamily === "Calibri") return '700 32px Calibri, Candara, Segoe, sans-serif';
  if (fontFamily === "HelveticaBold") return '700 32px "Segoe UI Variable Text", "Segoe UI", sans-serif';
  if (fontFamily === "Helvetica") return '500 32px "Segoe UI Variable Text", "Segoe UI", sans-serif';
  if (fontFamily === "TimesRomanBold") return '700 32px Georgia, "Times New Roman", serif';
  if (fontFamily === "CourierBold") return '700 32px Consolas, "Courier New", monospace';
  return '700 32px Calibri, Candara, Segoe, sans-serif';
}

export function createWatermarkWorkspaceController(deps) {
  const {
    pdfjsLib,
    state,
    document,
    notify,
    clearFeedbackBanner,
    formatBytes,
    buildFileListItem,
    showValidationMessage
  } = deps;
  let keyboardBindingsReady = false;

  let cachedPdfPageImage = null;
  let cachedPdfFilePath = null;
  let cachedPdfPageIndex = -1;
  let cachedPdfDocument = null;
  let previewToken = 0;

  function getPreviewCanvas() {
    return document.getElementById("watermark-preview-canvas");
  }

  function resetPdfPreviewCache({ destroyDocument = true } = {}) {
    previewToken += 1;
    if (destroyDocument) {
      void Promise.resolve(cachedPdfDocument?.destroy?.()).catch(() => {});
      cachedPdfDocument = null;
      cachedPdfFilePath = null;
      state.watermarkPreviewPageCount = 0;
    }
    cachedPdfPageImage = null;
    cachedPdfPageIndex = -1;
  }

  function updatePageNavigation() {
    const fileCount = state.watermarkFiles.length;
    const fileIndex = state.watermarkPreviewIndex || 0;
    const pageCount = Math.max(1, Number(state.watermarkPreviewPageCount) || 1);
    const pageIndex = clamp(Number(state.watermarkPreviewPageIndex) || 0, 0, pageCount - 1);
    state.watermarkPreviewPageIndex = pageIndex;
    const pageLabel = document.getElementById("watermark-page-label");
    if (pageLabel) {
      pageLabel.textContent = fileCount > 0
        ? `Arquivo ${fileIndex + 1} de ${fileCount} • Página ${pageIndex + 1} de ${pageCount}`
        : "Arquivo 0 de 0 • Página 0 de 0";
    }
    const previousButton = document.getElementById("btn-watermark-prev-page");
    const nextButton = document.getElementById("btn-watermark-next-page");
    if (previousButton) {
      previousButton.disabled = fileCount === 0 || pageIndex <= 0;
      previousButton.title = "Página anterior do arquivo selecionado";
      previousButton.setAttribute("aria-label", "Ir para a página anterior do arquivo selecionado");
    }
    if (nextButton) {
      nextButton.disabled = fileCount === 0 || pageIndex >= pageCount - 1;
      nextButton.title = "Próxima página do arquivo selecionado";
      nextButton.setAttribute("aria-label", "Ir para a próxima página do arquivo selecionado");
    }
  }

  function getFormValues() {
    return {
      kind: document.querySelector('input[name="watermark-kind"]:checked')?.value || "text",
      text: document.getElementById("watermark-text-value")?.value?.trim() || WATERMARK_DEFAULTS.textValue,
      fontFamily: document.getElementById("watermark-font-family")?.value || WATERMARK_DEFAULTS.fontFamily,
      fontSize: Number(document.getElementById("watermark-font-size")?.value) || WATERMARK_DEFAULTS.textSize,
      color: document.getElementById("watermark-color")?.value || WATERMARK_DEFAULTS.textColor,
      position: document.getElementById("watermark-position")?.value || WATERMARK_DEFAULTS.position,
      opacity: Number(document.getElementById("watermark-opacity")?.value) || WATERMARK_DEFAULTS.opacity,
      rotation: Number(document.getElementById("watermark-rotation")?.value) || WATERMARK_DEFAULTS.rotation,
      scale: Number(document.getElementById("watermark-scale")?.value) || WATERMARK_DEFAULTS.scale
    };
  }

  function getPendingMessage() {
    // A single source file is already work worth protecting: leaving this tab
    // clears it together with its preview and any configured watermark values.
    if (state.watermarkFiles.length > 0 || state.watermarkImageFile) {
      return "Há arquivos ou imagem configurados em Marca d'água. Se sairmos agora, essa seleção será perdida.";
    }
    return "";
  }

  function getQueuePayload() {
    const kind = document.querySelector('input[name="watermark-kind"]:checked')?.value || "text";
    const options = {
      watermarkKind: kind,
      position: document.getElementById("watermark-position").value,
      opacity: Number(document.getElementById("watermark-opacity").value),
      rotation: Number(document.getElementById("watermark-rotation").value),
      scale: Number(document.getElementById("watermark-scale").value),
      outputSuffix: document.getElementById("watermark-output-suffix").value.trim() || WATERMARK_DEFAULTS.outputSuffix,
      numberPages: document.getElementById("watermark-number-pages")?.checked ?? false,
      createCopies: true
    };

    options.sourceRotations = state.watermarkFiles.map((file) => normalizeQuarterTurn(file.rotation));

    if (kind === "text") {
      options.text = document.getElementById("watermark-text-value").value.trim();
      options.fontFamily = document.getElementById("watermark-font-family").value;
      options.fontSize = Number(document.getElementById("watermark-font-size").value);
      options.color = document.getElementById("watermark-color").value;
    } else {
      options.imagePath = state.watermarkImageFile?.path || "";
    }

    return {
      type: "watermark",
      files: state.watermarkFiles.map((file) => file.path),
      options
    };
  }

  function clearPreviewState() {
    state.watermarkImageFile = null;
    state.watermarkPreviewImageDataUrl = "";
    state.watermarkPreviewImageElement = null;
    resetPdfPreviewCache();
    document.getElementById("watermark-image-input").value = "";
    document.getElementById("watermark-image-meta").textContent = "PNG e JPG suportados. SVG será usado quando o ambiente local permitir rasterização segura.";
    const fileNameEl = document.getElementById("watermark-image-filename");
    if (fileNameEl) {
      fileNameEl.textContent = "Nenhuma imagem selecionada";
    }
    const emptyEl = document.getElementById("watermark-image-empty");
    if (emptyEl) {
      emptyEl.classList.remove("hidden");
    }
    const previewEl = document.getElementById("watermark-image-preview");
    if (previewEl) {
      previewEl.removeAttribute("src");
      previewEl.classList.add("hidden");
    }
    clearFeedbackBanner("warning");
    renderPreview();
  }

  function clearWorkspace() {
    state.watermarkFiles = [];
    state.watermarkPreviewIndex = 0;
    state.watermarkPreviewPageIndex = 0;
    state.watermarkPreviewPageCount = 0;
    cachedPdfPageImage = null;
    cachedPdfFilePath = null;
    clearPreviewState();
    renderState();
  }

  async function handleFiles(files) {
    const addedPaths = [];
    files.forEach((file) => {
      const fileKey = file?.path || `${file?.name || "file"}:${file?.size || 0}`;
      if (!state.watermarkFiles.some((existing) => (existing.path || `${existing.name || "file"}:${existing.size || 0}`) === fileKey)) {
        state.watermarkFiles.push({
          name: file.name,
          size: file.size,
          path: file.path || "",
          fileObject: file,
          rotation: 0,
          validationStatus: file.path ? "pending" : "invalid",
          validationMessage: file.path ? "Verificando arquivo…" : "O arquivo não possui um caminho local acessível."
        });
        if (file.path) addedPaths.push(file.path);
      }
    });
    if (state.watermarkPreviewIndex >= state.watermarkFiles.length) {
      state.watermarkPreviewIndex = 0;
    }
    state.watermarkPreviewPageIndex = 0;
    state.watermarkPreviewPageCount = 0;
    renderState();
    resetPdfPreviewCache();
    loadPdfPreviewPage();

    if (addedPaths.length > 0 && window.api?.preflightBatchFiles) {
      try {
        const result = await window.api.preflightBatchFiles({ type: "watermark", files: addedPaths });
        const byPath = new Map((result.results || []).map((item) => [item.path, item]));
        state.watermarkFiles.forEach((file) => {
          const validation = byPath.get(file.path);
          if (!validation) return;
          file.validationStatus = validation.status;
          file.validationMessage = validation.message;
        });
        renderState();
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
          notify({ tone: "success", title: "Arquivos adicionados", message: `${valid} arquivo(s) verificado(s) e pronto(s) para aplicação.` });
        }
      } catch (error) {
        state.watermarkFiles.forEach((file) => {
          if (file.validationStatus === "pending") {
            file.validationStatus = "invalid";
            file.validationMessage = "Não foi possível verificar este arquivo.";
          }
        });
        renderState();
        notify({ tone: "warning", title: "Verificação não concluída", message: "Revise os arquivos marcados antes de continuar." });
      }
    }
  }

  function removeFileAtIndex(removeIndex) {
    if (!Number.isInteger(removeIndex) || removeIndex < 0 || removeIndex >= state.watermarkFiles.length) return;
    state.watermarkFiles.splice(removeIndex, 1);
    if (state.watermarkPreviewIndex >= state.watermarkFiles.length) {
      state.watermarkPreviewIndex = Math.max(0, state.watermarkFiles.length - 1);
    }
    state.watermarkPreviewPageIndex = 0;
    state.watermarkPreviewPageCount = 0;
    renderState();
    resetPdfPreviewCache();
    loadPdfPreviewPage();
  }

  function renderState() {
    const container = document.getElementById("watermark-settings-container");
    const dropzone = document.getElementById("watermark-dropzone");
    const list = document.getElementById("watermark-file-list");

    const hasFiles = state.watermarkFiles.length > 0;
    container.classList.toggle("hidden", !hasFiles);
    dropzone.classList.toggle("hidden", hasFiles);

    if (!hasFiles) {
      list.innerHTML = "";
      const pageLabel = document.getElementById("watermark-page-label");
      if (pageLabel) pageLabel.textContent = "Arquivo 0 de 0 • Página 0 de 0";
      const rotationLabel = document.getElementById("watermark-source-rotation-label");
      if (rotationLabel) rotationLabel.textContent = "Documento: 0°";
      ["btn-watermark-rotate-left", "btn-watermark-rotate-right", "btn-watermark-reset-rotation"].forEach((id) => {
        const button = document.getElementById(id);
        if (button) button.disabled = true;
      });
      renderPreview();
      return;
    }

    list.innerHTML = state.watermarkFiles
      .map((file, index) => buildFileListItem(file, index, { 
        allowReorder: false, 
        total: state.watermarkFiles.length,
        isActive: index === (state.watermarkPreviewIndex || 0),
        showValidationStatus: true
      }))
      .join("");

    list.querySelectorAll("[data-remove]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        removeFileAtIndex(Number(button.getAttribute("data-remove")));
      });
    });

    list.querySelectorAll(".action-file-item").forEach((item) => {
      item.tabIndex = 0;
      item.setAttribute("role", "listitem");
      item.setAttribute("aria-selected", item.classList.contains("active") ? "true" : "false");
      item.setAttribute("aria-label", `Arquivo ${Number(item.getAttribute("data-index")) + 1}. Use Delete para remover.`);
      item.addEventListener("click", () => {
        const index = Number(item.getAttribute("data-index"));
        state.watermarkPreviewIndex = index;
        state.watermarkPreviewPageIndex = 0;
        state.watermarkPreviewPageCount = 0;
        renderState();
        resetPdfPreviewCache();
        loadPdfPreviewPage();
      });
      item.addEventListener("keydown", (event) => {
        if (event.target.closest("button, input, select, textarea")) return;
        const index = Number(item.getAttribute("data-index"));
        if (event.key === "Delete" || event.key === "Backspace") {
          event.preventDefault();
          removeFileAtIndex(index);
          return;
        }
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          state.watermarkPreviewIndex = index;
          state.watermarkPreviewPageIndex = 0;
          state.watermarkPreviewPageCount = 0;
          renderState();
          resetPdfPreviewCache();
          loadPdfPreviewPage();
        }
      });
    });

    const previewIndex = state.watermarkPreviewIndex || 0;
    const currentFile = state.watermarkFiles[previewIndex] || null;
    const sourceRotation = normalizeQuarterTurn(currentFile?.rotation);
    updatePageNavigation();

    const rotationLabel = document.getElementById("watermark-source-rotation-label");
    if (rotationLabel) {
      rotationLabel.textContent = `Documento: ${sourceRotation}°`;
    }
    ["btn-watermark-rotate-left", "btn-watermark-rotate-right", "btn-watermark-reset-rotation"].forEach((id) => {
      const button = document.getElementById(id);
      if (button) button.disabled = !currentFile || (id === "btn-watermark-reset-rotation" && sourceRotation === 0);
    });

    renderPreview();
  }

  function rotateCurrentSource(delta) {
    const currentFile = state.watermarkFiles[state.watermarkPreviewIndex || 0];
    if (!currentFile) return;
    currentFile.rotation = normalizeQuarterTurn((currentFile.rotation || 0) + delta);
    renderState();
  }

  function resetCurrentSourceRotation() {
    const currentFile = state.watermarkFiles[state.watermarkPreviewIndex || 0];
    if (!currentFile || normalizeQuarterTurn(currentFile.rotation) === 0) return;
    currentFile.rotation = 0;
    renderState();
  }

  async function loadPdfPreviewPage() {
    const currentPreviewToken = ++previewToken;
    const previewIndex = state.watermarkPreviewIndex || 0;
    const currentFile = state.watermarkFiles[previewIndex];
    if (!currentFile || !pdfjsLib) return;
    const filePath = currentFile.path || currentFile.fileObject?.path || "";
    const fileObject = currentFile.fileObject || null;
    const previewFileKey = filePath || currentFile.name || "";
    const requestedPageIndex = Math.max(0, Number(state.watermarkPreviewPageIndex) || 0);
    if (cachedPdfFilePath === previewFileKey && cachedPdfPageIndex === requestedPageIndex && cachedPdfPageImage) return;

    const isImage = /\.(jpg|jpeg|png)$/i.test(currentFile.name || filePath);

    try {
      if (isImage) {
        const fileData = filePath
          ? await window.api.readFileBytes(filePath)
          : typeof fileObject?.arrayBuffer === "function"
            ? await fileObject.arrayBuffer()
            : null;
        if (!fileData) return;
        const blob = new Blob([normalizeBinaryData(fileData)], { type: /\.png$/i.test(currentFile.name || filePath) ? "image/png" : "image/jpeg" });
        const dataUrl = URL.createObjectURL(blob);
        
        const img = await new Promise((resolve, reject) => {
          const imageElement = new Image();
          imageElement.onload = () => resolve(imageElement);
          imageElement.onerror = () => reject(new Error("Falha ao carregar imagem"));
          imageElement.src = dataUrl;
        });
        if (currentPreviewToken !== previewToken || state.watermarkFiles[previewIndex] !== currentFile) {
          URL.revokeObjectURL(dataUrl);
          return;
        }

        const offscreen = document.createElement("canvas");
        const imgWidth = Math.max(1, img.naturalWidth || img.width || 1);
        const imgHeight = Math.max(1, img.naturalHeight || img.height || 1);
        const previewScale = Math.min(1, PREVIEW_MAX_DIMENSION / imgWidth, PREVIEW_MAX_DIMENSION / imgHeight);
        offscreen.width = Math.max(1, Math.round(imgWidth * previewScale));
        offscreen.height = Math.max(1, Math.round(imgHeight * previewScale));
        const offCtx = offscreen.getContext("2d");
        if (!offCtx) return;

        offCtx.fillStyle = "#ffffff";
        offCtx.fillRect(0, 0, offscreen.width, offscreen.height);
        offCtx.drawImage(img, 0, 0, offscreen.width, offscreen.height);

        cachedPdfPageImage = offscreen;
        cachedPdfFilePath = previewFileKey;
        cachedPdfPageIndex = 0;
        state.watermarkPreviewPageIndex = 0;
        state.watermarkPreviewPageCount = 1;
        updatePageNavigation();
        renderPreview();
        URL.revokeObjectURL(dataUrl);
      } else {
        const fileData = filePath
          ? await window.api.readFileBytes(filePath)
          : typeof fileObject?.arrayBuffer === "function"
            ? await fileObject.arrayBuffer()
            : null;
        if (!fileData) return;
        if (!cachedPdfDocument || cachedPdfFilePath !== previewFileKey) {
          await Promise.resolve(cachedPdfDocument?.destroy?.()).catch(() => {});
          cachedPdfDocument = await pdfjsLib.getDocument({ data: normalizeBinaryData(fileData) }).promise;
        }
        state.watermarkPreviewPageCount = cachedPdfDocument.numPages || 1;
        state.watermarkPreviewPageIndex = clamp(requestedPageIndex, 0, state.watermarkPreviewPageCount - 1);
        const page = await cachedPdfDocument.getPage(state.watermarkPreviewPageIndex + 1);
        const viewport = page.getViewport({ scale: 1 });

        const scale = Math.min(1.5, PREVIEW_MAX_DIMENSION / viewport.width, PREVIEW_MAX_DIMENSION / viewport.height);
        const scaledViewport = page.getViewport({ scale });

        const renderCanvas = document.createElement("canvas");
        renderCanvas.width = Math.max(1, Math.round(scaledViewport.width));
        renderCanvas.height = Math.max(1, Math.round(scaledViewport.height));
        const renderCtx = renderCanvas.getContext("2d");

        if (!renderCtx) return;

        renderCtx.fillStyle = "#ffffff";
        renderCtx.fillRect(0, 0, renderCanvas.width, renderCanvas.height);

        await page.render({ canvasContext: renderCtx, viewport: scaledViewport }).promise;
        if (currentPreviewToken !== previewToken || state.watermarkFiles[previewIndex] !== currentFile) return;

        cachedPdfPageImage = renderCanvas;
        cachedPdfFilePath = previewFileKey;
        cachedPdfPageIndex = state.watermarkPreviewPageIndex;
        updatePageNavigation();
        renderPreview();
        await page.cleanup?.();
      }
    } catch (error) {
      if (currentPreviewToken !== previewToken) return;
      console.warn("Preview PDF page load failed, using fallback:", error);
      cachedPdfPageImage = null;
      cachedPdfFilePath = null;
      cachedPdfPageIndex = -1;
      state.watermarkPreviewPageCount = 0;
      updatePageNavigation();
      renderPreview();
    }
  }

  function syncPreviewCanvasDimensions(canvas) {
    if (!cachedPdfPageImage) {
      if (canvas.width !== 720 || canvas.height !== 960) {
        canvas.width = 720;
        canvas.height = 960;
      }
      return;
    }

    const currentFile = state.watermarkFiles[state.watermarkPreviewIndex || 0];
    const rotation = normalizeQuarterTurn(currentFile?.rotation);
    const swapsAxes = rotation === 90 || rotation === 270;
    const sourceWidth = Math.max(1, cachedPdfPageImage.width || 1);
    const sourceHeight = Math.max(1, cachedPdfPageImage.height || 1);
    const rotatedWidth = swapsAxes ? sourceHeight : sourceWidth;
    const rotatedHeight = swapsAxes ? sourceWidth : sourceHeight;
    const scale = Math.min(PREVIEW_MAX_DIMENSION / rotatedWidth, PREVIEW_MAX_DIMENSION / rotatedHeight);
    const targetWidth = Math.max(1, Math.round(rotatedWidth * scale));
    const targetHeight = Math.max(1, Math.round(rotatedHeight * scale));

    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
      canvas.width = targetWidth;
      canvas.height = targetHeight;
    }
  }

  function drawSourceWithRotation(context, image, width, height, rotation) {
    context.save();
    if (rotation === 90) {
      context.translate(width, 0);
      context.rotate(Math.PI / 2);
      context.drawImage(image, 0, 0, height, width);
    } else if (rotation === 180) {
      context.translate(width, height);
      context.rotate(Math.PI);
      context.drawImage(image, 0, 0, width, height);
    } else if (rotation === 270) {
      context.translate(0, height);
      context.rotate(-Math.PI / 2);
      context.drawImage(image, 0, 0, height, width);
    } else {
      context.drawImage(image, 0, 0, width, height);
    }
    context.restore();
  }

  function drawPreviewPage(context, width, height) {
    if (cachedPdfPageImage) {
      const currentFile = state.watermarkFiles[state.watermarkPreviewIndex || 0];
      drawSourceWithRotation(context, cachedPdfPageImage, width, height, normalizeQuarterTurn(currentFile?.rotation));
      return;
    }

    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);

    context.fillStyle = "#eef1f4";
    context.fillRect(60, 64, width - 120, 28);
    context.fillRect(60, 112, width - 210, 10);
    context.fillRect(60, 134, width - 150, 10);

    context.fillStyle = "#d7dde3";
    context.fillRect(60, 190, width - 120, 1);
    context.fillRect(60, 272, width - 120, 1);
    context.fillRect(60, 354, width - 120, 1);
    context.fillRect(60, 436, width - 120, 1);
    context.fillRect(60, 518, width - 120, 1);
    context.fillRect(60, 600, width - 120, 1);
    context.fillRect(60, 682, width - 120, 1);
    context.fillRect(60, 764, width - 120, 1);

    context.fillStyle = "#eef1f4";
    for (let block = 0; block < 4; block += 1) {
      const startY = 212 + block * 164;
      for (let line = 0; line < 4; line += 1) {
        context.fillRect(60, startY + line * 14, width - 140 - (line % 2 === 0 ? 0 : 54), 8);
      }
    }
  }

  function drawRotatedText(context, text, x, y, degrees) {
    context.save();
    context.translate(x, y);
    context.rotate((-degrees * Math.PI) / 180);
    context.fillText(text, 0, 0);
    context.restore();
  }

  function drawRotatedImage(context, image, x, y, drawWidth, drawHeight, degrees) {
    context.save();
    context.translate(x, y);
    context.rotate((-degrees * Math.PI) / 180);
    context.drawImage(image, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
    context.restore();
  }

  function resolvePreviewAnchor(width, height, position) {
    if (position === "center") return { x: width / 2, y: height / 2 };
    if (position === "corner") return { x: width - 150, y: 120 };
    return { x: width / 2, y: height / 2 };
  }

  function drawTextPreview(context, width, height, values) {
    const text = values.text || WATERMARK_DEFAULTS.textValue;
    context.fillStyle = values.color || WATERMARK_DEFAULTS.textColor;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.font = mapPreviewFontFamily(values.fontFamily).replace("32px", `${Math.max(12, values.fontSize || WATERMARK_DEFAULTS.textSize)}px`);

    if (values.position === "repeated") {
      for (let y = 170; y < height - 80; y += 180) {
        for (let x = 150; x < width - 60; x += 240) {
          drawRotatedText(context, text, x, y, values.rotation);
        }
      }
      return;
    }

    const point = resolvePreviewAnchor(width, height, values.position);
    drawRotatedText(context, text, point.x, point.y, values.rotation);
  }

  function drawImagePreview(context, width, height, values, image) {
    const scaleFactor = Math.max(0.1, values.scale / 100);
    const baseWidth = Math.min(width * 0.42, image.naturalWidth || image.width || 240);
    const aspectRatio = (image.naturalHeight || image.height || 1) / (image.naturalWidth || image.width || 1);
    const drawWidth = baseWidth * scaleFactor;
    const drawHeight = drawWidth * aspectRatio;

    if (values.position === "repeated") {
      for (let y = 160; y < height - 60; y += drawHeight + 72) {
        for (let x = 120; x < width - 40; x += drawWidth + 60) {
          drawRotatedImage(context, image, x, y, drawWidth, drawHeight, values.rotation);
        }
      }
      return;
    }

    const point = resolvePreviewAnchor(width, height, values.position);
    drawRotatedImage(context, image, point.x, point.y, drawWidth, drawHeight, values.rotation);
  }

  function renderPreview() {
    const canvas = getPreviewCanvas();
    if (!canvas) return;
    syncPreviewCanvasDimensions(canvas);
    const context = canvas.getContext("2d");
    if (!context) return;

    const { width, height } = canvas;
    const values = getFormValues();

    context.clearRect(0, 0, width, height);
    drawPreviewPage(context, width, height);
    context.save();
    context.globalAlpha = clamp(values.opacity / 100, 0.05, 0.8);

    if (values.kind === "image" && state.watermarkPreviewImageElement) {
      drawImagePreview(context, width, height, values, state.watermarkPreviewImageElement);
    } else {
      drawTextPreview(context, width, height, values);
    }

    context.restore();
  }

  async function loadPreviewImage(file) {
    if (!file) {
      state.watermarkPreviewImageDataUrl = "";
      state.watermarkPreviewImageElement = null;
      const previewEl = document.getElementById("watermark-image-preview");
      if (previewEl) {
        previewEl.removeAttribute("src");
        previewEl.classList.add("hidden");
      }
      const emptyEl = document.getElementById("watermark-image-empty");
      if (emptyEl) {
        emptyEl.classList.remove("hidden");
      }
      renderPreview();
      return;
    }

    const imageDataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("Falha ao carregar preview da marca d'água."));
      reader.readAsDataURL(file);
    });

    const image = await new Promise((resolve, reject) => {
      const previewImage = new Image();
      previewImage.onload = () => resolve(previewImage);
      previewImage.onerror = () => reject(new Error("Falha ao carregar preview da marca d'água."));
      previewImage.src = imageDataUrl;
    });

    state.watermarkPreviewImageDataUrl = imageDataUrl;
    state.watermarkPreviewImageElement = image;
    const previewEl = document.getElementById("watermark-image-preview");
    if (previewEl) {
      previewEl.src = imageDataUrl;
      previewEl.classList.remove("hidden");
    }
    const emptyEl = document.getElementById("watermark-image-empty");
    if (emptyEl) {
      emptyEl.classList.add("hidden");
    }
    renderPreview();
  }

  function setWatermarkKind(kind) {
    const textSettings = document.getElementById("watermark-text-settings");
    const imageSettings = document.getElementById("watermark-image-settings");
    const textRadio = document.querySelector('input[name="watermark-kind"][value="text"]');
    const imageRadio = document.querySelector('input[name="watermark-kind"][value="image"]');

    if (textRadio) textRadio.checked = kind === "text";
    if (imageRadio) imageRadio.checked = kind === "image";
    if (textSettings) textSettings.classList.toggle("hidden", kind !== "text");
    if (imageSettings) imageSettings.classList.toggle("hidden", kind !== "image");
  }

  function applyPreset(name) {
    const preset = WATERMARK_PRESETS[name];
    if (!preset) return;
    document.getElementById("watermark-text-value").value = preset.text;
    document.getElementById("watermark-color").value = preset.color;
    document.getElementById("watermark-opacity").value = String(preset.opacity);
    document.getElementById("watermark-rotation").value = String(preset.rotation);
    document.getElementById("watermark-position").value = preset.position;
    document.getElementById("watermark-font-size").value = String(preset.fontSize);
    renderPreview();
  }

  function validateBeforeQueue() {
    if (state.watermarkFiles.length === 0) {
      showValidationMessage("Selecione pelo menos um arquivo (PDF ou imagem).");
      return false;
    }

    const kind = document.querySelector('input[name="watermark-kind"]:checked')?.value || "text";
    if (kind === "text" && !document.getElementById("watermark-text-value").value.trim()) {
      showValidationMessage("Informe o texto da marca d'água.");
      return false;
    }

    if (kind === "image" && !state.watermarkImageFile) {
      showValidationMessage("Selecione a imagem da marca d'água.");
      return false;
    }

    return true;
  }

  function setup() {
    if (!keyboardBindingsReady) {
      keyboardBindingsReady = true;
      document.addEventListener("keydown", (event) => {
        const tab = document.getElementById("tab-watermark");
        if (!tab?.classList.contains("active") || state.watermarkFiles.length === 0) return;

        const target = event.target;
        const isEditableTarget = target && (
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable
        );
        if (isEditableTarget) return;

        if (event.key === "Delete" || event.key === "Backspace") {
          event.preventDefault();
          removeFileAtIndex(state.watermarkPreviewIndex || 0);
          return;
        }
        if (event.key === "ArrowLeft" && (state.watermarkPreviewPageIndex || 0) > 0) {
          event.preventDefault();
          state.watermarkPreviewPageIndex -= 1;
          resetPdfPreviewCache({ destroyDocument: false });
          loadPdfPreviewPage();
          return;
        }
        const pageCount = Math.max(1, Number(state.watermarkPreviewPageCount) || 1);
        if (event.key === "ArrowRight" && (state.watermarkPreviewPageIndex || 0) < pageCount - 1) {
          event.preventDefault();
          state.watermarkPreviewPageIndex += 1;
          resetPdfPreviewCache({ destroyDocument: false });
          loadPdfPreviewPage();
        }
      });
    }

    document.querySelectorAll('input[name="watermark-kind"]').forEach((radio) => {
      radio.addEventListener("change", (event) => {
        const kind = event.target.value;
        setWatermarkKind(kind);
        renderPreview();
      });
    });

    document.querySelectorAll("[data-watermark-preset]").forEach((button) => {
      button.addEventListener("click", () => applyPreset(button.getAttribute("data-watermark-preset")));
    });

    [
      "watermark-text-value",
      "watermark-font-family",
      "watermark-font-size",
      "watermark-color",
      "watermark-position",
      "watermark-opacity",
      "watermark-rotation",
      "watermark-scale"
    ].forEach((id) => {
      const element = document.getElementById(id);
      if (!element) return;
      element.addEventListener("input", renderPreview);
      element.addEventListener("change", renderPreview);
    });

    document.getElementById("watermark-image-trigger")?.addEventListener("click", () => {
      document.getElementById("watermark-image-input")?.click();
    });

    document.getElementById("watermark-image-input")?.addEventListener("change", async (event) => {
      state.watermarkImageFile = event.target.files?.[0] || null;
      const imageMeta = document.getElementById("watermark-image-meta");
      const fileNameEl = document.getElementById("watermark-image-filename");
      if (fileNameEl) {
        fileNameEl.textContent = state.watermarkImageFile?.name || "Nenhuma imagem selecionada";
      }
      if (imageMeta) imageMeta.textContent = state.watermarkImageFile
        ? formatDocumentMeta(formatBytes, state.watermarkImageFile)
        : "PNG e JPG suportados. SVG será usado quando o ambiente local permitir rasterização segura.";
      try {
        if (state.watermarkImageFile) {
          setWatermarkKind("image");
        }
        await loadPreviewImage(state.watermarkImageFile);
      } catch (error) {
        notify({
          tone: "error",
          title: "Preview da marca d'água",
          message: error.message,
          important: true
        });
        clearPreviewState();
      }
    });

    document.getElementById("btn-watermark-prev-page")?.addEventListener("click", () => {
      if (!state.watermarkFiles.length || (state.watermarkPreviewPageIndex || 0) <= 0) return;
      state.watermarkPreviewPageIndex -= 1;
      resetPdfPreviewCache({ destroyDocument: false });
      loadPdfPreviewPage();
    });

    document.getElementById("btn-watermark-next-page")?.addEventListener("click", () => {
      const pageCount = Math.max(1, Number(state.watermarkPreviewPageCount) || 1);
      if (!state.watermarkFiles.length || (state.watermarkPreviewPageIndex || 0) >= pageCount - 1) return;
      state.watermarkPreviewPageIndex += 1;
      resetPdfPreviewCache({ destroyDocument: false });
      loadPdfPreviewPage();
    });

    document.getElementById("btn-watermark-rotate-left")?.addEventListener("click", () => rotateCurrentSource(-90));
    document.getElementById("btn-watermark-rotate-right")?.addEventListener("click", () => rotateCurrentSource(90));
    document.getElementById("btn-watermark-reset-rotation")?.addEventListener("click", resetCurrentSourceRotation);

    renderState();
    setWatermarkKind(document.querySelector('input[name="watermark-kind"]:checked')?.value || "text");
    renderPreview();
  }

  return {
    setup,
    handleFiles,
    renderState,
    renderPreview,
    getFormValues,
    getPendingMessage,
    getQueuePayload,
    clearPreviewState,
    clearWorkspace,
    validateBeforeQueue,
    rotateCurrentSource,
    resetCurrentSourceRotation
  };
}
