import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { createAboutPanelController } from "./settings/about/about-panel.js";
import { initializeActionToolbars } from "./ui/action-toolbar.js";
import { addPulseTemporarily } from "./ui/animations/motion.js";
import { createPdfToWordWorkspaceController } from "./ui/conversion/pdf-to-word-workspace.js";
import { createImageToPdfWorkspaceController } from "./ui/image-to-pdf/image-to-pdf-workspace.js";
import { hasAnyPendingTabWork } from "./ui/navigation/pending-work.js";
import { createOrganizeWorkspaceController } from "./ui/organize/organize-workspace.js";
import { createQueueAndHistoryRenderer } from "./ui/queue/queue-status.js";
import { createCommandPalette } from "./ui/command-palette/command-palette.js";
import { createSignatureWorkspaceController } from "./ui/signature/signature-workspace.js";
import { QUEUE_UI_THRESHOLDS, UI_ICON_SIZES } from "./ui/constants.js";
import { lucideIcon, lucideIconByState, lucideToneIcon } from "./ui/icons/lucide-icons.js";
import { buildFeedbackMessage, getOperationLabel } from "./ui/message-system/messages.js";
import { createToastCenter } from "./ui/notifications/toast-center.js";
import { createWatermarkWorkspaceController } from "./ui/watermark/watermark-workspace.js";
import { createProtectWorkspaceController } from "./ui/security/protect-workspace.js";
import { createUnlockWorkspaceController } from "./ui/security/unlock-workspace.js";
import { createRedactWorkspaceController } from "./ui/redact/redact-workspace.js";
import { createOcrAreaExtractor } from "./ui/ocr/ocr-area-extractor.js";
import { downsampleImageAsBase64 } from "./ui/pdf-preview-utils.js";
import { createAppState } from "./state/app-state.js";

let systemThemeMediaQuery = null;
let systemAppearance = { accentColor: "" };

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const state = createAppState();
let splitContentSearchRequestId = '';
let splitContentStartPages = [];
let refreshRecentFilesCards = null;
let hideRecentFilesCard = () => {};
let ocrImagePreviewUrl = '';
let ocrImagePreviewToken = 0;

const DASHBOARD_QUICK_ACTION_DEFAULT_ORDER = [
  "images-to-pdf", "merge", "split", "signature", "pdf-to-word", "ocr",
  "organize", "watermark", "compress", "protect", "unlock", "redact"
];

const dom = {
  tabs: [...document.querySelectorAll(".nav-item")],
  tabContents: [...document.querySelectorAll(".tab-content")],
  processedHistoryButton: document.getElementById("btn-dashboard-processed-history"),
  processedHistoryModal: document.getElementById("recent-processed-modal"),
  processedHistoryModalList: document.getElementById("recent-processed-modal-list"),
  processedHistoryModalClose: document.getElementById("recent-processed-modal-close"),
  historyList: document.getElementById("recent-history-list"),
  historyExpandFooter: document.getElementById("history-expand-footer"),
  btnToggleHistory: document.getElementById("btn-toggle-history"),
  toastRegion: document.getElementById("app-toast-region"),
  queueBar: document.getElementById("queue-status-bar"),
  queueActiveCount: document.getElementById("queue-active-count"),
  queueSummary: document.getElementById("queue-summary"),
  queueTasksList: document.getElementById("queue-tasks-list"),
  organizeGrid: document.getElementById("pages-grid"),
  organizeWorkspace: document.getElementById("organize-workspace"),
  organizeDropzone: document.getElementById("organize-dropzone")
};

const toastCenter = createToastCenter(dom.toastRegion);
const organizeWorkspace = createOrganizeWorkspaceController({
  pdfjsLib,
  state,
  dom,
  document,
  icon,
  notify,
  showFeedbackBanner,
  buildFeedbackMessage,
  toneIcon,
  formatBytes,
  showCustomConfirmModal,
  showCustomPromptModal
});
const imageToPdfWorkspace = createImageToPdfWorkspaceController({
  state,
  document,
  icon,
  notify,
  showFeedbackBanner,
  clearFeedbackBanner,
  buildFeedbackMessage,
  toneIcon,
  formatBytes
});
const signatureWorkspace = createSignatureWorkspaceController({
  pdfjsLib,
  state,
  document,
  icon,
  notify,
  showFeedbackBanner,
  clearFeedbackBanner,
  buildFeedbackMessage,
  toneIcon,
  formatBytes
});
const pdfToWordWorkspace = createPdfToWordWorkspaceController({
  state,
  document,
  notify,
  showFeedbackBanner,
  clearFeedbackBanner,
  buildFeedbackMessage,
  toneIcon,
  formatBytes,
  analyzePdfForOcr: (payload) => window.api.analyzePdfForWordOcr(payload),
  cancelPdfForOcrAnalysis: (requestId) => window.api.cancelPdfForWordOcrAnalysis(requestId)
});
const watermarkWorkspace = createWatermarkWorkspaceController({
  pdfjsLib,
  state,
  document,
  notify,
  clearFeedbackBanner,
  formatBytes,
  buildFileListItem,
  showValidationMessage
});
const protectWorkspace = createProtectWorkspaceController({
  state,
  document,
  formatBytes,
  showValidationMessage,
  icon
});
const unlockWorkspace = createUnlockWorkspaceController({
  state,
  document,
  notify,
  showValidationMessage,
  formatBytes
});
const redactWorkspace = createRedactWorkspaceController({
  pdfjsLib,
  state,
  document,
  icon,
  notify,
  clearFeedbackBanner,
  formatBytes,
  showValidationMessage
});
const ocrAreaExtractor = createOcrAreaExtractor({
  pdfjsLib,
  windowApi: window.api,
  document,
  notify,
  getLanguage: () => document.getElementById('ocr-language')?.value || 'por+eng'
});
const queueAndHistory = createQueueAndHistoryRenderer({
  state,
  dom,
  windowApi: window.api,
  icon,
  lucideIcon,
  safeProgress,
  formatDuration,
  escapeHtml,
  buildFeedbackMessage,
  QUEUE_UI_THRESHOLDS,
  addPulseTemporarily,
  toneIcon,
  notify,
  showFeedbackBanner,
  clearFeedbackBanner,
  clearToast: toastCenter.clear,
  showCustomConfirmModal,
  updateRecentHistory: updateRecentHistoryFromTask,
  getWorkflowSuggestionActions
});
const commandPalette = createCommandPalette({
  switchTab,
  escapeHtml,
  state,
  windowApi: window.api,
  notify
});
const aboutPanel = createAboutPanelController({
  document,
  windowApi: window.api,
  icon,
  escapeHtml,
  formatBytes,
  notify,
  showFeedbackBanner,
  toneIcon
});

const lazyModuleSetupState = {
  about: false,
  "images-to-pdf": false,
  signature: false,
  "pdf-to-word": false,
  watermark: false,
  protect: false,
  unlock: false,
  redact: false,
  organize: true
};

let runtimeGuardInstalled = false;
let lastRuntimeIssueSignature = "";
let lastRuntimeIssueAt = 0;
let launchRequestHandlingReady = false;
let lastHandledLaunchRequest = { key: "", at: 0 };
const queuedLaunchRequests = [];
const LAUNCH_REQUEST_DEDUP_WINDOW_MS = 2500;

function reportRuntimeIssue(scope, errorLike) {
  const errorName = typeof errorLike?.name === 'string' ? errorLike.name : 'Error';
  const errorCode = typeof errorLike?.code === 'string' ? errorLike.code : '';
  const signature = `${scope}:${errorName}:${errorCode}`;
  const now = Date.now();

  if (signature === lastRuntimeIssueSignature && now - lastRuntimeIssueAt < 2500) {
    return;
  }

  lastRuntimeIssueSignature = signature;
  lastRuntimeIssueAt = now;

  console.error('[renderer-runtime] An interface error was captured.', { scope, errorName });
  window.api?.logRendererError?.({
    scope,
    errorName,
    errorCode
  }).catch(() => {});

  notify({
    tone: "error",
    title: "Algo saiu do esperado",
    message: "Encontramos uma falha nessa tela, mas o app permaneceu aberto para você continuar.",
    important: true
  });
}

function setupGlobalRuntimeGuards() {
  if (runtimeGuardInstalled) return;
  runtimeGuardInstalled = true;

  window.addEventListener("error", (event) => {
    const fallbackError = new Error(event.message || "Erro de interface");
    reportRuntimeIssue("window-error", event.error || fallbackError);
  });

  window.addEventListener("unhandledrejection", (event) => {
    event.preventDefault();
    const reason = event.reason instanceof Error
      ? event.reason
      : new Error(typeof event.reason === "string" ? event.reason : "Promise rejeitada sem tratamento");
    reportRuntimeIssue("unhandled-rejection", reason);
  });
}

window.addEventListener("recent-history-updated", () => {
  if (state.activeTab === "dashboard") {
    queueAndHistory.renderHistory();
  }
  updateDashboardSummary();
});

window.api?.onOperationFinished?.((task) => {
  if (!task || !task.id) return;
  if (task.status === "completed") {
    updateRecentHistoryFromTask(task, "sucesso");
    const outputPath = task.result?.outputPath || task.result?.firstOutputPath || "";
    if (state.appConfig?.openOutputAutomatically === true && outputPath) {
      window.api.openPath(outputPath).then((result) => {
        if (!result?.success) {
          notify({
            tone: "warning",
            title: "Arquivo concluído",
            message: result?.error || "O arquivo foi salvo, mas não foi possível abri-lo automaticamente."
          });
        }
      }).catch((error) => {
        notify({
          tone: "warning",
          title: "Arquivo concluído",
          message: error?.message || "O arquivo foi salvo, mas não foi possível abri-lo automaticamente."
        });
      });
    }
  } else if (task.status === "failed" || task.status === "timeout") {
    updateRecentHistoryFromTask(task, "falha");
  }
});

function showLaunchRequestError(error) {
  try {
    console.error("Launch request error:", error);
  } catch (_) {}
  notify({
    tone: "error",
    title: "Atalho do Windows",
    message: error?.message || "Não foi possível abrir esse arquivo no módulo solicitado."
  });
}

function buildLaunchRequestKey(payload) {
  if (!payload || typeof payload !== "object") return "";
  const action = normalizeLaunchRequestAction(payload.action || "");
  const fileKeys = Array.isArray(payload.files)
    ? payload.files
        .map((file) => String(file?.path || file?.name || "").trim().toLowerCase())
        .filter(Boolean)
    : [];
  if (!action && fileKeys.length === 0) return "";
  return `${action}::${fileKeys.join("|")}`;
}

function wasRecentlyHandledLaunchRequest(key) {
  if (!key || !lastHandledLaunchRequest.key) return false;
  if (lastHandledLaunchRequest.key !== key) return false;
  return Date.now() - Number(lastHandledLaunchRequest.at || 0) < LAUNCH_REQUEST_DEDUP_WINDOW_MS;
}

async function processLaunchRequestPayload(payload) {
  const key = buildLaunchRequestKey(payload);
  if (!key || wasRecentlyHandledLaunchRequest(key)) return;
  await openLaunchRequest(payload);
  lastHandledLaunchRequest = {
    key,
    at: Date.now()
  };
}

function queueLaunchRequest(payload) {
  const key = buildLaunchRequestKey(payload);
  if (!key || wasRecentlyHandledLaunchRequest(key)) return;
  if (queuedLaunchRequests.some((item) => buildLaunchRequestKey(item) === key)) return;
  queuedLaunchRequests.push(payload);
}

function scheduleNonCriticalBootstrapWork() {
  const run = () => {
    try {
      queueAndHistory.renderHistory();
      updateDashboardSummary();
      repairVisibleMojibake();
      aboutPanel.render().catch(() => {});
    } catch (_) {}
  };

  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(() => run(), { timeout: 1200 });
    return;
  }

  window.setTimeout(run, 120);
}

function ensureModuleSetup(tabId) {
  const runSetupOnce = (key, controller) => {
    if (lazyModuleSetupState[key]) return;
    if (!controller || typeof controller.setup !== "function") {
      lazyModuleSetupState[key] = true;
      return;
    }
    controller.setup();
    lazyModuleSetupState[key] = true;
  };

  switch (tabId) {
    case "help":
    case "settings":
      runSetupOnce("about", aboutPanel);
      break;
    case "images-to-pdf":
      runSetupOnce("images-to-pdf", imageToPdfWorkspace);
      break;
    case "signature":
      runSetupOnce("signature", signatureWorkspace);
      break;
    case "pdf-to-word":
      runSetupOnce("pdf-to-word", pdfToWordWorkspace);
      break;
    case "watermark":
      runSetupOnce("watermark", watermarkWorkspace);
      break;
    case "protect":
      runSetupOnce("protect", protectWorkspace);
      break;
    case "unlock":
      runSetupOnce("unlock", unlockWorkspace);
      break;
    case "redact":
      runSetupOnce("redact", redactWorkspace);
      break;
    case "organize":
      runSetupOnce("organize", organizeWorkspace);
      break;
    default:
      break;
  }
}

function handleIncomingLaunchRequest(payload) {
  if (!launchRequestHandlingReady) {
    queueLaunchRequest(payload);
    return;
  }
  processLaunchRequestPayload(payload).catch(showLaunchRequestError);
}

window.api?.onLaunchRequest?.((payload) => {
  handleIncomingLaunchRequest(payload);
});

async function bootstrapApp() {
  window.api?.reportStartupPhase?.("renderer-bootstrap-step", { step: "start" });
  rebuildSidebarLayout();
  renderDashboardShell();
  refreshDashboardDomRefs();
  hydrateStaticIcons();
  initializeActionToolbars(document, window);
  setupGlobalRuntimeGuards();
  setupPasswordVisibilityToggles();
  setupSystemThemeSync();
  dom.historyList.innerHTML = renderLoadingSkeleton(3);
  window.api?.reportStartupPhase?.("renderer-bootstrap-step", { step: "shell-ready" });
  window.api?.reportStartupPhase?.("renderer-bootstrap-step", { step: "loading-app-meta" });
  await loadAppMeta();
  window.api?.reportStartupPhase?.("renderer-bootstrap-step", { step: "app-meta-ready" });
  window.api?.reportStartupPhase?.("renderer-bootstrap-step", { step: "loading-app-config" });
  await loadAppConfig();
  window.api?.reportStartupPhase?.("renderer-bootstrap-step", { step: "app-config-ready" });
  setupOneOffOutputDirectoryRouting();
  setupNavigation();
  setupDashboardEnhancements();
  setupNavigationGuards();
  setupDropzones();
  setupOperations();
  removeDuplicateCompatibilityNotice();
  queueAndHistory.setupQueueStatus();
  window.api?.reportStartupPhase?.("renderer-bootstrap-step", { step: "workspaces-ready" });
  window.setTimeout(showFirstRunHints, 350);
  try {
    if (await window.api?.isE2ETestMode?.()) exposeAutomatedTestApi();
  } catch (error) {
    console.warn('Modo de teste automatizado indisponível.', error);
  }
  if (window.api?.consumeLaunchRequest) {
    try {
      const pendingLaunchRequest = await window.api.consumeLaunchRequest();
      if (pendingLaunchRequest) {
        queueLaunchRequest(pendingLaunchRequest);
      }
    } catch (error) {
      showLaunchRequestError(error);
    }
  }
  launchRequestHandlingReady = true;
  scheduleNonCriticalBootstrapWork();
  window.api?.reportStartupPhase?.("renderer-bootstrap-step", { step: "launch-queue-ready" });
  while (queuedLaunchRequests.length > 0) {
    const payload = queuedLaunchRequests.shift();
    await processLaunchRequestPayload(payload);
  }
  try {
    window.api?.reportStartupPhase?.("renderer-bootstrap-complete");
  } catch (_) {}
}

function showFirstRunHints() {
  const storageKey = "central-pdf:first-run-hints:v3";
  try {
    if (window.localStorage.getItem(storageKey) === "seen") return;
  } catch (_) {}

  const historyButton = document.getElementById("btn-dashboard-processed-history");
  const folderButton = document.getElementById("btn-dashboard-open-default-dir");
  const themeButton = document.getElementById("btn-dashboard-theme-toggle");
  const searchInput = document.getElementById("dashboard-search-input");
  if (!historyButton || !folderButton || !themeButton || !searchInput || document.getElementById("first-run-hints")) return;

  historyButton.classList.add("first-run-hint-target");
  folderButton.classList.add("first-run-hint-target");
  themeButton.classList.add("first-run-hint-target");
  searchInput.closest(".dashboard-search")?.classList.add("first-run-hint-target");

  const panel = document.createElement("aside");
  panel.id = "first-run-hints";
  panel.className = "first-run-hints-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Orientações rápidas");
  panel.innerHTML = `
    <div class="first-run-hints-header">
      <div>
        <strong>Conheça quatro atalhos úteis</strong>
        <span>Você poderá fechar esta orientação quando quiser.</span>
      </div>
      <button type="button" class="first-run-hints-close" aria-label="Fechar orientação">${icon("x")}</button>
    </div>
    <div class="first-run-hint-item">
      <span class="first-run-hint-icon">${icon("folder-open")}</span>
      <div>
        <strong>Pasta de destino</strong>
        <span>Abre sua pasta padrão, se definida; caso contrário, abre a pasta do último resultado. Sem resultados, fica indisponível.</span>
      </div>
    </div>
    <div class="first-run-hint-item">
      <span class="first-run-hint-icon">${icon("history")}</span>
      <div>
        <strong>Últimas atividades</strong>
        <span>Consulte e abra rapidamente os seus últimos resultados.</span>
      </div>
    </div>
    <div class="first-run-hint-item">
      <span class="first-run-hint-icon">${icon("weather-moon")}</span>
      <div>
        <strong>Tema</strong>
        <span>Alterne entre o tema claro, escuro ou o modo do sistema.</span>
      </div>
    </div>
    <div class="first-run-hint-item">
      <span class="first-run-hint-icon">${icon("search")}</span>
      <div>
        <strong>Buscar</strong>
        <span>Encontre rapidamente uma ferramenta ou ação pelo nome.</span>
      </div>
    </div>
    <button type="button" class="btn-primary btn-sm first-run-hints-confirm">Entendi</button>
  `;

  const close = () => {
    panel.remove();
    historyButton.classList.remove("first-run-hint-target");
    folderButton.classList.remove("first-run-hint-target");
    themeButton.classList.remove("first-run-hint-target");
    searchInput.closest(".dashboard-search")?.classList.remove("first-run-hint-target");
    try {
      window.localStorage.setItem(storageKey, "seen");
    } catch (_) {}
  };
  panel.querySelector(".first-run-hints-close")?.addEventListener("click", close);
  panel.querySelector(".first-run-hints-confirm")?.addEventListener("click", close);
  document.body.appendChild(panel);
}

function removeDuplicateCompatibilityNotice() {
  const notices = document.querySelectorAll('#tab-pdf-to-word .inline-optimized-hint');
  if (notices.length > 1) {
    notices[0].remove();
  }
}

function rebuildSidebarLayout() {
  const sidebarNav = document.querySelector(".sidebar-nav");
  if (!sidebarNav) return;

  const navDefinitions = {
    dashboard: { label: "Início", icon: "house" },
    merge: { label: "Mesclar", icon: "merge" },
    split: { label: "Separar PDFs", icon: "scissors" },
    organize: { label: "Organizar Páginas", icon: "layout-list" },
    watermark: { label: "Marca d'água", icon: "stamp" },
    compress: { label: "Reduzir tamanho", icon: "zap" },
    signature: { label: "Assinar PDF", icon: "pen-line" },
    protect: { label: "Proteger PDF", icon: "lock" },
    unlock: { label: "Desbloquear PDF", icon: "unlock" },
    redact: { label: "Ocultar Dados", icon: "eye-off" },
    "images-to-pdf": { label: "Converter para PDF", icon: "file-output" },
    "pdf-to-word": { label: "PDF para Word", icon: "file-text" },
    ocr: { label: "Reconhecer texto (OCR)", icon: "scan-text" },
    help: { label: "Ajuda", icon: "info" },
    settings: { label: "Configurações", icon: "settings" }
  };

  const groups = [
    { label: "Começar", tabs: ["dashboard"] },
    { label: "Editar PDFs", tabs: ["merge", "split", "organize", "watermark", "compress"] },
    { label: "Segurança", tabs: ["signature", "protect", "unlock", "redact"] },
    { label: "Conversão", tabs: ["images-to-pdf", "pdf-to-word", "ocr"] },
    { label: "Configurações", tabs: ["help", "settings"] }
  ];

  sidebarNav.innerHTML = "";

  groups.forEach((group) => {
    const wrapper = document.createElement("div");
    wrapper.className = "nav-group";

    const title = document.createElement("span");
    title.className = "nav-group-label";
    title.textContent = group.label;
    wrapper.appendChild(title);

    group.tabs.forEach((tabId) => {
      const definition = navDefinitions[tabId];
      if (!definition) return;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "nav-item";
      button.setAttribute("data-tab", tabId);
      button.setAttribute("data-icon", definition.icon);
      button.setAttribute("data-nav-label", definition.label);
      button.textContent = definition.label;
      button.classList.toggle("active", state.activeTab === tabId);
      wrapper.appendChild(button);
    });

    sidebarNav.appendChild(wrapper);
  });

  dom.tabs = [...document.querySelectorAll(".nav-item")];
}

function renderDashboardShell() {
  const dashboardTab = document.getElementById("tab-dashboard");
  if (!dashboardTab) return;

  dashboardTab.innerHTML = `
    <header class="dashboard-hero">
      <div class="dashboard-hero-copy">
        <div class="dashboard-hero-heading">
          <h1 id="dashboard-welcome">Bem-vindo ao Central PDF</h1>
          <p id="dashboard-subtitle">O que deseja fazer hoje?</p>
        </div>
      </div>
    </header>

    <div class="dashboard-grid dashboard-grid-home">
      <div class="dashboard-main-column">
        <div class="card dashboard-upload-card">
          <div class="section-heading">
            <h2 class="section-title-with-icon"><span class="section-title-icon" data-icon="folder-open"></span><span>Atalho Rápido</span></h2>
          </div>
          <div class="dashboard-upload-inline">
            <div class="dashboard-upload-box" id="dashboard-pdf-dropzone" role="button" tabindex="0" aria-label="Selecionar ou arrastar um arquivo para o atalho rápido">
              <input type="file" id="dashboard-pdf-input" accept=".pdf,.jpg,.jpeg,.png" class="file-input-hidden">
              <div class="dashboard-upload-copy">
                <span class="dashboard-upload-icon" data-icon="cloud-upload"></span>
                <strong id="dashboard-selected-file-name">Arraste seu arquivo aqui</strong>
                <span id="dashboard-selected-file-meta" style="margin-bottom: 4px;">PDF ou imagem (conforme a ferramenta)</span>
              </div>
            </div>
            <div class="dashboard-upload-aside">
              <div class="input-group">
                <label for="dashboard-pdf-action">O que deseja fazer?</label>
                <select id="dashboard-pdf-action">
                  <option value="organize" selected>Organizar Páginas</option>
                  <option value="merge">Mesclar</option>
                  <option value="split">Separar PDFs</option>
                  <option value="signature">Assinar PDF</option>
                  <option value="pdf-to-word">PDF para Word</option>
                  <option value="ocr">Reconhecer texto (OCR)</option>
                  <option value="images-to-pdf">Converter imagem para PDF</option>
                  <option value="protect">Proteger PDF</option>
                  <option value="unlock">Desbloquear PDF</option>
                  <option value="redact">Ocultar Dados</option>
                  <option value="compress">Reduzir tamanho</option>
                  <option value="watermark">Marca d'água</option>
                </select>
              </div>
              <button id="btn-dashboard-open-action" class="btn-primary btn-icon-label" data-icon="folder-open">Selecionar arquivo</button>
            </div>
          </div>
        </div>

        <section class="card dashboard-recent-files-card" aria-labelledby="dashboard-recent-files-title">
          <div class="dashboard-recent-files-heading">
            <div class="section-heading">
              <h2 id="dashboard-recent-files-title" class="section-title-with-icon"><span class="section-title-icon" data-icon="history"></span><span>Últimos arquivos usados</span></h2>
              <p>Arquivos recentes do computador. Escolha um módulo compatível para continuar.</p>
            </div>
            <button id="btn-dashboard-refresh-recent-files" class="btn-secondary btn-sm btn-icon-label" type="button" data-icon="refresh-cw" aria-label="Atualizar arquivos recentes">Atualizar</button>
          </div>
          <p id="dashboard-recent-files-status" class="dashboard-recent-files-status" role="status" aria-live="polite">Procurando arquivos recentes…</p>
          <div id="dashboard-recent-files-list" class="dashboard-recent-files-list" aria-label="Arquivos recentes"></div>
        </section>
      </div>

      <div class="card history-card dashboard-history-card">
        <div class="section-heading">
          <h2 class="section-title-with-icon"><span class="section-title-icon" data-icon="history"></span><span>Últimas atividades</span></h2>
          <p>Veja rapidamente o que foi feito recentemente.</p>
        </div>
        <div id="recent-history-list" class="history-list collapsed">
          <div class="empty-state">Nenhuma operação realizada recentemente.</div>
        </div>
        <div id="history-expand-footer" class="history-expand-footer hidden">
          <button id="btn-toggle-history" class="btn-secondary btn-sm btn-icon-label" data-icon="chevronDown">Ver mais</button>
        </div>
      </div>
    </div>
  `;
}

