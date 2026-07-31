import { fluentToneIcon } from "../icons/fluent-icons.js";

export function createFeedbackCenter(container) {
  if (!container) {
    return {
      show() {},
      clear() {}
    };
  }

  let autoClearTimer = null;

  function clear() {
    if (autoClearTimer) {
      clearTimeout(autoClearTimer);
      autoClearTimer = null;
    }
    container.classList.remove("visible", "feedback-info", "feedback-success", "feedback-warning", "feedback-error");
    container.innerHTML = "";
  }

  function show(options = {}) {
    const {
      tone = "info",
      title = "Status",
      message = "",
      detail = "",
      icon = fluentToneIcon(tone, 18),
      duration = 0
    } = options;

    if (!message) {
      clear();
      return;
    }

    if (autoClearTimer) {
      clearTimeout(autoClearTimer);
      autoClearTimer = null;
    }

    container.className = `feedback-banner visible feedback-${tone}`;
    container.innerHTML = `
      <div class="feedback-banner-icon" aria-hidden="true">${icon}</div>
      <div class="feedback-banner-copy">
        <strong>${title}</strong>
        <span>${message}</span>
        ${detail ? `<small>${detail}</small>` : ""}
      </div>
    `;

    if (Number.isFinite(duration) && duration > 0) {
      autoClearTimer = setTimeout(() => {
        clear();
      }, duration);
    }
  }

  return { show, clear };
}
