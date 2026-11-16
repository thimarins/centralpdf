const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, writeReport } = require('./_common');

class FakeElement {
  constructor(id) {
    this.id = id;
    this.value = '';
    this.disabled = false;
    this.dataset = {};
    this.style = {};
    this.textContent = '';
    this.options = [];
    this.listeners = new Map();
    this.classList = { add() {}, remove() {}, toggle() {}, contains() { return false; } };
  }

  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) || [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  async emit(type, event = {}) {
    for (const handler of this.listeners.get(type) || []) await handler(event);
  }

  append(element) { this.options.push(element); }
  replaceChildren() { this.options = []; }
  getContext() { return { fillStyle: '', fillRect() {} }; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100 }; }
  setPointerCapture() {}
}

function createAreaExtractor({ copyText, notify, windowApi, pdfjsLib = {} }) {
  const sourcePath = path.join(ROOT, 'src', 'renderer', 'ui', 'ocr', 'ocr-area-extractor.js');
  const source = fs.readFileSync(sourcePath, 'utf8').replace(/^export function createOcrAreaExtractor/m, 'function createOcrAreaExtractor');
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new FakeElement(id));
      return elements.get(id);
    },
    createElement: () => new FakeElement('created'),
    createTextNode: (text) => ({ textContent: text })
  };
  const window = { addEventListener() {} };
  const factory = new Function('document', 'window', `${source}\nreturn createOcrAreaExtractor;`)(document, window);
  const controller = factory({ document, window, pdfjsLib, windowApi: { copyText, ...windowApi }, notify, getLanguage: () => 'por+eng' });
  return { document, controller };
}