function refreshDashboardDomRefs() {
  dom.historyList = document.getElementById("recent-history-list");
  dom.historyExpandFooter = document.getElementById("history-expand-footer");
  dom.btnToggleHistory = document.getElementById("btn-toggle-history");
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    bootstrapApp().catch((error) => {
      try {
        window.api?.reportStartupPhase?.("renderer-bootstrap-failed", { message: error?.message || String(error) });
      } catch (_) {}
      console.error("Falha ao iniciar interface:", error);
    });
  }, { once: true });
} else {
  bootstrapApp().catch((error) => {
    try {
      window.api?.reportStartupPhase?.("renderer-bootstrap-failed", { message: error?.message || String(error) });
    } catch (_) {}
    console.error("Falha ao iniciar interface:", error);
  });
}

function icon(name, options = {}) {
  return lucideIcon(name, { size: UI_ICON_SIZES.quickAction, ...options });
}

function toneIcon(tone, size = 20) {
  return lucideToneIcon(tone, size);
}

function bindClick(id, handler) {
  const element = document.getElementById(id);
  if (!element) return null;
  element.addEventListener("click", async (event) => {
    try {
      await handler(event);
    } catch (error) {
      console.error(`Falha ao executar ação de clique: ${id}`, error);
      notify({
        tone: "error",
        title: "Ação não concluída",
        message: "Algo deu errado ao executar esse comando. Vamos manter a tela aberta e seguir em frente.",
        important: true
      });
    }
  });
  return element;
}

function bindChange(id, handler) {
  const element = document.getElementById(id);
  if (!element) return null;
  element.addEventListener("change", async (event) => {
    try {
      await handler(event);
    } catch (error) {
      console.error(`Falha ao executar alteração: ${id}`, error);
      notify({
        tone: "error",
        title: "Alteração não aplicada",
        message: "Não foi possível aplicar essa mudança agora.",
        important: true
      });
    }
  });
  return element;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeProgress(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return 0;
  return Math.max(0, Math.min(100, numericValue));
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 Bytes";
  const units = ["Bytes", "KB", "MB", "GB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function renderLoadingSkeleton(lines = 3) {
  return Array.from(
    { length: lines },
    () => '<div class="history-item skeleton-row" aria-hidden="true"><div class="skeleton-line long"></div><div class="skeleton-line short"></div></div>'
  ).join("");
}

function normalizeGlobalNotification(options = {}) {
  const safeOptions = { ...options };
  if (safeOptions.title) safeOptions.title = normalizeMojibakeText(safeOptions.title);
  if (safeOptions.message) safeOptions.message = normalizeMojibakeText(safeOptions.message);
  if (safeOptions.detail) safeOptions.detail = normalizeMojibakeText(safeOptions.detail);

  if (safeOptions.tone === "error") {
    const message = String(safeOptions.message || "").trim();
    const normalized = message.toLowerCase();
    const moduleName = safeOptions.title && safeOptions.title !== "Central PDF"
      ? `${safeOptions.title}: `
      : "";
    const standardMessages = [
      ["não foi possível atualizar o preview.", "Não foi possível atualizar a prévia. Tente novamente; se o erro persistir, recarregue o arquivo."],
      ["não foi possível atualizar a página.", "Não foi possível atualizar esta página. Tente novamente ou carregue o arquivo outra vez."],
      ["erro ao renderizar e salvar imagens das páginas.", "Não foi possível renderizar e salvar as imagens. Verifique o arquivo e a pasta de saída."],
      ["não foi possível preparar o arquivo de origem para extração.", "Não foi possível preparar o arquivo para extração. Verifique se ele ainda existe e pode ser lido."],
      ["não foi possível abrir o arquivo selecionado.", "Não foi possível abrir o arquivo selecionado. Verifique se ele ainda existe, pode ser lido e possui formato compatível."],
      ["não foi possível abrir este arquivo.", "Não foi possível abrir este arquivo. Verifique se ele ainda existe, pode ser lido e não está corrompido."]
    ];
    const match = standardMessages.find(([source]) => normalized === source);
    if (match) {
      safeOptions.message = `${moduleName}${match[1]}`;
    }

    const technicalTranslations = [
      [/the pdf file is empty(?:,? i\.e\. its size is zero bytes)?\.?/i, "o PDF está vazio (tamanho zero)."],
      [/the pdf file is corrupt(?:ed)?/i, "o PDF está corrompido."],
      [/invalid pdf(?: file)?/i, "o PDF é inválido."],
      [/file does not exist|file not found|invalid (?:input )?file path|enoent/i, "não foi possível localizar o arquivo selecionado."],
      [/permission denied|access denied|eacces|eperm/i, "o arquivo não pode ser lido por falta de permissão."],
      [/unable to (?:load|open|read) (?:the )?(?:pdf|file)/i, "não foi possível ler o arquivo."],
      [/failed to (?:load|open|read|render|process)|cannot read properties|unknown renderer error|internal error/i, "não foi possível concluir esta etapa."],
      [/operation_timeout|tempo limite excedido/i, "a operação demorou mais que o limite permitido."],
      [/operation_cancelled|operação cancelada/i, "a operação foi cancelada."]
    ];
    const translated = technicalTranslations.find(([pattern]) => pattern.test(message));
    if (translated) {
      safeOptions.message = `${moduleName}${translated[1]}`;
    }
  }
  if (safeOptions.tone === "error" && !safeOptions.id) {
    const key = `${safeOptions.title || "erro"}:${safeOptions.message || ""}`.toLowerCase();
    let hash = 0;
    for (let index = 0; index < key.length; index += 1) {
      hash = ((hash << 5) - hash + key.charCodeAt(index)) | 0;
    }
    safeOptions.id = `error-${Math.abs(hash)}`;
  }
  return safeOptions;
}

function notify(options = {}) {
  const safeOptions = normalizeGlobalNotification(options);
  return toastCenter.notify({ title: "Central PDF", duration: 4200, ...safeOptions });
}

function showFeedbackBanner(options = {}) {
  const safeOptions = normalizeGlobalNotification(options);
  const { mode, icon, detail, ...toastOptions } = safeOptions;
  notify({
    ...toastOptions,
    id: toastOptions.id || (mode ? `feedback-${mode}` : undefined),
    detail,
    icon
  });
}

function clearFeedbackBanner(mode = "") {
  if (mode && state.feedbackBannerMode && state.feedbackBannerMode !== mode) return;
  state.feedbackBannerMode = "";
}

function classifyWarningMessage(message) {
  const normalized = String(message || "").toLowerCase();
  if (normalized.includes("grande") || normalized.includes("gigante") || normalized.includes("memória") || normalized.includes("preview")) {
    return "giantPdf";
  }
  if (normalized.includes("seguro") || normalized.includes("otimizado")) {
    return "safeMode";
  }
  return "warning";
}

function showWarnings(warnings = [], title = "Atenção operacional") {
  const filteredWarnings = warnings.filter(Boolean);
  if (filteredWarnings.length === 0) return;

  const uniqueWarnings = [...new Set(filteredWarnings)];
  const firstWarning = uniqueWarnings[0];
  const category = classifyWarningMessage(firstWarning);
  const additionalCount = uniqueWarnings.length - 1;

  showFeedbackBanner({
    id: `warning-${category}-${firstWarning.slice(0, 24)}`,
    mode: "warning",
    tone: category === "warning" ? "warning" : "info",
    title,
    message: uniqueWarnings.length === 1
      ? buildFeedbackMessage(category, { seed: firstWarning, detail: firstWarning })
      : buildFeedbackMessage(category, {
          seed: firstWarning,
          detail: `${firstWarning}${additionalCount > 0 ? ` e mais ${additionalCount} aviso${additionalCount > 1 ? "s" : ""}` : ""}`
        }),
    detail: uniqueWarnings.length > 1
      ? uniqueWarnings.slice(0, 3).join(" ? ")
      : firstWarning,
    icon: toneIcon(category === "warning" ? "warning" : "info", 18)
  });
}

function setupPasswordVisibilityToggles() {
  const toggles = [
    { buttonId: "btn-protect-toggle-password", inputId: "protect-password" },
    { buttonId: "btn-unlock-toggle-password", inputId: "unlock-password" },
    { buttonId: "password-prompt-toggle", inputId: "password-prompt-input" }
  ];

  const ensurePasswordToggleMarkup = (button) => {
    if (!button || button.dataset.iconReady === "true") return;
    button.innerHTML = `
      <span class="password-visibility-icon" aria-hidden="true">
        <span class="password-visibility-icon--show">${icon("eye")}</span>
        <span class="password-visibility-icon--hide">${icon("eye-off")}</span>
      </span>
    `;
    button.dataset.iconReady = "true";
  };

  const updateToggleState = (button, input, visible) => {
    if (!button || !input) return;
    ensurePasswordToggleMarkup(button);
    input.type = visible ? "text" : "password";
    button.setAttribute("aria-pressed", visible ? "true" : "false");
    button.setAttribute("title", visible ? "Ocultar senha" : "Mostrar senha");
    button.setAttribute("aria-label", visible ? "Ocultar senha" : "Mostrar senha");
    button.classList.toggle("is-visible", visible);
  };

  toggles.forEach(({ buttonId, inputId }) => {
    const button = document.getElementById(buttonId);
    const input = document.getElementById(inputId);
    if (!button || !input || button.dataset.toggleReady === "true") return;

    updateToggleState(button, input, false);
    button.dataset.toggleReady = "true";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const shouldRestoreFocus = document.activeElement === input;
      const visible = input.type !== "password";
      updateToggleState(button, input, !visible);
      if (shouldRestoreFocus) {
        input.focus({ preventScroll: true });
        const end = input.value?.length || 0;
        try {
          input.setSelectionRange(end, end);
        } catch (_) {}
      }
    });
  });
}

function showValidationMessage(message) {
  notify({
    tone: "warning",
    title: "Ajuste rápido",
    message: buildFeedbackMessage("validation", { seed: message, detail: message })
  });
}

function normalizeOperationErrorMessage(type, error) {
  const rawMessage = typeof error === "string"
    ? error
    : error?.message || String(error || "");

  if (!rawMessage) {
    return "Não foi possível concluir a operação.";
  }

  const normalized = rawMessage.toLowerCase();
  const encryptedIssue = normalized.includes("encrypted")
    || normalized.includes("ignoreencryption")
    || normalized.includes("/encrypt")
    || normalized.includes("password protected")
    || normalized.includes("arquivo protegido")
    || normalized.includes("todos os arquivos deste lote estão protegidos");
  const unlockPathIssue = type === "unlock" && (
    rawMessage.includes("Error invoking remote method 'queue-operation'") ||
    rawMessage.includes("ERR_INVALID_ARG_TYPE") ||
    normalized.includes("invalid pdf path") ||
    normalized.includes("invalid input pdf path") ||
    normalized.includes("file is invalid") ||
    normalized.includes("file does not exist") ||
    normalized.includes("file is invalid or does not exist") ||
    normalized.includes("file is invalid, too large, or does not exist") ||
    normalized.includes("não foi possível abrir este pdf") ||
    normalized.includes("pdf inválido") ||
    normalized.includes("arquivo de entrada inválido") ||
    normalized.includes("arquivo de entrada inválido ou ausente") ||
    normalized.includes("arquivo não existe") ||
    normalized.includes("arquivo muito grande") ||
    normalized.includes("arquivo excede o limite") ||
    normalized.includes("size exceeds limit") ||
    normalized.includes("exceeds supported limit") ||
    normalized.includes("too large") ||
    normalized.includes("does not exist")
  );

  const mergeInputIssue = type === "merge" && (
    normalized.includes("não foi possível abrir este arquivo")
    || normalized.includes("não foi possível abrir o arquivo selecionado")
    || normalized.includes("arquivo de entrada inválido")
    || normalized.includes("arquivo de entrada inválido ou ausente")
    || normalized.includes("file is invalid")
    || normalized.includes("file does not exist")
    || normalized.includes("does not exist")
    || normalized.includes("invalid input pdf path")
    || normalized.includes("invalid pdf path")
  );

  const mergeNamedInputIssue = type === "merge"
    ? rawMessage.match(/Falha no arquivo\s*["']?([^"']+)["']?:\s*(.+)$/i)
    : null;

  if (type === "merge" && normalized.includes("não foi possível mesclar porque")) {
    return rawMessage;
  }

  if (mergeNamedInputIssue?.[1] && mergeNamedInputIssue?.[2]) {
    return `O arquivo "${mergeNamedInputIssue[1].trim()}" não pôde ser mesclado: ${mergeNamedInputIssue[2].trim()}`;
  }

  if (mergeInputIssue) {
    return "A mesclagem foi interrompida porque um dos arquivos não pôde ser lido. Confira se todos os PDFs ainda existem, não estão abertos exclusivamente em outro programa, corrompidos ou protegidos por senha; depois remova e adicione novamente o arquivo com problema.";
  }

  if (rawMessage.includes("Error invoking remote method 'queue-operation'")) {
    if (rawMessage.includes("ERR_INVALID_ARG_TYPE") || rawMessage.includes("Received undefined")) {
      return type === "unlock"
        ? "Não foi possível localizar ou abrir este PDF para desbloqueio. Selecione o arquivo novamente e tente outra vez."
        : "O documento enviado para processamento está inválido ou foi removido. Feche a tela, selecione o arquivo novamente e tente outra vez.";
    }
    return rawMessage.replace("Error invoking remote method 'queue-operation': ", "");
  }

  if (rawMessage.includes("ERR_INVALID_ARG_TYPE") && rawMessage.includes("path")) {
    return type === "unlock"
      ? "Não foi possível localizar ou abrir este PDF para desbloqueio. Selecione o arquivo novamente e tente outra vez."
      : "O documento enviado para processamento está inválido ou foi removido. Selecione o arquivo novamente e tente outra vez.";
  }

  if (unlockPathIssue) {
    return "Não foi possível abrir este PDF.";
  }

  if (encryptedIssue) {
    return type === "unlock"
      ? "Senha incorreta."
      : "Arquivo protegido.";
  }

  if (
    normalized.includes("invalid pdf path") ||
    normalized.includes("invalid input pdf path") ||
    normalized.includes("file is invalid") ||
    normalized.includes("file does not exist") ||
    normalized.includes("file is invalid or does not exist") ||
    normalized.includes("file is invalid, too large, or does not exist") ||
    normalized.includes("não foi possível abrir este pdf") ||
    normalized.includes("pdf inválido") ||
    normalized.includes("arquivo de entrada inválido") ||
    normalized.includes("arquivo de entrada inválido ou ausente") ||
    normalized.includes("arquivo não existe") ||
    normalized.includes("arquivo muito grande") ||
    normalized.includes("arquivo excede o limite") ||
    normalized.includes("size exceeds limit") ||
    normalized.includes("exceeds supported limit") ||
    normalized.includes("too large") ||
    normalized.includes("does not exist")
  ) {
    return "Não foi possível abrir o arquivo selecionado. Verifique se ele ainda existe, está acessível e não está protegido por senha.";
  }

  if (type === "unlock") {
    if (normalized.includes("senha incorreta") || normalized.includes("incorrect password") || normalized.includes("password")) {
      return "Senha incorreta.";
    }
    if (normalized.includes("não está protegido") || normalized.includes("not protected") || normalized.includes("/encrypt") || normalized.includes("não tem senha")) {
      return "Este PDF não está protegido por senha.";
    }
    if (normalized.includes("failed to fetch") || normalized.includes("fetch") || normalized.includes("wasm") || normalized.includes("qpdf")) {
      return "O mecanismo local de desbloqueio não carregou corretamente. Reinicie o app e tente novamente.";
    }
  }

  if (normalized.includes("invalid svg image")) {
    return "Imagem inválida.";
  }

  if (normalized.includes("cannot read properties of null")) {
    return "Não foi possível concluir a operação.";
  }

  return rawMessage.length > 160 ? "Não foi possível concluir a operação." : rawMessage;
}

function showOperationFailure(type, error) {
  const detail = normalizeOperationErrorMessage(type, error);
  // Uma falha não deve aparecer simultaneamente no banner persistente e no toast:
  // isso parece um erro duplicado e pode esconder a mensagem mais recente.
  clearFeedbackBanner();
  notify({
    id: `operation-error-${type}`,
    tone: "error",
    title: getOperationLabel(type),
    message: detail,
    important: true,
    duration: 6200
  });
}

function showOperationQueuedFeedback(type, result = {}) {
  notify({
    id: result.taskId ? `queue-pending-${result.taskId}` : undefined,
    tone: "info",
    title: `${getOperationLabel(type)} na fila`,
    message: "Tarefa adicionada à fila. O andamento aparece no painel de fila até a conclusão.",
    duration: 5200
  });

  if (result.warnings?.length) {
    showWarnings(result.warnings, `${getOperationLabel(type)} com avisos`);
    return;
  }

  clearFeedbackBanner("queue");
}

function getContextualIconSize(element) {
  if (element.classList.contains("nav-item")) return UI_ICON_SIZES.nav;
  if (element.classList.contains("btn-icon")) return UI_ICON_SIZES.button;
  if (element.classList.contains("btn-icon-label")) return UI_ICON_SIZES.button;
  if (element.classList.contains("quick-btn")) return UI_ICON_SIZES.quickAction;
  if (element.classList.contains("dropzone-prompt")) return UI_ICON_SIZES.dropzone;
  if (element.classList.contains("selected-file-icon")) return UI_ICON_SIZES.selectedFile;
  if (element.classList.contains("app-logo")) return UI_ICON_SIZES.appLogo;
  if (element.classList.contains("title-icon")) return UI_ICON_SIZES.pageTitle;
  if (element.classList.contains("section-title-icon")) return UI_ICON_SIZES.sectionTitle;
  return UI_ICON_SIZES.quickAction;
}

function renderNavItemIcon(button) {
  const name = button.getAttribute("data-icon");
  if (!name) return;
  const text = button.getAttribute("data-nav-label") || button.textContent.trim();
  const isActive = button.classList.contains("active");
  button.setAttribute("data-nav-label", text);

  let iconSlot = button.querySelector(".nav-icon");
  let labelSlot = button.querySelector(".nav-label");

  if (!iconSlot || !labelSlot) {
    button.textContent = "";
    iconSlot = document.createElement("span");
    iconSlot.className = "nav-icon";
    labelSlot = document.createElement("span");
    labelSlot.className = "nav-label";
    button.appendChild(iconSlot);
    button.appendChild(labelSlot);
  }

  iconSlot.innerHTML = lucideIconByState(name, { size: UI_ICON_SIZES.nav, active: isActive });
  labelSlot.textContent = text;
  button.title = text;
}

function hydrateStaticIcons() {
  document.querySelectorAll("[data-icon]").forEach((element) => {
    const name = element.getAttribute("data-icon");
    if (!name) return;

    if (element.classList.contains("nav-item")) {
      renderNavItemIcon(element);
      return;
    }

    if (element.classList.contains("help-nav-btn")) {
      const text = escapeHtml(element.textContent.trim());
      const isActive = element.classList.contains("active");
      element.innerHTML = `${lucideIconByState(name, { size: 18, active: isActive })}<span style="margin-left: 8px;">${text}</span>`;
      return;
    }

    if (element.classList.contains("quick-btn")) {
      const title = element.querySelector("h3")?.outerHTML || "";
      const description = element.querySelector("p")?.outerHTML || "";
      element.innerHTML = `
        <div class="quick-btn-header">
          ${icon(name, { size: getContextualIconSize(element), filled: true })}
          ${title}
        </div>
        ${description}
      `;
      return;
    }

    if (element.classList.contains("dropzone-prompt")) {
      const title = element.querySelector("h3")?.outerHTML || "";
      const description = element.querySelector("p")?.outerHTML || "";
      element.innerHTML = `${icon(name, { size: getContextualIconSize(element) })}${title}${description}`;
      return;
    }

    if (element.classList.contains("btn-icon-label")) {
      const label = element.textContent.trim();
      if (label && !element.hasAttribute("aria-label")) element.setAttribute("aria-label", label);
      if (label && !element.hasAttribute("title")) element.setAttribute("title", label);
      const text = escapeHtml(label);
      element.innerHTML = `${icon(name, {
        size: getContextualIconSize(element),
        filled: element.classList.contains("btn-primary")
      })}<span>${text}</span>`;
      return;
    }

    if (element.classList.contains("section-title-icon")) {
      element.innerHTML = icon(name, { size: getContextualIconSize(element), filled: true });
      return;
    }

    element.innerHTML = icon(name, {
      size: getContextualIconSize(element),
      filled: element.classList.contains("app-logo")
    });
  });
}

async function loadAppConfig() {
  try {
    state.appConfig = await window.api.getConfig();
    applyTheme(state.appConfig.theme);
    applyColorTheme(state.appConfig.colorTheme || "blue");

    const outDirInput = document.getElementById("setting-output-dir");
    const clearOutDirBtn = document.getElementById("btn-clear-output-dir");
    outDirInput.value = state.appConfig.defaultOutputDir || "";
    outDirInput.title = state.appConfig.defaultOutputDir || "Salvar na pasta de origem";
    clearOutDirBtn.classList.toggle("hidden", !state.appConfig.defaultOutputDir);

    document.getElementById("setting-theme").value = state.appConfig.theme;
    document.getElementById("setting-color-theme").value = state.appConfig.colorTheme || "blue";
    document.getElementById("setting-open-output-automatically").checked = state.appConfig.openOutputAutomatically === true;

    const runModeSpan = document.getElementById("setting-run-mode");
    runModeSpan.textContent = state.appConfig.isPortableMode ? "Portátil" : "Instalado";
    runModeSpan.className = `status-badge${state.appConfig.isPortableMode ? " success" : ""}`;
    updateDashboardThemeButton();
    updateDashboardDefaultDirButton();
    updateDashboardSummary();
    updateSavePathHints();
  } catch (error) {
    console.error("Falha ao carregar configuração:", error);
  }
}


function updateSavePathHints() {
  const currentDir = state.appConfig?.defaultOutputDir;
  const hintText = currentDir
    ? `Salvo em: ${currentDir}`
    : "Salvo na mesma pasta do arquivo de origem (altere em Configurações)";

  const filenameInputIds = [
    "images-pdf-output-name",
    "merge-output-name",
    "signature-output-name",
    "pdf-to-word-output-name",
    "split-output-prefix",
    "organize-output-name",
    "watermark-output-suffix",
    "compress-output-name",
    "protect-output-name",
    "unlock-output-name",
    "redact-output-name",
    "ocr-output-name"
  ];

  filenameInputIds.forEach((id) => {
    const input = document.getElementById(id);
    if (!input) return;

    const inputGroup = input.closest(".input-group") || input.parentNode;
    let actionBar = input.closest(".action-bar-settings");

    if (!actionBar && id === "unlock-output-name") {
      const unlockContainer = document.getElementById("unlock-settings-container");
      const unlockActionBar = unlockContainer?.querySelector(".action-bar-settings");
      if (unlockActionBar) {
        actionBar = unlockActionBar;
        if (inputGroup.parentNode !== unlockActionBar) {
          unlockActionBar.insertBefore(inputGroup, unlockActionBar.firstChild);
        }
      }
    }

    let hint = actionBar?.querySelector(`.save-path-hint[data-input-id="${id}"]`)
      || inputGroup.querySelector(".save-path-hint");

    if (!hint) {
      hint = document.createElement("div");
      hint.className = "save-path-hint";
    }

    const operationByInputId = {
      "images-pdf-output-name": "images-to-pdf",
      "merge-output-name": "merge",
      "signature-output-name": "sign",
      "pdf-to-word-output-name": "pdf-to-word",
      "split-output-prefix": "split-pages",
      "organize-output-name": "organize",
      "watermark-output-suffix": "watermark",
      "compress-output-name": "compress",
      "protect-output-name": "protect",
      "unlock-output-name": "unlock",
      "redact-output-name": "redact",
      "ocr-output-name": "ocr"
    };
    const operationType = operationByInputId[id];
    let controls = inputGroup.querySelector(".output-name-controls");
    if (!controls && operationType) {
      controls = document.createElement("div");
      controls.className = "output-name-controls";
      input.parentNode.insertBefore(controls, input);
      controls.appendChild(input);

      const changeFolderButton = document.createElement("button");
      changeFolderButton.type = "button";
      changeFolderButton.className = "btn-secondary btn-sm btn-icon-label output-folder-button";
      changeFolderButton.title = "Alterar a saída desta operação";
      changeFolderButton.setAttribute("aria-label", "Alterar saída desta operação");
      changeFolderButton.innerHTML = `${icon("folder-open")}<span>Alterar saída</span>`;
      changeFolderButton.addEventListener("click", async () => {
        const directory = await window.api.selectDirectory();
        if (!directory) return;
        state.operationOutputDirs[operationType] = directory;
        updateSavePathHints();
      });
      controls.appendChild(changeFolderButton);
    }

    hint.dataset.inputId = id;

    if (actionBar) {
      actionBar.classList.add("action-bar-settings--output-layout", "module-output-dock");
      actionBar.setAttribute("aria-label", "Opções de saída e ação principal");
      if (hint.parentNode !== actionBar) {
        actionBar.appendChild(hint);
      }
    } else if (hint.parentNode !== inputGroup) {
      inputGroup.appendChild(hint);
    }

    const oneOffDirectory = operationType ? state.operationOutputDirs[operationType] : "";
    const effectiveHintText = oneOffDirectory
      ? `Destino desta operação: ${oneOffDirectory}`
      : hintText;
    hint.textContent = typeof normalizeMojibakeText === "function"
      ? normalizeMojibakeText(effectiveHintText)
      : hintText;
  });
}

let routedQueueOperation = null;

