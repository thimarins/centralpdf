import { bindAboutDiagnosticActions } from "../diagnostics/diagnostics-actions.js";
import { buildAboutSystemMarkup } from "../system-info/system-info.js";

export function createAboutPanelController({
  document,
  windowApi,
  icon,
  escapeHtml,
  formatBytes,
  notify,
  showFeedbackBanner,
  toneIcon
}) {
  const panel = document.getElementById("settings-about-panel");
  const toggle = document.getElementById("btn-settings-about-toggle");
  const body = document.getElementById("settings-about-body");
  const systemSlot = document.getElementById("about-system-slot");
  const technologiesSlot = document.getElementById("about-technologies-list");
  const techToggle = document.getElementById("btn-about-tech-toggle");
  const techBody = document.getElementById("about-technologies-body");
  const toggleMeta = toggle.querySelector(".about-toggle-meta");
  const toggleChevron = toggle.querySelector(".about-toggle-chevron");
  const techToggleChevron = techToggle.querySelector(".about-toggle-chevron");
  let aboutInfo = null;

  function renderTechnologies() {
    if (!technologiesSlot) return;
    const groupedItems = [
      {
        name: "Aplicativo desktop",
        iconName: "desktop",
        description: "Electron, Node.js e Vite para execução local e interface."
      },
      {
        name: "Motor PDF",
        iconName: "file",
        description: "pdf-lib, pdfjs-dist, QPDF WASM e pdf-encrypt para manipulação, descriptografia e criptografia local."
      },
      {
        name: "Interface e ícones",
        iconName: "grid-2x2",
        description: "Fluent UI Icons e CSS leve para uma interface limpa e corporativa."
      },
      {
        name: "Empacotamento e suporte",
        iconName: "archive",
        description: "electron-builder e logging interno para release, suporte e diagnóstico."
      }
    ];

    technologiesSlot.innerHTML = groupedItems.map((item) => `
      <div class="about-tech-item">
        <div class="about-tech-icon">${icon(item.iconName, { size: 16, filled: true })}</div>
        <div class="about-tech-copy">
          <strong>${escapeHtml(item.name)}</strong>
          <span>${escapeHtml(item.description)}</span>
        </div>
      </div>
    `).join("");
  }

  function setExpanded(expanded) {
    panel.classList.toggle("expanded", expanded);
    body.classList.toggle("hidden", !expanded);
    toggle.setAttribute("aria-expanded", String(expanded));
    toggle.setAttribute("title", expanded ? "Ocultar detalhes do aplicativo" : "Exibir detalhes do aplicativo");
    if (toggleMeta) {
      toggleMeta.textContent = `${aboutInfo.app.versionLabel || "v-"} • Build ${aboutInfo.app.buildLabel || "-"}`;
    }
    if (toggleChevron) {
      toggleChevron.innerHTML = icon(expanded ? "chevronUp" : "chevronDown", { size: 16 });
    }
  }

  function setTechExpanded(expanded) {
    techBody.classList.toggle("hidden", !expanded);
    techToggle.setAttribute("aria-expanded", String(expanded));
    if (techToggleChevron) {
      techToggleChevron.innerHTML = icon(expanded ? "chevronUp" : "chevronDown", { size: 16 });
    }
  }

  async function render() {
    aboutInfo = await windowApi.getAboutInfo();
    if (!aboutInfo) return;

    if (systemSlot) {
      systemSlot.innerHTML = buildAboutSystemMarkup(aboutInfo, {
        icon,
        escapeHtml,
        formatBytes
      });
    }

    renderTechnologies();
    if (!panel.dataset.aboutDiagnosticsBound) {
      bindAboutDiagnosticActions({
        container: panel,
        aboutInfo,
        windowApi,
        notify,
        showFeedbackBanner,
        toneIcon
      });
      if (panel) {
        panel.dataset.aboutDiagnosticsBound = "true";
      }
    }
    setExpanded(panel.classList.contains("expanded"));
    setTechExpanded(false);
  }

  function setup() {
    toggle.addEventListener("click", () => {
      const expanded = toggle.getAttribute("aria-expanded") === "true";
      setExpanded(!expanded);
    });

    techToggle.addEventListener("click", () => {
      const expanded = techToggle.getAttribute("aria-expanded") === "true";
      setTechExpanded(!expanded);
    });
  }

  return {
    setup,
    render
  };
}

