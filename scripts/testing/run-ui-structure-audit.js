const fs = require('fs');
const path = require('path');
const { ROOT, toMarkdownTable, writeReport } = require('./_common');

const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
const ocrHelpStart = html.indexOf('id="help-pane-ocr"');
const ocrHelpEnd = html.indexOf('<!-- ORGANIZE -->', ocrHelpStart);
const ocrHelpPane = ocrHelpStart >= 0 && ocrHelpEnd > ocrHelpStart ? html.slice(ocrHelpStart, ocrHelpEnd) : '';
const appJs = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
const mainJs = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.js'), 'utf8');
const organizeJs = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'ui', 'organize', 'organize-workspace.js'), 'utf8');
const signatureJs = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'ui', 'signature', 'signature-workspace.js'), 'utf8');
const protectJs = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'ui', 'security', 'protect-workspace.js'), 'utf8');
const unlockJs = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'ui', 'security', 'unlock-workspace.js'), 'utf8');
const queueJs = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'ui', 'queue', 'queue-status.js'), 'utf8');
const commandPaletteJs = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'ui', 'command-palette', 'command-palette.js'), 'utf8');
const imageToPdfJs = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'ui', 'image-to-pdf', 'image-to-pdf-workspace.js'), 'utf8');
const signatureWorkspaceJs = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'ui', 'signature', 'signature-workspace.js'), 'utf8');
const watermarkWorkspaceJs = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'ui', 'watermark', 'watermark-workspace.js'), 'utf8');
const redactWorkspaceJs = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'ui', 'redact', 'redact-workspace.js'), 'utf8');
const ocrAreaJs = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'ui', 'ocr', 'ocr-area-extractor.js'), 'utf8');
const ocrServiceJs = fs.readFileSync(path.join(ROOT, 'src', 'main', 'services', 'ocr', 'ocr-service.js'), 'utf8');
const ocrResultSummaryJs = fs.readFileSync(path.join(ROOT, 'src', 'main', 'services', 'ocr', 'ocr-result-summary.js'), 'utf8');
const ocrProgressJs = fs.readFileSync(path.join(ROOT, 'src', 'main', 'services', 'ocr', 'ocr-progress.js'), 'utf8');
const pdfOperationWorkerJs = fs.readFileSync(path.join(ROOT, 'src', 'main', 'pdf-operation-worker.js'), 'utf8');
const workerRuntimeJs = fs.readFileSync(path.join(ROOT, 'src', 'main', 'worker-runtime.js'), 'utf8');
const toastCenterJs = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'ui', 'notifications', 'toast-center.js'), 'utf8');
const shellCss = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'styles', 'shell.css'), 'utf8');
const queueStatusJs = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'ui', 'queue', 'queue-status.js'), 'utf8');
const componentsHistoryCss = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'styles', 'components-history.css'), 'utf8');
const rendererCss = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'style.css'), 'utf8');
const baseCss = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'styles', 'base.css'), 'utf8');
const workspacesCss = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'styles', 'workspaces.css'), 'utf8');
const componentsDensityCss = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'styles', 'components-density.css'), 'utf8');
const responsiveCss = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'styles', 'responsive.css'), 'utf8');
const preloadJs = fs.readFileSync(path.join(ROOT, 'src', 'preload', 'index.js'), 'utf8');
const documentInfoJs = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'ui', 'document-info.js'), 'utf8');

function hasId(id) {
  return new RegExp(`id=["']${id}["']`).test(html);
}

function hasIdAnywhere(id) {
  return hasId(id) || new RegExp(`id=["']${id}["']`).test(appJs);
}

function hasText(code, text) {
  return code.includes(text);
}