function queueOperation(payload) {
  const operation = routedQueueOperation || window.api?.queueOperation;
  if (typeof operation !== "function") {
    return Promise.reject(new Error("Canal de processamento indisponível."));
  }
  return operation(payload);
}

function setupOneOffOutputDirectoryRouting() {
  if (!window.api?.queueOperation || routedQueueOperation) return;
  const originalQueueOperation = window.api.queueOperation.bind(window.api);
  const routedOperation = async (payload) => {
    const operationType = payload?.type;
    const outputDirectoryKey = operationType?.startsWith("split-") ? "split-pages" : operationType;
    const selectedDirectory = outputDirectoryKey ? state.operationOutputDirs[outputDirectoryKey] : "";
    const routedPayload = selectedDirectory
      ? {
          ...payload,
          options: { ...(payload.options || {}), outputDir: selectedDirectory }
        }
      : payload;
    const result = await originalQueueOperation(routedPayload);
    if (result?.success && outputDirectoryKey && selectedDirectory) {
      delete state.operationOutputDirs[outputDirectoryKey];
      updateSavePathHints();
    }
    return result;
  };
  routedQueueOperation = routedOperation;
}

function normalizeMojibakeText(text) {
  if (!text || typeof text !== "string") return text;

  const replacements = [
    ["Configura\u00c3\u00a7\u00c3\u00b5es", "Configura\u00e7\u00f5es"],
    ["Configura\u00c3\u00a7\u00c3\u00a3o", "Configura\u00e7\u00e3o"],
    ["aplica\u00c3\u00a7\u00c3\u00a3o", "aplica\u00e7\u00e3o"],
    ["A\u00c3\u00a7\u00c3\u00a3o", "A\u00e7\u00e3o"],
    ["a\u00c3\u00a7\u00c3\u00a3o", "a\u00e7\u00e3o"],
    ["n\u00c3\u00a3o", "n\u00e3o"],
    ["N\u00c3\u00a3o", "N\u00e3o"],
    ["est\u00c3\u00a1", "est\u00e1"],
    ["Pr\u00c3\u00a9", "Pr\u00e9"],
    ["P\u00c3\u00a1ginas", "P\u00e1ginas"],
    ["p\u00c3\u00a1ginas", "p\u00e1ginas"],
    ["P\u00c3\u00a1gina", "P\u00e1gina"],
    ["p\u00c3\u00a1gina", "p\u00e1gina"],
    ["sum\u00c3\u00a1rio", "sum\u00e1rio"],
    ["t\u00c3\u00b3pico", "t\u00f3pico"],
    ["come\u00c3\u00a7ar", "come\u00e7ar"],
    ["restri\u00c3\u00a7\u00c3\u00b5es", "restri\u00e7\u00f5es"],
    ["permiss\u00c3\u00b5es", "permiss\u00f5es"],
    ["Oculta\u00c3\u00a7\u00c3\u00a3o", "Oculta\u00e7\u00e3o"],
    ["extra\u00c3\u00a7\u00c3\u00a3o", "extra\u00e7\u00e3o"],
    ["Sa\u00c3\u00adda", "Sa\u00edda"],
    ["\u00c3\u00baltima", "\u00faltima"],
    ["Exclu\u00c3\u00adda", "Exclu\u00edda"],
    ["Port\u00c3\u00a1til", "Port\u00e1til"],
    ["Seguran\u00c3\u00a7a", "Seguran\u00e7a"],
    ["Convers\u00c3\u00a3o", "Convers\u00e3o"],
    ["Come\u00c3\u00a7ar", "Come\u00e7ar"],
    ["oculta\u003f\u003fo", "ocultação"],
    ["\u00c3\u00a1", "\u00e1"],
    ["\u00c3\u00a9", "\u00e9"],
    ["\u00c3\u00aa", "\u00ea"],
    ["\u00c3\u00a3", "\u00e3"],
    ["\u00c3\u00b5", "\u00f5"],
    ["\u00c3\u00a7", "\u00e7"],
    ["\u00c3\u00ad", "\u00ed"],
    ["\u00c3\u00b3", "\u00f3"],
    ["\u00c3\u00ba", "\u00fa"],
    ["\u00c3\u00a0", "\u00e0"]
  ];

  let result = text;
  replacements.forEach(([from, to]) => {
    result = result.split(from).join(to);
  });
  return result;
}

function repairVisibleMojibake(root = document.body) {
  if (!root) return;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  while (walker.nextNode()) {
    textNodes.push(walker.currentNode);
  }
  textNodes.forEach((node) => {
    const fixed = normalizeMojibakeText(node.nodeValue);
    if (fixed !== node.nodeValue) {
      node.nodeValue = fixed;
    }
  });

  root.querySelectorAll?.("[title],[aria-label],[placeholder]").forEach((element) => {
    ["title", "aria-label", "placeholder"].forEach((attr) => {
      const value = element.getAttribute(attr);
      if (!value) return;
      const fixed = normalizeMojibakeText(value);
      if (fixed !== value) {
        element.setAttribute(attr, fixed);
      }
    });
  });
}

  async function loadAppMeta() {
    try {
      state.appMeta = await window.api.getAppMeta();
      const versionText = state.appMeta?.releaseVersion ? `Central PDF • ${state.appMeta.releaseVersion}` : "Central PDF";
      document.title = versionText;
    const appVersionBadge = document.getElementById("app-version-badge");
    const settingAppVersion = document.getElementById("setting-app-version");
    if (appVersionBadge) {
      appVersionBadge.textContent = versionText;
    }
      if (settingAppVersion) {
        settingAppVersion.textContent = versionText;
        settingAppVersion.title = `Build ${state.appMeta?.buildLabel || "-"}`;
      }
      applySignatureUserDefaults();
      updateDashboardGreeting();
    } catch (error) {
      console.error("Falha ao carregar metadados da aplicação:", error);
    }
  }

function getEffectiveTheme(theme = state.appConfig?.theme || "system") {
  if (theme === "light" || theme === "dark") return theme;
  return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light";
}

function syncSystemThemeState() {
  const configuredTheme = state.appConfig?.theme || "system";
  const effectiveTheme = getEffectiveTheme(configuredTheme);
  document.body.dataset.effectiveTheme = effectiveTheme;
  document.documentElement.style.colorScheme = effectiveTheme;
  document.body.classList.toggle("theme-system-dark", configuredTheme === "system" && effectiveTheme === "dark");
  document.body.classList.toggle("theme-system-light", configuredTheme === "system" && effectiveTheme === "light");
  if (configuredTheme === "system") updateDashboardThemeButton();
}

function applySystemAccentColor(appearance = {}) {
  const accentColor = String(appearance.accentColor || "").trim();
  if (/^#[0-9a-f]{6}$/i.test(accentColor)) {
    systemAppearance = { ...systemAppearance, ...appearance, accentColor };
    document.body.style.setProperty("--system-accent-color", accentColor);
  }
  if (state.appConfig?.theme === "system" && state.appConfig?.colorTheme === "random") {
    applyColorTheme("random");
  }
}

function setupSystemThemeSync() {
  if (!window.matchMedia || systemThemeMediaQuery) return;
  systemThemeMediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  const handleSystemThemeChange = () => syncSystemThemeState();
  if (typeof systemThemeMediaQuery.addEventListener === "function") {
    systemThemeMediaQuery.addEventListener("change", handleSystemThemeChange);
  } else {
    systemThemeMediaQuery.addListener(handleSystemThemeChange);
  }
  syncSystemThemeState();
  window.api?.getSystemAppearance?.().then(applySystemAccentColor).catch(() => {});
  window.api?.onSystemAppearanceUpdated?.(applySystemAccentColor);
}

function applyTheme(theme) {
  document.body.classList.remove("theme-light", "theme-dark", "theme-system");
  if (theme === "dark") {
    document.body.classList.add("theme-dark");
  } else if (theme === "light") {
    document.body.classList.add("theme-light");
  } else {
    document.body.classList.add("theme-system");
  }
  syncSystemThemeState();
}

function applyColorTheme(color) {
  document.body.classList.remove("theme-color-blue", "theme-color-red", "theme-color-olive", "theme-color-violet");
  const palette = ["blue", "red", "olive", "violet"];
  if (color === "random" && state.appConfig?.theme === "system" && systemAppearance.accentColor) {
    state.runtimeColorTheme = "system";
    color = "system";
  } else if (color === "random") {
    const picked = palette[Math.floor(Math.random() * palette.length)] || "blue";
    state.runtimeColorTheme = picked;
    color = picked;
  } else {
    state.runtimeColorTheme = color || "blue";
  }
  if (color && color !== "blue" && color !== "system") {
    document.body.classList.add(`theme-color-${color}`);
  }
  document.body.classList.toggle("theme-color-system", color === "system");
}

function getGreetingLabel(date = new Date()) {
  const hour = date.getHours();
  const prefix = hour < 12 ? "Bom dia" : hour < 18 ? "Boa tarde" : "Boa noite";
  const currentUser = String(state.appMeta?.currentUser || "").trim();
  return currentUser ? `${prefix}, ${currentUser}` : "Bem-vindo ao Central PDF";
}

  function updateDashboardGreeting() {
    const welcome = document.getElementById("dashboard-welcome");
    const subtitle = document.getElementById("dashboard-subtitle");
    if (welcome) welcome.textContent = getGreetingLabel();
    if (subtitle) subtitle.textContent = "O que deseja fazer hoje?";
  }

  function applySignatureUserDefaults() {
    const userName = state.appMeta?.currentUser || "";
    if (!userName) return;

    const typedNameInput = document.getElementById("signature-typed-name");
    const initialsInput = document.getElementById("signature-initials");

    if (typedNameInput && !typedNameInput.value.trim()) {
      typedNameInput.value = userName;
    }

    if (initialsInput && !initialsInput.value.trim()) {
      const initials = userName
        .split(/\s+/)
        .filter(Boolean)
        .map((part) => part.charAt(0))
        .join("")
        .slice(0, 4)
        .toUpperCase();
      initialsInput.value = initials || userName.slice(0, 2).toUpperCase();
    }
  }

function updateDashboardThemeButton() {
  const button = document.getElementById("btn-dashboard-theme-toggle");
  if (!button) return;
  const currentTheme = state.appConfig?.theme || "system";
  if (currentTheme === "system") {
    button.innerHTML = lucideIcon("desktop", { size: 20 });
    button.title = "Tema: Sistema (clique para mudar para tema Claro)";
  } else if (currentTheme === "light") {
    button.innerHTML = lucideIcon("weather-sunny", { size: 20 });
    button.title = "Tema: Claro (clique para mudar para tema Escuro)";
  } else {
    button.innerHTML = lucideIcon("weather-moon", { size: 20 });
    button.title = "Tema: Escuro (clique para mudar para tema do Sistema)";
  }
}

function getDashboardDestinationTarget() {
  const defaultDir = state.appConfig?.defaultOutputDir?.trim() || "";
  if (defaultDir) return { path: defaultDir, source: "default" };

  const historyItems = Array.isArray(state.appConfig?.recentHistory) ? state.appConfig.recentHistory : [];
  for (const item of historyItems) {
    if (item?.status !== "sucesso") continue;
    const outputDir = String(item.outputDir || "").trim();
    if (outputDir) return { path: outputDir, source: "recent" };

    const outputPath = String(item.outputPath || item.firstOutputPath || "").trim();
    const separatorIndex = Math.max(outputPath.lastIndexOf("\\"), outputPath.lastIndexOf("/"));
    if (separatorIndex > 0) return { path: outputPath.slice(0, separatorIndex), source: "recent" };
  }

  return null;
}

function updateDashboardDefaultDirButton() {
  const button = document.getElementById("btn-dashboard-open-default-dir");
  if (!button) return;

  const target = getDashboardDestinationTarget();
  button.disabled = !target;
  button.title = target?.source === "default"
    ? `Abrir pasta padrão de destino\n${target.path}`
    : target
      ? `Abrir pasta do último arquivo gerado\n${target.path}`
      : "Nenhuma pasta disponível. Processe um arquivo ou defina uma pasta padrão.";
  button.setAttribute("aria-label", target?.source === "default"
    ? `Abrir pasta padrão de destino: ${target.path}`
    : target
      ? `Abrir pasta do último arquivo gerado: ${target.path}`
      : "Nenhuma pasta disponível ainda");
  button.innerHTML = lucideIcon("folder-open", { size: 20 });
  return;

  /* Lógica anterior mantida comentada durante a transição para o destino contextual.
  const defaultDir = state.appConfig?.defaultOutputDir || "";
  button.disabled = !defaultDir;
  button.title = defaultDir
    ? `Abrir a pasta personalizada de destino\n${defaultDir}`
    : "Sem pasta personalizada: os arquivos serão salvos na pasta de origem";
  button.setAttribute("aria-label", defaultDir
    ? `Abrir pasta personalizada: ${defaultDir}`
    : "Arquivos salvos na pasta de origem; nenhuma pasta personalizada cadastrada");
  button.innerHTML = lucideIcon("folder-open", { size: 20 });
  */
}

function updateDashboardSummary() {
  const countNode = document.getElementById("dashboard-processed-count");
  const historyButton = document.getElementById("btn-dashboard-processed-history");
  if (!countNode) return;

  const historyItems = state.appConfig?.recentHistory || [];
  const successCount = historyItems.filter((item) => item.status === "sucesso").length;

  countNode.textContent = String(successCount);
  if (historyButton) {
    historyButton.title = historyItems.length > 0
      ? `Abrir suas últimas atividades (${historyItems.length} item${historyItems.length > 1 ? "s" : ""})`
      : "Abrir suas últimas atividades";
    historyButton.setAttribute("aria-label", historyButton.title);
    historyButton.setAttribute("aria-expanded", "false");
  }

  const detailNode = document.getElementById("dashboard-processed-detail");
  if (!detailNode) return;

  const failureCount = historyItems.filter((item) => item.status === "falha").length;
  if (historyItems.length === 0) {
    detailNode.textContent = "Nenhum arquivo concluído ainda";
    return;
  }

  detailNode.textContent = failureCount > 0
    ? `${successCount} concluídos e ${failureCount} com falha`
    : `${successCount} arquivos concluídos recentemente`;

  sortDashboardQuickCards();
}
function normalizeQuickActionKey(value) {
  const normalized = String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  if (normalized.includes('image') && normalized.includes('pdf')) return 'images-to-pdf';
  if (normalized.includes('mesclar') || normalized.includes('merge') || normalized.includes('juntar')) return 'merge';
  if (normalized.includes('separar') || normalized.includes('split') || normalized.includes('divid')) return 'split';
  if (normalized.includes('assinar') || normalized.includes('signature')) return 'signature';
  if (normalized.includes('word') || normalized.includes('docx') || normalized.includes('converter')) return 'pdf-to-word';
  if (normalized.includes('organizar')) return 'organize';
  if (normalized.includes('marca') || normalized.includes('watermark')) return 'watermark';
  if (normalized.includes('comprimir') || normalized.includes('compress')) return 'compress';
  if (normalized.includes('proteger') || normalized.includes('protect')) return 'protect';
  if (normalized.includes('desbloquear') || normalized.includes('unlock')) return 'unlock';
  if (normalized.includes('ocultar') || normalized.includes('redact')) return 'redact';
  return '';
}

function getDashboardQuickActionStats() {
  const historyItems = state.appConfig?.recentHistory || [];
  const stats = new Map();

  historyItems.forEach((item, index) => {
    const key = normalizeQuickActionKey(item?.action);
    if (!key) return;
    const current = stats.get(key) || { count: 0, lastUsedIndex: -1 };
    current.count += 1;
    current.lastUsedIndex = Math.max(current.lastUsedIndex, index);
    stats.set(key, current);
  });

  return stats;
}

function sortDashboardQuickCards() {
  const grid = document.querySelector('.quick-grid-dashboard');
  if (!grid) return;

  const stats = getDashboardQuickActionStats();
  const cards = [...grid.querySelectorAll('.quick-btn')];
  const fallbackOrder = new Map(DASHBOARD_QUICK_ACTION_DEFAULT_ORDER.map((key, index) => [key, index]));

  cards.sort((left, right) => {
    const leftKey = left.getAttribute('data-go-tab') || '';
    const rightKey = right.getAttribute('data-go-tab') || '';
    const leftStats = stats.get(leftKey) || { count: 0, lastUsedIndex: -1 };
    const rightStats = stats.get(rightKey) || { count: 0, lastUsedIndex: -1 };

    if (leftStats.count !== rightStats.count) {
      return rightStats.count - leftStats.count;
    }

    if (leftStats.lastUsedIndex !== rightStats.lastUsedIndex) {
      return rightStats.lastUsedIndex - leftStats.lastUsedIndex;
    }

    const leftOrder = fallbackOrder.has(leftKey) ? fallbackOrder.get(leftKey) : Number.MAX_SAFE_INTEGER;
    const rightOrder = fallbackOrder.has(rightKey) ? fallbackOrder.get(rightKey) : Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder;
  });

  cards.forEach((card) => grid.appendChild(card));
}

function setDashboardSelectedPdfFile(file) {
  state.dashboardSelectedPdfFile = file || null;
  const fileNameNode = document.getElementById("dashboard-selected-file-name");
  const fileMetaNode = document.getElementById("dashboard-selected-file-meta");
  if (!fileNameNode || !fileMetaNode) return;

  if (!file) {
    fileNameNode.textContent = "Arraste seu arquivo aqui";
    fileMetaNode.textContent = "PDF, JPG, JPEG ou PNG";
    return;
  }

  fileNameNode.textContent = file.name;
  fileMetaNode.textContent = formatBytes(file.size);
}

function getDashboardAcceptedExtensions(action) {
  if (action === "ocr") return ".pdf,.jpg,.jpeg,.png,.tif,.tiff";
  if (action === "images-to-pdf") return ".jpg,.jpeg,.png,.docx,.xlsx";
  if (["organize", "merge", "compress", "watermark", "redact"].includes(action)) {
    return ".pdf,.jpg,.jpeg,.png";
  }
  return ".pdf";
}

function matchesDashboardAction(file, action) {
  const name = String(file?.name || "").toLowerCase();
  if (!name) return false;
  if (action === "ocr") return /\.(pdf|jpg|jpeg|png|tif|tiff)$/i.test(name);
  if (action === "images-to-pdf") return /\.(jpg|jpeg|png|docx|xlsx)$/i.test(name);
  if (["organize", "merge", "compress", "watermark", "redact"].includes(action)) {
    return /\.(pdf|jpg|jpeg|png)$/i.test(name);
  }
  return /\.pdf$/i.test(name);
}

const DASHBOARD_RECENT_FILE_EXTENSIONS = [".pdf", ".jpg", ".jpeg", ".png", ".tif", ".tiff", ".docx", ".xlsx"];
const DASHBOARD_RECENT_MODULES = {
  organize: "Organizar páginas",
  merge: "Mesclar PDFs",
  split: "Separar PDF",
  signature: "Assinar PDF",
  "pdf-to-word": "PDF para Word",
  ocr: "Reconhecer texto (OCR)",
  "images-to-pdf": "Converter para PDF",
  protect: "Proteger PDF",
  unlock: "Desbloquear PDF",
  compress: "Reduzir tamanho",
  watermark: "Marca d’água",
  redact: "Ocultar dados"
};
let dashboardRecentFilesRequestVersion = 0;
let dashboardRecentMenuDismissBound = false;

function getDashboardRecentFileActions(fileName) {
  const extension = String(fileName || "").toLowerCase().match(/\.[^.]+$/)?.[0] || "";
  if (extension === ".pdf") return Object.keys(DASHBOARD_RECENT_MODULES).filter((action) => action !== "images-to-pdf");
  if ([".jpg", ".jpeg", ".png"].includes(extension)) {
    return ["images-to-pdf", "organize", "merge", "ocr", "compress", "watermark", "redact"];
  }
  if ([".tif", ".tiff"].includes(extension)) return ["ocr"];
  if ([".docx", ".xlsx"].includes(extension)) return ["images-to-pdf"];
  return [];
}

async function refreshDashboardRecentFiles() {
  const list = document.getElementById("dashboard-recent-files-list");
  const status = document.getElementById("dashboard-recent-files-status");
  const refreshButton = document.getElementById("btn-dashboard-refresh-recent-files");
  if (!list || !status) return;

  const requestVersion = ++dashboardRecentFilesRequestVersion;
  if (refreshButton) refreshButton.disabled = true;
  status.textContent = "Procurando arquivos recentes…";
  list.replaceChildren();
  try {
    const result = await window.api?.findRecentUploadFiles?.(DASHBOARD_RECENT_FILE_EXTENSIONS);
    if (requestVersion !== dashboardRecentFilesRequestVersion) return;
    if (result?.success === false) throw new Error(result.error || "A busca de arquivos recentes falhou.");
    const files = Array.isArray(result?.files) ? result.files.slice(0, 6) : [];
    if (!files.length) {
      status.textContent = "Nenhum arquivo compatível foi encontrado recentemente. Abra ou modifique um PDF ou documento para ele aparecer aqui.";
      return;
    }

    status.textContent = `${files.length} arquivo${files.length === 1 ? " recente" : "s recentes"} encontrado${files.length === 1 ? "" : "s"}.`;
    list.innerHTML = files.map((file, index) => {
      const filePath = String(file?.path || "");
      const name = String(file?.name || filePath.split(/[\\/]/).pop() || "Arquivo recente");
      const location = filePath.replace(/[\\/][^\\/]*$/, "") || filePath;
      const actions = getDashboardRecentFileActions(name);
      const initialAction = actions[0] || "";
      const actionOptions = actions.map((action) => `<button class="dashboard-recent-module-option" type="button" role="menuitemradio" aria-checked="${action === initialAction}" data-dashboard-recent-option="${index}" data-module-action="${action}">${escapeHtml(DASHBOARD_RECENT_MODULES[action])}</button>`).join("");
      const modifiedAt = new Date(file?.modifiedAt);
      const modifiedText = Number.isNaN(modifiedAt.getTime()) ? "Data indisponível" : modifiedAt.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
      return `<article class="dashboard-recent-file" data-dashboard-recent-index="${index}" data-selected-action="${initialAction}">
        <span class="dashboard-recent-file-icon" data-icon="file-text" aria-hidden="true"></span>
        <div class="dashboard-recent-file-copy">
          <strong class="dashboard-recent-file-name" title="${escapeHtml(name)}">${escapeHtml(name)}</strong>
          <span class="dashboard-recent-file-location" title="${escapeHtml(filePath)}">${escapeHtml(location)}</span>
          <span class="dashboard-recent-file-meta">${escapeHtml(formatBytes(Number(file?.size) || 0))} <span aria-hidden="true">·</span> ${escapeHtml(modifiedText)}</span>
        </div>
        <div class="dashboard-recent-file-actions">
          <div class="dashboard-recent-module-picker">
            <button class="dashboard-recent-module-trigger" type="button" data-dashboard-recent-toggle="${index}" aria-haspopup="menu" aria-expanded="false" aria-label="Escolher módulo para ${escapeHtml(name)}">
              <span data-dashboard-recent-selected>${escapeHtml(DASHBOARD_RECENT_MODULES[initialAction] || "Escolher módulo")}</span><span data-icon="chevron-down" aria-hidden="true"></span>
            </button>
            <div class="dashboard-recent-module-menu hidden" role="menu" aria-label="Módulos compatíveis">${actionOptions}</div>
          </div>
          <button class="btn-primary btn-sm btn-icon-label" type="button" data-dashboard-recent-open="${index}" data-icon="arrow-right">Abrir</button>
          <button class="btn-secondary btn-sm btn-icon" type="button" data-dashboard-recent-reveal="${index}" data-icon="folder-open" aria-label="Mostrar ${escapeHtml(name)} na pasta" title="Mostrar na pasta"></button>
        </div>
      </article>`;
    }).join("");

    list.querySelectorAll("[data-icon]").forEach((node) => {
      node.innerHTML = lucideIcon(node.getAttribute("data-icon"), { size: 17 });
    });
    list.querySelectorAll("[data-dashboard-recent-toggle]").forEach((trigger) => {
      trigger.addEventListener("click", () => {
        const article = trigger.closest(".dashboard-recent-file");
        const menu = article?.querySelector(".dashboard-recent-module-menu");
        const shouldOpen = Boolean(menu?.classList.contains("hidden"));
        list.querySelectorAll(".dashboard-recent-module-menu").forEach((item) => item.classList.add("hidden"));
        list.querySelectorAll("[data-dashboard-recent-toggle]").forEach((item) => item.setAttribute("aria-expanded", "false"));
        if (shouldOpen && menu) {
          menu.classList.remove("hidden");
          trigger.setAttribute("aria-expanded", "true");
        }
      });
    });
    list.querySelectorAll("[data-dashboard-recent-option]").forEach((option) => {
      option.addEventListener("click", () => {
        const article = option.closest(".dashboard-recent-file");
        const trigger = article?.querySelector("[data-dashboard-recent-toggle]");
        const menu = article?.querySelector(".dashboard-recent-module-menu");
        const selectedAction = option.dataset.moduleAction || "";
        if (!article || !trigger || !DASHBOARD_RECENT_MODULES[selectedAction]) return;
        article.dataset.selectedAction = selectedAction;
        trigger.querySelector("[data-dashboard-recent-selected]").textContent = DASHBOARD_RECENT_MODULES[selectedAction];
        menu?.querySelectorAll("[data-dashboard-recent-option]").forEach((item) => {
          item.setAttribute("aria-checked", String(item === option));
        });
        menu?.classList.add("hidden");
        trigger.setAttribute("aria-expanded", "false");
        trigger.focus();
      });
    });
    if (!dashboardRecentMenuDismissBound) {
      document.addEventListener("click", (event) => {
        if (event.target.closest(".dashboard-recent-module-picker")) return;
        document.querySelectorAll(".dashboard-recent-module-menu").forEach((menu) => menu.classList.add("hidden"));
        document.querySelectorAll("[data-dashboard-recent-toggle]").forEach((trigger) => trigger.setAttribute("aria-expanded", "false"));
      });
      document.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        const openMenu = document.querySelector(".dashboard-recent-module-menu:not(.hidden)");
        if (!openMenu) return;
        const trigger = openMenu.closest(".dashboard-recent-module-picker")?.querySelector("[data-dashboard-recent-toggle]");
        openMenu.classList.add("hidden");
        trigger?.setAttribute("aria-expanded", "false");
        trigger?.focus();
      });
      dashboardRecentMenuDismissBound = true;
    }
    list.querySelectorAll("[data-dashboard-recent-open]").forEach((button) => {
      button.addEventListener("click", async () => {
        const index = Number(button.dataset.dashboardRecentOpen);
        const file = files[index];
        const action = button.closest(".dashboard-recent-file")?.dataset.selectedAction;
        if (!file || !action || !matchesDashboardAction(file, action)) {
          notify({ tone: "warning", title: "Módulo incompatível", message: "Escolha um módulo que aceite este formato de arquivo." });
          return;
        }
        button.disabled = true;
        try {
          const info = await window.api?.getFileInfo?.(String(file.path || ""));
          if (!info?.success) {
            status.textContent = "Esse arquivo não está mais disponível. Atualize a lista e tente novamente.";
            return;
          }
          await routeDashboardSelectedFile(toLaunchFileLike({ path: info.path, name: info.name, size: info.size }), action);
        } catch (error) {
          notify({ tone: "error", title: "Não foi possível abrir o arquivo", message: error?.message || "Tente novamente." });
        } finally {
          button.disabled = false;
        }
      });
    });
    list.querySelectorAll("[data-dashboard-recent-reveal]").forEach((button) => {
      button.addEventListener("click", async () => {
        const file = files[Number(button.dataset.dashboardRecentReveal)];
        const result = await window.api?.revealPath?.(String(file?.path || ""));
        if (!result?.success) notify({ tone: "error", title: "Localizar arquivo", message: result?.error || "Não foi possível abrir a localização." });
      });
    });
  } catch (error) {
    if (requestVersion !== dashboardRecentFilesRequestVersion) return;
    status.textContent = error?.message || "Não foi possível buscar arquivos recentes.";
  } finally {
    if (requestVersion === dashboardRecentFilesRequestVersion && refreshButton) refreshButton.disabled = false;
  }
}

