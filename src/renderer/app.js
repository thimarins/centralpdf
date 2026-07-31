import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { createAboutPanelController } from "./settings/about/about-panel.js";
import { addPulseTemporarily } from "./ui/animations/motion.js";
import { createFeedbackCenter } from "./ui/feedback/feedback-center.js";
import { createPdfToWordWorkspaceController } from "./ui/conversion/pdf-to-word-workspace.js";
import { createImageToPdfWorkspaceController } from "./ui/image-to-pdf/image-to-pdf-workspace.js";
import { getPendingTabMessage, hasAnyPendingTabWork } from "./ui/navigation/pending-work.js";
import { createOrganizeWorkspaceController } from "./ui/organize/organize-workspace.js";
import { createQueueAndHistoryRenderer } from "./ui/queue/queue-status.js";
import { createSignatureWorkspaceController } from "./ui/signature/signature-workspace.js";
import { QUEUE_UI_THRESHOLDS, UI_ICON_SIZES } from "./ui/constants.js";
import { fluentIcon, fluentIconByState, fluentToneIcon } from "./ui/icons/fluent-icons.js";
import { buildFeedbackMessage, getOperationLabel } from "./ui/message-system/messages.js";
import { createToastCenter } from "./ui/notifications/toast-center.js";
import { createWatermarkWorkspaceController } from "./ui/watermark/watermark-workspace.js";
import { createProtectWorkspaceController } from "./ui/security/protect-workspace.js";
import { createUnlockWorkspaceController } from "./ui/security/unlock-workspace.js";
import { createRedactWorkspaceController } from "./ui/redact/redact-workspace.js";
import { downsampleImageAsBase64 } from "./ui/pdf-preview-utils.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const state = {
  appMeta: null,
  appConfig: null,
  runtimeColorTheme: "random",
  activeTab: "dashboard",
  dashboardSelectedPdfFile: null,
  dashboardAutoRouteOnPick: false,
  imagePdfFiles: [],
  imagePdfDragIndex: null,
  imagePdfSelectedIndex: null,
  imagePdfOptimizedMode: false,
  imagePdfUndoStack: [],
  signatureFile: null,
  signaturePdfDoc: null,
  signaturePageCount: 0,
  signatureCurrentPageIndex: 0,
  signatureFields: [],
  signatureSelectedFieldId: "",
  signatureSealFile: null,
  signatureSealPreviewUrl: "",
  signatureDrawnDataUrl: "",
  signatureDrawHasInk: false,
  operationOutputDirs: {},
  mergeFiles: [],
  selectedSplitFile: null,
  selectedCompressFile: null,
  pdfToWordFile: null,
  watermarkFiles: [],
  watermarkImageFile: null,
  watermarkPreviewImageDataUrl: "",
  watermarkPreviewImageElement: null,
  redactFile: null,
  redactTempPaths: [],
  organizeFile: null,
  organizePdfDoc: null,
  organizePages: [],
  organizeRenderedPageIds: [],
  organizeLowMemoryMode: false,
  organizeUndoStack: [],
  organizeTempPaths: [],
  organizeSelection: new Set(),
  organizeLastSelectedId: null,
  organizeObserver: null,
  organizeDrag: {
    ids: [],
    sourceId: null,
    placeholderIndex: null
  },
  unlockFile: null,
  queueSnapshot: [],
  feedbackBannerMode: "",
  dashboardSearchQuery: ""
};

const DASHBOARD_QUICK_ACTION_DEFAULT_ORDER = [
  "images-to-pdf",
  "merge",
  "split",
  "signature",
  "pdf-to-word",
  "organize",
  "watermark",
  "compress",
  "protect",
  "unlock",
  "redact"
];

