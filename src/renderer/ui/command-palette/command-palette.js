import { lucideIcon } from "../icons/lucide-icons.js";

function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function displayText(value) {
  return String(value || "")
    .replaceAll("Ã§", "ç")
    .replaceAll("Ã£", "ã")
    .replaceAll("Ãµ", "õ")
    .replaceAll("Ã¡", "á")
    .replaceAll("Ã©", "é")
    .replaceAll("Ã­", "í")
    .replaceAll("Ã³", "ó")
    .replaceAll("Ãº", "ú");
}

export function createCommandPalette(deps) {
  const { switchTab, escapeHtml, state, windowApi, notify } = deps;

  const modal = document.getElementById("command-palette-modal");
  const input = document.getElementById("command-palette-input");
  const resultsEl = document.getElementById("command-palette-results");

  if (!modal || !input || !resultsEl || typeof switchTab !== "function" || typeof escapeHtml !== "function") {
    return { open() {}, close() {}, isOpen: () => false };
  }

  let allItems = [];
  let filteredItems = [];
  let activeIndex = 0;
  let isOpen = false;

  function addItem(items, item) {
    items.push({
      description: "",
      keywords: "",
      ...item,
      searchText: normalize(`${item.label || ""} ${item.description || ""} ${item.keywords || ""}`)
    });
  }

  async function openRecentFile(item) {
    const target = String(item?.outputPath || item?.outputDir || "").trim();
    if (!target) {
      notify?.({
        tone: "warning",
        title: "Última atividade",
        message: "Este item não possui um arquivo ou pasta disponíveis para abrir."
      });
      return;
    }

    const result = await windowApi?.openPath?.(target);
    if (!result?.success) {
      notify?.({
        tone: "warning",
        title: "Arquivo não encontrado",
        message: result?.error || "O arquivo desta atividade não existe mais no local registrado."
      });
    }
  }

  function collectItems() {
    const items = [];

    document.querySelectorAll(".sidebar-nav .nav-item[data-tab]").forEach((navItem) => {
      const tabId = navItem.getAttribute("data-tab");
      const label = (navItem.getAttribute("data-nav-label") || navItem.textContent || "").trim();
      if (!tabId || !label) return;
      items.push({
        group: "Ferramentas",
        label,
        icon: navItem.getAttribute("data-icon") || "chevronRight",
        searchText: normalize(label),
        run: () => switchTab(tabId)
      });
    });

    const quickActions = [
      { id: "btn-dashboard-theme-toggle", label: "Alternar tema claro/escuro", icon: "settings", keywords: "tema claro escuro aparencia" },
      { id: "btn-dashboard-open-default-dir", label: "Abrir pasta de destino", icon: "folder-open", keywords: "pasta destino salvar output" },
      { id: "btn-dashboard-processed-history", label: "Ver últimas atividades", icon: "history", keywords: "historico atividades recentes processado" }
    ];
    quickActions[2].label = "Ver últimas atividades";
    quickActions.forEach((action) => {
      const button = document.getElementById(action.id);
      if (!button) return;
      items.push({
        group: "Ações",
        label: action.label,
        icon: action.icon,
        searchText: normalize(`${action.label} ${action.keywords}`),
        run: () => button.click()
      });
    });

    addItem(items, {
      group: "Configurações",
      label: "Abrir configurações",
      description: "Tema, pasta de destino, diagnósticos e informações do aplicativo.",
      icon: "settings",
      keywords: "preferências destino aparência tema diagnóstico",
      run: () => switchTab("settings")
    });

    const historyItems = Array.isArray(state?.appConfig?.recentHistory) ? state.appConfig.recentHistory : [];
    historyItems.slice(0, 10).forEach((historyItem) => {
      const fileName = String(historyItem?.outputPath || historyItem?.fileName || "arquivo processado").split(/[\\/]/).pop();
      const action = historyItem?.action || "Atividade";
      const status = historyItem?.status === "falha" ? "Falhou" : "Concluído";
      addItem(items, {
        group: "Últimas atividades",
        label: `${action}: ${fileName}`,
        description: `${status}. Abrir arquivo ou pasta registrada.`,
        icon: historyItem?.status === "falha" ? "warning" : "file-check",
        keywords: `${historyItem?.fileName || ""} ${historyItem?.outputPath || ""} ${historyItem?.outputDir || ""}`,
        run: () => openRecentFile(historyItem)
      });
    });

    document.querySelectorAll(".help-nav-btn[data-help-target]").forEach((helpButton) => {
      const target = helpButton.getAttribute("data-help-target");
      const label = (helpButton.getAttribute("data-nav-label") || helpButton.textContent || "").trim();
      if (!target || !label) return;
      items.push({
        group: "Ajuda",
        label: `Ajuda: ${label}`,
        icon: "info",
        searchText: normalize(`ajuda ${label}`),
        run: () => {
          switchTab("help");
          helpButton.click();
        }
      });
    });

    return items;
  }

  function renderResults() {
    resultsEl.innerHTML = "";

    if (filteredItems.length === 0) {
      resultsEl.innerHTML = '<div class="command-palette-empty">Nenhum resultado encontrado.</div>';
      return;
    }

    let lastGroup = "";
    filteredItems.forEach((item, index) => {
      if (item.group !== lastGroup) {
        lastGroup = item.group;
        const groupLabel = document.createElement("div");
        groupLabel.className = "command-palette-group-label";
        groupLabel.textContent = displayText(item.group);
        resultsEl.appendChild(groupLabel);
      }

      const isActive = index === activeIndex;
      const button = document.createElement("button");
      button.type = "button";
      button.className = `command-palette-item${isActive ? " command-palette-item-active" : ""}`;
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(isActive));
      button.innerHTML = `
        ${lucideIcon(item.icon, { size: 18 })}
        <span class="command-palette-item-copy">
          <span class="command-palette-item-label">${escapeHtml(displayText(item.label))}</span>
          ${item.description ? `<span class="command-palette-item-description">${escapeHtml(displayText(item.description))}</span>` : ""}
        </span>
      `;
      button.addEventListener("mousemove", () => {
        if (activeIndex !== index) {
          activeIndex = index;
          renderResults();
        }
      });
      button.addEventListener("click", () => runItem(item));
      resultsEl.appendChild(button);
    });

    resultsEl.querySelector(".command-palette-item-active")?.scrollIntoView({ block: "nearest" });
  }

  function applyFilter(query) {
    const normalized = normalize(query.trim());
    filteredItems = normalized ? allItems.filter((item) => item.searchText.includes(normalized)) : allItems;
    activeIndex = 0;
    renderResults();
  }

  function runItem(item) {
    if (!item) return;
    close();
    item.run();
  }

  function isAnotherModalOpen() {
    return [...document.querySelectorAll(".modal-overlay:not(.hidden)")].some((overlay) => overlay !== modal);
  }

  function open(query = "") {
    if (isOpen || isAnotherModalOpen()) return;
    isOpen = true;
    allItems = collectItems();
    filteredItems = allItems;
    activeIndex = 0;
    input.value = String(query || "");
    modal.classList.remove("hidden");
    applyFilter(input.value);
    window.setTimeout(() => input.focus(), 0);
  }

  function setQuery(query = "") {
    input.value = String(query || "");
    if (isOpen) applyFilter(input.value);
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    modal.classList.add("hidden");
  }

  modal.addEventListener("click", (event) => {
    if (event.target === modal) close();
  });

  input.addEventListener("input", () => {
    applyFilter(input.value);
    const globalSearchInput = document.getElementById("dashboard-search-input");
    if (globalSearchInput && globalSearchInput.value !== input.value) {
      globalSearchInput.value = input.value;
    }
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (filteredItems.length === 0) return;
      activeIndex = (activeIndex + 1) % filteredItems.length;
      renderResults();
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (filteredItems.length === 0) return;
      activeIndex = (activeIndex - 1 + filteredItems.length) % filteredItems.length;
      renderResults();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      runItem(filteredItems[activeIndex]);
    }
  });

  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      if (isOpen) {
        close();
      } else {
        open();
      }
    }
  });

  return { open, close, setQuery, isOpen: () => isOpen };
}