async function routeDashboardSelectedFile(file, action) {
  if (!file) return;

  const preflightType = getSingleFilePreflightType(action);
  if (preflightType && !(await preflightSingleFile(file, preflightType))) return;

  ensureModuleSetup(action);
  switchTab(action, { skipGuard: true });

  if (action === "merge") {
    handleMergeFiles([file]);
  } else if (action === "split") {
    handleSplitFile(file);
  } else if (action === "organize") {
    await organizeWorkspace.handleOrganizeFile(file);
  } else if (action === "signature") {
    await signatureWorkspace.handleSignatureFile(file);
  } else if (action === "protect") {
    await protectWorkspace.handleProtectFile(file);
  } else if (action === "redact") {
    await redactWorkspace.handleRedactFile(file);
  } else if (action === "pdf-to-word") {
    await pdfToWordWorkspace.handleFile(file);
  } else if (action === "compress") {
    handleCompressFile(file);
  } else if (action === "watermark") {
    await watermarkWorkspace.handleFiles([file]);
  } else if (action === "unlock") {
    await unlockWorkspace.handleUnlockFile(file);
  } else if (action === "ocr") {
    await handleOcrFiles([file]);
  } else if (action === "images-to-pdf") {
    await imageToPdfWorkspace.addImageFiles([file]);
  }

  hideRecentFilesCard(action);
  setDashboardSelectedPdfFile(null);
}

async function cycleDashboardTheme() {
  const order = ["system", "light", "dark"];
  const currentTheme = state.appConfig?.theme || "system";
  const nextTheme = order[(order.indexOf(currentTheme) + 1) % order.length];
  await window.api.updateTheme(nextTheme);
  state.appConfig.theme = nextTheme;
  applyTheme(nextTheme);
  const settingsTheme = document.getElementById("setting-theme");
  if (settingsTheme) settingsTheme.value = nextTheme;
  updateDashboardThemeButton();
}

async function openDashboardSelectedAction() {
  const file = state.dashboardSelectedPdfFile;
  const action = document.getElementById("dashboard-pdf-action")?.value;

  if (!action) {
    showValidationMessage("Escolha o que você deseja fazer com o arquivo.");
    return;
  }

  const dashboardInput = document.getElementById("dashboard-pdf-input");
  if (!file) {
    state.dashboardAutoRouteOnPick = true;
    if (dashboardInput) {
      dashboardInput.accept = getDashboardAcceptedExtensions(action);
      dashboardInput.click();
    }
    return;
  }

  await routeDashboardSelectedFile(file, action);
}

function normalizeLaunchRequestAction(action) {
  const normalized = String(action || "")
    .trim()
    .toLowerCase();

  if (["open", "abrir"].includes(normalized)) return "open";
  if (["images-to-pdf", "converter-para-pdf"].includes(normalized)) return "images-to-pdf";
  if (["ocr", "reconhecer-texto"].includes(normalized)) return "ocr";
  if (["organize", "organizar"].includes(normalized)) return "organize";
  if (["merge", "mesclar", "juntar"].includes(normalized)) return "merge";
  if (["protect", "proteger"].includes(normalized)) return "protect";
  if (["unlock", "desbloquear"].includes(normalized)) return "unlock";
  if (["compress", "compactar", "reduzir"].includes(normalized)) return "compress";
  if (["watermark", "marca-dagua", "marca_dagua", "marcadagua"].includes(normalized)) return "watermark";
  if (["redact", "ocultar", "redact-data"].includes(normalized)) return "redact";

  return "";
}

function toLaunchFileLike(file) {
  if (!file?.path) return null;
  return {
    name: file.name || file.path.split(/[\\/]/).pop() || "arquivo.pdf",
    path: file.path,
    size: Number(file.size || 0),
    type: file.type || ""
  };
}

async function openLaunchRequest(payload) {
  const action = normalizeLaunchRequestAction(payload?.action);
  const files = Array.isArray(payload?.files)
    ? payload.files.map(toLaunchFileLike).filter(Boolean)
    : [];

  try {
    console.info("Launch request received:", {
      action,
      fileCount: files.length,
      files: files.map((file) => file?.name || "")
    });
  } catch (_) {}

  if (!action || files.length === 0) return;

  if (action === "open") {
    ensureModuleSetup("organize");
    switchTab("organize", { skipGuard: true });
    await organizeWorkspace.handleOrganizeFile(files[0]);
    return;
  }

  if (action === "images-to-pdf") {
    ensureModuleSetup(action);
    switchTab(action, { skipGuard: true });
    await imageToPdfWorkspace.addImageFiles(files);
    return;
  }

  if (action === "ocr") {
    ensureModuleSetup(action);
    switchTab(action, { skipGuard: true });
    await handleOcrFiles(files);
    return;
  }

  const preflightType = getSingleFilePreflightType(action);
  if (preflightType && !(await preflightSingleFile(files[0], preflightType))) return;

  ensureModuleSetup(action);
  switchTab(action, { skipGuard: true });

  if (action === "merge") {
    handleMergeFiles(files);
    return;
  }

  if (action === "organize") {
    await organizeWorkspace.handleOrganizeFile(files[0]);
    if (files.length > 1) {
      await organizeWorkspace.addOrganizeFiles(files.slice(1));
    }
    return;
  }

  if (action === "watermark") {
    await watermarkWorkspace.handleFiles(files);
    return;
  }

  if (action === "protect") {
    await protectWorkspace.handleProtectFile(files[0]);
    return;
  }

  if (action === "unlock") {
    await unlockWorkspace.handleUnlockFile(files[0]);
    return;
  }

  if (action === "compress") {
    handleCompressFile(files[0]);
    return;
  }

  if (action === "redact") {
    await redactWorkspace.handleRedactFile(files[0]);
  }
}

function getTaskOutputPath(task) {
  return task?.result?.outputPath || task?.result?.firstOutputPath || "";
}

function toTaskOutputFileLike(task) {
  const outputPath = getTaskOutputPath(task);
  if (!outputPath) return null;
  const name = outputPath.split(/[\\/]/).pop() || "arquivo.pdf";
  return {
    name,
    path: outputPath,
    size: Number(task?.result?.size || 0),
    type: ""
  };
}

async function routeTaskOutputToAction(action, task) {
  const outputFile = toTaskOutputFileLike(task);
  if (!outputFile) return;
  await routeDashboardSelectedFile(outputFile, action);
}

function getWorkflowSuggestionActions(task) {
  const outputFile = toTaskOutputFileLike(task);
  if (!outputFile) return [];

  const normalizeWorkflowTaskType = (value) => {
    const normalized = String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim();

    if (!normalized) return "";
    if (normalized.includes("marca d'agua") || normalized.includes("marca dagua") || normalized.includes("marcadagua")) return "watermark";
    if (normalized.includes("imagem para pdf") || normalized.includes("imagens para pdf") || normalized.includes("image to pdf") || normalized.includes("images to pdf")) return "images-to-pdf";
    if (normalized.includes("organizar paginas") || normalized.includes("organizar pagina") || normalized.includes("organizar")) return "organize";
    if (normalized.includes("assinar pdf") || normalized.includes("assinar") || normalized.includes("assinatura") || normalized.includes("signature")) return "sign";
    if (normalized.includes("desbloquear pdf") || normalized.includes("desbloquear") || normalized.includes("unlock")) return "unlock";
    if (normalized.includes("proteger pdf") || normalized.includes("proteger") || normalized.includes("protect")) return "protect";
    if (normalized.includes("reduzir tamanho") || normalized.includes("reduzir") || normalized.includes("compress")) return "compress";
    if (normalized.includes("separar pdf") || normalized.includes("separar")) return "split-pages";
    if (normalized.includes("mesclar pdf") || normalized.includes("mesclar arquivo") || normalized.includes("mesclar")) return "merge";
    if (normalized.includes("ocultar dados") || normalized.includes("ocultar") || normalized.includes("redact")) return "redact";
    if (["sign", "signature", "assinar", "assinar pdf"].includes(normalized)) return "sign";
    if (["merge", "mesclar", "juntar", "mesclar pdfs"].includes(normalized)) return "merge";
    if (["organize", "organizar", "organizar paginas"].includes(normalized)) return "organize";
    if (["watermark", "marca dagua", "marcadagua"].includes(normalized)) return "watermark";
    if (["redact", "ocultar", "ocultar dados"].includes(normalized)) return "redact";
    if (["compress", "comprimir", "reduzir", "reduzir tamanho"].includes(normalized)) return "compress";
    if (["protect", "proteger", "proteger pdf"].includes(normalized)) return "protect";
    if (["unlock", "desbloquear", "desbloquear pdf"].includes(normalized)) return "unlock";
    if (["images-to-pdf", "image-to-pdf", "imagem para pdf", "imagens para pdf"].includes(normalized)) return "images-to-pdf";
    if (["split-pages", "split-range", "split-size", "split", "separar", "separar pdfs"].includes(normalized)) {
      return normalized.startsWith("split-") ? normalized : "split-pages";
    }
    return normalized;
  };

  const byType = {
    merge: [
      { label: "Organizar páginas", description: "Continuar neste arquivo para ajustar ordem, rotação ou exclusões.", icon: "layout-list", onAction: () => routeTaskOutputToAction("organize", task) },
      { label: "Aplicar marca d'água", description: "Adicionar texto ou imagem por cima do arquivo já mesclado.", icon: "stamp", onAction: () => routeTaskOutputToAction("watermark", task) }
    ],
    sign: [
      { label: "Proteger com senha", description: "Bloquear a abertura deste arquivo assinado antes de compartilhar.", icon: "lock", onAction: () => routeTaskOutputToAction("protect", task) },
      { label: "Organizar páginas", description: "Reordenar, girar ou excluir páginas antes de finalizar.", icon: "layout-list", onAction: () => routeTaskOutputToAction("organize", task) }
    ],
    organize: [
      { label: "Assinar PDF", description: "Adicionar assinatura visual neste arquivo já organizado.", icon: "pen-line", onAction: () => routeTaskOutputToAction("signature", task) },
      { label: "Proteger com senha", description: "Bloquear este arquivo organizado antes de compartilhar.", icon: "lock", onAction: () => routeTaskOutputToAction("protect", task) }
    ],
    watermark: [
      { label: "Proteger com senha", description: "Adicionar uma camada final de proteção neste documento.", icon: "lock", onAction: () => routeTaskOutputToAction("protect", task) },
      { label: "Organizar páginas", description: "Ajustar a ordem ou revisar páginas depois da marca d'água.", icon: "layout-list", onAction: () => routeTaskOutputToAction("organize", task) }
    ],
    redact: [
      { label: "Aplicar marca d'água", description: "Incluir texto ou imagem por cima deste arquivo já ocultado.", icon: "stamp", onAction: () => routeTaskOutputToAction("watermark", task) },
      { label: "Proteger com senha", description: "Bloquear a abertura do arquivo já tratado.", icon: "lock", onAction: () => routeTaskOutputToAction("protect", task) }
    ],
    "split-pages": [
      { label: "Organizar páginas", description: "Abrir uma das partes geradas para revisar ordem, rotação ou exclusões.", icon: "layout-list", onAction: () => routeTaskOutputToAction("organize", task) },
      { label: "Proteger com senha", description: "Bloquear a abertura desta parte gerada antes de compartilhar.", icon: "lock", onAction: () => routeTaskOutputToAction("protect", task) }
    ],
    "split-range": [
      { label: "Organizar páginas", description: "Abrir uma das partes geradas para revisar ordem, rotação ou exclusões.", icon: "layout-list", onAction: () => routeTaskOutputToAction("organize", task) },
      { label: "Proteger com senha", description: "Bloquear a abertura desta parte gerada antes de compartilhar.", icon: "lock", onAction: () => routeTaskOutputToAction("protect", task) }
    ],
    "split-size": [
      { label: "Organizar páginas", description: "Abrir uma das partes geradas para revisar ordem, rotação ou exclusões.", icon: "layout-list", onAction: () => routeTaskOutputToAction("organize", task) },
      { label: "Proteger com senha", description: "Bloquear a abertura desta parte gerada antes de compartilhar.", icon: "lock", onAction: () => routeTaskOutputToAction("protect", task) }
    ],
    compress: [
      { label: "Organizar páginas", description: "Continuar neste arquivo mais leve para ajustar páginas se precisar.", icon: "layout-list", onAction: () => routeTaskOutputToAction("organize", task) },
      { label: "Proteger com senha", description: "Bloquear a abertura do arquivo já reduzido.", icon: "lock", onAction: () => routeTaskOutputToAction("protect", task) }
    ],
    protect: [
      { label: "Desbloquear PDF", description: "Testar ou remover a senha deste mesmo arquivo protegido quando precisar.", icon: "unlock", onAction: () => routeTaskOutputToAction("unlock", task) },
      { label: "Organizar páginas", description: "Abrir este arquivo protegido para seguir ajustando o conteúdo quando necessário.", icon: "layout-list", onAction: () => routeTaskOutputToAction("organize", task) }
    ],
    unlock: [
      { label: "Organizar páginas", description: "Continuar neste arquivo liberado para ajustar páginas ou ordem.", icon: "layout-list", onAction: () => routeTaskOutputToAction("organize", task) },
      { label: "Assinar PDF", description: "Adicionar assinatura visual agora que o arquivo está desbloqueado.", icon: "pen-line", onAction: () => routeTaskOutputToAction("signature", task) }
    ],
    "images-to-pdf": [
      { label: "Proteger com senha", description: "Bloquear a abertura do PDF recém-gerado.", icon: "lock", onAction: () => routeTaskOutputToAction("protect", task) },
      { label: "Reduzir tamanho", description: "Gerar uma versão mais leve desse PDF antes de compartilhar.", icon: "zap", onAction: () => routeTaskOutputToAction("compress", task) }
    ]
  };

  const normalizedType = normalizeWorkflowTaskType(task?.type)
    || normalizeWorkflowTaskType(task?.name);

  return byType[normalizedType] || [];
}

function setupDashboardEnhancements() {
  const themeButton = document.getElementById("btn-dashboard-theme-toggle");
  const defaultDirButton = document.getElementById("btn-dashboard-open-default-dir");
  const processedHistoryButton = document.getElementById("btn-dashboard-processed-history");
  const searchInput = document.getElementById("dashboard-search-input");
  const fileInput = document.getElementById("dashboard-pdf-input");
  const dropzone = document.getElementById("dashboard-pdf-dropzone");
  const openActionButton = document.getElementById("btn-dashboard-open-action");
  const actionSelect = document.getElementById("dashboard-pdf-action");

  if (actionSelect && fileInput) {
    actionSelect.addEventListener("change", () => {
      fileInput.accept = getDashboardAcceptedExtensions(actionSelect.value);
    });
    fileInput.accept = getDashboardAcceptedExtensions(actionSelect.value || "organize");
  }

  if (themeButton) {
    themeButton.addEventListener("click", () => {
      cycleDashboardTheme().catch((error) => console.error("Falha ao alternar tema:", error));
    });
  }

  if (defaultDirButton) {
    defaultDirButton.addEventListener("click", async () => {
      const target = getDashboardDestinationTarget();
      if (!target) {
        notify({
          tone: "warning",
          title: "Pasta de destino",
          message: "Ainda não há uma pasta para abrir. Processe um arquivo ou defina uma pasta padrão nas configurações."
        });
        return;
      }

      const result = await window.api.openPath(target.path);
      if (!result?.success) {
        notify({
          tone: "error",
          title: "Abrir pasta de destino",
          message: result?.error || "Não foi possível abrir a pasta de destino."
        });
      }
    });
  }

  if (searchInput) {
    const openGlobalSearch = () => commandPalette.open(searchInput.value);
    searchInput.addEventListener("focus", openGlobalSearch);
    searchInput.addEventListener("click", openGlobalSearch);
  }

  if (processedHistoryButton) {
    processedHistoryButton.addEventListener("click", () => {
      queueAndHistory.openRecentProcessedModal(processedHistoryButton).catch((error) => {
        notify({
          tone: "error",
          title: "Lista recente",
          message: error.message || "Não foi possível abrir a lista rápida."
        });
      });
    });
  }

  document.getElementById("btn-dashboard-refresh-recent-files")?.addEventListener("click", () => {
    void refreshDashboardRecentFiles();
  });

  if (fileInput) {
    fileInput.addEventListener("change", async (event) => {
      try {
        const action = actionSelect?.value || "organize";
        const [file] = normalizeSelectedFiles(event.target.files).filter((item) => matchesDashboardAction(item, action));
        setDashboardSelectedPdfFile(file || null);
        if (file && state.dashboardAutoRouteOnPick) {
          state.dashboardAutoRouteOnPick = false;
          await routeDashboardSelectedFile(file, action);
        } else {
          state.dashboardAutoRouteOnPick = false;
        }
      } finally {
        fileInput.value = "";
      }
    });
  }

  if (dropzone && fileInput) {
    dropzone.addEventListener("click", (event) => {
      if (event.target !== fileInput) fileInput.click();
    });

    dropzone.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      fileInput.click();
    });

    dropzone.addEventListener("dragover", (event) => {
      event.preventDefault();
      dropzone.classList.add("drag-over");
    });

    dropzone.addEventListener("dragleave", () => {
      dropzone.classList.remove("drag-over");
    });

    dropzone.addEventListener("drop", (event) => {
      event.preventDefault();
      dropzone.classList.remove("drag-over");
      const action = actionSelect?.value || "organize";
      const [file] = normalizeSelectedFiles(event.dataTransfer.files).filter((item) => matchesDashboardAction(item, action));
      setDashboardSelectedPdfFile(file || null);
    });
  }

  if (openActionButton) {
    openActionButton.addEventListener("click", () => {
      openDashboardSelectedAction().catch((error) => {
        notify({
          tone: "error",
          title: "Atalho rápido",
          message: error?.message || "Não foi possível abrir esse arquivo no módulo escolhido."
        });
      });
    });
  }

  updateDashboardGreeting();
  updateDashboardThemeButton();
  updateDashboardDefaultDirButton();
  updateDashboardSummary();
  void refreshDashboardRecentFiles();
}

function setupNavigation() {
  dom.tabs.forEach((tab) => {
    tab.addEventListener("click", () => switchTab(tab.getAttribute("data-tab")));
  });

  const settingsTabs = [...document.querySelectorAll("[data-settings-tab]")];
  const settingsPanes = [...document.querySelectorAll(".settings-pane")];
  settingsTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const target = tab.getAttribute("data-settings-tab");
      settingsTabs.forEach((item) => {
        const isActive = item === tab;
        item.classList.toggle("active", isActive);
        item.setAttribute("aria-selected", String(isActive));
        item.tabIndex = isActive ? 0 : -1;
      });
      settingsPanes.forEach((pane) => {
        const isActive = pane.id === `settings-pane-${target}`;
        pane.classList.toggle("active", isActive);
        pane.hidden = !isActive;
      });
    });

    tab.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
      event.preventDefault();
      const offset = event.key === "ArrowRight" ? 1 : -1;
      const nextIndex = (settingsTabs.indexOf(tab) + offset + settingsTabs.length) % settingsTabs.length;
      settingsTabs[nextIndex]?.focus();
      settingsTabs[nextIndex]?.click();
    });
  });

  document.querySelectorAll("[data-go-tab]").forEach((button) => {
    button.addEventListener("click", () => switchTab(button.getAttribute("data-go-tab")));
  });

  // Wire Help Tab Sub-navigation
  const helpButtons = [...document.querySelectorAll(".help-nav-btn")];
  const activateHelpTopic = (btn) => {
      const targetPaneId = `help-pane-${btn.getAttribute("data-help-target")}`;
      helpButtons.forEach((b) => {
        const isActive = b === btn;
        b.classList.toggle("active", isActive);
        b.setAttribute("aria-selected", String(isActive));
        const bName = b.getAttribute("data-icon");
        const bText = b.querySelector("span")?.textContent || b.textContent.trim();
        b.innerHTML = `${lucideIconByState(bName, { size: 18, active: isActive })}<span style="margin-left: 8px;">${escapeHtml(bText)}</span>`;
      });
      document.querySelectorAll(".help-pane").forEach((p) => {
        const isActive = p.id === targetPaneId;
        p.classList.toggle("active", isActive);
        p.setAttribute("aria-hidden", String(!isActive));
      });
    };

  helpButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      activateHelpTopic(btn);
    });
    btn.addEventListener("keydown", (event) => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const currentIndex = helpButtons.indexOf(btn);
      const nextIndex = event.key === "Home" ? 0
        : event.key === "End" ? helpButtons.length - 1
          : (currentIndex + (event.key === "ArrowDown" ? 1 : -1) + helpButtons.length) % helpButtons.length;
      helpButtons[nextIndex].focus();
      activateHelpTopic(helpButtons[nextIndex]);
    });
  });

  // Keep ARIA state synchronized with the initial topic.
  const initialHelpButton = helpButtons.find((button) => button.classList.contains("active"));
  if (initialHelpButton) {
    activateHelpTopic(initialHelpButton);
  }

  const helpToolTargets = {
    "images-to-pdf": "Converter para PDF",
    merge: "Mesclar",
    split: "Separar PDFs",
    signature: "Assinar PDF",
    "pdf-to-word": "PDF para Word",
    organize: "Organizar Páginas",
    watermark: "Marca d'água",
    compress: "Reduzir tamanho",
    protect: "Proteger PDF",
    unlock: "Desbloquear PDF",
    redact: "Ocultar Dados",
    ocr: "Reconhecer texto (OCR)"
  };
  Object.entries(helpToolTargets).forEach(([target, label]) => {
    const pane = document.getElementById(`help-pane-${target}`);
    if (!pane || pane.querySelector(".help-open-tool")) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "help-open-tool btn-secondary btn-sm btn-icon-label";
    button.innerHTML = `${lucideIcon("external-link", { size: 16 })}<span>Abrir ${escapeHtml(label)}</span>`;
    button.addEventListener("click", () => switchTab(target));
    pane.querySelector("p")?.after(button);
  });

  bindClick("btn-sidebar-close-app", () => {
    showCustomConfirmModal(
      "Fechar o Central PDF?",
      "Se houver uma tarefa em andamento, ela pode ser interrompida.\nDeseja fechar mesmo assim?",
      async () => {
        await window.api.closeApp();
      }
    );
  });
}

function setupNavigationGuards() {
  if (window.api && typeof window.api.onCloseRequest === "function") {
    window.api.onCloseRequest(async () => {
      const hasWork = hasAnyPendingTabWork(state, {
        getWatermarkPendingMessage: () => watermarkWorkspace.getPendingMessage(),
        getImagePendingMessage: () => imageToPdfWorkspace.getPendingMessage(),
        getSignaturePendingMessage: () => signatureWorkspace.getPendingMessage(),
        getPdfToWordPendingMessage: () => pdfToWordWorkspace.getPendingMessage(),
        getProtectPendingMessage: () => protectWorkspace.getPendingMessage(),
        getUnlockPendingMessage: () => unlockWorkspace.getPendingMessage(),
        getRedactPendingMessage: () => redactWorkspace.getPendingMessage()
      }) || (state.queueSnapshot && state.queueSnapshot.some(t => ["pending", "running"].includes(t.status)));

      if (hasWork) {
        showCustomConfirmModal(
          "Fechar o Central PDF?",
          "Há tarefas ou arquivos sendo editados. Deseja fechar mesmo assim e perder as alterações não salvas?",
          async () => {
            await window.api.closeApp();
          }
        );
      } else {
        await window.api.closeApp();
      }
    });
  }
}