function runUiStructureAudit() {
  const checks = [];

  function check(name, ok, details) {
    checks.push({ name, ok, details });
  }

  check('Separar por conteúdo possui análise, cancelamento e revisão dos cortes',
    ['split-content-query', 'btn-split-content-analyze', 'btn-split-content-cancel', 'split-content-results', 'split-content-result-list'].every(hasId) &&
      appJs.includes('async function analyzeSplitContent') && appJs.includes('type = "split-content"') &&
      appJs.includes('cancelPdfTextSearch'),
    'busca local com OCR, cancelamento e seleção explícita de páginas antes de dividir');
  check('Busca de ocultação oferece preset de datas na interface e no OCR',
    html.includes('data-redact-preset="DATA"') &&
      redactWorkspaceJs.includes("else if (term === 'DATA')") &&
      fs.readFileSync(path.join(ROOT, 'src', 'main', 'services', 'ocr', 'ocr-service.js'), 'utf8').includes("query === 'DATA'"),
    'mesmo padrão DD/MM/AAAA ou AAAA-MM-DD nas camadas nativa e OCR');
  check('OCR oferece orientação adaptativa sem alterar a imagem original',
    hasId('ocr-auto-rotate') && appJs.includes("autoRotate: document.getElementById('ocr-auto-rotate')?.checked !== false") &&
      ocrServiceJs.includes('recognizeWithAdaptiveOrientation') && ocrServiceJs.includes('mapOcrBoxesToOriginal') &&
      ocrServiceJs.includes('createContrastEnhancedImage'),
    'tentativas de rotação/pré-processamento sob baixa confiança, com coordenadas remapeadas');
  check('Ajuda de OCR explica o risco para assinaturas digitais',
    ocrHelpPane.includes('Assinaturas digitais') && ocrHelpPane.includes('Guarde o original') && ocrHelpPane.includes('assine a cópia final'),
    'a orientação fica na seção OCR e explica que recriar o PDF pode invalidar a assinatura digital original');
  check('OCR separa correção de orientação e melhoria automática da imagem',
    hasId('ocr-auto-rotate') && hasId('ocr-image-enhancement') &&
      appJs.includes("imageEnhancement: document.getElementById('ocr-image-enhancement')?.checked !== false") &&
      ocrServiceJs.includes('options.autoRotate !== false') &&
      (ocrServiceJs.match(/options\.imageEnhancement !== false/g) || []).length >= 3 &&
      mainJs.includes("['autoRotate', 'imageEnhancement']") &&
      mainJs.includes('typeof options[optionName] !== \'boolean\''),
    'desativar rotação não bloqueia contraste/ruído; opções são independentes e validadas na entrada IPC');
  check('OCR disponibiliza modo completo com proteção contra duplicação',
    html.includes('<option value="auto">') && html.includes('<option value="complete">') &&
      ocrServiceJs.includes("mode === 'complete'") && ocrServiceJs.includes('existingTextBoxes'),
    'modo automático permanece padrão; modo completo examina as páginas sem sobrepor texto nativo detectado');
  check('OCR refaz apenas camada rastreável e preserva PDFs legados com segurança',
    html.includes('<option value="redo">') && ocrServiceJs.includes("mode === 'redo'") &&
      ocrServiceJs.includes('OCR_LAYER_CONTENTS_KEY') && ocrServiceJs.includes('readOcrLayerMetadata') &&
      ocrServiceJs.includes('removeOcrLayer') && ocrServiceJs.includes('safeUserMessage'),
    'substitui somente stream OCR identificado; falha com orientação clara quando uma camada antiga não tem referência segura');
  check('E2E inclui substituição OCR no aplicativo empacotado',
    fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.js'), 'utf8').includes("runStep('ocr-redo'") &&
      fs.readFileSync(path.join(ROOT, 'scripts', 'testing', 'run-ocr-tests.js'), 'utf8').includes('Refazer OCR repetido acumulou camadas'),
    'regressão funcional cobre redo por fila empacotada e por teste de integração local');
  check('Conclusão OCR resume páginas e confiança sem expor texto do documento',
    queueJs.includes('recognizedOcrPages') && queueJs.includes('skippedOcrPages') && queueJs.includes('noTextOcrPages') &&
      queueJs.includes('confiança média ${averageOcrConfidence}%') && mainJs.includes('averageOcrConfidence') &&
      mainJs.includes('noTextPages:') && mainJs.includes('warnings: Array.isArray(task.result.warnings)'),
    'aviso final recebe métricas agregadas e avisos limitados; conteúdo reconhecido não atravessa a fronteira IPC');
  check('Conclusão OCR alerta páginas reconhecidas com baixa confiança',
    ocrResultSummaryJs.includes('OCR_LOW_CONFIDENCE_THRESHOLD = 60') &&
      pdfOperationWorkerJs.includes('createLowConfidenceWarnings(pageResults)') &&
      queueJs.includes('concluído com avisos') && ocrResultSummaryJs.includes('Revise o texto com o documento original.'),
    'aviso estimado é agrupado por arquivo/páginas, chega como conclusão com aviso e não transforma sucesso parcial em erro');
  check('OCR mostra progresso real do motor em porcentagem e português',
    ocrProgressJs.includes("numeric * 100") && ocrProgressJs.includes('Reconhecendo texto') &&
      pdfOperationWorkerJs.includes('createOcrProgressUpdate(item') &&
      fs.readFileSync(path.join(ROOT, 'scripts', 'testing', 'run-ocr-tests.js'), 'utf8').includes('Progresso fracionário do motor'),
    'frações 0–1 do Tesseract viram porcentagem, entram no progresso do lote e exibem nome de etapa traduzido');
  check('E2E OCR usa timeout compatível e limpa tarefas após falha',
    mainJs.includes('async function cancelLingeringE2eWork') && mainJs.includes('window.api.cancelOperation(task.id)') &&
      mainJs.includes('detail });') && mainJs.includes('}, 15 * 60 * 1000);') &&
      mainJs.includes('let completedOcrResultPath') && mainJs.includes('files: [completedOcrResultPath]') &&
      mainJs.includes('const pdfEntries = state.ocrFiles.filter') && mainJs.includes('waitForSearchResults') &&
      mainJs.includes("'busca textual/OCR no PDF', 310_000") &&
      mainJs.includes("'pontos de separação por conteúdo', 310_000") &&
      mainJs.includes("ocrLanguageSelect.value = 'eng'") &&
      mainJs.includes('encerramento da pesquisa/extração OCR') &&
      fs.readFileSync(path.join(ROOT, 'scripts', 'testing', 'run-ui-app-e2e.js'), 'utf8').includes('30 * 60 * 1000'),
    'reusa resultado OCR, usa índice PDF filtrado, alinha espera às operações OCR e aguarda limpeza após cancelamento');
  check('Cancelamento OCR sempre encerra a promessa do worker',
    workerRuntimeJs.includes("worker.on('exit', (code) => {") &&
      workerRuntimeJs.includes('if (settled) return;') &&
      workerRuntimeJs.includes('reject(createWorkerExitError(code, cancelledReason));') &&
      fs.readFileSync(path.join(ROOT, 'scripts', 'testing', 'run-queue-tests.js'), 'utf8').includes("exitedWorker.emit('exit', 0)"),
    'inclusive saída de código 0 resolve como cancelamento em vez de manter pesquisa/extração ativa');
  check('Upload OCR avisa sobre modelos de idioma ausentes antes de iniciar',
    hasId('ocr-runtime-warning') && mainJs.includes('ocrRuntime: getOcrRuntimeStatus()') &&
      appJs.includes('OCR indisponível neste aplicativo') && appJs.includes('state.ocrRuntime.availableLanguages') &&
      fs.readFileSync(path.join(ROOT, 'src', 'main', 'services', 'ocr', 'ocr-runtime.js'), 'utf8').includes('OCR_MODEL_INTEGRITY') &&
      fs.readFileSync(path.join(ROOT, 'src', 'main', 'services', 'ocr', 'ocr-runtime.js'), 'utf8').includes('invalidLanguages'),
    'preflight valida SHA-256, identifica modelos ausentes/adulterados e impede reconhecer sem idioma íntegro');
  check('OCR de baixa qualidade testa binarização adaptativa com limite de recursos',
    ocrServiceJs.includes('createAdaptiveBinarizedImage') && ocrServiceJs.includes('OCR_ADAPTIVE_THRESHOLD_MAX_PIXELS') &&
      ocrServiceJs.includes('binarizedScore > bestScore + 1.5') && queueJs.includes('melhoria da imagem em'),
    'a alternativa é limitada a 4 MP, só substitui o resultado quando a pontuação melhora e a conclusão usa texto não técnico');

  const moduleControls = {
    'Organizar principais': [
      'btn-run-organize',
      'btn-organize-move-first',
      'btn-organize-move-up',
      'btn-organize-move-down',
      'btn-organize-move-last',
      'btn-organize-rotate-selected',
      'btn-organize-duplicate-selected',
      'btn-organize-delete-selected',
      'btn-organize-extract-selected',
      'btn-organize-export-images',
      'btn-organize-select-all',
      'btn-organize-clear-selection',
      'btn-organize-undo-action',
      'btn-organize-reverse',
      'btn-organize-add-file',
      'btn-organize-add-image',
      'btn-organize-clear-file',
      'organize-output-name',
      'organize-zip',
      'organize-number-pages'
    ],
    'Assinar principais': [
      'btn-run-signature',
      'btn-add-signature-field',
      'btn-save-signature-draw',
      'btn-add-initials-field',
      'btn-add-date-field',
      'btn-add-text-field',
      'btn-add-seal-field',
      'signature-field-editor'
    ],
    'Proteger principais': [
      'btn-run-protect',
      'btn-protect-change-file',
      'btn-protect-clear-file',
      'btn-protect-generate-password',
      'btn-protect-copy-password',
      'btn-protect-toggle-password',
      'protect-password',
      'protect-output-name'
    ],
    'Desbloquear principais': [
      'btn-run-unlock',
      'btn-unlock-change-file',
      'btn-unlock-clear-file',
      'btn-unlock-clear-password',
      'btn-unlock-copy-password',
      'btn-unlock-toggle-password',
      'unlock-password',
      'unlock-output-name'
    ],
    'Fila e histórico': [
      'btn-dashboard-processed-history',
      'recent-history-list',
      'recent-processed-modal-list',
      'queue-status-bar',
      'queue-tasks-list'
    ]
  };

  Object.entries(moduleControls).forEach(([name, ids]) => {
    const missing = ids.filter((id) => !hasIdAnywhere(id));
    check(name, missing.length === 0, missing.length === 0 ? `${ids.length} controles encontrados` : `faltando: ${missing.join(', ')}`);
  });

  check(
    'Organizar vinculado no app',
    hasText(appJs, 'bindClick("btn-run-organize", queueOrganize);') &&
      hasText(appJs, 'organizeWorkspace.moveSelectedPages("up")') &&
      hasText(appJs, 'organizeWorkspace.rotateSelectedPages') &&
      hasText(appJs, 'organizeWorkspace.clearOrganizeWorkspace'),
    'ações principais do Organizar ligadas ao renderer'
  );

  check(
    'Organizar handlers internos',
    hasText(organizeJs, 'bindOrganizeUiOnce()') &&
      hasText(organizeJs, 'btnExtract.onclick = async') &&
      hasText(organizeJs, 'btnExportImages.onclick = async') &&
      hasText(organizeJs, 'btnShowDetails.onclick = async') &&
      hasText(organizeJs, 'togglePageSelection') &&
      hasText(organizeJs, 'btnSelectAll.onclick = selectAllOrganizePages') &&
      hasText(organizeJs, 'btnClearSelection.onclick = clearOrganizeSelection'),
    'handlers únicos para ações internas'
  );

  check(
    'Paleta de comandos global',
    hasId('dashboard-search-input') &&
      hasId('command-palette-modal') &&
      hasText(commandPaletteJs, 'Configurações') &&
      hasText(commandPaletteJs, 'Últimas atividades') &&
      hasText(commandPaletteJs, 'openRecentFile') &&
      hasText(appJs, 'commandPalette.open(searchInput.value)'),
    'a busca global abre a mesma paleta de ferramentas, configurações e últimas atividades'
  );

  check(
    'Tema do sistema acompanha o Windows',
    hasText(appJs, 'window.matchMedia?.("(prefers-color-scheme: dark)")') &&
      hasText(appJs, 'setupSystemThemeSync') &&
      hasText(appJs, 'addEventListener("change", handleSystemThemeChange)') &&
      hasText(appJs, 'document.documentElement.style.colorScheme = effectiveTheme') &&
      hasText(rendererCss, 'base.css'),
    'o modo Sistema usa prefers-color-scheme, reage a mudanças do Windows e ajusta controles nativos'
  );

  check(
    'Tema do sistema usa destaque do Windows',
    hasText(preloadJs, "getSystemAppearance: () => invokeOrReject('get-system-appearance')") &&
      hasText(appJs, 'applySystemAccentColor') &&
      hasText(appJs, 'theme-color-system') &&
      hasText(appJs, 'onSystemAppearanceUpdated') &&
      hasText(appJs, '--system-accent-color'),
    'quando a cor não foi personalizada, o modo Sistema usa o destaque do Windows e acompanha mudanças'
  );

  const systemThemeRules = [...baseCss.matchAll(/\.theme-system[^{}]*\{([^{}]*)\}/g)].map((match) => match[1]);
  check(
    'Tema do sistema preserva tipografia do aplicativo',
    hasText(baseCss, '--font-family-text: "Aptos"') &&
      hasText(baseCss, '--font-family-display: "Aptos Display"') &&
      hasText(baseCss, '--text-primary: #f1f5f9') &&
      hasText(baseCss, '--text-secondary: #a8b5c7') &&
      systemThemeRules.length > 0 && systemThemeRules.every((rule) => !rule.includes('font-family:')),
    'o modo Sistema altera superfícies e destaque sem substituir a tipografia ou a paleta textual principal'
  );

  check(
    'Atalho rápido acessível',
    hasText(appJs, 'id="dashboard-pdf-dropzone" role="button" tabindex="0"') &&
      hasText(appJs, 'dropzone.addEventListener("keydown"') &&
      hasText(appJs, 'event.key !== "Enter" && event.key !== " "'),
    'área de envio do início pode ser acionada por Enter e Espaço'
  );

  check(
    'Atalho rápido: foco visível',
    hasText(shellCss, '.dashboard-upload-box:focus-visible') &&
      hasText(shellCss, 'outline: 2px solid var(--accent-color)'),
    'a área de envio destaca o foco para navegação por teclado'
  );

  check(
    'Últimas atividades: restaura foco',
    hasText(queueStatusJs, 'let recentHistoryTrigger = null') &&
      hasText(queueStatusJs, 'const trigger = recentHistoryTrigger || historyButton') &&
      hasText(queueStatusJs, 'trigger.focus();'),
    'ao fechar o painel, o foco retorna ao botão que o abriu'
  );

  check(
    'Destino de saída: fluxo único',
    !hasText(appJs, 'Fluxo antigo substituído pelo destino contextual') &&
      !hasText(appJs, 'legacyResult'),
    'o atalho de pasta usa somente o destino contextual atual'
  );

  check(
    'Organizar: confirmação visual para limpar sumário',
    hasText(organizeJs, 'showCustomConfirmModal') &&
      !hasText(organizeJs, "confirm('Deseja realmente limpar todo o sumário?')"),
    'a ação destrutiva usa o diálogo visual e acessível do aplicativo'
  );

  check(
    'Barra inferior de saída em todos os módulos',
    (html.match(/module-output-dock/g) || []).length === 12 &&
      hasText(appJs, 'actionBar.classList.add("action-bar-settings--output-layout", "module-output-dock")') &&
      hasText(componentsHistoryCss, '.module-output-dock') &&
      hasText(componentsHistoryCss, 'position: fixed') &&
      hasText(componentsHistoryCss, 'bottom: 14px') &&
      hasText(componentsHistoryCss, 'left: calc(var(--sidebar-width) + 30px)') &&
      hasText(componentsHistoryCss, 'display: flex') &&
      hasText(componentsHistoryCss, 'flex: 1 1 clamp(320px, 42%, 760px)') &&
      hasText(componentsHistoryCss, 'flex: 1 1 220px') &&
      hasText(componentsHistoryCss, '.module-output-dock :is(.btn-primary, .module-action-group--primary .btn-primary)') &&
      hasText(responsiveCss, '.module-output-dock'),
    'módulos mantêm campo, opções e ação principal alinhados e visíveis'
  );

  check(
    'Ritmo visual global de cards e controles',
    hasText(rendererCss, '@import "./styles/components-density.css";') &&
      hasText(componentsDensityCss, '--ui-control-height: 40px') &&
      hasText(componentsDensityCss, '--ui-card-gap: 12px') &&
      hasText(componentsDensityCss, '.section-heading :is(h2, h3)') &&
      hasText(componentsDensityCss, '.setting-info') &&
      hasText(componentsDensityCss, '.setting-action-output-dir .btn-icon'),
    'cards, títulos, descrições e controles compartilham tokens de espaçamento e altura'
  );

  check(
    'Seletores nativos de arquivo compatíveis com Electron atual',
    hasText(preloadJs, 'webUtils') &&
      hasText(preloadJs, 'getPathForFile') &&
      hasText(appJs, 'normalizeSelectedFiles') &&
      hasText(appJs, 'await handler(selectedFiles)') &&
      hasText(componentsHistoryCss, 'pointer-events: none'),
    'o caminho local usa webUtils, o input fica realmente oculto e só é limpo depois do carregamento'
  );

  check(
    'Imagem para PDF: atalhos de teclado',
    hasText(imageToPdfJs, 'keyboardBindingsReady') &&
      hasText(imageToPdfJs, 'event.key === "Escape"') &&
      hasText(imageToPdfJs, 'event.key.toLowerCase() === "z"'),
    'Esc limpa a seleção e Ctrl/Cmd+Z desfaz alterações na lista'
  );

  check(
    'Assinatura: remoção por teclado',
    hasText(signatureWorkspaceJs, 'keyboardBindingsReady') &&
      hasText(signatureWorkspaceJs, "event.key === 'Delete'") &&
      hasText(signatureWorkspaceJs, "event.key === 'Escape'") &&
      hasText(signatureWorkspaceJs, 'removeSelectedField();'),
    'Delete/Backspace remove o campo selecionado e Esc limpa a seleção'
  );

  check(
    'Marca d\'água: remoção por teclado',
    hasText(watermarkWorkspaceJs, 'keyboardBindingsReady') &&
      hasText(watermarkWorkspaceJs, 'function removeFileAtIndex') &&
      hasText(watermarkWorkspaceJs, 'tab-watermark') &&
      hasText(watermarkWorkspaceJs, 'event.key === "Delete"'),
    'Delete/Backspace remove o arquivo ativo sem interferir nos campos de edição'
  );

  check(
    'Ocultar dados: remoção por teclado',
    hasText(redactWorkspaceJs, 'keyboardBindingsReady') &&
      hasText(redactWorkspaceJs, 'function removeBox') &&
      hasText(redactWorkspaceJs, "tab-redact") &&
      hasText(redactWorkspaceJs, "event.key === 'Delete'"),
    'Delete/Backspace remove a tarja selecionada e Esc limpa a seleção'
  );

  check(
    'Preview: Esc preserva ausência de seleção',
    hasText(signatureWorkspaceJs, "if (state.signatureSelectedFieldId && !state.signatureFields.some") &&
      hasText(redactWorkspaceJs, "if (state.redactSelectedBoxId && !state.redactBoxes.some"),
    'o preview não volta a selecionar automaticamente um item após Esc'
  );

  check(
    'Ocultar dados: navegação tolera troca de arquivo',
    hasText(redactWorkspaceJs, 'pdfDoc !== state.redactPdfDoc') &&
      hasText(redactWorkspaceJs, "getElementById('btn-redact-prev-page')") &&
      hasText(redactWorkspaceJs, "getElementById('btn-redact-next-page')") &&
      hasText(redactWorkspaceJs, "title: 'Preview do PDF'") ,
    'a prévia ignora páginas obsoletas e trata falhas de navegação sem rejeição global'
  );

  check(
    'Ocultar dados: zoom acessível no preview',
    hasId('redact-zoom-range') &&
      hasId('btn-redact-zoom-out') &&
      hasId('btn-redact-zoom-in') &&
      hasId('btn-redact-zoom-reset') &&
      hasText(redactWorkspaceJs, 'function syncPreviewZoom') &&
      hasText(redactWorkspaceJs, 'setPreviewZoom') &&
      hasText(workspacesCss, 'redact-preview-shell--zoomed'),
    'o preview permite ampliar, reduzir e voltar a 100% sem alterar as coordenadas das tarjas'
  );

  check(
    'Ocultar dados: zoom e navegação alinhados',
    html.indexOf('class="redact-preview-controls"') < html.indexOf('id="redact-preview-shell"') &&
      html.indexOf('id="btn-redact-prev-page"') < html.indexOf('id="redact-preview-shell"') &&
      hasText(workspacesCss, 'flex-wrap: wrap;') &&
      hasText(workspacesCss, 'redact-preview-controls'),
    'zoom e navegação ficam na mesma faixa e quebram para duas linhas quando necessário'
  );

  check(
    'Ocultar dados: pan no zoom',
    hasText(redactWorkspaceJs, 'let panState = null') &&
      hasText(redactWorkspaceJs, 'startScrollLeft') &&
      hasText(redactWorkspaceJs, 'redact-preview-shell--panning') &&
      hasText(workspacesCss, 'cursor: grabbing'),
    'com zoom acima de 100%, o preview pode ser arrastado com a mão'
  );

  check(
    'Ocultar dados: erro de aplicação contextualizado',
    hasText(redactWorkspaceJs, 'Não foi possível renderizar a página') &&
      hasText(redactWorkspaceJs, 'state.redactTempPaths') &&
      hasText(fs.readFileSync(path.join(ROOT, 'src', 'main', 'pdf-service.js'), 'utf8'), 'Não foi possível aplicar a ocultação na página'),
    'falhas de renderização e de temporários indicam a página afetada e permitem refazer a prévia'
  );

  check(
    'Notificações: mensagem mais recente na frente',
    hasText(toastCenterJs, 'mountTarget.prepend(element)') &&
      hasText(responsiveCss, '.toast-region') &&
      !hasText(html, 'app-feedback-banner') &&
      !hasText(appJs, 'createFeedbackCenter'),
    'novos avisos aparecem no sistema padrão e o banner superior legado não é renderizado'
  );

  check(
    'Ocultar dados: busca isolada da prévia',
    hasText(redactWorkspaceJs, 'state.redactPdfBytes') &&
      hasText(redactWorkspaceJs, 'smartSearchLoadingTask') &&
      hasText(redactWorkspaceJs, "id: 'redact-smart-search'") &&
      hasText(redactWorkspaceJs, 'getDocument({ data: sourceBytes })'),
    'a busca usa uma instância própria do PDF e substitui a notificação de progresso pelo resultado'
  );

  check(
    'Ocultar dados: aplicação isolada da prévia',
    hasText(redactWorkspaceJs, 'generationLoadingTask') &&
      hasText(redactWorkspaceJs, 'generationPdfDoc') &&
      hasText(redactWorkspaceJs, 'state.redactPdfBytes.slice()'),
    'a geração das páginas ocultadas não disputa o documento usado pelo preview'
  );

  check(
    'Ocultar dados: navegação e pan robustos',
    hasText(redactWorkspaceJs, 'pageRenderQueue') &&
      hasText(redactWorkspaceJs, 'centerPreviewScroll') &&
      hasText(redactWorkspaceJs, "addEventListener('wheel'") &&
      hasText(redactWorkspaceJs, 'event.ctrlKey'),
    'renders são serializados, o zoom inicia centralizado e Ctrl+roda ajusta a ampliação'
  );

  check(
    'Ocultar dados: renderização não fica pendurada',
    hasText(redactWorkspaceJs, 'activePageRenderTask') &&
      hasText(redactWorkspaceJs, 'cancelActivePageRender') &&
      hasText(redactWorkspaceJs, 'Timeout ao renderizar a página do preview'),
    'a troca de página cancela renderizações antigas e encerra previews que ultrapassam o tempo limite'
  );

  check(
    'Ocultar dados: preview recupera falha interna do PDF.js',
    hasText(redactWorkspaceJs, 'reloadPreviewDocument') &&
      hasText(redactWorkspaceJs, "getPageWithRetry(pdfDoc, pageIndex + 1, 'preview')") &&
      !hasText(redactWorkspaceJs, '/sendWithPromise|null/i'),
    'falhas de getPage não são ignoradas silenciosamente; a prévia é reaberta uma vez'
  );

  const toolbarCss = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'styles', 'components-toolbar.css'), 'utf8');
  check(
    'Fila inferior: mensagem ampla e responsiva',
    hasText(toolbarCss, 'width: min(680px') &&
      hasText(toolbarCss, '@media (max-width: 760px)') &&
      hasText(componentsHistoryCss, 'queue-tasks-list'),
    'status inferior comporta metadados e se adapta a telas menores'
  );

  check(
    'Ocultar dados: Adicionar Tarja destacado',
    hasId('btn-add-redact-box') &&
      hasText(html, 'redact-add-box-button') &&
      hasText(workspacesCss, '.redact-add-box-button'),
    'a ação manual principal tem maior destaque visual e área de clique'
  );

  check(
    'Informações do documento padronizadas',
    hasText(documentInfoJs, 'formatDocumentMeta') &&
      hasText(signatureWorkspaceJs, "formatDocumentMeta(formatBytes") &&
      hasText(redactWorkspaceJs, "formatDocumentMeta(formatBytes") &&
      hasText(organizeJs, "formatDocumentMeta(formatBytes") &&
      hasText(imageToPdfJs, "formatDocumentMeta(formatBytes") &&
      hasText(watermarkWorkspaceJs, "formatDocumentMeta(formatBytes"),
    'tipo, tamanho e quantidade de páginas usam o mesmo formato nos módulos'
  );

  check(
    'Assinar handlers',
    hasText(signatureJs, "['signature', 'drawn', 'initials', 'date', 'text', 'seal'].forEach") &&
      hasText(signatureJs, 'btn-remove-signature-field') &&
      hasText(signatureJs, 'btn-remove-signature-field'),
    'ações de assinatura declaradas'
  );

  check(
    'Assinatura: navegação tolera troca de arquivo',
    hasText(signatureJs, 'pdfDoc !== state.signaturePdfDoc') &&
      hasText(signatureJs, 'sendWithPromise'),
    'a prévia de assinatura ignora documentos destruídos durante a navegação'
  );

  check(
    'Proteger handlers',
    hasText(protectJs, 'btn-protect-generate-password') &&
      hasText(protectJs, 'btn-protect-copy-password') &&
      hasText(protectJs, 'btn-protect-clear-file'),
    'ações de proteção declaradas'
  );

  check(
    'Desbloquear handlers',
    hasText(unlockJs, 'btn-unlock-clear-password') &&
      hasText(unlockJs, 'btn-unlock-copy-password') &&
      hasText(unlockJs, 'btn-unlock-clear-file'),
    'ações de desbloqueio declaradas'
  );

  check(
    'Notificações de fila',
    hasText(queueJs, 'queue-running-') &&
      hasText(queueJs, 'queue-complete-') &&
      hasText(queueJs, 'queue-error-') &&
      hasText(queueJs, "updateRecentHistory?.(task, 'sucesso')"),
    'fluxos de andamento, sucesso e erro presentes'
  );

  check(
    'Fila: cancelamento só termina após a execução parar',
    hasText(queueStatusJs, "task.status === 'running' && task.cancellationRequested") &&
      hasText(queueStatusJs, "return 'Cancelando'") &&
      hasText(queueStatusJs, "task.status === 'running' && !task.cancellationRequested && !task.timeoutRequested") &&
      hasText(queueStatusJs, 'encerrando a etapa atual com segurança'),
    'mostra cancelamento/timeout em andamento e esconde o botão até o worker liberar o arquivo'
  );

  check(
    'E2E de ocultação tolera carga após OCR prolongado',
    /await runStep\('redact',[\s\S]*?\}, 180000\);/.test(mainJs),
    'a etapa final tem até 180 s para concluir antes de cancelar uma operação válida do worker'
  );

  check(
    'Fila: resultado parcial não aparece como sucesso total',
    hasText(queueJs, 'task.result?.warnings') &&
      hasText(queueJs, 'concluído com avisos') &&
      hasText(queueJs, 'slice(0, 3)'),
    'mostra aviso resumido para falhas parciais sem inundar notificações'
  );

  check(
    'Marca d\'agua: orientacao adaptavel e rotacao da origem',
    hasId('btn-watermark-rotate-left') &&
      hasId('btn-watermark-rotate-right') &&
      hasId('btn-watermark-reset-rotation') &&
      hasText(watermarkWorkspaceJs, 'syncPreviewCanvasDimensions') &&
      hasText(watermarkWorkspaceJs, 'sourceRotations'),
    'preview acompanha retrato/paisagem e separa a rotacao da origem da marca'
  );

  check(
    'Marca d\'agua: navegação por página dentro do lote',
    hasId('btn-watermark-prev-page') &&
      hasId('btn-watermark-next-page') &&
      hasText(watermarkWorkspaceJs, 'watermarkPreviewPageIndex') &&
      hasText(watermarkWorkspaceJs, 'watermarkPreviewPageCount') &&
      hasText(watermarkWorkspaceJs, 'cachedPdfDocument.getPage'),
    'o arquivo ativo pode avançar e voltar páginas sem trocar o item do lote'
  );

  check(
    'Marca d\'agua: confirma perda de qualquer arquivo carregado',
    hasText(watermarkWorkspaceJs, 'if (state.watermarkFiles.length > 0 || state.watermarkImageFile)') &&
      !hasText(watermarkWorkspaceJs, 'state.watermarkFiles.length > 1'),
    'inclusive um único arquivo com configurações padrão aciona a confirmação ao sair'
  );

  check(
    'Converter para PDF: rotacao individual de imagens',
    hasText(imageToPdfJs, 'data-image-rotate-left') &&
      hasText(imageToPdfJs, 'data-image-rotate-right') &&
      hasText(imageToPdfJs, 'function rotateImage') &&
      hasText(componentsHistoryCss, 'object-fit: contain'),
    'cada imagem pode ser girada e a miniatura inteira permanece visivel'
  );

  check(
    'Mesclar: rotacao individual de imagens',
    hasText(appJs, 'data-merge-rotate-left') &&
      hasText(appJs, 'data-merge-rotate-right') &&
      hasText(appJs, 'function rotateMergeImage'),
    'imagens do lote podem ser corrigidas antes da conversao temporaria'
  );

  check(
    'Mesclar: pré-validação no upload',
    hasText(appJs, 'preflightBatchFiles') &&
      hasText(appJs, 'validationStatus') &&
      hasText(appJs, 'Aguarde a verificação dos arquivos terminar') &&
      hasText(appJs, 'const mergeableFiles = state.mergeFiles.filter'),
    'mostra o estado de cada arquivo antes de mesclar e não repete avisos já apresentados'
  );

  check(
    'Assinar e Ocultar: encaminhamento seguro de orientacao',
    hasId('btn-signature-fix-orientation') &&
      hasId('btn-redact-fix-orientation') &&
      hasText(appJs, 'routeEditorFileToOrganize') &&
      hasText(appJs, 'hasPlacedElements'),
    'encaminha ao Organizar com confirmacao quando ha campos ou tarjas'
  );

  check(
    'OCR: extrair texto de região selecionada',
    ['ocr-area-file', 'ocr-area-canvas', 'ocr-area-selection', 'btn-ocr-area-prev', 'btn-ocr-area-next', 'btn-ocr-area-draw', 'btn-ocr-area-extract', 'ocr-area-text'].every(hasId) &&
      hasText(ocrAreaJs, 'onPointerDown') && hasText(ocrAreaJs, 'onPointerMove') && hasText(ocrAreaJs, 'onPointerUp') &&
      hasText(ocrAreaJs, 'extractOcrTextFromArea') && hasText(ocrAreaJs, 'cancelOcrAreaExtraction') &&
      hasText(ocrAreaJs, 'windowApi.copyText') && hasText(appJs, 'ocrAreaExtractor.setFiles(valid)'),
    'seletor visual por arraste, paginação, reconhecimento sob demanda, cópia e cancelamento'
  );

  check(
    'OCR: cancelamento regional confirmado e tolerante a corrida',
    hasText(mainJs, 'pendingOcrAreaCancels.consume(requestId)') &&
      hasText(mainJs, 'ipcMain.handle(\'ocr-extract-area-cancel\'') &&
      hasText(ocrAreaJs, 'cancelamento. Aguarde o reconhecimento terminar') &&
      hasText(mainJs, 'CENTRAL_PDF_E2E_STEPS'),
    'cancelamentos antecipados ficam limitados e expiram, o IPC confirma recebimento e o E2E pode rodar apenas o fluxo afetado'
  );

  check(
    'Janela principal: fechamento não acessa BrowserWindow destruída',
    hasText(mainJs, "const window = mainWindow;") &&
      hasText(mainJs, "const windowContents = window.webContents;") &&
      hasText(mainJs, "window.on('closed'") &&
      hasText(mainJs, 'pdfPreviewRangeSessions.closeSender(windowContents)') &&
      hasText(mainJs, 'if (mainWindow === window) mainWindow = null;'),
    'o handler usa referências capturadas antes do fechamento e só limpa a janela correspondente'
  );

  check(
    'OCR: busca em PDF nativo e digitalizado',
    ['ocr-document-search-input', 'btn-ocr-document-search', 'btn-ocr-document-search-cancel', 'ocr-document-search-status', 'ocr-document-search-results', 'ocr-area-search-highlights'].every(hasId) &&
      hasText(ocrAreaJs, 'searchPdfText') && hasText(ocrAreaJs, 'source === \'OCR\'') && hasText(ocrAreaJs, 'pageNumber = match.pageNumber') &&
      hasText(ocrAreaJs, 'cancelActiveSearch({ invalidate: true })'),
    'pesquisa texto nativo e OCR, navega ao resultado, destaca a região e invalida operações ao trocar o PDF'
  );

  check(
    'Organizar: localizar página por texto sem alterar a seleção',
    ['organize-document-search-input', 'btn-organize-document-search', 'btn-organize-document-search-cancel', 'organize-document-search-results'].every(hasId) &&
      hasText(organizeJs, 'searchPdfText') && hasText(organizeJs, 'candidate.sourceIndex === match.pageNumber - 1') &&
      hasText(organizeJs, 'is-search-result-focus') && hasText(organizeJs, 'cancelOrganizeDocumentSearch({ invalidate: true })'),
    'usa a busca OCR compartilhada, aponta a miniatura da página sem modificar seleção ou conteúdo'
  );

  const reportPath = writeReport('ui-structure-audit.md', [
    '# UI Structure Audit Report',
    '',
    `Gerado em ${new Date().toISOString()}.`,
    '',
    ...toMarkdownTable(
      ['Check', 'Status', 'Detalhes'],
      checks.map((item) => [item.name, item.ok ? 'ok' : 'warning', item.details])
    )
  ]);

  return {
    ok: checks.every((item) => item.ok),
    reportPath,
    checks
  };
}

if (require.main === module) {
  try {
    const summary = runUiStructureAudit();
    console.log(`UI structure audit completed: ${summary.checks.length} checks`);
    process.exit(summary.ok ? 0 : 1);
  } catch (error) {
    console.error(error.stack || String(error));
    process.exit(1);
  }
}

module.exports = {
  runUiStructureAudit
};