async function run() {
  const cases = [];
  const copiedText = 'Texto reconhecido em contrato — revisão necessária.';
  const successNotifications = [];
  let clipboardValue = '';
  const success = createAreaExtractor({
    copyText: async (value) => { clipboardValue = value; },
    notify: (message) => successNotifications.push(message)
  });
  success.document.getElementById('ocr-area-text').value = copiedText;
  await success.document.getElementById('btn-ocr-area-copy').emit('click');
  assert.equal(clipboardValue, copiedText, 'O botão deve copiar exatamente o texto reconhecido.');
  assert.equal(successNotifications[0]?.tone, 'success', 'A cópia bem-sucedida deve gerar confirmação padrão.');
  assert.equal(successNotifications[0]?.title, 'Texto copiado');
  cases.push('cópia exata e confirmação de sucesso');

  const failedCopy = createAreaExtractor({ copyText: async () => { throw new Error('erro técnico simulado'); }, notify() {} });
  failedCopy.document.getElementById('ocr-area-text').value = copiedText;
  failedCopy.document.getElementById('ocr-area-status').textContent = 'Texto reconhecido.';
  await failedCopy.document.getElementById('btn-ocr-area-copy').emit('click');
  assert.match(failedCopy.document.getElementById('ocr-area-status').textContent, /copiar automaticamente.*manualmente/i);
  assert.equal(failedCopy.document.getElementById('ocr-area-status').dataset.tone, 'warning');
  cases.push('falha de clipboard mostra alternativa manual sem erro técnico');

  let emptyCopyCalls = 0;
  const empty = createAreaExtractor({ copyText: async () => { emptyCopyCalls += 1; }, notify() {} });
  await empty.document.getElementById('btn-ocr-area-copy').emit('click');
  assert.equal(emptyCopyCalls, 0, 'Texto vazio não deve ser enviado para a área de transferência.');
  cases.push('resultado vazio não aciona clipboard');

  let fullReadCalls = 0;
  let rangeReadCalls = 0;
  let appliedRange = null;
  let closeCalls = 0;
  class FakeRangeTransport {
    constructor(length, initialData, progressiveDone, fileName) {
      this.length = length;
      this.initialData = initialData;
      this.progressiveDone = progressiveDone;
      this.fileName = fileName;
    }
    onDataRange(begin, bytes) { appliedRange = { begin, bytes: Array.from(bytes) }; }
  }
  const largeDocument = {
    numPages: 1,
    async getPage() {
      return {
        getViewport: () => ({ width: 300, height: 400 }),
        getTextContent: async () => ({ items: [] }),
        render: () => ({ promise: Promise.resolve() }),
        cleanup() {}
      };
    },
    async destroy() {}
  };
  const entries = [{ path: 'C:\\docs\\large.pdf', name: 'large.pdf', validation: { status: 'valid' } }];
  let testDocument;
  const ranged = createAreaExtractor({
    notify() {},
    copyText: async () => {},
    pdfjsLib: {
      PDFDataRangeTransport: FakeRangeTransport,
      getDocument(options) {
        testDocument.__rangeTransport = options.range;
        testDocument.__rangeOptions = options;
        return { promise: Promise.resolve(largeDocument), async destroy() { options.range.abort(); } };
      }
    },
    windowApi: {
      async readFileBytes() { fullReadCalls += 1; throw new Error('A prévia não deve carregar o PDF inteiro.'); },
      async openPdfPreviewRangeSession() {
        return { sessionId: 'test-session', length: 96 * 1024, initialData: new Uint8Array(64 * 1024), fileName: 'large.pdf' };
      },
      async readPdfPreviewRange({ begin, end }) {
        rangeReadCalls += 1;
        return new Uint8Array(end - begin).fill(7);
      },
      async closePdfPreviewRangeSession() { closeCalls += 1; }
    },
    getLanguage: () => 'por+eng'
  });
  testDocument = ranged.document;
  ranged.controller.setFiles(entries);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(testDocument.__rangeOptions.disableAutoFetch, true);
  assert.equal(testDocument.__rangeOptions.rangeChunkSize, 64 * 1024);
  testDocument.__rangeTransport.requestDataRange(64 * 1024, 96 * 1024);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rangeReadCalls, 1);
  assert.equal(appliedRange?.begin, 64 * 1024);
  assert.equal(appliedRange?.bytes.length, 32 * 1024);
  assert.equal(appliedRange?.bytes[0], 7);
  assert.equal(fullReadCalls, 0, 'PDFs grandes devem usar apenas leituras por intervalo.');
  await ranged.controller.destroy();
  assert.equal(closeCalls, 1, 'A sessão de leitura deve ser encerrada ao fechar a prévia.');
  cases.push('prévia OCR regional usa intervalos de 64 KiB e fecha sessão sem carregar o PDF inteiro');

  const pendingExtractions = [];
  const areaProgressListeners = new Set();
  const cancelledAreaRequests = [];
  let sessionSequence = 0;
  const race = createAreaExtractor({
    notify() {},
    copyText: async () => {},
    pdfjsLib: {
      PDFDataRangeTransport: FakeRangeTransport,
      getDocument: () => ({
        promise: Promise.resolve({
          numPages: 1,
          async getPage() {
            return {
              getViewport: () => ({ width: 100, height: 100 }),
              getTextContent: async () => ({ items: [] }),
              render: () => ({ promise: Promise.resolve() }),
              cleanup() {}
            };
          },
          async destroy() {}
        }),
        async destroy() {}
      })
    },
    windowApi: {
      async openPdfPreviewRangeSession(filePath) {
        const bytes = new Uint8Array([1, 2]);
        return { sessionId: `race-session-${++sessionSequence}`, length: bytes.length, initialData: bytes, fileName: path.basename(filePath) };
      },
      async closePdfPreviewRangeSession() {},
      async cancelOcrAreaExtraction(requestId) { cancelledAreaRequests.push(requestId); return { accepted: true }; },
      onOcrAreaProgress(listener) { areaProgressListeners.add(listener); return () => areaProgressListeners.delete(listener); },
      extractOcrTextFromArea(payload) {
        return new Promise((resolve) => pendingExtractions.push({ ...payload, resolve }));
      }
    }
  });
  const raceEntries = ['first.pdf', 'second.pdf'].map((name) => ({
    name, path: `C:\\docs\\${name}`, validation: { status: 'valid' }
  }));
  const waitForPreview = async () => {
    for (let attempt = 0; attempt < 12 && !race.controller.getState().pageCount; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(race.controller.getState().pageCount, 1, 'A prévia simulada deve abrir antes da interação.');
  };
  const drawTestSelection = async () => {
    await race.document.getElementById('btn-ocr-area-draw').emit('click');
    const canvas = race.document.getElementById('ocr-area-canvas');
    const pointerEvent = (clientX, clientY) => ({ button: 0, pointerId: 1, clientX, clientY, preventDefault() {} });
    await canvas.emit('pointerdown', pointerEvent(10, 10));
    await canvas.emit('pointermove', pointerEvent(40, 40));
    await canvas.emit('pointerup', pointerEvent(40, 40));
    assert.equal(race.controller.getState().hasSelection, true, 'A região simulada deve ficar selecionada.');
  };
  race.controller.setFiles(raceEntries);
  await waitForPreview();
  await drawTestSelection();
  const staleExtraction = race.document.getElementById('btn-ocr-area-extract').emit('click');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pendingExtractions.length, 1);
  const staleAreaRequestId = pendingExtractions[0].requestId;
  race.document.getElementById('ocr-area-file').value = '1';
  await race.document.getElementById('ocr-area-file').emit('change');
  await waitForPreview();
  assert.ok(cancelledAreaRequests.includes(staleAreaRequestId), 'Trocar de arquivo deve solicitar o cancelamento da extração anterior.');
  assert.equal(areaProgressListeners.size, 0, 'O listener antigo deve ser removido ao invalidar a extração.');
  await drawTestSelection();
  const currentExtraction = race.document.getElementById('btn-ocr-area-extract').emit('click');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pendingExtractions.length, 2);
  const currentAreaRequestId = pendingExtractions[1].requestId;
  pendingExtractions[0].resolve({ text: 'TEXTO DO PDF ANTERIOR', confidence: 99 });
  await staleExtraction;
  assert.equal(race.document.getElementById('ocr-area-text').value, '', 'Resposta tardia do arquivo anterior não pode aparecer no documento atual.');
  assert.equal(race.controller.getState().busy, true, 'A finalização antiga não pode limpar o estado da extração atual.');
  assert.equal(areaProgressListeners.size, 1, 'A finalização antiga não pode remover o listener de progresso da extração atual.');
  for (const listener of areaProgressListeners) listener({ requestId: currentAreaRequestId, progress: 55 });
  assert.match(race.document.getElementById('ocr-area-status').textContent, /55%/, 'O progresso da requisição atual deve continuar visível.');
  pendingExtractions[1].resolve({ text: 'TEXTO DO PDF ATUAL', confidence: 96 });
  await currentExtraction;
  assert.equal(race.document.getElementById('ocr-area-text').value, 'TEXTO DO PDF ATUAL');
  assert.equal(areaProgressListeners.size, 0, 'A conclusão atual deve liberar seu próprio listener.');
  cases.push('troca de PDF invalida OCR regional antigo e preserva estado/listener da requisição atual');

  const pendingSearches = [];
  const searchProgressListeners = new Set();
  const cancelledSearchRequests = [];
  const searchRace = createAreaExtractor({
    notify() {},
    copyText: async () => {},
    pdfjsLib: {
      PDFDataRangeTransport: FakeRangeTransport,
      getDocument: () => ({ promise: Promise.resolve({ numPages: 1, async getPage() { return { getViewport: () => ({ width: 100, height: 100 }), getTextContent: async () => ({ items: [] }), render: () => ({ promise: Promise.resolve() }), cleanup() {} }; }, async destroy() {} }), async destroy() {} })
    },
    windowApi: {
      async openPdfPreviewRangeSession(filePath) { return { sessionId: `search-${path.basename(filePath)}`, length: 2, initialData: new Uint8Array([1, 2]), fileName: path.basename(filePath) }; },
      async closePdfPreviewRangeSession() {},
      cancelPdfTextSearch(requestId) { cancelledSearchRequests.push(requestId); },
      onOcrSearchProgress(listener) { searchProgressListeners.add(listener); return () => searchProgressListeners.delete(listener); },
      searchPdfText(payload) { return new Promise((resolve) => pendingSearches.push({ ...payload, resolve })); }
    }
  });
  searchRace.controller.setFiles(raceEntries);
  for (let attempt = 0; attempt < 12 && !searchRace.controller.getState().pageCount; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
  const searchInput = searchRace.document.getElementById('ocr-document-search-input');
  const searchButton = searchRace.document.getElementById('btn-ocr-document-search');
  searchInput.value = 'termo';
  const staleSearch = searchButton.emit('click');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pendingSearches.length, 1);
  const staleSearchId = pendingSearches[0].requestId;
  searchRace.document.getElementById('ocr-area-file').value = '1';
  await searchRace.document.getElementById('ocr-area-file').emit('change');
  assert.ok(cancelledSearchRequests.includes(staleSearchId), 'Trocar de arquivo deve solicitar o cancelamento da pesquisa anterior.');
  assert.equal(searchProgressListeners.size, 0);
  searchInput.value = 'termo';
  const currentSearch = searchButton.emit('click');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pendingSearches.length, 2);
  const currentSearchId = pendingSearches[1].requestId;
  pendingSearches[0].resolve({ matches: [], scannedPages: 1 });
  await staleSearch;
  assert.equal(searchProgressListeners.size, 1, 'A finalização tardia da busca antiga deve preservar o listener da busca atual.');
  for (const listener of searchProgressListeners) listener({ requestId: currentSearchId, page: 1, totalPages: 1, progress: 60 });
  assert.match(searchRace.document.getElementById('ocr-document-search-status').textContent, /60%/);
  pendingSearches[1].resolve({ matches: [], scannedPages: 1 });
  await currentSearch;
  assert.equal(searchProgressListeners.size, 0);
  cases.push('troca de PDF invalida busca antiga sem remover progresso da busca atual');

  const reportPath = writeReport('ocr-area-ui-report.md', [
    '# Regressão comportamental — prévia e cópia OCR regional', '',
    `Verificações aprovadas: ${cases.length}/${cases.length}.`, '',
    ...cases.map((item) => `- Aprovado: ${item}.`), '',
    'As APIs de arquivo/visualização e de área de transferência foram simuladas; o teste não abriu arquivos reais nem leu/alterou o clipboard do usuário.'
  ]);
  console.log(`OCR area UI passed: ${cases.length}/${cases.length}; clipboard real não foi acessado. Relatório: ${reportPath}`);
}

run().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