function showCustomConfirmModal(title, message, onConfirm, onCancel, options = {}) {
  const modal = document.getElementById("custom-confirm-modal");
  if (!modal) return;

  const titleEl = document.getElementById("custom-confirm-title");
  const msgEl = document.getElementById("custom-confirm-message");
  const btnOk = document.getElementById("custom-confirm-btn-ok");
  const btnCancel = document.getElementById("custom-confirm-btn-cancel");
  const confirmLabel = options.confirmLabel || "Sair mesmo assim";
  const cancelLabel = options.cancelLabel || "Permanecer";

  if (titleEl) titleEl.textContent = title;
  if (msgEl) {
    msgEl.innerHTML = message.replace(/\n/g, "<br>");
  }
  if (btnOk) btnOk.textContent = confirmLabel;
  if (btnCancel) btnCancel.textContent = cancelLabel;

  const previouslyFocused = document.activeElement;
  modal.classList.remove("hidden");

  const close = () => {
    modal.classList.add("hidden");
    btnOk.removeEventListener("click", handleOk);
    btnCancel.removeEventListener("click", handleCancel);
    modal.removeEventListener("click", handleBackdrop);
    modal.removeEventListener("keydown", handleKeydown);
    if (previouslyFocused && typeof previouslyFocused.focus === "function") {
      previouslyFocused.focus({ preventScroll: true });
    }
  };

  const handleOk = () => {
    close();
    if (typeof onConfirm === "function") {
      onConfirm();
    }
  };

  const handleCancel = () => {
    close();
    if (typeof onCancel === "function") {
      onCancel();
    }
  };

  const handleBackdrop = (event) => {
    if (event.target === modal) {
      handleCancel();
    }
  };

  const handleKeydown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      handleCancel();
    }
  };

  btnOk.addEventListener("click", handleOk);
  btnCancel.addEventListener("click", handleCancel);
  modal.addEventListener("click", handleBackdrop);
  modal.addEventListener("keydown", handleKeydown);

  window.setTimeout(() => {
    btnOk.focus({ preventScroll: true });
  }, 0);
}

function showCustomPromptModal(title, message, options = {}) {
  const modal = document.getElementById("custom-prompt-modal");
  const titleEl = document.getElementById("custom-prompt-title");
  const messageEl = document.getElementById("custom-prompt-message");
  const input = document.getElementById("custom-prompt-input");
  const confirmButton = document.getElementById("custom-prompt-btn-ok");
  const cancelButton = document.getElementById("custom-prompt-btn-cancel");
  if (!modal || !input || !confirmButton || !cancelButton) return Promise.resolve("");

  const previousFocus = document.activeElement;
  if (titleEl) titleEl.textContent = title;
  if (messageEl) messageEl.textContent = message;
  input.value = options.initialValue || "";
  input.placeholder = options.placeholder || "Digite um nome";
  confirmButton.textContent = options.confirmLabel || "Salvar";
  cancelButton.textContent = options.cancelLabel || "Cancelar";
  modal.classList.remove("hidden");

  return new Promise((resolve) => {
    const close = (value = "") => {
      modal.classList.add("hidden");
      confirmButton.removeEventListener("click", confirm);
      cancelButton.removeEventListener("click", cancel);
      modal.removeEventListener("click", onBackdrop);
      modal.removeEventListener("keydown", onKeydown);
      if (previousFocus && typeof previousFocus.focus === "function") {
        previousFocus.focus({ preventScroll: true });
      }
      resolve(value);
    };
    const confirm = () => close(input.value.trim());
    const cancel = () => close("");
    const onBackdrop = (event) => {
      if (event.target === modal) cancel();
    };
    const onKeydown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        cancel();
      } else if (event.key === "Enter") {
        event.preventDefault();
        confirm();
      }
    };

    confirmButton.addEventListener("click", confirm);
    cancelButton.addEventListener("click", cancel);
    modal.addEventListener("click", onBackdrop);
    modal.addEventListener("keydown", onKeydown);
    window.setTimeout(() => {
      input.focus({ preventScroll: true });
      input.select();
    }, 0);
  });
}

function switchTab(tabId) {
  if (!tabId || tabId === state.activeTab) return;

  // Trocar de função é apenas navegação. O workspace anterior continua em
  // memória para que o usuário possa voltar e concluir o trabalho depois.
  // A limpeza acontece somente pelos botões explícitos de limpar, após uma
  // conclusão controlada ou no encerramento do app.
  ensureModuleSetup(tabId);

  state.activeTab = tabId;
  dom.tabs.forEach((tab) => tab.classList.toggle("active", tab.getAttribute("data-tab") === tabId));
  dom.tabs.forEach(renderNavItemIcon);
  const targetContentId = `tab-${tabId}`;
  dom.tabContents.forEach((content) => {
    content.classList.toggle("active", content.id === targetContentId);
  });

  refreshRecentFilesCards?.(tabId);

  if (tabId === "dashboard") {
    queueAndHistory.renderHistory();
    sortDashboardQuickCards();
  }
  updateDashboardGreeting();
  repairVisibleMojibake(document.getElementById(`tab-${tabId}`) || document.body);

}

function clearPreviousTabState(tab) {
  if (tab === "signature") {
    signatureWorkspace.clearWorkspace();
  } else if (tab === "watermark") {
    watermarkWorkspace.clearWorkspace();
  } else if (tab === "images-to-pdf") {
    imageToPdfWorkspace.clearWorkspace();
  } else if (tab === "pdf-to-word") {
    pdfToWordWorkspace.clearWorkspace();
  } else if (tab === "ocr") {
    state.ocrFiles = [];
    state.ocrRuntime = null;
    document.getElementById("ocr-file-list")?.replaceChildren();
    const subtitle = document.getElementById("ocr-files-subtitle");
    if (subtitle) subtitle.textContent = "Adicione mais documentos ou limpe a seleção.";
    clearOcrImagePreview();
    const runtimeWarning = document.getElementById("ocr-runtime-warning");
    if (runtimeWarning) {
      runtimeWarning.textContent = "";
      runtimeWarning.classList.add("hidden");
    }
    ocrAreaExtractor.setFiles([]);
  } else if (tab === "protect") {
    protectWorkspace.clearWorkspace();
  } else if (tab === "unlock") {
    unlockWorkspace.clearWorkspace();
  } else if (tab === "redact") {
    redactWorkspace.clearWorkspace();
  } else if (tab === "organize") {
    organizeWorkspace.clearOrganizeWorkspace();
  } else if (tab === "merge") {
    state.mergeFiles = [];
    renderMergeFileList();
  } else if (tab === "split") {
    cancelSplitContentSearch();
    state.selectedSplitFile = null;
    document.getElementById("split-settings-container").classList.add("hidden");
    document.getElementById("split-dropzone").classList.remove("hidden");
  } else if (tab === "compress") {
    state.selectedCompressFile = null;
    document.getElementById("compress-settings-container").classList.add("hidden");
    document.getElementById("compress-dropzone").classList.remove("hidden");
  }
}

function updateRecentHistoryFromTask(task, status) {
  if (!task || !state.appConfig || !Array.isArray(state.appConfig.recentHistory)) return;
  if (!["sucesso", "falha"].includes(status)) return;

  const primaryFileName = task.fileNames?.[0] || task.currentItemName || "";
  if (!primaryFileName) return;

  const fingerprint = `${task.id}:${status}`;
  if (state.appConfig.recentHistory.some((item) => item.__fingerprint === fingerprint)) {
    return;
  }

  const normalizeHistoryActionType = (value) => {
    const normalized = String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim();

    if (!normalized) return "";
    if (normalized.includes("marca d'agua") || normalized.includes("marca dagua") || normalized.includes("marcadagua")) return "watermark";
    if (normalized.includes("imagem para pdf") || normalized.includes("imagens para pdf") || normalized.includes("image to pdf") || normalized.includes("images to pdf")) return "images-to-pdf";
    if (normalized.includes("organizar paginas") || normalized.includes("organizar pagina") || normalized.includes("organizar")) return "organize";
    if (normalized.includes("assinar pdf") || normalized.includes("assinar") || normalized.includes("assinatura") || normalized.includes("signature")) return "sign";
    if (normalized.includes("desbloquear pdf") || normalized.includes("desbloquear") || normalized.includes("unlock")) return "unlock";
    if (normalized.includes("proteger pdf") || normalized.includes("proteger") || normalized.includes("protect")) return "protect";
    if (normalized.includes("reduzir tamanho") || normalized.includes("reduzir") || normalized.includes("compress") || normalized.includes("comprimir")) return "compress";
    if (normalized.includes("separar pdf") || normalized.includes("separar")) return "split-pages";
    if (normalized.includes("mesclar pdf") || normalized.includes("mesclar arquivo") || normalized.includes("mesclar") || normalized.includes("juntar arquivo") || normalized.includes("juntar")) return "merge";
    if (normalized.includes("ocultar dados") || normalized.includes("ocultar") || normalized.includes("redact")) return "redact";
    return "";
  };

  const normalizedActionType = normalizeHistoryActionType(task.type || task.name);
  const normalizedActionLabel = normalizedActionType ? getOperationLabel(normalizedActionType) : task.name;

  const entry = {
    action: normalizedActionLabel,
    fileName: primaryFileName,
    status,
    timestamp: new Date().toISOString(),
    errorMessage: task.error || "",
    outputPath: task.result?.outputPath || task.result?.firstOutputPath || "",
    outputDir: task.result?.outputDir || "",
    __fingerprint: fingerprint
  };

  state.appConfig.recentHistory.unshift(entry);
  state.appConfig.recentHistory = state.appConfig.recentHistory.slice(0, 10);
  window.dispatchEvent(new Event("recent-history-updated"));

  if (state.activeTab === "dashboard") {
    queueAndHistory.renderHistory();
  }
  updateDashboardSummary();
}

function setupDropzones() {
  if (!document.documentElement.dataset.filePathBridgeReady) {
    document.documentElement.dataset.filePathBridgeReady = "true";
    document.addEventListener("change", (event) => {
      const target = event.target;
      if (target?.tagName === "INPUT" && target.type === "file") {
        normalizeSelectedFiles(target.files);
      }
    }, true);
  }

  const uploadTools = [
    { id: "images-pdf-dropzone", inputId: "images-pdf-input", handler: imageToPdfWorkspace.addImageFiles, filter: (file) => /\.(jpg|jpeg|png|docx|xlsx)$/i.test(file.name) },
    { id: "signature-dropzone", inputId: "signature-file-input", handler: (files) => signatureWorkspace.handleSignatureFile(files[0]), filter: (file) => file.name.toLowerCase().endsWith(".pdf"), preflightType: "single-pdf" },
    { id: "pdf-to-word-dropzone", inputId: "pdf-to-word-file-input", handler: (files) => pdfToWordWorkspace.handleFile(files[0]), filter: (file) => file.name.toLowerCase().endsWith(".pdf"), preflightType: "single-pdf" },
    { id: "ocr-dropzone", inputId: "ocr-file-input", handler: handleOcrFiles, filter: (file) => file.name.toLowerCase().endsWith(".pdf") || /\.(jpg|jpeg|png|tif|tiff)$/i.test(file.name) },
    { id: "merge-dropzone", inputId: "merge-file-input", handler: handleMergeFiles, filter: (file) => file.name.toLowerCase().endsWith(".pdf") || /\.(jpg|jpeg|png)$/i.test(file.name) },
    { id: "split-dropzone", inputId: "split-file-input", handler: (files) => handleSplitFile(files[0]), filter: (file) => file.name.toLowerCase().endsWith(".pdf"), preflightType: "single-pdf" },
    { id: "organize-dropzone", inputId: "organize-file-input", handler: async (files) => {
      if (!files || files.length === 0) return;
      const shouldAppend = state.organizePages.length > 0 || state.organizeFiles.length > 0;
      if (!shouldAppend) {
        await organizeWorkspace.handleOrganizeFile(files[0]);
        if (files.length > 1) {
          await organizeWorkspace.addOrganizeFiles(files.slice(1));
        }
        return;
      }
      await organizeWorkspace.addOrganizeFiles(files);
    }, filter: (file) => file.name.toLowerCase().endsWith(".pdf") || /\.(jpg|jpeg|png)$/i.test(file.name) },
    { id: "watermark-dropzone", inputId: "watermark-file-input", handler: watermarkWorkspace.handleFiles, filter: (file) => file.name.toLowerCase().endsWith(".pdf") || /\.(jpg|jpeg|png)$/i.test(file.name) },
    { id: "compress-dropzone", inputId: "compress-file-input", handler: (files) => handleCompressFile(files[0]), filter: (file) => file.name.toLowerCase().endsWith(".pdf"), preflightType: "single-pdf" },
    { id: "protect-dropzone", inputId: "protect-file-input", handler: (files) => protectWorkspace.handleProtectFile(files[0]), filter: (file) => file.name.toLowerCase().endsWith(".pdf"), preflightType: "single-pdf" },
    { id: "unlock-dropzone", inputId: "unlock-file-input", handler: (files) => unlockWorkspace.handleUnlockFile(files[0]), filter: (file) => file.name.toLowerCase().endsWith(".pdf"), preflightType: "single-pdf-unlock" },
    { id: "redact-dropzone", inputId: "redact-file-input", handler: (files) => redactWorkspace.handleRedactFile(files[0]), filter: (file) => file.name.toLowerCase().endsWith(".pdf") || /\.(jpg|jpeg|png)$/i.test(file.name), preflightType: "single-pdf-or-image" }
  ];
  uploadTools.forEach(setupDropzone);
  refreshRecentFilesCards = setupRecentFilesCards(uploadTools);
}

function setupRecentFilesCards(uploadTools) {
  const extensionsByTab = {
    // Converter arquivos para PDF aceita imagens comuns, DOCX e XLSX.
    // Filtrar aqui evita que arquivos sem suporte apareçam nos atalhos recentes.
    "images-to-pdf": [".jpg", ".jpeg", ".png", ".docx", ".xlsx"],
    merge: [".pdf", ".jpg", ".jpeg", ".png"],
    signature: [".pdf"],
    ocr: [".pdf", ".jpg", ".jpeg", ".png", ".tif", ".tiff"],
    "pdf-to-word": [".pdf"],
    split: [".pdf"],
    organize: [".pdf", ".jpg", ".jpeg", ".png"],
    watermark: [".pdf", ".jpg", ".jpeg", ".png"],
    compress: [".pdf", ".jpg", ".jpeg", ".png"],
    protect: [".pdf"],
    unlock: [".pdf"],
    redact: [".pdf", ".jpg", ".jpeg", ".png"]
  };
  const cards = new Map();
  const requestVersions = new Map();

  uploadTools.forEach(({ id }) => {
    const dropzone = document.getElementById(id);
    if (!dropzone) return;
    const tabId = dropzone.closest(".tab-content")?.id?.replace(/^tab-/, "");
    const card = document.createElement("section");
    card.className = "card recent-inputs-card hidden";
    card.setAttribute("aria-label", "Arquivos modificados recentemente");
    dropzone.insertAdjacentElement("afterend", card);
    cards.set(tabId, card);
    let wasDropzoneHidden = dropzone.classList.contains("hidden");
    new MutationObserver(() => {
      const isDropzoneHidden = dropzone.classList.contains("hidden");
      if (isDropzoneHidden === wasDropzoneHidden) return;
      wasDropzoneHidden = isDropzoneHidden;
      if (isDropzoneHidden) hideRecentFilesCard(tabId);
      else if (tabId === state.activeTab) refreshRecentFilesCards?.(tabId);
    }).observe(dropzone, { attributes: true, attributeFilter: ["class"] });
  });

  const hide = (tabId) => {
    const card = cards.get(tabId);
    if (!card) return;
    requestVersions.set(tabId, (requestVersions.get(tabId) || 0) + 1);
    card.classList.add("hidden");
  };
  hideRecentFilesCard = hide;

  const render = async (tabId) => {
    const card = cards.get(tabId);
    const accepts = extensionsByTab[tabId];
    const dropzone = document.getElementById(`tab-${tabId}`)?.querySelector(".file-upload-area");
    if (!card || !accepts || !dropzone || tabId !== state.activeTab || dropzone.classList.contains("hidden")) {
      hide(tabId);
      return;
    }

    const requestVersion = (requestVersions.get(tabId) || 0) + 1;
    requestVersions.set(tabId, requestVersion);
    card.classList.add("hidden");
    let result;
    try {
      result = await window.api?.findRecentUploadFiles?.(accepts);
    } catch (error) {
      console.warn("Não foi possível localizar arquivos recentes para upload.", error);
      return;
    }
    if (requestVersions.get(tabId) !== requestVersion || tabId !== state.activeTab || dropzone.classList.contains("hidden")) return;

    const entries = Array.isArray(result?.files) ? result.files : [];
    if (entries.length === 0) {
      card.replaceChildren();
      return;
    }

    const isBatchTab = ["ocr", "merge", "images-to-pdf", "organize"].includes(tabId);

    const formatAge = (value) => {
      const modifiedAt = new Date(value);
      const diffMs = Math.max(0, Date.now() - modifiedAt.getTime());
      const diffHours = Math.floor(diffMs / 3600000);
      const ageInDays = Math.floor(diffMs / 86400000);
      let ageLabel;
      if (diffHours < 1) ageLabel = "Agora há pouco";
      else if (diffHours < 24) ageLabel = `Hoje, ${modifiedAt.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`;
      else if (ageInDays === 1) ageLabel = "Ontem";
      else ageLabel = `Há ${ageInDays} dias`;
      return { ageLabel, fullDate: modifiedAt.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) };
    };

    card.innerHTML = `
      <div class="section-heading compact recent-heading-row">
        <div>
          <h2 class="section-title-with-icon"><span class="section-title-icon" data-icon="history"></span><span>Arquivos modificados recentemente</span></h2>
          <p>Arquivos existentes no computador, alterados ou abertos recentemente.</p>
        </div>
        ${isBatchTab && entries.length > 1 ? `
          <button type="button" class="btn btn-secondary btn-sm" id="btn-recent-add-all-${tabId}" data-icon="plus">
            <span data-icon="plus"></span>Adicionar todos ao lote (${entries.length})
          </button>
        ` : ""}
      </div>
      <div class="recent-inputs-list">${entries.map((item, index) => {
        const name = String(item?.name || item?.path?.split(/[\\/]/).pop() || "Arquivo recente");
        const { ageLabel, fullDate } = formatAge(item?.modifiedAt);
        return `<button type="button" class="recent-input-item" data-recent-input-index="${index}" title="Modificado em ${escapeHtml(fullDate)}"><span data-icon="file-text"></span><span class="recent-input-copy"><span class="recent-input-name">${escapeHtml(name)}</span><span class="recent-input-meta">${escapeHtml(ageLabel)}</span></span><span class="recent-input-action" data-recent-action-label>${isBatchTab ? "+ Adicionar ao lote" : "Usar arquivo"}</span></button>`;
      }).join("")}</div>`;
    card.classList.remove("hidden");

    card.querySelectorAll("[data-icon]").forEach((node) => {
      node.innerHTML = lucideIcon(node.getAttribute("data-icon"), { size: 18 });
    });

    const addAllBtn = card.querySelector(`#btn-recent-add-all-${tabId}`);
    if (addAllBtn) {
      addAllBtn.addEventListener("click", async () => {
        addAllBtn.disabled = true;
        const filesToAdd = [];
        for (const item of entries) {
          const filePath = String(item?.path || "");
          const fileName = String(item?.name || filePath.split(/[\\/]/).pop() || "");
          if (!accepts.some((extension) => fileName.toLowerCase().endsWith(extension))) continue;
          let info = null;
          try {
            info = filePath ? await window.api?.getFileInfo?.(filePath) : null;
          } catch (_) {}
          if (info?.success) {
            const file = toLaunchFileLike({ path: filePath, name: info.name, size: info.size });
            if (file) filesToAdd.push(file);
          }
        }
        if (!filesToAdd.length) {
          notify({ tone: "info", title: "Arquivos recentes", message: "Nenhum arquivo recente está disponível para carregar." });
          return;
        }
        card.querySelectorAll("[data-recent-action-label]").forEach((lbl) => {
          lbl.textContent = "✓ Adicionado";
          lbl.classList.add("text-success");
        });
        card.querySelectorAll("[data-recent-input-index]").forEach((btn) => {
          btn.disabled = true;
        });
        if (tabId === "ocr") {
          await handleOcrFiles(filesToAdd);
        } else if (tabId === "merge") {
          handleMergeFiles(filesToAdd);
        } else if (tabId === "images-to-pdf") {
          await imageToPdfWorkspace.addImageFiles(filesToAdd);
        } else if (tabId === "organize") {
          await organizeWorkspace.addOrganizeFiles(filesToAdd);
        }
        notify({ tone: "success", title: "Lote atualizado", message: `${filesToAdd.length} arquivo(s) adicionado(s) com sucesso ao lote.` });
      });
    }

    card.querySelectorAll("[data-recent-input-index]").forEach((button) => {
      button.addEventListener("click", async () => {
        button.disabled = true;
        const item = entries[Number(button.dataset.recentInputIndex)];
        const filePath = String(item?.path || "");
        const fileName = String(item?.name || filePath.split(/[\\/]/).pop() || "");
        if (!accepts.some((extension) => fileName.toLowerCase().endsWith(extension))) {
          notify({ tone: "warning", title: "Formato não compatível", message: "Escolha JPG, JPEG, PNG, DOCX ou XLSX para converter em PDF." });
          button.disabled = false;
          return;
        }
        let info = null;
        try {
          info = filePath ? await window.api?.getFileInfo?.(filePath) : null;
        } catch (_) {}
        if (!info?.success) {
          notify({ tone: "info", title: "Arquivo não está mais disponível", message: "Atualizei a lista de arquivos recentes. Escolha outro arquivo para continuar." });
          hide(tabId);
          void render(tabId);
          return;
        }

        const file = toLaunchFileLike({ path: filePath, name: info.name, size: info.size });
        if (!file) return;

        if (isBatchTab) {
          const actionLabel = button.querySelector("[data-recent-action-label]");
          if (actionLabel) {
            actionLabel.textContent = "✓ Adicionado";
            actionLabel.classList.add("text-success");
          }
          if (tabId === "ocr") {
            await handleOcrFiles([file]);
          } else if (tabId === "merge") {
            handleMergeFiles([file]);
          } else if (tabId === "images-to-pdf") {
            await imageToPdfWorkspace.addImageFiles([file]);
          } else if (tabId === "organize") {
            await organizeWorkspace.addOrganizeFiles([file]);
          }
        } else {
          hide(tabId);
          const action = tabId === "pdf-to-word" ? "pdf-to-word" : tabId;
          try {
            await routeDashboardSelectedFile(file, action);
          } catch (error) {
            notify({ tone: "error", title: "Arquivo recente", message: error?.message || "Não foi possível carregar este arquivo." });
            void render(tabId);
          }
        }
      });
    });
  };
  return (tabId) => { void render(tabId); };
}

function normalizeSelectedFile(file) {
  if (!file) return file;

  const currentPath = typeof file.path === "string" ? file.path.trim() : "";
  const localPath = currentPath || window.api?.getPathForFile?.(file) || "";
  if (!localPath || currentPath === localPath) return file;

  try {
    Object.defineProperty(file, "path", {
      value: localPath,
      configurable: true,
      enumerable: true
    });
  } catch (_) {
    try {
      file.path = localPath;
    } catch (_) {}
  }

  return file;
}

function normalizeSelectedFiles(fileList) {
  return [...(fileList || [])].map(normalizeSelectedFile).filter(Boolean);
}

async function processDropzoneSelection({ id, handler, filter, preflightType }, rawFiles) {
  const normalizedFiles = normalizeSelectedFiles(rawFiles);
  const files = normalizedFiles.filter(filter);
  const rejectedFiles = normalizedFiles.filter((file) => !filter(file));
  if (rejectedFiles.length > 0) {
    const names = rejectedFiles.slice(0, 3).map((file) => file.name).join(", ");
    notify({
      tone: "warning",
      title: "Arquivos não compatíveis",
      message: `${rejectedFiles.length} arquivo(s) não foram adicionados.`,
      detail: `${names}${rejectedFiles.length > 3 ? ` e mais ${rejectedFiles.length - 3}` : ""}`
    });
  }
  if (files.length === 0) return;
  const selectedFiles = preflightType && files.length > 1 ? files.slice(0, 1) : files;
  if (preflightType && files.length > 1) {
    notify({
      tone: "info",
      title: "Apenas um arquivo será usado",
      message: `${files.length - 1} arquivo(s) extra(s) não foram adicionados neste módulo.`,
      detail: "Este módulo trabalha com um arquivo por vez."
    });
  }

  if (preflightType && window.api?.preflightBatchFiles) {
    if (!(await preflightSingleFile(selectedFiles[0], preflightType))) return;
  } else if (preflightType) {
    notify({
      tone: "error",
      title: "Verificação indisponível",
      message: "Não foi possível confirmar o arquivo neste momento.",
      detail: "Reabra o aplicativo antes de tentar novamente.",
      important: true
    });
    return;
  }
  const tabId = document.getElementById(id)?.closest(".tab-content")?.id?.replace(/^tab-/, "");
  if (tabId) hideRecentFilesCard(tabId);
  await handler(selectedFiles);
}