const dom = {
  tabs: [...document.querySelectorAll(".nav-item")],
  tabContents: [...document.querySelectorAll(".tab-content")],
  searchInput: document.getElementById("dashboard-search-input"),
  searchClearButton: document.getElementById("dashboard-search-clear"),
  processedHistoryButton: document.getElementById("btn-dashboard-processed-history"),
  processedHistoryModal: document.getElementById("recent-processed-modal"),
  processedHistoryModalList: document.getElementById("recent-processed-modal-list"),
  processedHistoryModalClose: document.getElementById("recent-processed-modal-close"),
  historyList: document.getElementById("recent-history-list"),
  historyExpandFooter: document.getElementById("history-expand-footer"),
  btnToggleHistory: document.getElementById("btn-toggle-history"),
  feedbackBanner: document.getElementById("app-feedback-banner"),
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
const feedbackCenter = createFeedbackCenter(dom.feedbackBanner);
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
  formatBytes
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
  formatBytes
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
  showValidationMessage
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
const queueAndHistory = createQueueAndHistoryRenderer({
  state,
  dom,
  windowApi: window.api,
  icon,
  fluentIcon,
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
  getOperationLabel,
  updateRecentHistory: updateRecentHistoryFromTask,
  getWorkflowSuggestionActions
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

function reportRuntimeIssue(scope, errorLike, context = "") {
  const message = errorLike?.message || String(errorLike || "Erro inesperado");
  const stack = errorLike?.stack || "";
  const signature = `${scope}:${message}:${context}`;
  const now = Date.now();

  if (signature === lastRuntimeIssueSignature && now - lastRuntimeIssueAt < 2500) {
    return;
  }

  lastRuntimeIssueSignature = signature;
  lastRuntimeIssueAt = now;

  console.error(`[${scope}]`, errorLike);
  window.api?.logRendererError?.({
    scope,
    message,
    stack,
    context
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
    reportRuntimeIssue("window-error", event.error || fallbackError, event.filename || "");
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
  rebuildSidebarLayout();
  renderDashboardShell();
  refreshDashboardDomRefs();
  hydrateStaticIcons();
  setupGlobalRuntimeGuards();
  setupPasswordVisibilityToggles();
  dom.historyList.innerHTML = renderLoadingSkeleton(3);
  await loadAppMeta();
  await loadAppConfig();
  setupOneOffOutputDirectoryRouting();
  setupNavigation();
  setupDashboardEnhancements();
  setupNavigationGuards();
  setupDropzones();
  setupOperations();
  removeDuplicateCompatibilityNotice();
  queueAndHistory.setupQueueStatus();
  window.setTimeout(showFirstRunHints, 350);
  exposeAutomatedTestApi();
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
        <span>Abra a pasta onde os resultados serão salvos. Se quiser, escolha um destino personalizado.</span>
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
    help: { label: "Ajuda", icon: "info" },
    settings: { label: "Configurações", icon: "settings" }
  };

  const groups = [
    { label: "Começar", tabs: ["dashboard"] },
    { label: "Editar PDFs", tabs: ["merge", "split", "organize", "watermark", "compress"] },
    { label: "Segurança", tabs: ["signature", "protect", "unlock", "redact"] },
    { label: "Conversão", tabs: ["images-to-pdf", "pdf-to-word"] },
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
            <div class="dashboard-upload-box" id="dashboard-pdf-dropzone">
              <input type="file" id="dashboard-pdf-input" accept=".pdf,.jpg,.jpeg,.png" class="file-input-hidden">
              <div class="dashboard-upload-copy">
                <span class="dashboard-upload-icon" data-icon="cloud-upload"></span>
                <strong id="dashboard-selected-file-name">Arraste seu arquivo aqui</strong>
                <span id="dashboard-selected-file-meta" style="margin-bottom: 4px;">PDF, JPG, JPEG ou PNG</span>
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
                  <option value="protect">Proteger PDF</option>
                  <option value="redact">Ocultar Dados</option>
                  <option value="pdf-to-word">PDF para Word</option>
                  <option value="compress">Reduzir tamanho</option>
                  <option value="watermark">Marca d'água</option>
                </select>
              </div>
              <button id="btn-dashboard-open-action" class="btn-primary btn-icon-label" data-icon="folder-open">Selecionar arquivo</button>
            </div>
          </div>
        </div>

        <div class="card service-card-panel">
          <div class="section-heading">
            <h2 class="section-title-with-icon"><span class="section-title-icon" data-icon="list"></span><span>Ferramentas principais</span></h2>
            <p>Escolha a opção mais próxima do que você quer fazer.</p>
          </div>
          <div class="quick-grid quick-grid-dashboard">
            <button class="quick-btn quick-btn-image-pdf" data-go-tab="images-to-pdf" data-icon="file-output" data-search-label="converter para pdf arquivos imagens word excel docx xlsx">
              <h3>Converter para PDF</h3>
              <p>Converta imagens, documentos Word e planilhas Excel em PDF.</p>
            </button>
            <button class="quick-btn quick-btn-merge" data-go-tab="merge" data-icon="merge" data-search-label="mesclar pdf">
              <h3>Mesclar</h3>
              <p>Mescle vários PDFs em um só documento.</p>
            </button>
            <button class="quick-btn quick-btn-split" data-go-tab="split" data-icon="scissors" data-search-label="separar dividir paginas">
              <h3>Separar</h3>
              <p>Separe um PDF por página ou intervalo.</p>
            </button>
            <button class="quick-btn quick-btn-signature" data-go-tab="signature" data-icon="pen-line" data-search-label="assinar assinatura">
              <h3>Assinar PDF</h3>
              <p>Adicione assinatura visual de forma simples.</p>
            </button>
            <button class="quick-btn quick-btn-word" data-go-tab="pdf-to-word" data-icon="file-text" data-search-label="converter word docx">
              <h3>PDF para Word</h3>
              <p>Converta conteúdo do PDF para Word.</p>
            </button>
            <button class="quick-btn quick-btn-organize" data-go-tab="organize" data-icon="layout-list" data-search-label="organizar paginas ordem">
              <h3>Organizar</h3>
              <p>Reordene, exclua ou duplique páginas.</p>
            </button>
            <button class="quick-btn quick-btn-watermark" data-go-tab="watermark" data-icon="stamp" data-search-label="marca dagua texto imagem">
              <h3>Marca d'água</h3>
              <p>Aplique texto ou imagem sobre o documento.</p>
            </button>
            <button class="quick-btn quick-btn-compress" data-go-tab="compress" data-icon="zap" data-search-label="reduzir tamanho compactar imagem pdf">
              <h3>Reduzir tamanho</h3>
              <p>Deixe PDFs e imagens mais leves sem perder legibilidade.</p>
            </button>
            <button class="quick-btn quick-btn-protect" data-go-tab="protect" data-icon="lock" data-search-label="proteger senha seguranca">
              <h3>Proteger PDF</h3>
              <p>Defina senha e restrições de acesso.</p>
            </button>
            <button class="quick-btn quick-btn-unlock" data-go-tab="unlock" data-icon="unlock" data-search-label="desbloquear remover senha abrir pdf protegido">
              <h3>Desbloquear PDF</h3>
              <p>Remova a senha de abertura de um PDF protegido.</p>
            </button>
            <button class="quick-btn quick-btn-redact" data-go-tab="redact" data-icon="eye-off" data-search-label="ocultar dados tarja preta">
              <h3>Ocultar Dados</h3>
              <p>Esconda informações sensíveis de vez.</p>
            </button>
          </div>
        </div>
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
  return fluentIcon(name, { size: UI_ICON_SIZES.quickAction, ...options });
}

function toneIcon(tone, size = 20) {
  return fluentToneIcon(tone, size);
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

function notify(options = {}) {
  const safeOptions = { ...options };
  if (safeOptions.title) safeOptions.title = normalizeMojibakeText(safeOptions.title);
  if (safeOptions.message) safeOptions.message = normalizeMojibakeText(safeOptions.message);
  if (safeOptions.detail) safeOptions.detail = normalizeMojibakeText(safeOptions.detail);
  return toastCenter.notify({ title: "Central PDF", duration: 4200, ...safeOptions });
}

function showFeedbackBanner(options = {}) {
  state.feedbackBannerMode = options.mode || "";
  feedbackCenter.show(options);
}

function clearFeedbackBanner(mode = "") {
  if (mode && state.feedbackBannerMode && state.feedbackBannerMode !== mode) return;
  state.feedbackBannerMode = "";
  feedbackCenter.clear();
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

  notify({
    id: `warning-${category}-${firstWarning.slice(0, 24)}`,
    tone: category === "warning" ? "warning" : "info",
    title,
    message: uniqueWarnings.length === 1
      ? buildFeedbackMessage(category, { seed: firstWarning, detail: firstWarning })
      : `${buildFeedbackMessage(category, { seed: firstWarning })} ${uniqueWarnings.length} avisos detectados.`
  });

  showFeedbackBanner({
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
        <svg class="password-visibility-icon--show" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.06 12.35a1 1 0 0 1 0-.7C3.75 7.63 7.52 5 12 5s8.25 2.63 9.94 6.65a1 1 0 0 1 0 .7C20.25 16.37 16.48 19 12 19s-8.25-2.63-9.94-6.65"></path><circle cx="12" cy="12" r="3"></circle></svg>
        <svg class="password-visibility-icon--hide" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-4.48 0-8.25-2.63-9.94-6.65a1 1 0 0 1 0-.7 11.69 11.69 0 0 1 5-5.77"></path><path d="M9.9 4.24A10.72 10.72 0 0 1 12 4c4.48 0 8.25 2.63 9.94 6.65a1 1 0 0 1 0 .7 11.73 11.73 0 0 1-1.67 2.68"></path><path d="M14.12 14.12a3 3 0 0 1-4.24-4.24"></path><path d="M3 3l18 18"></path></svg>
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
    return "Não foi possível abrir este arquivo.";
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
  notify({
    tone: "error",
    title: getOperationLabel(type),
    message: detail,
    important: true,
    duration: 6200
  });
  showFeedbackBanner({
    mode: "error",
    tone: "error",
    title: getOperationLabel(type),
    message: detail,
    detail: "",
    icon: toneIcon("error", 18),
    duration: 6500
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
    showWarnings(result.warnings, `${getOperationLabel(type)} com proteções`);
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

  iconSlot.innerHTML = fluentIconByState(name, { size: UI_ICON_SIZES.nav, active: isActive });
  labelSlot.textContent = text;
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
      element.innerHTML = `${fluentIconByState(name, { size: 18, active: isActive })}<span style="margin-left: 8px;">${text}</span>`;
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
      const text = escapeHtml(element.textContent.trim());
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
    applyColorTheme(state.appConfig.colorTheme || "random");

    const outDirInput = document.getElementById("setting-output-dir");
    const clearOutDirBtn = document.getElementById("btn-clear-output-dir");
    outDirInput.value = state.appConfig.defaultOutputDir || "";
    outDirInput.title = state.appConfig.defaultOutputDir || "Salvar na pasta de origem";
    clearOutDirBtn.classList.toggle("hidden", !state.appConfig.defaultOutputDir);

    document.getElementById("setting-theme").value = state.appConfig.theme;
    document.getElementById("setting-color-theme").value = state.appConfig.colorTheme || "random";

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
    "redact-output-name"
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
      "redact-output-name": "redact"
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
      changeFolderButton.title = "Escolher uma pasta de destino somente para esta operação";
      changeFolderButton.setAttribute("aria-label", "Escolher pasta de destino para esta operação");
      changeFolderButton.innerHTML = `${icon("folder-open")}<span>Alterar pasta</span>`;
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
      actionBar.classList.add("action-bar-settings--output-layout");
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
      const versionText = `Central PDF • ${state.appMeta?.releaseVersion || "1.0.3"}`;
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

function applyTheme(theme) {
  document.body.classList.remove("theme-light", "theme-dark", "theme-system");
  if (theme === "dark") {
    document.body.classList.add("theme-dark");
  } else if (theme === "light") {
    document.body.classList.add("theme-light");
  } else {
    document.body.classList.add("theme-system");
  }
}

function applyColorTheme(color) {
  document.body.classList.remove("theme-color-blue", "theme-color-red", "theme-color-olive", "theme-color-violet");
  const palette = ["blue", "red", "olive", "violet"];
  if (color === "random") {
    const picked = palette[Math.floor(Math.random() * palette.length)] || "blue";
    state.runtimeColorTheme = picked;
    color = picked;
  } else {
    state.runtimeColorTheme = color || "blue";
  }
  if (color && color !== "blue") {
    document.body.classList.add(`theme-color-${color}`);
  }
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
    button.innerHTML = fluentIcon("desktop", { size: 20 });
    button.title = "Tema: Sistema (clique para mudar para tema Claro)";
  } else if (currentTheme === "light") {
    button.innerHTML = fluentIcon("weather-sunny", { size: 20 });
    button.title = "Tema: Claro (clique para mudar para tema Escuro)";
  } else {
    button.innerHTML = fluentIcon("weather-moon", { size: 20 });
    button.title = "Tema: Escuro (clique para mudar para tema do Sistema)";
  }
}

function updateDashboardDefaultDirButton() {
  const button = document.getElementById("btn-dashboard-open-default-dir");
  if (!button) return;

  const defaultDir = state.appConfig?.defaultOutputDir || "";
  button.disabled = !defaultDir;
  button.title = defaultDir
    ? `Abrir a pasta personalizada de destino\n${defaultDir}`
    : "Sem pasta personalizada: os arquivos serão salvos na pasta de origem";
  button.setAttribute("aria-label", defaultDir
    ? `Abrir pasta personalizada: ${defaultDir}`
    : "Arquivos salvos na pasta de origem; nenhuma pasta personalizada cadastrada");
  button.innerHTML = fluentIcon("folder-open", { size: 20 });
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


let dashboardSearchHighlight = null;

function normalizeSearchText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function getSearchableText(element) {
  if (!element) return "";
  const pieces = [
    element.getAttribute?.("aria-label"),
    element.getAttribute?.("title"),
    element.getAttribute?.("placeholder"),
    element.textContent,
    element.value
  ].filter(Boolean);

  return normalizeSearchText(pieces.join(" "));
}

function clearDashboardSearchHighlight() {
  if (dashboardSearchHighlight) {
    dashboardSearchHighlight.classList.remove("search-match-highlight");
    dashboardSearchHighlight = null;
  }
}

function markDashboardSearchHighlight(element) {
  clearDashboardSearchHighlight();
  if (!element) return;
  element.classList.add("search-match-highlight");
  dashboardSearchHighlight = element;
  element.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
}

function updateDashboardSearchClearButton(query) {
  if (!dom.searchClearButton) return;
  dom.searchClearButton.classList.toggle("hidden", !String(query || "").trim());
}

function getDashboardSearchScope() {
  return document.getElementById(`tab-${state.activeTab}`) || document.body;
}

function findFirstScopedSearchMatch(scope, query) {
  if (!scope || !query) return null;
  const normalizedQuery = normalizeSearchText(query);
  const selectors = [
    "h1", "h2", "h3", "h4", "h5",
    "p", "li", "label", "button", "summary",
    ".card", ".page-card", ".empty-state", ".input-help",
    ".section-title-with-icon", ".title-with-icon",
    ".section-heading", ".section-title", ".help-card",
    ".help-pane", ".help-nav-btn", ".setting-row",
    ".settings-inline", ".toggle",
    ".tab-header"
  ].join(", ");

  const candidates = [...scope.querySelectorAll(selectors)]
    .filter((element) => element.offsetParent !== null && !element.closest(".hidden"));

  return candidates.find((element) => {
    const text = getSearchableText(element);
    return text && text.includes(normalizedQuery);
  }) || null;
}

function applyDashboardSearch(query) {
  const normalizedQuery = normalizeSearchText(query);
  state.dashboardSearchQuery = String(query || "");
  updateDashboardSearchClearButton(query);

  document.querySelectorAll(".sidebar-nav .nav-item, .help-nav-btn, .quick-btn, [data-search-label]").forEach((button) => {
    const label = button.getAttribute("data-search-label")
      || button.getAttribute("data-nav-label")
      || button.textContent
      || "";
    const matches = !normalizedQuery || normalizeSearchText(label).includes(normalizedQuery);
    button.classList.toggle("search-hidden", !matches);
  });

  document.querySelectorAll(".sidebar-nav .nav-group").forEach((group) => {
    const visibleItems = [...group.querySelectorAll(".nav-item")].some((button) => !button.classList.contains("search-hidden"));
    group.classList.toggle("search-hidden", !visibleItems);
  });

  document.querySelectorAll("#tab-dashboard .quick-btn").forEach((button) => {
    const label = `${button.textContent} ${button.getAttribute("data-search-label") || ""}`;
    const matches = !normalizedQuery || normalizeSearchText(label).includes(normalizedQuery);
    button.classList.toggle("search-hidden", !matches);
  });

  clearDashboardSearchHighlight();
  if (!normalizedQuery) return;

  const searchScope = getDashboardSearchScope();
  let target = null;

  if (state.activeTab === "help") {
    const helpButtons = [...searchScope.querySelectorAll(".help-nav-btn")];
    target = helpButtons.find((button) => {
      const text = getSearchableText(button);
      return text.includes(normalizedQuery);
    }) || null;

    if (target && target.classList.contains("help-nav-btn")) {
      target.click();
      target = null;
      requestAnimationFrame(() => {
        const refreshedScope = getDashboardSearchScope();
        const refreshedTarget = findFirstScopedSearchMatch(refreshedScope, normalizedQuery);
        markDashboardSearchHighlight(refreshedTarget);
      });
      return;
    }
  }

  target = findFirstScopedSearchMatch(searchScope, normalizedQuery);
  markDashboardSearchHighlight(target);
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
  if (["organize", "merge", "compress", "watermark", "redact"].includes(action)) {
    return ".pdf,.jpg,.jpeg,.png";
  }
  return ".pdf";
}

function matchesDashboardAction(file, action) {
  const name = String(file?.name || "").toLowerCase();
  if (!name) return false;
  if (["organize", "merge", "compress", "watermark", "redact"].includes(action)) {
    return /\.(pdf|jpg|jpeg|png)$/i.test(name);
  }
  return /\.pdf$/i.test(name);
}

async function routeDashboardSelectedFile(file, action) {
  if (!file) return;

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
  }

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
  const searchClearButton = document.getElementById("dashboard-search-clear");
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
      const defaultDir = state.appConfig?.defaultOutputDir || "";
      if (!defaultDir) {
        notify({
          tone: "warning",
          title: "Pasta personalizada",
          message: "Nenhuma pasta personalizada está cadastrada. Os arquivos são salvos na pasta de origem."
        });
        return;
      }

      const result = await window.api.openPath(defaultDir);
      if (!result?.success) {
        notify({
          tone: "error",
          title: "Abrir pasta personalizada",
          message: result?.error || "Não foi possível abrir a pasta personalizada de destino."
        });
      }
    });
  }

  if (searchInput) {
    applyDashboardSearch(searchInput.value);
    searchInput.addEventListener("input", (event) => {
      applyDashboardSearch(event.target.value);
    });
    searchInput.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && searchInput.value) {
        event.preventDefault();
        searchInput.value = "";
        applyDashboardSearch("");
        searchInput.focus();
      }
    });
  }

  if (searchClearButton) {
    searchClearButton.addEventListener("click", () => {
      if (!searchInput) return;
      searchInput.value = "";
      applyDashboardSearch("");
      searchInput.focus();
    });
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

  if (fileInput) {
    fileInput.addEventListener("change", async (event) => {
      const action = actionSelect?.value || "organize";
      const [file] = [...event.target.files].filter((item) => matchesDashboardAction(item, action));
      setDashboardSelectedPdfFile(file || null);
      if (file && state.dashboardAutoRouteOnPick) {
        state.dashboardAutoRouteOnPick = false;
        await routeDashboardSelectedFile(file, action);
      } else {
        state.dashboardAutoRouteOnPick = false;
      }
      fileInput.value = "";
    });
  }

  if (dropzone && fileInput) {
    dropzone.addEventListener("click", (event) => {
      if (event.target !== fileInput) fileInput.click();
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
      const [file] = [...event.dataTransfer.files].filter((item) => matchesDashboardAction(item, action));
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
}

function setupNavigation() {
  dom.tabs.forEach((tab) => {
    tab.addEventListener("click", () => switchTab(tab.getAttribute("data-tab")));
  });

  document.querySelectorAll("[data-go-tab]").forEach((button) => {
    button.addEventListener("click", () => switchTab(button.getAttribute("data-go-tab")));
  });

  // Wire Help Tab Sub-navigation
  document.querySelectorAll(".help-nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const targetPaneId = `help-pane-${btn.getAttribute("data-help-target")}`;
      
      document.querySelectorAll(".help-nav-btn").forEach((b) => {
        b.classList.remove("active");
        const bName = b.getAttribute("data-icon");
        const bText = b.querySelector("span")?.textContent || b.textContent.trim();
        b.innerHTML = `${fluentIconByState(bName, { size: 18, active: false })}<span style="margin-left: 8px;">${escapeHtml(bText)}</span>`;
      });
      document.querySelectorAll(".help-pane").forEach((p) => p.classList.remove("active"));
      
      btn.classList.add("active");
      const name = btn.getAttribute("data-icon");
      const text = btn.querySelector("span")?.textContent || btn.textContent.trim();
      btn.innerHTML = `${fluentIconByState(name, { size: 18, active: true })}<span style="margin-left: 8px;">${escapeHtml(text)}</span>`;
      
      const targetPane = document.getElementById(targetPaneId);
      if (targetPane) {
        targetPane.classList.add("active");
      }
    });
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

function switchTab(tabId, options = {}) {
  if (!tabId || tabId === state.activeTab) return;
  const { skipGuard = false } = options;
  const previousTab = state.activeTab;

  const pendingMessage = skipGuard ? "" : getPendingTabMessage(previousTab, state, {
    getWatermarkPendingMessage: () => watermarkWorkspace.getPendingMessage(),
    getImagePendingMessage: () => imageToPdfWorkspace.getPendingMessage(),
    getSignaturePendingMessage: () => signatureWorkspace.getPendingMessage(),
    getPdfToWordPendingMessage: () => pdfToWordWorkspace.getPendingMessage(),
    getProtectPendingMessage: () => protectWorkspace.getPendingMessage(),
    getUnlockPendingMessage: () => unlockWorkspace.getPendingMessage(),
    getRedactPendingMessage: () => redactWorkspace.getPendingMessage()
  });

  if (pendingMessage) {
    showCustomConfirmModal(
      "Aviso",
      `${pendingMessage}\n\nDeseja realmente sair desta tela?`,
      () => {
        switchTab(tabId, { skipGuard: true });
      }
    );
    return;
  }

  clearPreviousTabState(previousTab);
  ensureModuleSetup(tabId);

  state.activeTab = tabId;
  dom.tabs.forEach((tab) => tab.classList.toggle("active", tab.getAttribute("data-tab") === tabId));
  dom.tabs.forEach(renderNavItemIcon);
  dom.tabContents.forEach((content) => content.classList.toggle("active", content.id === `tab-${tabId}`));

  if (tabId === "dashboard") {
    queueAndHistory.renderHistory();
    sortDashboardQuickCards();
  }
  updateDashboardGreeting();
  repairVisibleMojibake(document.getElementById(`tab-${tabId}`) || document.body);

  if (dom.searchInput) {
    applyDashboardSearch(dom.searchInput.value);
  }
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
  [
    { id: "images-pdf-dropzone", inputId: "images-pdf-input", handler: imageToPdfWorkspace.addImageFiles, filter: (file) => /\.(jpg|jpeg|png|docx|xlsx)$/i.test(file.name) },
    { id: "signature-dropzone", inputId: "signature-file-input", handler: (files) => signatureWorkspace.handleSignatureFile(files[0]), filter: (file) => file.name.toLowerCase().endsWith(".pdf") },
    { id: "pdf-to-word-dropzone", inputId: "pdf-to-word-file-input", handler: (files) => pdfToWordWorkspace.handleFile(files[0]), filter: (file) => file.name.toLowerCase().endsWith(".pdf") },
    { id: "merge-dropzone", inputId: "merge-file-input", handler: handleMergeFiles, filter: (file) => file.name.toLowerCase().endsWith(".pdf") || /\.(jpg|jpeg|png)$/i.test(file.name) },
    { id: "split-dropzone", inputId: "split-file-input", handler: (files) => handleSplitFile(files[0]), filter: (file) => file.name.toLowerCase().endsWith(".pdf") },
    { id: "organize-dropzone", inputId: "organize-file-input", handler: async (files) => {
      if (!files || files.length === 0) return;
      const shouldAppend = state.organizePages.length > 0 || state.organizeFile || state.organizeFiles?.length > 0;
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
    { id: "compress-dropzone", inputId: "compress-file-input", handler: (files) => handleCompressFile(files[0]), filter: (file) => file.name.toLowerCase().endsWith(".pdf") },
    { id: "protect-dropzone", inputId: "protect-file-input", handler: (files) => protectWorkspace.handleProtectFile(files[0]), filter: (file) => file.name.toLowerCase().endsWith(".pdf") },
    { id: "unlock-dropzone", inputId: "unlock-file-input", handler: (files) => unlockWorkspace.handleUnlockFile(files[0]), filter: (file) => file.name.toLowerCase().endsWith(".pdf") },
    { id: "redact-dropzone", inputId: "redact-file-input", handler: (files) => redactWorkspace.handleRedactFile(files[0]), filter: (file) => file.name.toLowerCase().endsWith(".pdf") || /\.(jpg|jpeg|png)$/i.test(file.name) }
  ].forEach(setupDropzone);
}

function setupDropzone({ id, inputId, handler, filter }) {
  const dropzone = document.getElementById(id);
  const input = document.getElementById(inputId);
  if (!dropzone || !input) return;

  dropzone.addEventListener("click", (event) => {
    if (event.target !== input) input.click();
  });

  input.addEventListener("change", (event) => {
    const files = [...event.target.files].filter(filter);
    if (files.length > 0) {
      Promise.resolve(handler(files)).catch((error) => {
        console.error(`Dropzone handler failed for ${id}:`, error);
      });
    }
    input.value = "";
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
    const files = [...event.dataTransfer.files].filter(filter);
    if (files.length > 0) handler(files);
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

  const activeClass = options.isActive ? "active" : "";
  return `
    <li class="action-file-item ${activeClass}" data-index="${index}" tabindex="0" role="listitem" aria-label="Arquivo ${index + 1}: ${escapeHtml(file.name)}. Use Delete para remover." style="display: flex; flex-direction: column; align-items: stretch; gap: 4px;">
      <div class="action-file-row" style="display: flex; align-items: center; justify-content: space-between; width: 100%;">
        <div class="action-file-info">
          ${icon("file")}
          <div class="selected-file-meta">
            <div style="display: flex; align-items: center; flex-wrap: wrap; gap: 4px;">
              <span class="action-file-name" title="${escapeHtml(file.path || file.name)}">${escapeHtml(file.name)}</span>
              ${typeBadge}
            </div>
            <span class="action-file-size">${escapeHtml(formatBytes(file.size))}</span>
          </div>
        </div>
        <div class="action-file-controls">
          ${moveControls}
          <button class="btn-danger-text btn-sm" data-remove="${index}" title="Remover este arquivo da lista">${icon("remove")}</button>
        </div>
      </div>
      ${rangeInputHtml}
    </li>
  `;
}

function handleMergeFiles(files) {
  files.forEach((file) => {
    const fileKey = file?.path || `${file?.name || "file"}:${file?.size || 0}`;
    if (!fileKey) return;
    if (state.mergeFiles.some((existing) => (existing.path || `${existing.name || "file"}:${existing.size || 0}`) === fileKey)) return;
    const kind = /\.(jpg|jpeg|png)$/i.test(file.name) ? "image" : "pdf";
    state.mergeFiles.push({
      name: file.name,
      size: file.size,
      path: file.path || "",
      fileObject: file,
      kind
    });
  });
  renderMergeFileList();
}

function getMergeFileKindLabel(kind) {
  if (kind === "image") return "Imagem";
  return "PDF";
}

function buildMergeSmartSummary() {
  const summary = document.getElementById("merge-smart-summary");
  if (!summary) return;

  const pdfCount = state.mergeFiles.filter((file) => file.kind !== "image").length;
  const imageCount = state.mergeFiles.filter((file) => file.kind === "image").length;
  const totalCount = state.mergeFiles.length;

  if (totalCount === 0) {
    summary.style.display = "none";
    summary.textContent = "";
    return;
  }

  summary.style.display = "block";
  if (imageCount > 0 && pdfCount > 0) {
    summary.textContent = `${pdfCount} PDF${pdfCount > 1 ? "s" : ""} + ${imageCount} imagem${imageCount > 1 ? "s" : ""} serão mesclados em um único PDF. Imagens serão convertidas localmente antes da mesclagem.`;
  } else if (imageCount > 0) {
    summary.textContent = `${imageCount} imagem${imageCount > 1 ? "s" : ""} serão convertidas localmente e juntadas em um único PDF.`;
  } else {
    summary.textContent = `${pdfCount} PDF${pdfCount > 1 ? "s" : ""} pronto${pdfCount > 1 ? "s" : ""} para mesclagem.`;
  }
}

function renderMergeFileList() {
  const container = document.getElementById("merge-file-list-container");
  const list = document.getElementById("merge-file-list");
  const dropzone = document.getElementById("merge-dropzone");

  if (state.mergeFiles.length === 0) {
    container.classList.add("hidden");
    dropzone.classList.remove("hidden");
    return;
  }

  dropzone.classList.add("hidden");
  container.classList.remove("hidden");
  buildMergeSmartSummary();
  list.innerHTML = state.mergeFiles
    .map((file, index) => buildFileListItem(file, index, { 
      allowReorder: true, 
      total: state.mergeFiles.length,
      showRangeInput: file.kind !== "image",
      badgeLabel: getMergeFileKindLabel(file.kind)
    }))
    .join("");

  list.querySelectorAll("[data-move-up]").forEach((button) => {
    button.addEventListener("click", () => swapMergeFiles(Number(button.getAttribute("data-move-up")), -1));
  });
  list.querySelectorAll("[data-move-down]").forEach((button) => {
    button.addEventListener("click", () => swapMergeFiles(Number(button.getAttribute("data-move-down")), 1));
  });
  list.querySelectorAll("[data-remove]").forEach((button) => {
    button.addEventListener("click", () => {
      state.mergeFiles.splice(Number(button.getAttribute("data-remove")), 1);
      renderMergeFileList();
    });
  });
  list.querySelectorAll(".action-file-item").forEach((item) => {
    item.addEventListener("keydown", (event) => {
      if (event.target.closest("button, input, select, textarea")) return;
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        const removeButton = item.querySelector("[data-remove]");
        removeButton?.click();
      }
    });
  });
  list.querySelectorAll(".merge-range-input").forEach((input) => {
    input.addEventListener("input", (event) => {
      const idx = Number(event.target.getAttribute("data-index"));
      if (state.mergeFiles[idx]) {
        state.mergeFiles[idx].range = event.target.value;
      }
    });
  });

  buildMergeSmartSummary();
}

function swapMergeFiles(index, direction) {
  const targetIndex = index + direction;
  if (targetIndex < 0 || targetIndex >= state.mergeFiles.length) return;
  [state.mergeFiles[index], state.mergeFiles[targetIndex]] = [state.mergeFiles[targetIndex], state.mergeFiles[index]];
  renderMergeFileList();
}

function handleSplitFile(file) {
  state.selectedSplitFile = file;
  document.getElementById("split-dropzone").classList.add("hidden");
  document.getElementById("split-settings-container").classList.remove("hidden");
  document.getElementById("split-file-name").textContent = file.name;
  document.getElementById("split-file-meta").textContent = formatBytes(file.size);
  const cleanName = file.name.replace(/\.pdf$/i, "");
  document.getElementById("split-output-prefix").value = `${cleanName}_separado`;
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

  const btnImagesAddMore = document.getElementById("btn-images-pdf-add-more");
  if (btnImagesAddMore) {
    btnImagesAddMore.addEventListener("click", () => document.getElementById("images-pdf-input").click());
  }
  const btnMergeAddMore = document.getElementById("btn-merge-add-more");
  if (btnMergeAddMore) {
    btnMergeAddMore.addEventListener("click", () => document.getElementById("merge-file-input").click());
  }
  const btnWatermarkAddMore = document.getElementById("btn-watermark-add-more");
  if (btnWatermarkAddMore) {
    btnWatermarkAddMore.addEventListener("click", () => document.getElementById("watermark-file-input").click());
  }

  bindClick("btn-split-change-file", () => {
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
      const files = [...(event.target.files || [])];
      await organizeWorkspace.addOrganizeFiles(files);
      organizeAddFileInput.value = "";
    });
  }
  const btnOrganizeAddImage = document.getElementById("btn-organize-add-image");
  const organizeAddImageInput = document.getElementById("organize-add-image-input");
  if (btnOrganizeAddImage && organizeAddImageInput) {
    btnOrganizeAddImage.addEventListener("click", () => organizeAddImageInput.click());
    organizeAddImageInput.addEventListener("change", async (event) => {
      const files = [...(event.target.files || [])];
      await organizeWorkspace.addOrganizeFiles(files);
      organizeAddImageInput.value = "";
    });
  }
  bindClick("btn-organize-move-first", () => organizeWorkspace.moveSelectedPages("first"));
  bindClick("btn-organize-move-up", () => organizeWorkspace.moveSelectedPages("up"));
  bindClick("btn-organize-move-down", () => organizeWorkspace.moveSelectedPages("down"));
  bindClick("btn-organize-move-last", () => organizeWorkspace.moveSelectedPages("last"));
  bindClick("btn-organize-rotate-selected", organizeWorkspace.rotateSelectedPages);
  bindClick("btn-organize-duplicate-selected", organizeWorkspace.duplicateSelectedPages);
  bindClick("btn-organize-delete-selected", organizeWorkspace.deleteSelectedPages);
  bindClick("btn-organize-reverse", organizeWorkspace.reverseOrganizeOrder);

  document.querySelectorAll('input[name="split-mode"]').forEach((radio) => {
    radio.addEventListener("change", (event) => {
      const mode = event.target.value;
      document.getElementById("split-range-input-group").classList.toggle("hidden", mode !== "range");
      document.getElementById("split-size-input-group").classList.toggle("hidden", mode !== "size");
    });
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
  if (state.mergeFiles.length < 2) {
    showValidationMessage("Selecione pelo menos 2 arquivos para mesclar.");
    return;
  }

  const outputName = document.getElementById("merge-output-name").value.trim();
  if (!outputName) {
    showValidationMessage("Informe um nome para o arquivo final.");
    return;
  }

  const filePaths = [];
  const cleanupPaths = [];
  const mixedKinds = new Set();

  try {
    for (const item of state.mergeFiles) {
      const prepared = await prepareMergeInputFile(item);
      if (!prepared?.path) continue;
      filePaths.push(prepared.path);
      cleanupPaths.push(...(prepared.cleanupPaths || []));
      mixedKinds.add(prepared.kind);
    }
  } catch (error) {
    console.error("Erro ao preparar arquivos para mesclagem:", error);
    showOperationFailure("merge", `N\u00e3o foi poss\u00edvel preparar os arquivos: ${error.message || error}`);
    return;
  }

  if (filePaths.length < 2) {
    showValidationMessage("N\u00e3o foi poss\u00edvel preparar arquivos suficientes para mesclar.");
    return;
  }

  const result = await queueOperation({
    type: "merge",
    files: filePaths,
    options: {
      outputName,
      zipResults: document.getElementById("merge-zip")?.checked ?? false,
      cleanupPaths
    }
  });

  if (!result.success) {
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

  const outputName = document.getElementById("images-pdf-output-name").value.trim();
  if (!outputName) {
    showValidationMessage("Informe o nome do PDF final.");
    return;
  }

  const optimize = document.getElementById("images-pdf-optimize")?.checked ?? false;
  const hasOfficeDocument = state.imagePdfFiles.some((item) => /\.(docx|xlsx)$/i.test(item.name || ""));
  if (optimize && hasOfficeDocument) {
    showValidationMessage("O modo otimizado está disponível apenas para imagens. Desmarque-o para converter documentos.");
    return;
  }
  let filePaths = [];

  const runBtn = document.getElementById("btn-run-images-pdf");
  const originalText = runBtn.innerHTML;

  runBtn.disabled = true;
  runBtn.innerText = optimize ? "Preparando..." : "Enviando...";

  try {
    for (const item of state.imagePdfFiles) {
      if (/\.(docx|xlsx)$/i.test(item.name || "")) {
        const sourcePath = await resolveQueuedFilePath(item, item.name.toLowerCase().endsWith('.xlsx') ? 'xlsx' : 'docx');
        filePaths.push(await window.api.convertDocumentToTempPdf(sourcePath));
        continue;
      }

      if (optimize) {
        const fileObj = item.fileObject;
        if (!fileObj) {
          throw new Error("Arquivo não disponível para otimização.");
        }
        const base64Data = await downsampleImage(fileObj, 1500, 0.75);
        const tempPath = await window.api.saveTempFile({ base64Data, extension: "jpg" });
        filePaths.push(tempPath);
        continue;
      }

      if (item.path) {
        filePaths.push(item.path);
        continue;
      }
      if (!item.fileObject) {
        throw new Error("Arquivo de imagem sem caminho local e sem conteúdo disponível.");
      }
      const base64Data = await fileToBase64(item.fileObject);
      const ext = (item.fileObject.name || item.name || "jpg").split(".").pop().toLowerCase();
      const tempPath = await window.api.saveTempFile({
        base64Data,
        extension: ["jpg", "jpeg", "png"].includes(ext) ? ext : "jpg"
      });
      filePaths.push(tempPath);
    }
  } catch (error) {
    console.error("Erro na preparação dos arquivos para PDF:", error);
    showOperationFailure("files-to-pdf", `Não foi possível preparar os arquivos: ${error.message || error}`);
    return;
  } finally {
    runBtn.disabled = false;
    runBtn.innerHTML = originalText;
  }

  const result = await queueOperation({
    type: "files-to-pdf",
    files: filePaths,
    options: {
      outputName,
        zipResults: document.getElementById("images-pdf-zip")?.checked ?? false
    }
  });

  if (!result.success) {
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
  }

  options.zipResults = document.getElementById("split-zip")?.checked ?? false;
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

  state.selectedSplitFile = null;
  document.getElementById("split-settings-container").classList.add("hidden");
  document.getElementById("split-dropzone").classList.remove("hidden");
  switchTab("dashboard", { skipGuard: true });
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
          zipResults: document.getElementById("compress-zip")?.checked ?? false
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
        zipResults: document.getElementById("compress-zip")?.checked ?? false
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
  if (!state.organizeFile && (!state.organizeFiles || state.organizeFiles.length === 0)) return;
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
    const organizeInputs = state.organizeFiles && state.organizeFiles.length > 0 ? state.organizeFiles : [state.organizeFile];
    for (const file of organizeInputs) {
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
        cleanupPaths
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

  const payload = watermarkWorkspace.getQueuePayload();
  payload.options.zipResults = document.getElementById("watermark-zip")?.checked ?? false;
  payload.options.numberPages = document.getElementById("watermark-number-pages")?.checked ?? false;
  payload.files = await Promise.all((state.watermarkFiles || []).map((file) => resolveQueuedFilePath(file, "pdf")));
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
    } catch (_) {
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
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

async function prepareMergeInputFile(item) {
  const isImage = item.kind === "image" || /\.(jpg|jpeg|png)$/i.test(item?.name || "");
  const cleanupPaths = [];

  if (isImage) {
    let imagePath = "";
    const imageFile = item.fileObject || null;
    if (imageFile) {
      const base64Data = await downsampleImage(imageFile, 2200, 0.82);
      imagePath = await window.api.saveTempFile({ base64Data, extension: "jpg" });
      if (imagePath) cleanupPaths.push(imagePath);
    } else {
      imagePath = await resolveQueuedFilePath(item, "png");
      if (!item.path && imagePath) cleanupPaths.push(imagePath);
    }
    const tempPdfPath = await window.api.convertImageToTempPdf(imagePath);
    if (tempPdfPath) cleanupPaths.push(tempPdfPath);
    return { path: tempPdfPath, cleanupPaths, kind: "image" };
  }

  const pdfPath = await resolveQueuedFilePath(item, "pdf");
  if (!item.path && pdfPath) cleanupPaths.push(pdfPath);
  return { path: pdfPath, cleanupPaths, kind: "pdf" };
}

async function queueProtect() {
  if (!protectWorkspace.validateBeforeQueue()) return;

  const payload = protectWorkspace.getQueuePayload();
  payload.options.zipResults = document.getElementById("protect-zip")?.checked ?? false;
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
        cleanupPaths: [...new Set(state.redactTempPaths || [])]
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

