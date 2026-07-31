import { WATERMARK_DEFAULTS } from "../constants.js";
import { normalizeBinaryData, clamp } from "../pdf-preview-utils.js";

const WATERMARK_PRESETS = {
  CONFIDENCIAL: { text: "CONFIDENCIAL", color: "#6e6e6e", opacity: 15, rotation: 35, position: "diagonal", fontSize: 76 },
  INTERNO: { text: "INTERNO", color: "#0f6cbd", opacity: 15, rotation: 35, position: "diagonal", fontSize: 76 },
  RASCUNHO: { text: "RASCUNHO", color: "#9a6700", opacity: 15, rotation: 35, position: "diagonal", fontSize: 76 },
  COPIA: { text: "COPIA", color: "#5b5fc7", opacity: 15, rotation: 35, position: "diagonal", fontSize: 76 }
};

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

  let cachedPdfPageImage = null;
  let cachedPdfFilePath = null;
  let previewToken = 0;

  function getPreviewCanvas() {
    return document.getElementById("watermark-preview-canvas");
  }

  function resetPdfPreviewCache() {
    previewToken += 1;
    cachedPdfPageImage = null;
    cachedPdfFilePath = null;
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
    if (state.watermarkFiles.length === 0) {
      return ""; // No files loaded, so no progress to lose
    }

    const values = getFormValues();
    const isDirty = values.kind !== "text"
      || values.text !== WATERMARK_DEFAULTS.textValue
      || values.fontFamily !== WATERMARK_DEFAULTS.fontFamily
      || values.fontSize !== WATERMARK_DEFAULTS.textSize
      || String(values.color || "").toLowerCase() !== WATERMARK_DEFAULTS.textColor.toLowerCase()
      || values.position !== WATERMARK_DEFAULTS.position
      || values.opacity !== WATERMARK_DEFAULTS.opacity
      || values.rotation !== WATERMARK_DEFAULTS.rotation
      || values.scale !== WATERMARK_DEFAULTS.scale
      || (document.getElementById("watermark-output-suffix")?.value?.trim() || "") !== WATERMARK_DEFAULTS.outputSuffix;

    // Only warn if they changed settings, loaded a watermark image, or loaded multiple files in batch
    if (state.watermarkImageFile || isDirty || state.watermarkFiles.length > 1) {
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
    cachedPdfPageImage = null;
    cachedPdfFilePath = null;
    clearPreviewState();
    renderState();
  }

  function handleFiles(files) {
    files.forEach((file) => {
      const fileKey = file?.path || `${file?.name || "file"}:${file?.size || 0}`;
      if (!state.watermarkFiles.some((existing) => (existing.path || `${existing.name || "file"}:${existing.size || 0}`) === fileKey)) {
        state.watermarkFiles.push({ name: file.name, size: file.size, path: file.path || "", fileObject: file });
      }
    });
    if (state.watermarkPreviewIndex >= state.watermarkFiles.length) {
      state.watermarkPreviewIndex = 0;
    }
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
      return;
    }

    list.innerHTML = state.watermarkFiles
      .map((file, index) => buildFileListItem(file, index, { 
        allowReorder: false, 
        total: state.watermarkFiles.length,
        isActive: index === (state.watermarkPreviewIndex || 0)
      }))
      .join("");

    list.querySelectorAll("[data-remove]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        const removeIndex = Number(button.getAttribute("data-remove"));
        state.watermarkFiles.splice(removeIndex, 1);
        if (state.watermarkPreviewIndex >= state.watermarkFiles.length) {
          state.watermarkPreviewIndex = Math.max(0, state.watermarkFiles.length - 1);
        }
        renderState();
        resetPdfPreviewCache();
        loadPdfPreviewPage();
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
        renderState();
        resetPdfPreviewCache();
        loadPdfPreviewPage();
      });
      item.addEventListener("keydown", (event) => {
        if (event.target.closest("button, input, select, textarea")) return;
        const index = Number(item.getAttribute("data-index"));
        if (event.key === "Delete" || event.key === "Backspace") {
          event.preventDefault();
          const removeButton = item.querySelector("[data-remove]");
          removeButton?.click();
          return;
        }
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          state.watermarkPreviewIndex = index;
          renderState();
          resetPdfPreviewCache();
          loadPdfPreviewPage();
        }
      });
    });

    const previewIndex = state.watermarkPreviewIndex || 0;
    const pageLabel = document.getElementById("watermark-page-label");
    if (pageLabel) {
      pageLabel.textContent = hasFiles
        ? `Item ${previewIndex + 1} de ${state.watermarkFiles.length}`
        : "Item 0 de 0";
    }

    renderPreview();
  }

  async function loadPdfPreviewPage() {
    const currentPreviewToken = ++previewToken;
    const previewIndex = state.watermarkPreviewIndex || 0;
    const currentFile = state.watermarkFiles[previewIndex];
    if (!currentFile || !pdfjsLib) return;
    const filePath = currentFile.path || currentFile.fileObject?.path || "";
    const fileObject = currentFile.fileObject || null;
    if (cachedPdfFilePath === filePath && cachedPdfPageImage) return;

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

        const canvas = getPreviewCanvas();
        if (!canvas) return;

        const offscreen = document.createElement("canvas");
        offscreen.width = canvas.width;
        offscreen.height = canvas.height;
        const offCtx = offscreen.getContext("2d");

        offCtx.fillStyle = "#ffffff";
        offCtx.fillRect(0, 0, offscreen.width, offscreen.height);

        const imgWidth = img.naturalWidth || img.width;
        const imgHeight = img.naturalHeight || img.height;
        const scale = Math.min(canvas.width / imgWidth, canvas.height / imgHeight);
        
        const drawWidth = imgWidth * scale;
        const drawHeight = imgHeight * scale;
        const xOffset = (canvas.width - drawWidth) / 2;
        const yOffset = (canvas.height - drawHeight) / 2;

        offCtx.drawImage(img, xOffset, yOffset, drawWidth, drawHeight);

        cachedPdfPageImage = offscreen;
        cachedPdfFilePath = filePath || currentFile.name || "";
        renderPreview();
        URL.revokeObjectURL(dataUrl);
      } else {
        const fileData = filePath
          ? await window.api.readFileBytes(filePath)
          : typeof fileObject?.arrayBuffer === "function"
            ? await fileObject.arrayBuffer()
            : null;
        if (!fileData) return;
        const pdf = await pdfjsLib.getDocument({ data: normalizeBinaryData(fileData) }).promise;
        const page = await pdf.getPage(1);
        const viewport = page.getViewport({ scale: 1 });

        const canvas = getPreviewCanvas();
        if (!canvas) return;

        const scale = Math.min(canvas.width / viewport.width, canvas.height / viewport.height);
        const scaledViewport = page.getViewport({ scale });

        const offscreen = document.createElement("canvas");
        offscreen.width = canvas.width;
        offscreen.height = canvas.height;
        const offCtx = offscreen.getContext("2d");
        const renderCanvas = document.createElement("canvas");
        renderCanvas.width = Math.max(1, Math.round(scaledViewport.width));
        renderCanvas.height = Math.max(1, Math.round(scaledViewport.height));
        const renderCtx = renderCanvas.getContext("2d");

        if (!offCtx || !renderCtx) return;

        renderCtx.fillStyle = "#ffffff";
        renderCtx.fillRect(0, 0, renderCanvas.width, renderCanvas.height);

        await page.render({ canvasContext: renderCtx, viewport: scaledViewport }).promise;
        if (currentPreviewToken !== previewToken || state.watermarkFiles[previewIndex] !== currentFile) return;
        offCtx.fillStyle = "#ffffff";
        offCtx.fillRect(0, 0, offscreen.width, offscreen.height);
        const xOffset = (offscreen.width - renderCanvas.width) / 2;
        const yOffset = (offscreen.height - renderCanvas.height) / 2;
        offCtx.drawImage(renderCanvas, xOffset, yOffset);

        cachedPdfPageImage = offscreen;
        cachedPdfFilePath = filePath || currentFile.name || "";
        renderPreview();
        await page.cleanup?.();
      }
    } catch (error) {
      if (currentPreviewToken !== previewToken) return;
      console.warn("Preview PDF page load failed, using fallback:", error);
      cachedPdfPageImage = null;
      cachedPdfFilePath = null;
      renderPreview();
    }
  }

  function drawPreviewPage(context, width, height) {
    if (cachedPdfPageImage) {
      context.drawImage(cachedPdfPageImage, 0, 0, width, height);
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
        ? `${state.watermarkImageFile.name} - ${formatBytes(state.watermarkImageFile.size)}`
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
      if (state.watermarkFiles.length <= 1) return;
      state.watermarkPreviewIndex = (state.watermarkPreviewIndex || 0) - 1;
      if (state.watermarkPreviewIndex < 0) {
        state.watermarkPreviewIndex = state.watermarkFiles.length - 1;
      }
      renderState();
      resetPdfPreviewCache();
      loadPdfPreviewPage();
    });

    document.getElementById("btn-watermark-next-page")?.addEventListener("click", () => {
      if (state.watermarkFiles.length <= 1) return;
      state.watermarkPreviewIndex = (state.watermarkPreviewIndex || 0) + 1;
      if (state.watermarkPreviewIndex >= state.watermarkFiles.length) {
        state.watermarkPreviewIndex = 0;
      }
      renderState();
      resetPdfPreviewCache();
      loadPdfPreviewPage();
    });

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
    validateBeforeQueue
  };
}