function getSingleFilePreflightType(action) {
  if (["signature", "pdf-to-word", "split", "protect"].includes(action)) return "single-pdf";
  if (action === "unlock") return "single-pdf-unlock";
  if (["redact", "compress"].includes(action)) return "single-pdf-or-image";
  return "";
}

async function preflightSingleFile(file, type) {
  if (!file || !type || !window.api?.preflightBatchFiles) {
    notify({ tone: "error", title: "Verificação indisponível", message: "Não foi possível confirmar o arquivo neste momento.", detail: "Reabra o aplicativo antes de tentar novamente.", important: true });
    return false;
  }
  const result = await window.api.preflightBatchFiles({ type, files: [file.path || ""] });
  const validation = result?.results?.[0];
  if (!validation || validation.status !== "valid") {
    notify({
      tone: validation?.status === "protected" ? "warning" : "error",
      title: "Arquivo não adicionado",
      message: validation?.status === "protected" ? "Este arquivo está protegido por senha." : "Este arquivo não passou na verificação.",
      detail: `${validation?.name || file.name}: ${validation?.message || "Não foi possível confirmar o conteúdo."}`,
      important: true
    });
    return false;
  }
  notify({ tone: "success", title: "Arquivo adicionado", message: `${validation.name || file.name} foi verificado e está pronto.` });
  return true;
}

function setupDropzone({ id, inputId, handler, filter, preflightType }) {
  const dropzone = document.getElementById(id);
  const input = document.getElementById(inputId);
  if (!dropzone || !input) return;

  dropzone.setAttribute("role", "button");
  dropzone.setAttribute("tabindex", "0");
  const promptTitle = dropzone.querySelector(".dropzone-prompt h3")?.textContent?.trim();
  if (promptTitle && !dropzone.hasAttribute("aria-label")) {
    dropzone.setAttribute("aria-label", promptTitle);
  }
  input.setAttribute("tabindex", "-1");
  input.setAttribute("aria-hidden", "true");
  input.dataset.dropzoneReady = "true";

  dropzone.addEventListener("click", (event) => {
    if (event.target !== input) input.click();
  });

  dropzone.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    input.click();
  });

  input.addEventListener("change", async (event) => {
    try {
      await processDropzoneSelection({ id, handler, filter, preflightType }, event.target.files);
    } catch (error) {
      console.error(`Dropzone handler failed for ${id}:`, error);
      notify({
        tone: "error",
        title: "Arquivo não carregado",
        message: error?.message || "Não foi possível abrir o arquivo selecionado.",
        important: true
      });
    } finally {
      input.value = "";
    }
  });

  dropzone.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropzone.classList.add("drag-over");
  });

  dropzone.addEventListener("dragleave", () => {
    dropzone.classList.remove("drag-over");
  });

  dropzone.addEventListener("drop", (event) => {
    event.preventDefault();
    dropzone.classList.remove("drag-over");
    processDropzoneSelection({ id, handler, filter, preflightType }, event.dataTransfer.files).catch((error) => {
        console.error(`Dropzone handler failed for ${id}:`, error);
        notify({
          tone: "error",
          title: "Arquivo não carregado",
          message: error?.message || "Não foi possível abrir o arquivo selecionado.",
          important: true
        });
    });
  });
}

function buildFileListItem(file, index, options = {}) {
  const moveControls = options.allowReorder
    ? `
      <button class="btn-secondary btn-sm" data-move-up="${index}" title="Mover este arquivo uma posição para cima" ${index === 0 ? "disabled" : ""}>${icon("chevronUp")}</button>
      <button class="btn-secondary btn-sm" data-move-down="${index}" title="Mover este arquivo uma posição para baixo" ${index === options.total - 1 ? "disabled" : ""}>${icon("chevronDown")}</button>
    `
    : "";

  const rangeInputHtml = options.showRangeInput
    ? `
      <div class="file-range-container" style="display: flex; align-items: center; gap: 8px; margin-top: 8px; padding-left: 30px;">
        <label for="merge-range-${index}" style="font-size: 0.78rem; font-weight: 600; color: var(--text-secondary); white-space: nowrap;">Páginas:</label>
        <input type="text" id="merge-range-${index}" class="merge-range-input" data-index="${index}" placeholder="Ex: 1-3, 5 (opcional)" value="${escapeHtml(file.range || '')}" style="flex: 1; min-height: 28px; padding: 4px 8px; font-size: 0.82rem; border: 1px solid var(--border-color); border-radius: 4px; background: var(--bg-card);">
      </div>
    `
    : "";
  const typeBadge = options.badgeLabel
    ? `<span class="toolbar-chip" style="margin-left: 8px; font-size: 0.72rem; padding: 3px 8px;">${escapeHtml(options.badgeLabel)}</span>`
    : "";
  const validationStatus = file.validationStatus || "pending";
  const validationLabels = { pending: "Verificando…", valid: "Pronto", protected: "Protegido", invalid: "Com problema" };
  const validationBadge = (options.allowReorder || options.showValidationStatus)
    ? `<span class="file-validation-status file-validation-${validationStatus}" title="${escapeHtml(file.validationMessage || '')}">${validationLabels[validationStatus] || validationLabels.pending}</span>`
    : "";
  const rotationControls = options.showRotate
    ? `
      <button class="btn-secondary btn-sm btn-icon rotate-left-icon" data-merge-rotate-left="${index}" title="Girar esta imagem 90 graus para a esquerda" aria-label="Girar ${escapeHtml(file.name)} para a esquerda">${icon("rotate-cw")}</button>
      <span class="toolbar-chip" aria-label="Rotação da imagem">${Number(file.rotation) || 0}°</span>
      <button class="btn-secondary btn-sm btn-icon" data-merge-rotate-right="${index}" title="Girar esta imagem 90 graus para a direita" aria-label="Girar ${escapeHtml(file.name)} para a direita">${icon("rotate-cw")}</button>
    `
    : "";

  const activeClass = options.isActive ? "active" : "";
  return `
    <li class="action-file-item ${activeClass}" data-index="${index}" tabindex="0" role="listitem" aria-label="Arquivo ${index + 1}: ${escapeHtml(file.name)}. Use Delete para remover." style="display: flex; flex-direction: column; align-items: stretch; gap: 4px;">
      <div class="action-file-row" style="display: flex; align-items: center; justify-content: space-between; width: 100%;">
        <div class="action-file-info">
          ${icon("file")}
          <div class="selected-file-meta">
            <div style="display: flex; align-items: center; flex-wrap: wrap; gap: 4px;">
              <span class="action-file-name" title="${escapeHtml(file.path || file.name)}">${escapeHtml(file.name)}</span>
              ${typeBadge}${validationBadge}
            </div>
            <span class="action-file-size">${escapeHtml(formatBytes(file.size))}</span>
          </div>
        </div>
        <div class="action-file-controls">
          ${rotationControls}
          ${moveControls}
          <button class="btn-danger-text btn-sm" data-remove="${index}" title="Remover este arquivo da lista">${icon("remove")}</button>
        </div>
      </div>
      ${rangeInputHtml}
    </li>
  `;
}

const MERGE_LARGE_BATCH_THRESHOLD = 32;
const MERGE_RENDER_CHUNK_SIZE = 12;
let mergeRenderRequestId = 0;

function yieldToRenderer() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const values = Array.isArray(items) ? items : [];
  const results = new Array(values.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, Number(concurrency) || 1), values.length || 1);

  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index], index);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function handleMergeFiles(files) {
  const existingKeys = new Set(state.mergeFiles.map((existing) => (
    existing.path || `${existing.name || "file"}:${existing.size || 0}`
  )));
  files.forEach((file) => {
    const fileKey = file?.path || `${file?.name || "file"}:${file?.size || 0}`;
    if (!fileKey) return;
    if (existingKeys.has(fileKey)) return;
    existingKeys.add(fileKey);
    const kind = /\.(jpg|jpeg|png)$/i.test(file.name) ? "image" : "pdf";
    state.mergeFiles.push({
      name: file.name,
      size: file.size,
      path: file.path || "",
      fileObject: file,
      kind,
      rotation: 0,
      validationStatus: "pending",
      validationMessage: "Verificando arquivo…"
    });
  });
  await renderMergeFileList();
  const entries = state.mergeFiles.filter((item) => item.validationStatus === "pending");
  if (entries.length === 0) return;
  if (!window.api?.preflightBatchFiles) {
    entries.forEach((entry) => {
      entry.validationStatus = "invalid";
      entry.validationMessage = "Não foi possível verificar este arquivo.";
    });
    await renderMergeFileList();
    notify({
      tone: "error",
      title: "Verificação dos arquivos",
      message: "Não foi possível confirmar os arquivos adicionados.",
      detail: "Recarregue o aplicativo e tente adicionar os arquivos novamente.",
      important: true
    });
    return;
  }
  try {
    const result = await window.api.preflightBatchFiles({ type: "merge", files: entries.map((item) => item.path) });
    const byPath = new Map((result?.results || []).map((item) => [item.path, item]));
    entries.forEach((entry) => {
      const status = byPath.get(entry.path);
      if (status) {
        entry.validationStatus = status.status;
        entry.validationMessage = status.message;
      }
    });
    const invalidEntries = entries.filter((entry) => entry.validationStatus === "invalid");
    const protectedEntries = entries.filter((entry) => entry.validationStatus === "protected");
    const validEntries = entries.filter((entry) => entry.validationStatus === "valid");
    if (invalidEntries.length > 0 || protectedEntries.length > 0) {
      const problemEntries = [...invalidEntries, ...protectedEntries];
      const details = problemEntries.slice(0, 3)
        .map((entry) => `${entry.name}: ${entry.validationMessage}`)
        .join(" • ");
      const remaining = problemEntries.length - Math.min(3, problemEntries.length);
      notify({
        id: `merge-upload-warning-${problemEntries.map((entry) => entry.path).join("|")}`,
        tone: "warning",
        title: "Arquivos adicionados com atenção",
        message: `${validEntries.length} arquivo(s) pronto(s); ${problemEntries.length} arquivo(s) não poderão ser mesclado(s).`,
        detail: `${details}${remaining > 0 ? ` • e mais ${remaining} arquivo(s)` : ""}`,
        important: true
      });
    } else {
      notify({
        id: `merge-upload-success-${entries.map((entry) => entry.path).join("|")}`,
        tone: "success",
        title: "Arquivos adicionados",
        message: `${validEntries.length} arquivo(s) verificado(s) e pronto(s) para mesclagem.`
      });
    }
  } catch (_) {
    entries.forEach((entry) => {
      entry.validationStatus = "invalid";
      entry.validationMessage = "Não foi possível verificar este arquivo.";
    });
    notify({
      tone: "error",
      title: "Falha na verificação",
      message: "Os arquivos foram adicionados, mas não foi possível confirmar a integridade deles.",
      detail: "Revise os itens marcados antes de tentar mesclar.",
      important: true
    });
  }
  await renderMergeFileList();
}

function getMergeFileKindLabel(kind) {
  if (kind === "image") return "Imagem";
  return "PDF";
}

function buildMergeSmartSummary() {
  const summary = document.getElementById("merge-smart-summary");
  if (!summary) return;

  const validFiles = state.mergeFiles.filter((file) => file.validationStatus === "valid");
  const pendingCount = state.mergeFiles.filter((file) => file.validationStatus === "pending").length;
  const problemCount = state.mergeFiles.filter((file) => ["invalid", "protected"].includes(file.validationStatus)).length;
  const pdfCount = validFiles.filter((file) => file.kind !== "image").length;
  const imageCount = validFiles.filter((file) => file.kind === "image").length;
  const totalCount = state.mergeFiles.length;

  if (totalCount === 0) {
    summary.style.display = "none";
    summary.textContent = "";
    return;
  }

  summary.style.display = "block";
  const largeBatchHint = totalCount >= MERGE_LARGE_BATCH_THRESHOLD
    ? " A interface será carregada em blocos para permanecer responsiva."
    : "";
  const statusSuffix = pendingCount > 0
    ? ` Verificando ${pendingCount} arquivo(s)…`
    : problemCount > 0
      ? ` ${problemCount} arquivo(s) com problema ficam fora da mesclagem.`
      : "";
  if (imageCount > 0 && pdfCount > 0) {
    summary.textContent = `${pdfCount} PDF${pdfCount > 1 ? "s" : ""} + ${imageCount} imagem${imageCount > 1 ? "s" : ""} prontos para mesclagem. Imagens serão convertidas localmente antes da mesclagem.${statusSuffix}${largeBatchHint}`;
  } else if (imageCount > 0) {
    summary.textContent = `${imageCount} imagem${imageCount > 1 ? "s" : ""} pronta${imageCount > 1 ? "s" : ""} para conversão e mesclagem.${statusSuffix}${largeBatchHint}`;
  } else {
    summary.textContent = `${pdfCount} PDF${pdfCount > 1 ? "s" : ""} pronto${pdfCount > 1 ? "s" : ""} para mesclagem.${statusSuffix}${largeBatchHint}`;
  }
}

async function renderMergeFileList() {
  const container = document.getElementById("merge-file-list-container");
  const list = document.getElementById("merge-file-list");
  const dropzone = document.getElementById("merge-dropzone");

  if (state.mergeFiles.length === 0) {
    mergeRenderRequestId += 1;
    list.innerHTML = "";
    container.classList.add("hidden");
    dropzone.classList.remove("hidden");
    return;
  }

  dropzone.classList.add("hidden");
  container.classList.remove("hidden");
  buildMergeSmartSummary();
  const requestId = ++mergeRenderRequestId;
  list.innerHTML = "";
  for (let start = 0; start < state.mergeFiles.length; start += MERGE_RENDER_CHUNK_SIZE) {
    if (requestId !== mergeRenderRequestId) return;
    const chunk = state.mergeFiles.slice(start, start + MERGE_RENDER_CHUNK_SIZE)
      .map((file, offset) => buildFileListItem(file, start + offset, {
        allowReorder: true,
        total: state.mergeFiles.length,
        showRangeInput: file.kind !== "image",
        showRotate: file.kind === "image",
        badgeLabel: getMergeFileKindLabel(file.kind)
      })).join("");
    list.insertAdjacentHTML("beforeend", chunk);
    if (start + MERGE_RENDER_CHUNK_SIZE < state.mergeFiles.length) await yieldToRenderer();
  }

  if (!list.dataset.mergeDelegated) {
    list.dataset.mergeDelegated = "true";
    list.addEventListener("click", (event) => {
      const target = event.target.closest("button");
      if (!target || !list.contains(target)) return;
      if (target.hasAttribute("data-move-up")) return swapMergeFiles(Number(target.getAttribute("data-move-up")), -1);
      if (target.hasAttribute("data-move-down")) return swapMergeFiles(Number(target.getAttribute("data-move-down")), 1);
      if (target.hasAttribute("data-merge-rotate-left")) return rotateMergeImage(Number(target.getAttribute("data-merge-rotate-left")), -90);
      if (target.hasAttribute("data-merge-rotate-right")) return rotateMergeImage(Number(target.getAttribute("data-merge-rotate-right")), 90);
      if (target.hasAttribute("data-remove")) {
        state.mergeFiles.splice(Number(target.getAttribute("data-remove")), 1);
        renderMergeFileList();
      }
    });
    list.addEventListener("input", (event) => {
      const input = event.target.closest(".merge-range-input");
      if (!input) return;
      const idx = Number(input.getAttribute("data-index"));
      if (state.mergeFiles[idx]) state.mergeFiles[idx].range = input.value;
    });
    list.addEventListener("keydown", (event) => {
      const item = event.target.closest(".action-file-item");
      if (!item || event.target.closest("button, input, select, textarea")) return;
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      event.preventDefault();
      item.querySelector("[data-remove]")?.click();
    });
  }
  buildMergeSmartSummary();
}

function swapMergeFiles(index, direction) {
  const targetIndex = index + direction;
  if (targetIndex < 0 || targetIndex >= state.mergeFiles.length) return;
  [state.mergeFiles[index], state.mergeFiles[targetIndex]] = [state.mergeFiles[targetIndex], state.mergeFiles[index]];
  renderMergeFileList();
}

function rotateMergeImage(index, delta) {
  const item = state.mergeFiles[index];
  if (!item || item.kind !== "image") return;
  item.rotation = (((Number(item.rotation) || 0) + delta) % 360 + 360) % 360;
  renderMergeFileList();
}

function handleSplitFile(file) {
  cancelSplitContentSearch();
  resetSplitContentResults();
  state.selectedSplitFile = file;
  document.getElementById("split-dropzone").classList.add("hidden");
  document.getElementById("split-settings-container").classList.remove("hidden");
  document.getElementById("split-file-name").textContent = file.name;
  document.getElementById("split-file-meta").textContent = formatBytes(file.size);
  const cleanName = file.name.replace(/\.pdf$/i, "");
  document.getElementById("split-output-prefix").value = `${cleanName}_separado`;
}

function resetSplitContentResults() {
  splitContentStartPages = [];
  document.getElementById("split-content-results")?.classList.add("hidden");
  document.getElementById("split-content-result-list")?.replaceChildren();
  const status = document.getElementById("split-content-status");
  if (status) {
    status.textContent = "Os pontos encontrados serão mostrados para revisão antes da divisão.";
    status.dataset.tone = "";
  }
}

function cancelSplitContentSearch() {
  if (!splitContentSearchRequestId) return;
  window.api.cancelPdfTextSearch?.(splitContentSearchRequestId);
  splitContentSearchRequestId = "";
  const analyzeButton = document.getElementById("btn-split-content-analyze");
  const suggestButton = document.getElementById("btn-split-content-suggest");
  const cancelButton = document.getElementById("btn-split-content-cancel");
  if (analyzeButton) analyzeButton.disabled = false;
  if (suggestButton) suggestButton.disabled = false;
  cancelButton?.classList.add("hidden");
}

async function analyzeSplitContent({ suggestSplitStarts = false } = {}) {
  const file = state.selectedSplitFile;
  const query = String(document.getElementById("split-content-query")?.value || "").trim();
  const status = document.getElementById("split-content-status");
  const results = document.getElementById("split-content-results");
  const resultList = document.getElementById("split-content-result-list");
  const analyzeButton = document.getElementById("btn-split-content-analyze");
  const suggestButton = document.getElementById("btn-split-content-suggest");
  const cancelButton = document.getElementById("btn-split-content-cancel");
  if (!file) return;
  if (!suggestSplitStarts && query.length < 2) {
    if (status) { status.textContent = "Digite pelo menos 2 caracteres para pesquisar."; status.dataset.tone = "warning"; }
    document.getElementById("split-content-query")?.focus();
    return;
  }
  cancelSplitContentSearch();
  resetSplitContentResults();
  const requestId = crypto.randomUUID();
  splitContentSearchRequestId = requestId;
  if (analyzeButton) analyzeButton.disabled = true;
  if (suggestButton) suggestButton.disabled = true;
  cancelButton?.classList.remove("hidden");
  if (status) {
    status.textContent = suggestSplitStarts
      ? "Analisando o topo das páginas para encontrar títulos recorrentes…"
      : "Preparando o documento para análise…";
    status.dataset.tone = "info";
  }
  const removeProgress = window.api.onOcrSearchProgress?.((progress) => {
    if (progress?.requestId !== requestId || splitContentSearchRequestId !== requestId) return;
    if (status) status.textContent = `Analisando página ${progress.page || 0} de ${progress.totalPages || 0}…`;
  });
  try {
    const filePath = await resolveQueuedFilePath(file, "pdf");
    if (splitContentSearchRequestId !== requestId) return;
    const result = await window.api.searchPdfText({ requestId, filePath, query, language: "por+eng", suggestSplitStarts });
    if (splitContentSearchRequestId !== requestId) return;
    if (result?.cancelled) {
      if (status) { status.textContent = "Análise cancelada. Nenhuma alteração foi feita no documento."; status.dataset.tone = "info"; }
      return;
    }
    const matches = Array.isArray(result?.matches) ? result.matches : [];
    const suggestions = Array.isArray(result?.suggestions) ? result.suggestions : [];
    const suggestionByPage = new Map(suggestions.map((suggestion) => [Number(suggestion.pageNumber), suggestion]));
    const foundPages = suggestSplitStarts
      ? suggestions.map((suggestion) => Number(suggestion.pageNumber))
      : matches.map((match) => Number(match.pageNumber));
    splitContentStartPages = [...new Set(foundPages.filter((page) => Number.isSafeInteger(page) && page > 1))].sort((a, b) => a - b);
    const tooManyBreaks = splitContentStartPages.length > 199;
    splitContentStartPages = splitContentStartPages.slice(0, 199);
    if (splitContentStartPages.length) {
      for (const page of splitContentStartPages) {
        const label = document.createElement("label");
        label.className = "split-content-result-row";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = !suggestSplitStarts;
        checkbox.value = String(page);
        checkbox.setAttribute("aria-label", `Iniciar nova parte na página ${page}`);
        const description = document.createElement("span");
        if (suggestSplitStarts) {
          const suggestion = suggestionByPage.get(page);
          const heading = String(suggestion?.heading || "título recorrente").slice(0, 100);
          description.textContent = `Página ${page} · “${heading}” · ${suggestion?.source === "OCR" ? "OCR" : "texto do PDF"} · aparece em ${Number(suggestion?.repeatedOnPages) || 2} páginas`;
        } else {
          description.textContent = `Página ${page} · ${matches.some((match) => Number(match.pageNumber) === page && match.source === "OCR") ? "texto reconhecido" : "texto do PDF"}`;
        }
        label.append(checkbox, description);
        resultList?.append(label);
      }
      results?.classList.remove("hidden");
      if (status) {
        status.textContent = suggestSplitStarts
          ? `${splitContentStartPages.length}${result?.truncated || tooManyBreaks ? "+" : ""} possível(is) início(s) sugerido(s) em ${Number(result?.scannedPages) || 0} páginas analisadas. As sugestões estão desmarcadas: confira cada página e marque somente as que devem iniciar uma parte${result?.truncated || tooManyBreaks ? ". A lista atingiu o limite de segurança." : "."}`
          : `${splitContentStartPages.length}${result?.truncated || tooManyBreaks ? "+" : ""} página(s) encontrada(s). Revise as caixas; somente as selecionadas iniciarão uma nova parte${result?.truncated || tooManyBreaks ? ". A lista tem limite de segurança; refine a expressão se necessário." : "."}`;
        status.dataset.tone = "success";
      }
    } else if (status) {
      status.textContent = suggestSplitStarts
        ? `Não foram encontrados títulos recorrentes que indiquem possíveis inícios entre as ${Number(result?.scannedPages) || 0} páginas analisadas. Se souber o título, pesquise-o pelo campo de palavra ou frase.`
        : `Nenhum ponto de separação encontrado para “${query}” nas ${Number(result?.scannedPages) || 0} páginas analisadas. Tente outra palavra ou frase.`;
      status.dataset.tone = "warning";
    }
  } catch (error) {
    if (splitContentSearchRequestId === requestId && status) {
      status.textContent = error?.message || "Não foi possível analisar este documento. Verifique se o PDF continua acessível e tente novamente.";
      status.dataset.tone = "error";
    }
  } finally {
    removeProgress?.();
    if (splitContentSearchRequestId === requestId) {
      splitContentSearchRequestId = "";
      if (analyzeButton) analyzeButton.disabled = false;
      if (suggestButton) suggestButton.disabled = false;
      cancelButton?.classList.add("hidden");
    }
  }
}

function handleCompressFile(file) {
  state.selectedCompressFile = file;
  document.getElementById("compress-dropzone").classList.add("hidden");
  document.getElementById("compress-settings-container").classList.remove("hidden");
  document.getElementById("compress-file-name").textContent = file.name;
  document.getElementById("compress-file-meta").textContent = formatBytes(file.size);
  const isImage = /\.(png|jpe?g)$/i.test(file.name || "");
  const cleanName = file.name.replace(/\.[^.]+$/i, "");
  document.getElementById("compress-output-name").value = isImage
    ? `${cleanName}_reduzido.${/\.jpe?g$/i.test(file.name || "") ? "jpg" : "png"}`
    : `${cleanName}_reduzido.pdf`;
  const modeSelector = document.getElementById("compress-mode-selector");
  if (modeSelector) {
    modeSelector.classList.toggle("hidden", isImage);
  }
}

