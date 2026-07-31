
function formatModeLabel(modeLabel = "") {
  const normalized = String(modeLabel).trim().toLowerCase();
  if (normalized === "installed mode") return "Modo instalado";
  if (normalized === "portable mode") return "Modo portátil";
  return modeLabel || "-";
}

function buildSupportLocations(paths = {}, helpers = {}) {
  const logs = helpers.escapeHtml(paths.logs || "Não disponível");
  const config = helpers.escapeHtml(paths.config || "Não disponível");
  const temp = helpers.escapeHtml(paths.temp || "Não disponível");

  return `
    <div class="about-location-grid">
      <div class="about-location-card">
        <div class="about-location-copy">
          <h4>Logs e configurações</h4>
          <span title="${logs}"><strong>Logs:</strong> ${logs}</span>
          <span title="${config}"><strong>Configuração:</strong> ${config}</span>
        </div>
        <div class="about-location-actions">
          <button class="btn-secondary btn-sm btn-icon-label" data-about-copy-support-paths>
            ${helpers.icon("copy", { size: 16 })}
            <span>Copiar caminhos</span>
          </button>
          <button class="btn-secondary btn-sm btn-icon-label" data-about-open-logs>
            ${helpers.icon("folder-open", { size: 16 })}
            <span>Abrir logs</span>
          </button>
          <button class="btn-secondary btn-sm btn-icon-label" data-about-open-configs>
            ${helpers.icon("folder-open", { size: 16 })}
            <span>Abrir config.</span>
          </button>
        </div>
      </div>

      <div class="about-location-card">
        <div class="about-location-copy">
          <h4>Temporários</h4>
          <span title="${temp}"><strong>Temporários:</strong> ${temp}</span>
        </div>
        <div class="about-location-actions">
          <button class="btn-secondary btn-sm btn-icon-label" data-about-copy-runtime-paths>
            ${helpers.icon("copy", { size: 16 })}
            <span>Copiar caminhos</span>
          </button>
          <button class="btn-secondary btn-sm btn-icon-label" data-about-open-temp>
            ${helpers.icon("folder-open", { size: 16 })}
            <span>Abrir temp.</span>
          </button>
        </div>
      </div>
    </div>
  `;
}

function formatMemoryLine(memory = {}) {
  const totalMb = Number.isFinite(memory.totalMb) ? memory.totalMb : 0;
  const freeMb = Number.isFinite(memory.freeMb) ? memory.freeMb : 0;
  return `${totalMb} MB totais / ${freeMb} MB livres`;
}

export function buildAboutSystemMarkup(aboutInfo, helpers) {
  const { app = {}, system = {}, paths = {}, safeguards = {} } = aboutInfo || {};

  return `
    <div class="about-summary-grid">
      <div class="about-summary-item">
        <span class="about-summary-label">Aplicativo</span>
        <strong>${helpers.escapeHtml(app.name || "Central PDF")}</strong>
      </div>
      <div class="about-summary-item">
        <span class="about-summary-label">Versão</span>
        <strong>${helpers.escapeHtml(app.versionLabel || "v-")}</strong>
      </div>
      <div class="about-summary-item">
        <span class="about-summary-label">Build</span>
        <strong>${helpers.escapeHtml(app.buildLabel || "-")}</strong>
      </div>
      <div class="about-summary-item">
        <span class="about-summary-label">Modo de execução</span>
        <strong>${helpers.escapeHtml(formatModeLabel(app.modeLabel))}</strong>
      </div>
    </div>

    <div class="about-detail-grid">
      <div class="about-detail-card">
        <h3>Ambiente</h3>
        <p>${helpers.escapeHtml(app.architectureLabel || "Electron + Node.js")}</p>
        <p>${helpers.escapeHtml(system.platformLabel || app.environmentLabel || "Windows")}</p>
        <p>${helpers.escapeHtml(formatMemoryLine(system.memory))}</p>
      </div>
      <div class="about-detail-card">
        <h3>Escopo e suporte</h3>
        <p>Processamento local e offline para ambiente corporativo.</p>
        <p>Limite configurado atual: ${helpers.formatBytes(safeguards.maxFileSizeBytes || 0)} por arquivo.</p>
        <p>Sem envio automático de documentos para a internet.</p>
      </div>
    </div>

    <div class="about-block">
      <div class="about-block-heading">
        <h3>Suporte e governança</h3>
        <p>Caminhos essenciais para diagnóstico e administração do ambiente.</p>
      </div>
      ${buildSupportLocations(paths, helpers)}
    </div>

    <div class="about-institutional-note">
      ${helpers.icon("shield", { size: 18, filled: true })}
      <div>
        <p>${helpers.escapeHtml(safeguards.offlineMessage || "")}</p>
        <p>Uso interno autorizado. O Central PDF não pode ser redistribuído, comercializado, sublicenciado ou utilizado fora do ambiente autorizado sem aprovação formal.</p>
      </div>
    </div>
  `;
}


