const fs = require('fs');
const path = require('path');
const { ROOT, toMarkdownTable, writeReport } = require('./_common');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function uniqueMatches(source, regex, group = 1) {
  const values = new Set();
  let match;
  while ((match = regex.exec(source))) values.add(match[group]);
  return [...values].sort();
}

function listJavaScriptFiles(rootDir) {
  const files = [];
  const pending = [rootDir];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(fullPath);
      else if (entry.name.endsWith('.js')) files.push(fullPath);
    }
  }
  return files;
}

function runCrossModuleAudit() {
  const html = read('src/renderer/index.html');
  const app = read('src/renderer/app.js');
  const preload = read('src/preload/index.js');
  const main = read('src/main/index.js');
  const queueUi = read('src/renderer/ui/queue/queue-status.js');
  const organize = read('src/renderer/ui/organize/organize-workspace.js');
  const historyCss = read('src/renderer/styles/components-history.css');
  const responsiveCss = read('src/renderer/styles/responsive.css');
  const css = [
    read('src/renderer/styles/base.css'),
    read('src/renderer/styles/shell.css'),
    read('src/renderer/styles/responsive.css'),
    read('src/renderer/styles/components-history.css')
  ].join('\n');
  const messageSystem = read('src/renderer/ui/message-system/messages.js');
  const appState = read('src/renderer/state/app-state.js');
  const imageProcessing = read('src/main/image-processing.js');
  const ocrGuide = read('docs/OCR.md');
  const rendererStateUsage = listJavaScriptFiles(path.join(ROOT, 'src', 'renderer'))
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n');
  const checks = [];
  const check = (name, ok, details) => checks.push({ name, ok: Boolean(ok), details });

  const requiredTabs = ['dashboard', 'merge', 'split', 'organize', 'watermark', 'compress', 'signature', 'protect', 'unlock', 'redact', 'images-to-pdf', 'pdf-to-word'];
  const missingTabs = requiredTabs.filter((id) => !html.includes(`id="tab-${id}"`));
  check('Módulos registrados', missingTabs.length === 0, missingTabs.length ? `ausentes: ${missingTabs.join(', ')}` : `${requiredTabs.length} módulos disponíveis`);

  const stateFactoryStart = appState.indexOf('return {');
  const stateFactoryEnd = appState.indexOf('\n  };', stateFactoryStart);
  const stateContract = appState.slice(stateFactoryStart, stateFactoryEnd);
  const declaredStateKeys = uniqueMatches(stateContract, /^ {4}([A-Za-z][A-Za-z0-9_]*):/gm);
  const usedStateKeys = uniqueMatches(rendererStateUsage, /(?<![-/])\bstate\.([A-Za-z][A-Za-z0-9_]*)\b/g);
  const undeclaredStateKeys = usedStateKeys.filter((key) => !declaredStateKeys.includes(key));
  check('Contrato de estado explícito', undeclaredStateKeys.length === 0, undeclaredStateKeys.length ? `propriedades fora do contrato: ${undeclaredStateKeys.join(', ')}` : `${declaredStateKeys.length} chaves de estado declaradas antes do uso`);

  const noOrganizeAliases = !/\bstate\.(?:organizeFile|organizePdfDoc)\b/.test(rendererStateUsage)
    && appState.includes('organizeFiles: []')
    && appState.includes('organizePdfDocs: []')
    && !/\borganizeInputs\b/.test(app)
    && app.includes('originalFileNames: state.organizeFiles.map');
  check('Organizar sem aliases duplicados', noOrganizeAliases, 'fontes múltiplas usam arrays como única fonte de verdade');

  const imageRulesShared = imageProcessing.includes('AUTO_IMAGE_MAX_DIMENSION')
    && imageProcessing.includes('normalizeQuarterTurn')
    && read('src/main/pdf-service.js').includes("require('./image-processing')")
    && read('src/main/services/image-conversion/image-to-pdf.js').includes("require('../../image-processing')")
    && read('src/main/services/signature/signature-renderer.js').includes("require('../../image-processing')");
  check('Regras de imagem compartilhadas', imageRulesShared, 'rotação, dimensão e qualidade ficam centralizadas no processo principal');

  const outputDocks = (html.match(/module-output-dock/g) || []).length;
  check('Barra de saída global', outputDocks === 12 && historyCss.includes('position: fixed') && responsiveCss.includes('.module-output-dock'), `${outputDocks} barras de saída declaradas com modo responsivo`);

  const promptModalReady = html.includes('id="custom-prompt-modal"')
    && app.includes('function showCustomPromptModal')
    && organize.includes('showCustomPromptModal')
    && !/\bprompt\s*\(/.test(organize);
  check('Entradas de texto no padrão visual', promptModalReady, 'sumário usa modal acessível em vez de prompt nativo');

  const rendererSources = [app, queueUi, organize, read('src/renderer/ui/signature/signature-workspace.js'), read('src/renderer/ui/watermark/watermark-workspace.js'), read('src/renderer/ui/redact/redact-workspace.js')].join('\n');
  const hasNativeDialog = /\b(?:window\.)?(?:alert|prompt)\s*\(/.test(rendererSources)
    || /\bwindow\.confirm\s*\(/.test(rendererSources);
  check('Sem diálogos nativos nos módulos', !hasNativeDialog, 'alert/confirm/prompt nativos não são usados nos fluxos principais');

  const preloadChannels = uniqueMatches(preload, /invokeOrReject\('([^']+)'/g);
  const mainChannels = uniqueMatches(main, /ipcMain\.handle\('([^']+)'/g);
  const missingIpcHandlers = preloadChannels.filter((channel) => !mainChannels.includes(channel));
  check('Contrato IPC completo', missingIpcHandlers.length === 0, missingIpcHandlers.length ? `sem handler: ${missingIpcHandlers.join(', ')}` : `${preloadChannels.length} canais expostos possuem handler no processo principal`);

  const ocrModuleRationales = [
    'Reconhecer texto', 'Mesclar', 'Separar PDFs', 'Organizar páginas', 'Imagens para PDF',
    'PDF para Word', 'Ocultar dados', 'Reduzir tamanho', 'Assinar PDF',
    'Proteger / desbloquear PDF', 'Marca d’água'
  ];
  const missingOcrRationales = ocrModuleRationales.filter((moduleName) => !ocrGuide.includes(`| ${moduleName} |`));
  check('Matriz de integração OCR documentada por módulo', missingOcrRationales.length === 0,
    missingOcrRationales.length ? `sem decisão documentada: ${missingOcrRationales.join(', ')}` : `${ocrModuleRationales.length} módulos têm uso ou justificativa explícitos`);

  const expectedPayloadGuards = ['Formato de envio inválido.', 'Tipo de operação inválido.', 'Parâmetros da operação inválidos.', 'Caminhos inválidos para movimentação.', 'Dados inválidos para arquivo temporário.'];
  const missingPayloadGuards = expectedPayloadGuards.filter((message) => !main.includes(message));
  check('Payloads críticos validados', missingPayloadGuards.length === 0, missingPayloadGuards.length ? `guardas ausentes: ${missingPayloadGuards.length}` : 'fila, temporários e movimentação de arquivos validam formato e escopo');

  const errorPresentationReady = messageSystem.includes('buildFeedbackMessage')
    && app.includes('showValidationMessage')
    && app.includes('notify({');
  check('Mensagens de erro padronizadas', errorPresentationReady, 'erros de módulo passam por banner e notificações centralizadas');

  const noUnsafeHtmlFromFiles = app.includes('escapeHtml(file.name)')
    && queueUi.includes('escapeHtml(item.fileName')
    && organize.includes("textContent = primaryFile.name");
  check('Dados externos escapados no renderer', noUnsafeHtmlFromFiles, 'nomes de arquivos e histórico não entram diretamente em HTML');

  const accessibilityReady = css.includes(':focus-visible')
    && css.includes('prefers-reduced-motion')
    && html.includes('aria-live="polite"');
  check('Acessibilidade transversal', accessibilityReady, 'foco visível, redução de movimento e região de status presentes');

  const reportPath = writeReport('cross-module-audit.md', [
    '# Cross-module Quality Audit',
    '',
    `Gerado em ${new Date().toISOString()}.`,
    '',
    ...toMarkdownTable(['Verificação', 'Status', 'Detalhes'], checks.map((item) => [item.name, item.ok ? 'ok' : 'erro', item.details]))
  ]);

  return { ok: checks.every((item) => item.ok), reportPath, checks };
}

if (require.main === module) {
  try {
    const summary = runCrossModuleAudit();
    console.log(`Cross-module audit completed: ${summary.checks.length} checks`);
    process.exit(summary.ok ? 0 : 1);
  } catch (error) {
    console.error(error.stack || String(error));
    process.exit(1);
  }
}

module.exports = { runCrossModuleAudit };