async function handleOcrFiles(files) {
  const selected = Array.isArray(files) ? files : [...(files || [])];
  const existingEntries = Array.isArray(state.ocrFiles) ? state.ocrFiles : [];
  const fileKey = (file) => {
    const path = String(file?.path || '').trim().toLowerCase();
    return path || `${String(file?.name || '').trim().toLowerCase()}|${Number(file?.size) || 0}`;
  };
  const knownFiles = new Set(existingEntries.map(fileKey));
  const entries = selected
    .map((file) => ({ name: file.name, size: file.size, path: file.path || '', fileObject: file, validationStatus: 'pending' }))
    .filter((entry) => {
      const key = fileKey(entry);
      if (knownFiles.has(key)) return false;
      knownFiles.add(key);
      return true;
    });
  if (!entries.length) return;
  document.getElementById('ocr-dropzone')?.classList.add('hidden');
  document.getElementById('ocr-settings-card')?.classList.remove('hidden');
  const result = await window.api.preflightBatchFiles({ type: 'ocr', files: entries.map((item) => item.path) });
  const ocrRuntime = result?.ocrRuntime;
  state.ocrRuntime = ocrRuntime && typeof ocrRuntime === 'object' ? ocrRuntime : null;
  const hasAnyOcrModel = Array.isArray(ocrRuntime?.availableLanguages) && ocrRuntime.availableLanguages.length > 0;
  const hasAllOcrModels = Boolean(ocrRuntime?.available);
  const languageSelect = document.getElementById('ocr-language');
  if (hasAnyOcrModel && !hasAllOcrModels && languageSelect) {
    const fallbackLanguage = ocrRuntime.availableLanguages.includes('por') ? 'por' : 'eng';
    if (!ocrRuntime.availableLanguages.includes(languageSelect.value.split('+')[0]) || languageSelect.value.includes('+')) {
      languageSelect.value = fallbackLanguage;
    }
  }
  const runtimeWarning = document.getElementById('ocr-runtime-warning');
  if (runtimeWarning) {
    runtimeWarning.textContent = ocrRuntime?.missingLanguages?.length
      ? ocrRuntime.message || 'Os arquivos foram verificados, mas os modelos OCR não estão disponíveis. Reinstale o Central PDF ou procure o suporte de TI.'
      : '';
    runtimeWarning.classList.toggle('hidden', !ocrRuntime?.missingLanguages?.length);
    runtimeWarning.dataset.tone = ocrRuntime?.missingLanguages?.length ? 'warning' : '';
  }
  const byPath = new Map((result?.results || []).map((item) => [item.path, item]));
  const addedEntries = entries.map((entry) => ({ ...entry, validation: byPath.get(entry.path) }));
  state.ocrFiles = [...existingEntries, ...addedEntries];
  renderOcrFileList();
  renderOcrImagePreview();
  const valid = state.ocrFiles.filter((entry) => entry.validation?.status === 'valid');
  ocrAreaExtractor.setFiles(valid);
  const addedValid = addedEntries.filter((entry) => entry.validation?.status === 'valid').length;
  const invalid = addedEntries.length - addedValid;
  if (!hasAnyOcrModel) {
    notify({ tone: 'warning', title: 'OCR indisponível neste aplicativo', message: `${addedValid} arquivo(s) passaram pela verificação, mas não podem ser reconhecidos agora.${invalid ? ` ${invalid} arquivo(s) também apresentaram problemas.` : ''}`, detail: ocrRuntime.message, important: true });
  } else if (ocrRuntime?.missingLanguages?.length) {
    notify({ tone: 'warning', title: 'OCR parcialmente disponível', message: `Os arquivos foram verificados. O idioma foi ajustado para ${languageSelect?.value === 'por' ? 'português' : 'inglês'}, que está instalado.`, detail: ocrRuntime.message });
  } else {
    notify({ tone: invalid ? 'warning' : 'success', title: invalid ? 'Arquivos adicionados com atenção' : 'Arquivos adicionados', message: `${addedValid} arquivo(s) pronto(s) para reconhecimento.${invalid ? ` ${invalid} arquivo(s) não poderão ser processado(s).` : ''}` });
  }
}

function removeOcrFile(removeIndex) {
  if (!Array.isArray(state.ocrFiles) || removeIndex < 0 || removeIndex >= state.ocrFiles.length) return;
  state.ocrFiles.splice(removeIndex, 1);
  if (state.ocrFiles.length === 0) {
    clearOcrWorkspace();
    return;
  }
  renderOcrFileList();
  renderOcrImagePreview();
  const valid = state.ocrFiles.filter((entry) => entry.validation?.status === 'valid');
  ocrAreaExtractor.setFiles(valid);
}

function renderOcrFileList() {
  const list = document.getElementById('ocr-file-list');
  const subtitle = document.getElementById('ocr-files-subtitle');
  if (!list) return;
  const count = state.ocrFiles.length;
  if (subtitle) {
    subtitle.textContent = count
      ? `${count} arquivo${count === 1 ? '' : 's'} selecionado${count === 1 ? '' : 's'}. Remova individualmente ou adicione mais.`
      : 'Adicione mais documentos ou limpe a seleção.';
  }
  if (!count) {
    list.innerHTML = '';
    return;
  }
  list.innerHTML = state.ocrFiles.map((entry, index) => {
    const status = entry.validation?.status || 'invalid';
    const statusLabel = status === 'valid' ? 'Pronto' : (entry.validation?.message || 'Não disponível');
    return `
      <li class="action-file-item" data-index="${index}" style="display: flex; align-items: center; justify-content: space-between; padding: 6px 10px; gap: 8px;">
        <div class="action-file-info" style="display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1;">
          ${icon('file')}
          <div class="selected-file-meta" style="min-width: 0; flex: 1;">
            <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
              <span class="action-file-name" title="${escapeHtml(entry.path || entry.name)}">${escapeHtml(entry.name)}</span>
              <span class="file-validation-status file-validation-${status}">${escapeHtml(statusLabel)}</span>
            </div>
            <span class="action-file-size" style="font-size: 0.74rem; color: var(--text-secondary);">${escapeHtml(formatBytes(entry.size))}</span>
          </div>
        </div>
        <div class="action-file-controls" style="flex: 0 0 auto;">
          <button type="button" class="btn-danger-text btn-sm" data-remove-ocr="${index}" title="Remover ${escapeHtml(entry.name)} da lista" aria-label="Remover ${escapeHtml(entry.name)}">${icon('remove')}</button>
        </div>
      </li>
    `;
  }).join('');

  list.querySelectorAll('[data-remove-ocr]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const removeIndex = Number(button.getAttribute('data-remove-ocr'));
      removeOcrFile(removeIndex);
    });
  });
}

function releaseOcrImagePreviewUrl() {
  ocrImagePreviewToken += 1;
  if (ocrImagePreviewUrl) URL.revokeObjectURL(ocrImagePreviewUrl);
  ocrImagePreviewUrl = '';
  const image = document.getElementById('ocr-image-preview');
  if (image) {
    image.onload = null;
    image.onerror = null;
    image.removeAttribute('src');
    image.classList.add('hidden');
  }
}

function clearOcrImagePreview() {
  releaseOcrImagePreviewUrl();
  document.getElementById('ocr-image-preview-card')?.classList.add('hidden');
  document.getElementById('ocr-image-preview-file')?.replaceChildren();
  const status = document.getElementById('ocr-image-preview-status');
  if (status) status.textContent = '';
}

function renderOcrImagePreview() {
  const card = document.getElementById('ocr-image-preview-card');
  const select = document.getElementById('ocr-image-preview-file');
  const image = document.getElementById('ocr-image-preview');
  const status = document.getElementById('ocr-image-preview-status');
  if (!card || !select || !image || !status) return;

  const previousValue = select.value;
  const imageEntries = (Array.isArray(state.ocrFiles) ? state.ocrFiles : [])
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry?.validation?.status === 'valid' && /\.(?:jpe?g|png|tiff?)$/i.test(entry.name || ''));
  const hasPdfs = (Array.isArray(state.ocrFiles) ? state.ocrFiles : []).some(
    (entry) => entry?.validation?.status === 'valid' && /\.pdf$/i.test(entry.name || '')
  );

  // If there are PDFs, ocr-area-card is the active workspace; don't show stacked image preview card.
  if (hasPdfs || !imageEntries.length) {
    clearOcrImagePreview();
    return;
  }

  select.replaceChildren();
  for (const { entry, index } of imageEntries) {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = entry.name;
    select.append(option);
  }
  card.classList.remove('hidden');

  select.value = imageEntries.some(({ index }) => String(index) === previousValue)
    ? previousValue
    : String(imageEntries[0].index);
  const selected = state.ocrFiles[Number(select.value)];
  releaseOcrImagePreviewUrl();
  status.textContent = 'Carregando prévia local…';
  const fileObject = selected?.fileObject;
  const isTiff = /\.tiff?$/i.test(selected?.name || '');

  if (isTiff) {
    image.classList.add('hidden');
    status.textContent = 'Arquivo TIFF pronto para reconhecimento de texto via OCR.';
    return;
  }

  if (typeof Blob === 'undefined' || !(fileObject instanceof Blob) || typeof URL?.createObjectURL !== 'function') {
    image.classList.add('hidden');
    status.textContent = 'Imagem pronta para reconhecimento de texto via OCR.';
    return;
  }

  const token = ocrImagePreviewToken;
  try {
    ocrImagePreviewUrl = URL.createObjectURL(fileObject);
    image.onload = () => {
      if (token !== ocrImagePreviewToken) return;
      image.classList.remove('hidden');
      status.textContent = `${image.naturalWidth} × ${image.naturalHeight} px · prévia local`;
    };
    image.onerror = () => {
      if (token !== ocrImagePreviewToken) return;
      image.classList.add('hidden');
      status.textContent = 'Imagem pronta para reconhecimento via OCR.';
    };
    image.src = ocrImagePreviewUrl;
  } catch {
    releaseOcrImagePreviewUrl();
    image.classList.add('hidden');
    status.textContent = 'Imagem pronta para reconhecimento via OCR.';
  }
}

async function queueOcr(forcedFormat) {
  if (state.ocrRuntime && state.ocrRuntime.availableLanguages.length === 0) {
    showValidationMessage(document.getElementById('ocr-runtime-warning')?.textContent || 'O OCR não está disponível neste aplicativo. Reinstale o Central PDF ou procure o suporte de TI.');
    return;
  }
  const requestedLanguages = (document.getElementById('ocr-language')?.value || 'por+eng').split('+');
  if (state.ocrRuntime && requestedLanguages.some((language) => !state.ocrRuntime.availableLanguages.includes(language))) {
    showValidationMessage(state.ocrRuntime.message || 'O idioma selecionado não está instalado neste aplicativo. Escolha outro idioma disponível ou reinstale o Central PDF.');
    return;
  }
  const validFiles = state.ocrFiles.filter((entry) => entry.validation?.status === 'valid');
  if (!validFiles.length) {
    showValidationMessage('Adicione pelo menos um PDF ou imagem válido para reconhecer o texto.');
    return;
  }
  const format = typeof forcedFormat === 'string' && ['pdf', 'text'].includes(forcedFormat)
    ? forcedFormat
    : (document.getElementById('ocr-format')?.value || 'pdf');
  const outputName = document.getElementById('ocr-output-name')?.value.trim() || '';
  const result = await window.api.queueOperation({
    type: 'ocr',
    files: validFiles.map((entry) => entry.path),
    options: {
      language: document.getElementById('ocr-language')?.value || 'por+eng',
      mode: document.getElementById('ocr-mode')?.value || 'auto',
      format,
      autoRotate: document.getElementById('ocr-auto-rotate')?.checked !== false,
      imageEnhancement: document.getElementById('ocr-image-enhancement')?.checked !== false,
      pageRange: document.getElementById('ocr-page-range')?.value.trim() || '',
      ...(outputName ? { outputName } : {}),
      zipResults: document.getElementById('ocr-zip')?.checked ?? false,
      originalFileNames: validFiles.map((entry) => entry.name)
    }
  });
  if (!result?.success) showOperationFailure('ocr', result?.error);
  else notify({
    tone: 'success',
    title: format === 'text' ? 'Exportação TXT enviada' : 'Reconhecimento enviado',
    message: format === 'text'
      ? 'Os arquivos estão sendo processados para texto (.txt) na fila.'
      : 'Os arquivos foram adicionados à fila. O progresso aparecerá no painel de processamento.'
  });
}

function queueOcrTxt() {
  return queueOcr('text');
}

function clearOcrWorkspace() {
  clearPreviousTabState('ocr');
  document.getElementById('ocr-file-input').value = '';
  document.getElementById('ocr-dropzone')?.classList.remove('hidden');
  document.getElementById('ocr-settings-card')?.classList.add('hidden');
}

async function routeEditorFileToOrganize(source) {
  const isSignature = source === "signature";
  const file = isSignature ? state.signatureFile : state.redactFile;
  if (!file) return;

  const hasPlacedElements = isSignature
    ? state.signatureFields.length > 0
    : (state.redactBoxes || []).length > 0;
  const proceed = async () => {
    if (isSignature) signatureWorkspace.clearWorkspace();
    else redactWorkspace.clearWorkspace();
    switchTab("organize", { skipGuard: true });
    await organizeWorkspace.handleOrganizeFile(file);
  };

  if (hasPlacedElements) {
    showCustomConfirmModal(
      "Corrigir orientação",
      isSignature
        ? "Os campos de assinatura atuais serão removidos antes de abrir o documento em Organizar Páginas. Deseja continuar?"
        : "As tarjas atuais serão removidas antes de abrir o documento em Organizar Páginas. Deseja continuar?",
      proceed
    );
    return;
  }

  await proceed();
}

function setupOperations() {
  bindClick("btn-run-images-pdf", queueImagesToPdf);
  bindClick("btn-run-signature", queueSignature);
  bindClick("btn-run-pdf-to-word", queuePdfToWord);
  bindClick("btn-run-merge", queueMerge);
  bindClick("btn-run-split", queueSplit);
  bindClick("btn-run-compress", queueCompress);
  bindClick("btn-run-organize", queueOrganize);
  bindClick("btn-run-watermark", queueWatermark);
  bindClick("btn-run-protect", queueProtect);
  bindClick("btn-run-unlock", queueUnlock);
  bindClick("btn-run-redact", queueRedact);
  bindClick("btn-run-ocr", queueOcr);
  bindClick("btn-run-ocr-txt", queueOcrTxt);

  bindClick("btn-ocr-add-more", () => document.getElementById("ocr-file-input")?.click());
  bindClick("btn-ocr-clear", clearOcrWorkspace);
  const ocrImagePreviewFileSelect = document.getElementById('ocr-image-preview-file');
  if (ocrImagePreviewFileSelect && !ocrImagePreviewFileSelect.dataset.previewBound) {
    ocrImagePreviewFileSelect.addEventListener('change', renderOcrImagePreview);
    ocrImagePreviewFileSelect.dataset.previewBound = 'true';
  }

  const btnImagesAddMore = document.getElementById("btn-images-pdf-add-more");
  if (btnImagesAddMore) {
    btnImagesAddMore.addEventListener("click", () => document.getElementById("images-pdf-input").click());
  }
  const btnMergeAddMore = document.getElementById("btn-merge-add-more");
  if (btnMergeAddMore) {
    btnMergeAddMore.addEventListener("click", () => document.getElementById("merge-file-input").click());
  }
  bindClick("btn-merge-clear", () => {
    state.mergeFiles = [];
    void renderMergeFileList();
  });
  const btnWatermarkAddMore = document.getElementById("btn-watermark-add-more");
  if (btnWatermarkAddMore) {
    btnWatermarkAddMore.addEventListener("click", () => document.getElementById("watermark-file-input").click());
  }
  bindClick("btn-watermark-clear", watermarkWorkspace.clearWorkspace);

  bindClick("btn-split-change-file", () => {
    cancelSplitContentSearch();
    resetSplitContentResults();
    state.selectedSplitFile = null;
    document.getElementById("split-settings-container").classList.add("hidden");
    document.getElementById("split-dropzone").classList.remove("hidden");
  });

  bindClick("btn-compress-change-file", () => {
    state.selectedCompressFile = null;
    document.getElementById("compress-settings-container").classList.add("hidden");
    document.getElementById("compress-dropzone").classList.remove("hidden");
  });

  bindClick("btn-organize-clear-file", organizeWorkspace.clearOrganizeWorkspace);
  const btnOrganizeAddFile = document.getElementById("btn-organize-add-file");
  const organizeAddFileInput = document.getElementById("organize-add-file-input");
  if (btnOrganizeAddFile && organizeAddFileInput) {
    btnOrganizeAddFile.addEventListener("click", () => organizeAddFileInput.click());
    organizeAddFileInput.addEventListener("change", async (event) => {
      try {
        const files = normalizeSelectedFiles(event.target.files);
        await organizeWorkspace.addOrganizeFiles(files);
      } finally {
        organizeAddFileInput.value = "";
      }
    });
  }
  const btnOrganizeAddImage = document.getElementById("btn-organize-add-image");
  const organizeAddImageInput = document.getElementById("organize-add-image-input");
  if (btnOrganizeAddImage && organizeAddImageInput) {
    btnOrganizeAddImage.addEventListener("click", () => organizeAddImageInput.click());
    organizeAddImageInput.addEventListener("change", async (event) => {
      try {
        const files = normalizeSelectedFiles(event.target.files);
        await organizeWorkspace.addOrganizeFiles(files);
      } finally {
        organizeAddImageInput.value = "";
      }
    });
  }
  bindClick("btn-organize-move-first", () => organizeWorkspace.moveSelectedPages("first"));
  bindClick("btn-organize-move-up", () => organizeWorkspace.moveSelectedPages("up"));
  bindClick("btn-organize-move-down", () => organizeWorkspace.moveSelectedPages("down"));
  bindClick("btn-organize-move-last", () => organizeWorkspace.moveSelectedPages("last"));
  bindClick("btn-organize-rotate-selected", organizeWorkspace.rotateSelectedPages);
  bindClick("btn-signature-fix-orientation", () => routeEditorFileToOrganize("signature"));
  bindClick("btn-redact-fix-orientation", () => routeEditorFileToOrganize("redact"));
  bindClick("btn-organize-duplicate-selected", organizeWorkspace.duplicateSelectedPages);
  bindClick("btn-organize-delete-selected", organizeWorkspace.deleteSelectedPages);
  bindClick("btn-organize-reverse", organizeWorkspace.reverseOrganizeOrder);

  document.querySelectorAll('input[name="split-mode"]').forEach((radio) => {
    radio.addEventListener("change", (event) => {
      const mode = event.target.value;
      if (mode !== "content") cancelSplitContentSearch();
      document.getElementById("split-range-input-group").classList.toggle("hidden", mode !== "range");
      document.getElementById("split-size-input-group").classList.toggle("hidden", mode !== "size");
      document.getElementById("split-content-input-group").classList.toggle("hidden", mode !== "content");
    });
  });
  bindClick("btn-split-content-analyze", analyzeSplitContent);
  bindClick("btn-split-content-suggest", () => analyzeSplitContent({ suggestSplitStarts: true }));
  bindClick("btn-split-content-cancel", () => {
    cancelSplitContentSearch();
    const status = document.getElementById("split-content-status");
    if (status) { status.textContent = "Análise cancelada. Nenhuma alteração foi feita no documento."; status.dataset.tone = "info"; }
  });
  const splitContentQuery = document.getElementById("split-content-query");
  splitContentQuery?.addEventListener("input", () => {
    if (!splitContentStartPages.length && !splitContentSearchRequestId) return;
    cancelSplitContentSearch();
    resetSplitContentResults();
    const status = document.getElementById("split-content-status");
    if (status) { status.textContent = "A busca mudou. Analise novamente para confirmar os pontos de separação."; status.dataset.tone = "info"; }
  });

  bindClick("btn-select-output-dir", async () => {
    const dir = await window.api.selectDirectory();
    if (dir) {
      await window.api.updateOutputDir(dir);
      await loadAppConfig();
    }
  });

  bindClick("btn-clear-output-dir", async () => {
    await window.api.updateOutputDir("");
    await loadAppConfig();
  });

  bindChange("setting-theme", async (event) => {
    await window.api.updateTheme(event.target.value);
    applyTheme(event.target.value);
  });

  bindChange("setting-color-theme", async (event) => {
    await window.api.updateColorTheme(event.target.value);
    state.appConfig.colorTheme = event.target.value;
    applyColorTheme(event.target.value);
  });

  bindChange("setting-open-output-automatically", async (event) => {
    const enabled = event.target.checked === true;
    try {
      await window.api.updateOpenOutputAutomatically(enabled);
      state.appConfig.openOutputAutomatically = enabled;
    } catch (error) {
      event.target.checked = state.appConfig?.openOutputAutomatically === true;
      throw error;
    }
  });

  bindClick("btn-export-diagnostics", async () => {
    const result = await window.api.exportDiagnostics();
    if (result.success) {
      notify({
        tone: "success",
        title: "Diagnóstico exportado",
        message: `Pacote salvo em ${result.path}`
      });
      showFeedbackBanner({
        mode: "info",
        tone: "success",
        title: "Exportação concluída",
        message: "Pacote de diagnóstico pronto para a equipe de TI.",
        detail: result.path,
        icon: toneIcon("success", 18)
      });
    } else if (result.reason !== "canceled") {
      notify({
        tone: "error",
        title: "Diagnóstico",
        message: `Falha ao exportar diagnóstico: ${result.error}`,
        important: true
      });
    }
  });

  bindClick("btn-force-close-app", async () => {
    showCustomConfirmModal(
      "Fechar Aplicativo",
      "Deseja fechar o Central PDF agora?\n\nUse esta opção quando o encerramento normal parecer travado ou não responder.",
      async () => {
        await window.api.forceCloseApp();
      }
    );
  });
}

async function queueMerge() {
  const pendingFiles = state.mergeFiles.filter((file) => file.validationStatus === "pending");
  if (pendingFiles.length > 0) {
    showValidationMessage("Aguarde a verificação dos arquivos terminar.");
    return;
  }
  const mergeableFiles = state.mergeFiles.filter((file) => file.validationStatus === "valid");
  if (mergeableFiles.length < 2) {
    showValidationMessage("Selecione pelo menos 2 arquivos para mesclar.");
    return;
  }

  const outputName = document.getElementById("merge-output-name").value.trim();
  if (!outputName) {
    showValidationMessage("Informe um nome para o arquivo final.");
    return;
  }

  const filePaths = [];
  const originalFileNames = [];
  const cleanupPaths = [];
  const ranges = [];
  const preparationWarnings = [];

  const preparedResults = await mapWithConcurrency(mergeableFiles, 2, async (item) => {
    try {
      const prepared = await prepareMergeInputFile(item);
      if (!prepared?.path) throw new Error("não foi possível obter o arquivo preparado");
      return { item, prepared };
    } catch (error) {
      return { item, error };
    }
  });

  for (const result of preparedResults) {
    if (result?.prepared?.path) {
      filePaths.push(result.prepared.path);
      originalFileNames.push(result.item.name || "");
      ranges.push(result.item.range || "");
      cleanupPaths.push(...(result.prepared.cleanupPaths || []));
    } else {
      const fileName = result?.item?.name || "arquivo selecionado";
      preparationWarnings.push(`Arquivo "${fileName}" foi ignorado: não foi possível prepará-lo para mesclagem.`);
    }
  }

  if (filePaths.length < 2) {
    if (cleanupPaths.length > 0) {
      await window.api.deleteTempPaths(cleanupPaths).catch(() => {});
    }
    showOperationFailure("merge", preparationWarnings.slice(0, 8).join("\n") || "Não foi possível preparar arquivos suficientes para mesclar.");
    return;
  }

  const result = await queueOperation({
    type: "merge",
    files: filePaths,
    options: {
      outputName,
      zipResults: document.getElementById("merge-zip")?.checked ?? false,
      searchableOcr: document.getElementById("merge-searchable-ocr")?.checked ?? false,
      cleanupPaths,
      originalFileNames,
      ranges,
      validationWarnings: preparationWarnings
    }
  });

  if (!result.success) {
    if (cleanupPaths.length > 0) {
      await window.api.deleteTempPaths(cleanupPaths).catch(() => {});
    }
    showOperationFailure("merge", result.error);
    return;
  }
  showOperationQueuedFeedback("merge", result);

  state.mergeFiles = [];
  renderMergeFileList();
  switchTab("dashboard", { skipGuard: true });
}

async function queueSignature() {
    if (!state.signatureFile) {
      showValidationMessage("Selecione um PDF para assinar.");
      return;
    }

  if (!state.signatureFields.length) {
    showValidationMessage("Adicione pelo menos um campo visual antes de aplicar a assinatura.");
    return;
  }

  const payload = signatureWorkspace.getQueuePayload();
    if (!payload.options.outputName) {
      showValidationMessage("Informe o nome do arquivo assinado.");
      return;
    }

    payload.options.zipResults = document.getElementById("signature-zip")?.checked ?? false;
    payload.options.originalFileNames = [state.signatureFile.name || ""];
    payload.files = [await resolveQueuedFilePath(state.signatureFile, "pdf")];

    if (state.signatureSealFile) {
      const sealPath = await resolveQueuedFilePath(state.signatureSealFile, "png");
      payload.options.fields = payload.options.fields.map((field) => (
        field.type === "seal" ? { ...field, imagePath: sealPath } : field
      ));
    }

    const runBtn = document.getElementById("btn-run-signature");
    const originalText = runBtn?.innerHTML || "";

    if (runBtn) {
      runBtn.disabled = true;
      runBtn.innerText = "Aplicando...";
    }

    try {
      const result = await queueOperation(payload);
      if (!result.success) {
        showOperationFailure("sign", result.error);
        return;
      }

      showOperationQueuedFeedback("sign", result);
      signatureWorkspace.clearWorkspace();
      switchTab("dashboard", { skipGuard: true });
    } catch (error) {
      console.error("Erro ao aplicar assinatura:", error);
      showOperationFailure("sign", error.message || error);
    } finally {
      if (runBtn) {
        runBtn.disabled = false;
        runBtn.innerHTML = originalText;
      }
    }
  }

async function queuePdfToWord() {
  if (!state.pdfToWordFile) {
    showValidationMessage("Selecione um PDF textual para converter.");
    return;
  }

  const payload = pdfToWordWorkspace.getQueuePayload();
  if (!payload.options.outputName) {
    showValidationMessage("Informe o nome do arquivo convertido.");
    return;
  }

  payload.options.zipResults = document.getElementById("pdf-to-word-zip")?.checked ?? false;
  payload.options.useOcr = document.getElementById("pdf-to-word-use-ocr")?.checked ?? false;
  payload.options.originalFileNames = [state.pdfToWordFile.name || ""];
  payload.files = [await resolveQueuedFilePath(state.pdfToWordFile, "pdf")];
  const result = await queueOperation(payload);
  if (!result.success) {
    showOperationFailure("pdf-to-word", result.error);
    return;
  }

  pdfToWordWorkspace.showStatus({
    tone: result.warnings?.length ? "warning" : "success",
    title: result.warnings?.length ? "Conversão enviada com atenção" : "Conversão enviada",
    message: result.warnings?.length
      ? result.warnings[0]
      : "A tarefa entrou na fila e o resultado aparecerá no histórico quando finalizar."
  });
}

