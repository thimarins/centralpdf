import { fluentIcon, fluentToneIcon } from "../icons/fluent-icons.js";

function normalizeTone(tone) {
  if (["success", "warning", "error", "info"].includes(tone)) return tone;
  return "info";
}

export function createToastCenter(container) {
  if (!container) {
    return {
      notify() {},
      clear() {},
      clearAll() {}
    };
  }

  const activeToasts = new Map();
  const pendingToasts = new Map();

  function syncSpotlightState() {
    const hasSpotlight = [...activeToasts.values()].some((record) => record?.isSpotlight);
    document.body.classList.toggle("toast-spotlight-open", hasSpotlight);
  }

  function removeToastRecord(record) {
    if (!record) return;
    window.clearTimeout(record.timeoutId);
    record.backdrop?.remove();
    record.element.remove();
    syncSpotlightState();
  }

  function clear(id, options = {}) {
    const { immediate = false } = options;
    const pendingRecord = pendingToasts.get(id);
    if (pendingRecord) {
      window.clearTimeout(pendingRecord.delayTimeoutId);
      pendingToasts.delete(id);
    }

    const record = activeToasts.get(id);
    if (!record) return;
    activeToasts.delete(id);
    if (record.closing) return;
    record.closing = true;
    window.clearTimeout(record.timeoutId);
    if (immediate) {
      record.backdrop?.remove();
      record.element.remove();
      syncSpotlightState();
      return;
    }
    record.backdrop?.classList.add("is-leaving");
    record.element.classList.add("is-leaving");
    window.setTimeout(() => {
      record.backdrop?.remove();
      record.element.remove();
      syncSpotlightState();
    }, 180);
  }

  function renderToast(options) {
    const {
      id,
      title,
      message,
      tone,
      duration,
      important,
      actionLabel,
      onAction,
      actions = [],
      actionSections = [],
      layout = "default"
    } = options;

    if (!message) return id;
    if (activeToasts.has(id)) {
      removeToastRecord(activeToasts.get(id));
      activeToasts.delete(id);
    }

    const normalizedActions = Array.isArray(actions) && actions.length > 0
      ? actions.filter((action) => action && action.label && typeof action.onAction === "function")
      : (actionLabel && typeof onAction === "function" ? [{ label: actionLabel, onAction }] : []);
    const normalizedActionSections = Array.isArray(actionSections)
      ? actionSections
          .map((section) => ({
            title: String(section?.title || "").trim(),
            actions: Array.isArray(section?.actions)
              ? section.actions.filter((action) => action && action.label && typeof action.onAction === "function")
              : []
          }))
          .filter((section) => section.actions.length > 0)
      : [];
    const isSpotlight = layout === "spotlight";
    let backdrop = null;
    const mountTarget = isSpotlight ? document.body : container;

    if (isSpotlight) {
      backdrop = document.createElement("div");
      backdrop.className = "toast-spotlight-backdrop";
      backdrop.addEventListener("click", () => clear(id, { immediate: true }));
      document.body.appendChild(backdrop);
    }

    const element = document.createElement("article");
    element.className = `toast toast-${normalizeTone(tone)}${isSpotlight ? " toast-spotlight" : ""}`;
    element.setAttribute("role", important || tone === "error" ? "alert" : "status");
    element.style.setProperty("--toast-duration", `${Math.max(1200, Number(duration) || 4200)}ms`);
    element.innerHTML = `
      <div class="toast-accent" aria-hidden="true"></div>
      <div class="toast-icon" aria-hidden="true">${fluentToneIcon(normalizeTone(tone), 18)}</div>
      <div class="toast-body">
        <div class="toast-title-row">
          ${isSpotlight ? `<span class="toast-title-icon" aria-hidden="true">${tone === "success" ? fluentIcon("success", { size: 18 }) : fluentToneIcon(normalizeTone(tone), 18)}</span>` : ""}
          <strong class="toast-title"></strong>
        </div>
        <p class="toast-message"></p>
        ${normalizedActionSections.length > 0
          ? `<div class="toast-action-sections"></div>`
          : normalizedActions.length > 0
            ? `<div class="toast-actions"></div>`
            : ""}
      </div>
      <button class="toast-close" type="button" aria-label="Fechar aviso">${fluentIcon("x", { size: 16 })}</button>
    `;

    element.querySelector(".toast-title").textContent = title;
    element.querySelector(".toast-message").textContent = message;
    const sectionsContainer = element.querySelector(".toast-action-sections");
    if (sectionsContainer && isSpotlight && normalizedActionSections.length > 0) {
      normalizedActionSections.forEach((section) => {
        const sectionElement = document.createElement("section");
        sectionElement.className = "toast-action-section";
        if (section.title === "ABRIR RESULTADO") {
          sectionElement.classList.add("toast-action-section-open-result");
        }

        const label = document.createElement("div");
        label.className = "toast-action-section-label";
        label.textContent = section.title;
        sectionElement.appendChild(label);

        const actionsGrid = document.createElement("div");
        actionsGrid.className = "toast-actions";

        section.actions.forEach((action, index) => {
          const actionButton = document.createElement("button");
          actionButton.className = "toast-action toast-action-card";
          actionButton.classList.add(index < 2 ? "toast-action-card-half" : "toast-action-card-full");
          if (section.title === "ABRIR RESULTADO") {
            actionButton.classList.add("toast-action-card-open-result");
          }
          actionButton.type = "button";
          actionButton.innerHTML = `
            <span class="toast-action-icon" aria-hidden="true">${fluentIcon(action.icon || "arrow-right", { size: 16 })}</span>
            <span class="toast-action-copy">
              <strong>${action.label}</strong>
              ${action.description ? `<small>${action.description}</small>` : ""}
            </span>
          `;
          actionButton.addEventListener("click", async () => {
            try {
              await action.onAction();
            } finally {
              clear(id, { immediate: true });
            }
          });
          actionsGrid.appendChild(actionButton);
        });

        sectionElement.appendChild(actionsGrid);
        sectionsContainer.appendChild(sectionElement);
      });
    }

    const actionsContainer = element.querySelector(".toast-actions");
    if (!sectionsContainer && actionsContainer) {
      normalizedActions.forEach((action, index) => {
        const actionButton = document.createElement("button");
        actionButton.className = `toast-action${isSpotlight ? " toast-action-card" : ""}`;
        if (isSpotlight) {
          actionButton.classList.add(index < 2 ? "toast-action-card-half" : "toast-action-card-full");
        }
        actionButton.type = "button";
        if (isSpotlight) {
          actionButton.innerHTML = `
            <span class="toast-action-icon" aria-hidden="true">${fluentIcon(action.icon || "arrow-right", { size: 16 })}</span>
            <span class="toast-action-copy">
              <strong>${action.label}</strong>
              ${action.description ? `<small>${action.description}</small>` : ""}
            </span>
          `;
        } else {
          actionButton.textContent = action.label;
        }
        actionButton.addEventListener("click", async () => {
          try {
            await action.onAction();
          } finally {
              clear(id, { immediate: true });
          }
        });
        actionsContainer.appendChild(actionButton);
      });
    }
    element.querySelector(".toast-close").addEventListener("click", () => clear(id, { immediate: true }));

    mountTarget.appendChild(element);

    const timeoutId = window.setTimeout(() => clear(id), duration);
    activeToasts.set(id, { element, backdrop, timeoutId, closing: false, isSpotlight });
    syncSpotlightState();
    return id;
  }

  function notify(options = {}) {
    const {
      id = `toast-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      title = "Central PDF",
      message = "",
      tone = "info",
      duration = 4200,
      important = false,
      actionLabel = "",
      onAction = null,
      actions = [],
      actionSections = [],
      delayMs = 0,
      layout = "default"
    } = options;

    const payload = {
      id,
      title,
      message,
      tone,
      duration,
      important,
      actionLabel,
      onAction,
      actions,
      actionSections,
      layout
    };

    if (!payload.message) return id;

    const pendingRecord = pendingToasts.get(id);
    if (pendingRecord) {
      window.clearTimeout(pendingRecord.delayTimeoutId);
      pendingToasts.delete(id);
    }

    if (activeToasts.has(id)) {
      removeToastRecord(activeToasts.get(id));
      activeToasts.delete(id);
    }

    if (delayMs > 0) {
      const delayTimeoutId = window.setTimeout(() => {
        pendingToasts.delete(id);
        renderToast(payload);
      }, delayMs);
      pendingToasts.set(id, { delayTimeoutId, payload });
      return id;
    }

    return renderToast(payload);
  }

  function clearAll() {
    [...pendingToasts.keys()].forEach((id) => clear(id));
    [...activeToasts.keys()].forEach(clear);
    syncSpotlightState();
  }

  return {
    notify,
    clear,
    clearAll
  };
}
