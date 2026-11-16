const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, writeReport } = require('./_common');

class FakeElement {
  constructor(id) {
    this.id = id;
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.value = '';
    this.clickCount = 0;
    this.classList = { add() {}, remove() {} };
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  setAttribute(name, value) { this.attributes.set(name, value); }
  hasAttribute(name) { return this.attributes.has(name); }
  getAttribute(name) { return this.attributes.get(name); }
  querySelector() { return null; }
  closest() { return { id: 'tab-ocr' }; }
  click() { this.clickCount += 1; }

  async emit(type, event = {}) {
    for (const listener of this.listeners.get(type) || []) await listener(event);
  }
}

async function run() {
  const source = fs.readFileSync(path.join(ROOT, 'src/renderer/app.js'), 'utf8');
  const start = source.indexOf('function normalizeSelectedFile(file)');
  const end = source.indexOf('function buildFileListItem(file, index, options = {})', start);
  assert.ok(start >= 0 && end > start, 'Não foi possível localizar o código comum dos dropzones.');

  const elements = new Map([
    ['ocr-dropzone', new FakeElement('ocr-dropzone')],
    ['ocr-file-input', new FakeElement('ocr-file-input')]
  ]);
  const document = { getElementById: (id) => elements.get(id) || null };
  const notifications = [];
  const handled = [];
  const hiddenRecentCards = [];
  const window = { api: { getPathForFile: (file) => file.nativePath || '' } };
  const factory = new Function('document', 'window', 'notify', 'hideRecentFilesCard', `${source.slice(start, end)}\nreturn setupDropzone;`);
  const setupDropzone = factory(document, window, (message) => notifications.push(message), (tab) => hiddenRecentCards.push(tab));
  const handler = async (files) => handled.push(...files);
  const filter = (file) => /\.(pdf|jpe?g|png|tiff?)$/i.test(file.name);

  setupDropzone({ id: 'ocr-dropzone', inputId: 'ocr-file-input', handler, filter });
  const dropzone = elements.get('ocr-dropzone');
  const input = elements.get('ocr-file-input');

  assert.equal(dropzone.getAttribute('role'), 'button');
  assert.equal(dropzone.getAttribute('tabindex'), '0');
  assert.equal(input.dataset.dropzoneReady, 'true');
  dropzone.clickCount = 0;
  await dropzone.emit('click', { target: dropzone });
  assert.equal(input.clickCount, 1, 'Clique na área não abriu o seletor de arquivos.');
  await dropzone.emit('keydown', { key: 'Enter', preventDefault() {} });
  assert.equal(input.clickCount, 2, 'Acesso por teclado não abriu o seletor de arquivos.');

  const selectedPdf = { name: 'documento.pdf', size: 128, nativePath: 'C:\\fixture\\documento.pdf' };
  const selectedInvalid = { name: 'notas.txt', size: 8, nativePath: 'C:\\fixture\\notas.txt' };
  input.value = 'selecionado';
  await input.emit('change', { target: { files: [selectedPdf, selectedInvalid] } });
  assert.equal(handled.length, 1, 'O seletor não encaminhou somente os formatos OCR aceitos.');
  assert.equal(handled[0].path, selectedPdf.nativePath, 'O caminho local do arquivo selecionado não foi preservado.');
  assert.equal(input.value, '', 'O input não foi limpo para permitir selecionar o mesmo arquivo novamente.');
  assert.equal(notifications[0]?.title, 'Arquivos não compatíveis');
  assert.deepEqual(hiddenRecentCards, ['ocr']);

  await dropzone.emit('drop', {
    preventDefault() {},
    dataTransfer: { files: [{ name: 'scan.tiff', size: 512, nativePath: 'C:\\fixture\\scan.tiff' }] }
  });
  assert.equal(handled.length, 2, 'Arrastar e soltar não encaminhou o arquivo OCR para o mesmo handler.');
  assert.equal(handled[1].path, 'C:\\fixture\\scan.tiff');

  const reportPath = writeReport('ocr-upload-path-report.md', [
    '# OCR Upload Path Tests', '',
    `Gerado em ${new Date().toISOString()}.`, '',
    '| Caminho | Resultado | Evidência |', '| --- | --- | --- |',
    '| Seletor HTML (evento change) | aprovado | Filtro, caminho local, limpeza do input e handler OCR verificados |',
    '| Arrastar e soltar (evento drop) | aprovado | Mesmo handler recebe TIFF com caminho local |',
    '| Acessibilidade do dropzone | aprovado | Clique, Enter, role=button e tabindex verificados |',
    '| Diálogo nativo do Windows | não coberto | Teste de renderer não automatiza interface do sistema operacional |'
  ]);
  console.log(`OCR upload paths passed: seletor, drop, acessibilidade; relatório: ${reportPath}`);
}

run().catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