async function queueImagesToPdf() {
  if (state.imagePdfFiles.length === 0) {
    showValidationMessage("Selecione pelo menos um arquivo.");
    return;
  }

  const pendingFiles = state.imagePdfFiles.filter((file) => (file.validationStatus || 'valid') === 'pending');
  if (pendingFiles.length > 0) {
    showValidationMessage("Aguarde a verificação dos arquivos terminar.");
    return;
  }
  const inputFiles = state.imagePdfFiles.filter((file) => (file.validationStatus || 'valid') === 'valid');
  if (inputFiles.length === 0) {
    showOperationFailure("files-to-pdf", "Nenhum arquivo válido está disponível para conversão.");
    return;
  }

  const outputName = document.getElementById("images-pdf-output-name").value.trim();
  if (!outputName) {
    showValidationMessage("Informe o nome do PDF final.");
    return;
  }

  const optimize = document.getElementById("images-pdf-optimize")?.checked ?? false;
  const hasOfficeDocument = inputFiles.some((item) => /\.(docx|xlsx)$/i.test(item.name || ""));
  if (optimize && hasOfficeDocument) {
    showValidationMessage("O modo otimizado está disponível apenas para imagens. Desmarque-o para converter documentos.");
    return;
  }
  let filePaths = [];
  const cleanupPaths = [];
  const sourceRotations = [];
  const preparedOriginalFileNames = [];
  const preparationWarnings = [];

  const runBtn = document.getElementById("btn-run-images-pdf");
  const originalText = runBtn.innerHTML;

  runBtn.disabled = true;
  runBtn.innerText = optimize ? "Preparando..." : "Enviando...";

  try {
    for (const item of inputFiles) {
      try {
        if (/\.(docx|xlsx)$/i.test(item.name || "")) {
          const sourcePath = await resolveQueuedFilePath(item, item.name.toLowerCase().endsWith('.xlsx') ? 'xlsx' : 'docx');
          const tempPath = await window.api.convertDocumentToTempPdf(sourcePath);
          filePaths.push(tempPath);
          preparedOriginalFileNames.push(item.name || "arquivo");
          sourceRotations.push(0);
          cleanupPaths.push(tempPath);
          continue;
        }

        if (optimize) {
          const fileObj = item.fileObject;
          if (!fileObj) {
            throw new Error("arquivo não disponível para otimização");
          }
          const base64Data = await downsampleImage(fileObj, 1500, 0.75);
          const tempPath = await window.api.saveTempFile({ base64Data, extension: "jpg" });
          filePaths.push(tempPath);
          preparedOriginalFileNames.push(item.name || "arquivo");
          sourceRotations.push(Number(item.rotation) || 0);
          cleanupPaths.push(tempPath);
          continue;
        }

        if (item.path) {
          filePaths.push(item.path);
          preparedOriginalFileNames.push(item.name || "arquivo");
          sourceRotations.push(Number(item.rotation) || 0);
          continue;
        }
        if (!item.fileObject) {
          throw new Error("imagem sem caminho local e sem conteúdo disponível");
        }
        const base64Data = await fileToBase64(item.fileObject);
        const ext = (item.fileObject.name || item.name || "jpg").split(".").pop().toLowerCase();
        const tempPath = await window.api.saveTempFile({
          base64Data,
          extension: ["jpg", "jpeg", "png"].includes(ext) ? ext : "jpg"
        });
        filePaths.push(tempPath);
        preparedOriginalFileNames.push(item.name || "arquivo");
        sourceRotations.push(Number(item.rotation) || 0);
        cleanupPaths.push(tempPath);
      } catch (error) {
        preparationWarnings.push(`Arquivo "${item.name || 'sem nome'}" foi ignorado: ${error.message || 'não foi possível prepará-lo'}.`);
      }
    }
  } catch (error) {
    if (cleanupPaths.length > 0) {
      await window.api.deleteTempPaths(cleanupPaths).catch(() => {});
    }
    console.error("Erro na preparação dos arquivos para PDF:", error);
    showOperationFailure("files-to-pdf", `Não foi possível preparar os arquivos: ${error.message || error}`);
    return;
  } finally {
    runBtn.disabled = false;
    runBtn.innerHTML = originalText;
  }

  if (filePaths.length === 0) {
    if (cleanupPaths.length > 0) {
      await window.api.deleteTempPaths(cleanupPaths).catch(() => {});
    }
    showOperationFailure("files-to-pdf", preparationWarnings.slice(0, 8).join("\n") || "Nenhum arquivo pôde ser preparado para conversão.");
    return;
  }

  const result = await queueOperation({
    type: "files-to-pdf",
    files: filePaths,
    options: {
      outputName,
      zipResults: document.getElementById("images-pdf-zip")?.checked ?? false,
      originalFileNames: preparedOriginalFileNames,
      sourceRotations,
      searchableOcr: document.getElementById("images-pdf-searchable")?.checked ?? false,
      cleanupPaths,
      validationWarnings: preparationWarnings
    }
  });

  if (!result.success) {
    if (cleanupPaths.length > 0) {
      await window.api.deleteTempPaths(cleanupPaths).catch(() => {});
    }
    showOperationFailure("files-to-pdf", result.error);
    return;
  }

  showOperationQueuedFeedback("files-to-pdf", result);
  imageToPdfWorkspace.clearWorkspace();
  switchTab("dashboard", { skipGuard: true });
}

async function queueSplit() {
  if (!state.selectedSplitFile) return;

  const mode = document.querySelector('input[name="split-mode"]:checked').value;
  const prefix = document.getElementById("split-output-prefix").value.trim();
  if (!prefix) {
    showValidationMessage("Informe um prefixo para os arquivos.");
    return;
  }

  const options = { prefix };
  let type = "split-pages";

  if (mode === "range") {
    const rangeStr = document.getElementById("split-range-string").value.trim();
    if (!rangeStr) {
      showValidationMessage("Informe o intervalo de páginas.");
      return;
    }
    type = "split-range";
    options.rangeStr = rangeStr;
  } else if (mode === "size") {
    const sizeMb = Number(document.getElementById("split-size-limit").value);
    if (!Number.isFinite(sizeMb) || sizeMb <= 0) {
      showValidationMessage("Informe um tamanho válido.");
      return;
    }
    type = "split-size";
    options.maxSizeBytes = sizeMb * 1024 * 1024;
  } else if (mode === "content") {
    const selectedPages = [...(document.querySelectorAll("#split-content-result-list input[type='checkbox']:checked") || [])]
      .map((checkbox) => Number(checkbox.value))
      .filter((page) => Number.isSafeInteger(page) && page > 1);
    if (!splitContentStartPages.length) {
      showValidationMessage("Analise o documento e revise os pontos encontrados antes de iniciar a divisão por conteúdo.");
      return;
    }
    if (!selectedPages.length) {
      showValidationMessage("Selecione pelo menos uma página para iniciar uma nova parte.");
      return;
    }
    type = "split-content";
    options.startPages = [...new Set(selectedPages)].sort((a, b) => a - b);
  }

  options.zipResults = document.getElementById("split-zip")?.checked ?? false;
  options.originalFileNames = [state.selectedSplitFile.name || ""];
  const splitInputPath = await resolveQueuedFilePath(state.selectedSplitFile, "pdf");
  const result = await queueOperation({
    type,
    files: [splitInputPath],
    options
  });

  if (!result.success) {
    showOperationFailure(type, result.error);
    return;
  }
  showOperationQueuedFeedback(type, result);

  cancelSplitContentSearch();
  resetSplitContentResults();
  state.selectedSplitFile = null;
  document.getElementById("split-settings-container").classList.add("hidden");
  document.getElementById("split-dropzone").classList.remove("hidden");
  switchTab("dashboard", { skipGuard: true });
  return result;
}

async function queueCompress() {
  if (!state.selectedCompressFile) return;

  const outputName = document.getElementById("compress-output-name").value.trim();
  if (!outputName) {
    showValidationMessage("Informe o nome do arquivo final.");
    return;
  }

  const isImageInput = /\.(png|jpe?g)$/i.test(state.selectedCompressFile?.name || "");
  const mode = isImageInput
    ? "normal"
    : (document.querySelector('input[name="compress-mode"]:checked')?.value || "normal");

  if (mode === "rasterize") {
    const runBtn = document.getElementById("btn-run-compress");
    const originalText = runBtn.innerHTML;
    runBtn.disabled = true;
    runBtn.innerText = "Rasterizando...";

    try {
      const fileBytes = await state.selectedCompressFile.arrayBuffer();
      const loadingTask = pdfjsLib.getDocument({ data: fileBytes });
      const pdfDoc = await loadingTask.promise;
      const numPages = pdfDoc.numPages;

      const tempJpegs = [];

      for (let i = 1; i <= numPages; i++) {
        runBtn.innerText = `Rasterizando pág. ${i}/${numPages}...`;
        const page = await pdfDoc.getPage(i);
        const viewport = page.getViewport({ scale: 3.0 });
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          throw new Error("Contexto Canvas 2D indisponível para renderização.");
        }
        await page.render({ canvasContext: ctx, viewport }).promise;

        const dataUrl = canvas.toDataURL("image/jpeg", 0.75);
        const base64Data = dataUrl.split(",")[1];
        const tempPath = await window.api.saveTempFile({ base64Data, extension: "jpg" });
        tempJpegs.push(tempPath);
      }

      runBtn.innerText = "Enviando para fila...";
      const result = await queueOperation({
        type: "images-to-pdf",
        files: tempJpegs,
        options: {
          outputName,
          zipResults: document.getElementById("compress-zip")?.checked ?? false,
          originalFileNames: [state.selectedCompressFile.name || ""]
        }
      });

      if (!result.success) {
        showOperationFailure("compress", result.error);
        return;
      }

      showOperationQueuedFeedback("compress", result);

      state.selectedCompressFile = null;
      document.getElementById("compress-settings-container").classList.add("hidden");
      document.getElementById("compress-dropzone").classList.remove("hidden");
      switchTab("dashboard", { skipGuard: true });
    } catch (error) {
      console.error("Erro na compressão por rasterização:", error);
      showOperationFailure("compress", `Compressão falhou: ${error.message || error}`);
    } finally {
      runBtn.disabled = false;
      runBtn.innerHTML = originalText;
    }
  } else {
    const compressInputPath = await resolveQueuedFilePath(
      state.selectedCompressFile,
      isImageInput ? (/\.png$/i.test(state.selectedCompressFile?.name || "") ? "png" : "jpg") : "pdf"
    );
    const result = await queueOperation({
      type: "compress",
      files: [compressInputPath],
      options: {
        outputName,
        zipResults: document.getElementById("compress-zip")?.checked ?? false,
        originalFileNames: [state.selectedCompressFile.name || ""]
      }
    });

    if (!result.success) {
      showOperationFailure("compress", result.error);
      return;
    }
    showOperationQueuedFeedback("compress", result);

    state.selectedCompressFile = null;
    document.getElementById("compress-settings-container").classList.add("hidden");
    document.getElementById("compress-dropzone").classList.remove("hidden");
    switchTab("dashboard", { skipGuard: true });
  }
}

async function queueOrganize() {
  if (state.organizeFiles.length === 0) return;
  if (state.organizePages.length === 0) {
    showValidationMessage("Mantenha pelo menos uma página antes de salvar.");
    return;
  }

  const outputName = document.getElementById("organize-output-name").value.trim();
  if (!outputName) {
    showValidationMessage("Informe o nome do arquivo final.");
    return;
  }

  try {
    const cleanupPaths = [...new Set((state.organizeTempPaths || []).filter((item) => typeof item === "string" && item.trim()))];
    const filesArray = [];
    for (const file of state.organizeFiles) {
      filesArray.push(await resolveQueuedFilePath(file, "pdf"));
    }

    // Helper to recursive-map bookmarks tree to the new page ordering
    function mapBookmarksToOutput(nodes) {
      const mapped = [];
      for (const node of nodes) {
        const pageIndex = state.organizePages.findIndex(p => p.fileIndex === node.fileIndex && p.sourceIndex === node.sourceIndex);
        const childNodes = node.children && node.children.length > 0 ? mapBookmarksToOutput(node.children) : [];
        if (pageIndex !== -1 || childNodes.length > 0) {
          mapped.push({
            title: node.title,
            pageIndex, // This will be the index in the new PDF page array (or -1 if not pointing to a page but has children)
            children: childNodes
          });
        }
      }
      return mapped;
    }

    const bookmarks = mapBookmarksToOutput(state.organizeBookmarks || []);

    const result = await queueOperation({
      type: "organize",
      files: filesArray,
      options: {
        outputName,
        pageActions: state.organizePages.map((page) => ({
          fileIndex: page.fileIndex || 0,
          sourceIndex: page.sourceIndex,
          rotation: page.rotation
        })),
        bookmarks,
        zipResults: document.getElementById("organize-zip")?.checked ?? false,
        numberPages: document.getElementById("organize-number-pages")?.checked ?? false,
        cleanupPaths,
        originalFileNames: state.organizeFiles.map((file) => file.name || "")
      }
    });

    if (!result.success) {
      showOperationFailure("organize", result.error);
      return;
    }
    showOperationQueuedFeedback("organize", result);

    state.organizeTempPaths = [];
    organizeWorkspace.clearOrganizeWorkspace();
    switchTab("dashboard", { skipGuard: true });
  } catch (error) {
    console.error("Erro no salvamento da organização:", error);
    showOperationFailure("organize", `Organização falhou: ${error.message || error}`);
  }
}

async function queueWatermark() {
  if (!watermarkWorkspace.validateBeforeQueue()) return;

  const pendingFiles = (state.watermarkFiles || []).filter((file) => (file.validationStatus || 'pending') === 'pending');
  if (pendingFiles.length > 0) {
    showValidationMessage("Aguarde a verificação dos arquivos terminar.");
    return;
  }
  const validWatermarkFiles = (state.watermarkFiles || []).filter((file) => file.validationStatus === 'valid');
  if (validWatermarkFiles.length === 0) {
    showOperationFailure("watermark", "Nenhum arquivo válido está disponível para aplicar a marca d'água.");
    return;
  }

  const payload = watermarkWorkspace.getQueuePayload();
  payload.files = validWatermarkFiles.map((file) => file.path);
  payload.options.sourceRotations = validWatermarkFiles.map((file) => Number(file.rotation) || 0);
  payload.options.zipResults = document.getElementById("watermark-zip")?.checked ?? false;
  payload.options.numberPages = document.getElementById("watermark-number-pages")?.checked ?? false;
  const watermarkFiles = [];
  const watermarkOriginalFileNames = [];
  const watermarkWarnings = [];
  const watermarkResults = await mapWithConcurrency(validWatermarkFiles, 4, async (file) => {
    try {
      return { file, resolvedPath: await resolveQueuedFilePath(file, "pdf") };
    } catch (error) {
      return { file, error };
    }
  });
  for (const result of watermarkResults) {
    if (result?.resolvedPath) {
      watermarkFiles.push(result.resolvedPath);
      watermarkOriginalFileNames.push(result.file.name || "arquivo");
    } else {
      watermarkWarnings.push(`Arquivo "${result?.file?.name || 'sem nome'}" foi ignorado: não foi possível prepará-lo.`);
    }
  }
  if (watermarkFiles.length === 0) {
    showOperationFailure("watermark", watermarkWarnings.slice(0, 8).join("\n") || "Nenhum arquivo pôde ser preparado para aplicar a marca d'água.");
    return;
  }
  payload.options.originalFileNames = watermarkOriginalFileNames;
  payload.options.validationWarnings = watermarkWarnings;
  payload.files = watermarkFiles;
  if (payload.options.watermarkKind === "image" && state.watermarkImageFile) {
    payload.options.imagePath = await resolveQueuedFilePath(state.watermarkImageFile, "png");
  }
  const result = await queueOperation(payload);

  if (!result.success) {
    showOperationFailure("watermark", result.error);
    return;
  }
  showOperationQueuedFeedback("watermark", result);

  watermarkWorkspace.clearWorkspace();
  switchTab("dashboard", { skipGuard: true });
}

function downsampleImage(fileObject, maxDimension = 2200, quality = 0.82) {
  return downsampleImageAsBase64(fileObject, maxDimension, quality, "Não foi possível obter o contexto 2D do Canvas.");
}

function fileToBase64(fileObject) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      const result = String(event.target?.result || "");
      const commaIndex = result.indexOf(",");
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
    };
    reader.onerror = (err) => reject(err);
    reader.readAsDataURL(fileObject);
  });
}

async function resolveQueuedFilePath(fileLike, fallbackExtension = "pdf") {
  if (!fileLike) {
    throw new Error("Arquivo de entrada inválido ou ausente.");
  }

  const candidatePaths = [
    typeof fileLike.path === "string" ? fileLike.path.trim() : "",
    typeof fileLike.fileObject?.path === "string" ? fileLike.fileObject.path.trim() : ""
  ].filter(Boolean);

  for (const candidatePath of candidatePaths) {
    try {
      const exists = await window.api.pathExists(candidatePath);
      if (exists?.exists) {
        return candidatePath;
      }
    } catch {
      // Fallback to temp copy below.
    }
  }

  const fileObject = fileLike.fileObject || fileLike;
  if (typeof fileObject?.arrayBuffer !== "function") {
    if (candidatePaths.length > 0) {
      return candidatePaths[0];
    }
    throw new Error("Arquivo de entrada inválido ou ausente.");
  }

  const fileName = String(fileObject.name || fileLike.name || "");
  const extensionFromName = fileName.includes(".") ? fileName.split(".").pop().toLowerCase() : "";
  const allowedExtensions = new Set(["pdf", "jpg", "jpeg", "png", "txt", "docx", "xlsx"]);
  const extension = allowedExtensions.has(extensionFromName) ? extensionFromName : fallbackExtension;
  const base64Data = await fileToBase64(fileObject);
  return window.api.saveTempFile({ base64Data, extension });
}

async function waitForExistingPath(targetPath, timeoutMs = 3000, intervalMs = 150) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    try {
      const exists = await window.api.pathExists(targetPath);
      if (exists?.exists) {
        return true;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

async function prepareMergeInputFile(item) {
  const isImage = item.kind === "image" || /\.(jpg|jpeg|png)$/i.test(item?.name || "");
  const cleanupPaths = [];

  try {
    if (isImage) {
      let imagePath;
      const imageFile = item.fileObject || null;
      if (imageFile) {
        const base64Data = await downsampleImage(imageFile, 2200, 0.82);
        imagePath = await window.api.saveTempFile({ base64Data, extension: "jpg" });
        if (imagePath) cleanupPaths.push(imagePath);
      } else {
        imagePath = await resolveQueuedFilePath(item, "png");
        if (!item.path && imagePath) cleanupPaths.push(imagePath);
      }
      const tempPdfPath = await window.api.convertImageToTempPdf(imagePath, Number(item.rotation) || 0);
      if (tempPdfPath) cleanupPaths.push(tempPdfPath);
      return { path: tempPdfPath, cleanupPaths, kind: "image" };
    }

    const pdfPath = await resolveQueuedFilePath(item, "pdf");
    if (!item.path && pdfPath) cleanupPaths.push(pdfPath);
    return { path: pdfPath, cleanupPaths, kind: "pdf" };
  } catch (error) {
    if (cleanupPaths.length > 0) {
      await window.api.deleteTempPaths(cleanupPaths).catch(() => {});
    }
    throw error;
  }
}

async function queueProtect() {
  if (!protectWorkspace.validateBeforeQueue()) return;

  const payload = protectWorkspace.getQueuePayload();
  payload.options.zipResults = document.getElementById("protect-zip")?.checked ?? false;
  payload.options.originalFileNames = [state.protectFile.name || ""];
  payload.files = [await resolveQueuedFilePath(state.protectFile, "pdf")];
  const runBtn = document.getElementById("btn-run-protect");
    const originalText = runBtn?.innerHTML || "";

    if (runBtn) {
      runBtn.disabled = true;
      runBtn.innerText = "Protegendo...";
    }

    try {
      const result = await queueOperation(payload);

      if (!result.success) {
        showOperationFailure("protect", result.error);
        return;
      }
      showOperationQueuedFeedback("protect", result);

      protectWorkspace.clearWorkspace();
      switchTab("dashboard", { skipGuard: true });
    } catch (error) {
      console.error("Erro ao proteger PDF:", error);
      showOperationFailure("protect", error.message || error);
    } finally {
      if (runBtn) {
        runBtn.disabled = false;
        runBtn.innerHTML = originalText;
      }
    }
  }

async function queueUnlock() {
  if (!unlockWorkspace.validateBeforeQueue()) return;

  const payload = unlockWorkspace.getQueuePayload();
  let unlockInputPath;
  try {
    unlockInputPath = await resolveQueuedFilePath(state.unlockFile, "pdf");
  } catch (error) {
    showOperationFailure("unlock", error.message || error);
    return { success: false, stage: "resolve", error: error.message || String(error) };
  }

  const unlockPathExists = await waitForExistingPath(unlockInputPath, 4000, 200);
  if (!unlockPathExists) {
    showOperationFailure("unlock", "Não foi possível localizar o PDF selecionado. Escolha o arquivo novamente.");
    return { success: false, stage: "path-exists", error: "Não foi possível localizar o PDF selecionado. Escolha o arquivo novamente." };
  }

  payload.files = [unlockInputPath];
  payload.options.originalFileNames = [state.unlockFile.name || ""];
  const runBtn = document.getElementById("btn-run-unlock");
  const originalText = runBtn?.innerHTML || "";

  if (runBtn) {
    runBtn.disabled = true;
    runBtn.innerText = "Desbloqueando...";
  }

  try {
    const result = await queueOperation(payload);

    if (!result.success) {
      showOperationFailure("unlock", result.error);
      return { success: false, stage: "queue", error: result.error || "Falha ao enviar desbloqueio para a fila." };
    }
    showOperationQueuedFeedback("unlock", result);

    unlockWorkspace.clearWorkspace();
    switchTab("dashboard", { skipGuard: true });
    return { success: true, taskId: result.taskId };
  } catch (error) {
    console.error("Erro ao desbloquear PDF:", error);
    showOperationFailure("unlock", error.message || error);
    return { success: false, stage: "exception", error: error.message || String(error) };
  } finally {
    if (runBtn) {
      runBtn.disabled = false;
      runBtn.innerHTML = originalText;
    }
  }
}

async function queueRedact() {
  if (!redactWorkspace.validateBeforeQueue()) return;

  const runBtn = document.getElementById("btn-run-redact");
  const originalText = runBtn.innerHTML;
  runBtn.disabled = true;
  runBtn.innerText = "Preparando páginas...";

  try {
    if (!state.redactFile?.path) {
      state.redactFile = { ...(state.redactFile || {}), path: await resolveQueuedFilePath(state.redactFile, "pdf") };
    }

    const fileExists = await window.api.pathExists(state.redactFile.path);
    if (!fileExists?.exists) {
      showOperationFailure("redact", "O documento selecionado não existe mais. Carregue o arquivo novamente.");
      redactWorkspace.clearWorkspace();
      return;
    }

    const redactedPages = await redactWorkspace.generateRedactedPagesPayload();
    const outputName = document.getElementById("redact-output-name").value.trim();

    const result = await queueOperation({
      type: "redact",
      files: [state.redactFile.path],
      options: {
        outputName,
        redactedPages,
        zipResults: document.getElementById("redact-zip")?.checked ?? false,
        cleanupPaths: [...new Set(state.redactTempPaths || [])],
        originalFileNames: [state.redactFile.name || ""]
      }
    });

    if (!result.success) {
      showOperationFailure("redact", result.error);
      return;
    }
    showOperationQueuedFeedback("redact", result);

    redactWorkspace.clearWorkspace({ preserveTemp: true });
    switchTab("dashboard", { skipGuard: true });
  } catch (error) {
    console.error("Erro na ocultação:", error);
    showOperationFailure("redact", error.message || error);
  } finally {
    runBtn.disabled = false;
    runBtn.innerHTML = originalText;
  }
}

function exposeAutomatedTestApi() {
  window.__CENTRAL_PDF_TEST_API__ = {
    state,
    dom,
    switchTab,
    notify,
    loadAppConfig,
    queueImagesToPdf,
    queueSignature,
    queuePdfToWord,
    queueMerge,
    queueSplit,
    queueCompress,
    queueOrganize,
    queueWatermark,
    queueProtect,
    queueUnlock,
    queueRedact,
    handleOcrFiles,
    queueOcr,
    ocrAreaExtractor,
    handleSplitFile,
    handleCompressFile,
    renderMergeFileList,
    renderHistory: () => queueAndHistory.renderHistory(),
    openRecentProcessedModal: (anchor) => queueAndHistory.openRecentProcessedModal(anchor),
    closeRecentProcessedModal: () => queueAndHistory.closeRecentProcessedModal(),
    imageToPdfWorkspace,
    signatureWorkspace,
    pdfToWordWorkspace,
    watermarkWorkspace,
    protectWorkspace,
    unlockWorkspace,
    redactWorkspace,
    organizeWorkspace
  };
}

