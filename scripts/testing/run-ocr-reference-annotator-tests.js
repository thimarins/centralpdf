'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseCsv, serializeCsv, normalizeReviewStatus, isReviewedStatus, findNextUnannotated } = require('./ocr-reference-annotator');

const input = [
  '\uFEFFarquivo,texto,paper_type,defeito',
  'pagina_0001.png,"Linha 1, com vírgula"" e aspas',
  'segunda linha",A4,limpo',
  'pagina_0002.png,,A5,branco'
].join('\r\n');
const parsed = parseCsv(input);
assert.deepEqual(parsed, [
  ['arquivo', 'texto', 'paper_type', 'defeito'],
  ['pagina_0001.png', 'Linha 1, com vírgula" e aspas\r\nsegunda linha', 'A4', 'limpo'],
  ['pagina_0002.png', '', 'A5', 'branco']
]);

const rows = [
  { arquivo: 'pagina_0001.png', texto: 'A, "B"\ne C', paper_type: 'A4', defeito: 'limpo', status_revisao: 'transcrito' },
  { arquivo: 'pagina_0002.png', texto: '', paper_type: 'A5', defeito: 'branco', status_revisao: 'em_branco' }
];
assert.deepEqual(parseCsv(serializeCsv(rows)), [
  ['arquivo', 'texto', 'paper_type', 'defeito', 'status_revisao'],
  ['pagina_0001.png', 'A, "B"\ne C', 'A4', 'limpo', 'transcrito'],
  ['pagina_0002.png', '', 'A5', 'branco', 'em_branco']
]);
assert.throws(() => parseCsv('arquivo,texto\na.png,"sem fechamento'), /sem fechamento/);
assert.throws(() => parseCsv('arquivo,texto\na.png,ab"cd'), /aspas em posição inválida/);
assert.throws(() => parseCsv('arquivo,texto\na.png,"valor"extra'), /texto depois do fechamento/);
assert.deepEqual(parseCsv('arquivo,texto\r\n\r\na.png,ok\r\n'), [
  ['arquivo', 'texto'], ['a.png', 'ok']
]);
assert.equal(normalizeReviewStatus('em branco'), 'em_branco');
assert.equal(normalizeReviewStatus('ilegivel'), 'ilegivel');
assert.equal(normalizeReviewStatus('', 'Texto legado'), 'transcrito');
assert.equal(isReviewedStatus('rascunho', 'Texto ainda não confirmado'), false);
assert.equal(isReviewedStatus('em_branco', ''), true);

const pendingFiles = ['a.png', 'b.png', 'c.png'].map((name) => ({ name }));
assert.equal(findNextUnannotated(pendingFiles, new Map([['a.png', 'A']]), 0), 1);
assert.equal(findNextUnannotated(pendingFiles, new Map([['a.png', 'A'], ['b.png', 'B'], ['c.png', 'C']]), 1), -1);
assert.equal(findNextUnannotated([], new Map(), -1), -1);
const extendedFiles = ['a.png', 'b.png', 'c.png', 'd.png', 'e.png'].map((name) => ({ name }));
const reviewStatuses = new Map([
  ['a.png', 'transcrito'], ['b.png', 'em_branco'], ['c.png', 'ilegivel'],
  ['d.png', 'rascunho'], ['e.png', 'pendente']
]);
assert.equal(findNextUnannotated(extendedFiles, new Map(), 0, reviewStatuses), 3,
  'Páginas concluídas em branco/ilegíveis não devem retornar à fila; rascunhos continuam pendentes.');
reviewStatuses.set('d.png', 'transcrito');
assert.equal(findNextUnannotated(extendedFiles, new Map(), 0, reviewStatuses), 4,
  'Depois de confirmar o rascunho, a próxima página pendente deve ser selecionada.');
reviewStatuses.set('e.png', 'em_branco');
assert.equal(findNextUnannotated(extendedFiles, new Map(), 0, reviewStatuses), -1,
  'Toda página marcada como revisada, inclusive em branco, conclui a navegação de pendências.');

const html = fs.readFileSync(path.join(__dirname, 'ocr-reference-annotator.html'), 'utf8');
const ui = fs.readFileSync(path.join(__dirname, 'ocr-reference-annotator.js'), 'utf8');
for (const controlId of ['review-state', 'mark-blank', 'mark-illegible', 'next-empty']) {
  assert.ok(html.includes(`id="${controlId}"`), `Controle de revisão ausente na página: ${controlId}`);
}
assert.match(html, /status_revisao/, 'A interface deve explicar a coluna de estado exportada.');
assert.match(ui, /markBlankButton\.addEventListener\('click'/, 'A ação para marcar página em branco deve estar conectada.');
assert.match(ui, /markIllegibleButton\.addEventListener\('click'/, 'A ação para marcar página ilegível deve estar conectada.');
assert.match(ui, /status_revisao:\s*getReviewStatus\(file\.name\)/, 'O estado separado deve ser exportado junto da referência.');
assert.match(ui, /reviewColumn\s*=\s*findColumn\(/, 'A importação deve restaurar estados de revisão do CSV.');
assert.match(ui, /findNextUnannotated\(imageFiles,\s*transcriptionByName,\s*currentIndex,\s*reviewStatusByName\)/,
  'A navegação da interface deve respeitar estados revisados em branco ou ilegíveis.');
assert.match(ui, /values\.length\s*!==\s*headers\.length/, 'A importação deve rejeitar linhas com colunas desalinhadas.');
assert.match(ui, /new Set\(normalizedHeaders\)\.size !== normalizedHeaders\.length/, 'A importação deve rejeitar cabeçalhos ambíguos.');

class FakeElement {
  constructor(id) {
    this.id = id;
    this.listeners = new Map();
    this.style = {};
    this.value = id === 'zoom' ? '100' : '';
    this.disabled = false;
    this.hidden = false;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) || []) listener(event);
  }

  click() {
    this.dispatch('click');
  }
}

const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, new FakeElement(id)]));
const documentListeners = new Map();
const downloads = [];
const blobs = [];
let blobSequence = 0;
const fakeDocument = {
  getElementById: (id) => elements.get(id) || null,
  addEventListener: (type, listener) => documentListeners.set(type, listener),
  createElement: (tagName) => {
    assert.equal(tagName, 'a');
    const link = new FakeElement('download-link');
    link.click = () => downloads.push(link);
    return link;
  }
};
class FakeBlob {
  constructor(parts, options) {
    this.parts = parts;
    this.options = options;
    blobs.push(this);
  }
}
const fakeUrl = {
  createObjectURL: () => `blob:annotator-test-${++blobSequence}`,
  revokeObjectURL: () => {}
};
vm.runInNewContext(ui, {
  document: fakeDocument,
  URL: fakeUrl,
  Blob: FakeBlob,
  module: { exports: {} },
  setTimeout: () => 0
}, { filename: 'ocr-reference-annotator.js' });

let uiChecks = 0;
function checkEqual(actual, expected, message) {
  uiChecks += 1;
  assert.equal(actual, expected, message);
}
function checkMatch(actual, pattern, message) {
  uiChecks += 1;
  assert.match(actual, pattern, message);
}
const files = ['pagina_1.png', 'pagina_2.png', 'pagina_3.png'].map((name) => ({
  name,
  webkitRelativePath: `corpus/${name}`
}));
elements.get('folder-input').dispatch('change', { target: { files } });
checkEqual(elements.get('file-title').textContent, '1 de 3 — pagina_1.png', 'A primeira imagem deve ser exibida após a seleção da pasta.');
checkEqual(elements.get('stats').textContent, '3 imagens · 0 revisadas · 3 pendentes', 'O resumo inicial deve contar todas as páginas como pendentes.');
elements.get('mark-blank').click();
checkEqual(elements.get('review-state').textContent, 'Revisada: página em branco', 'Marcar em branco deve atualizar o estado exibido.');
checkMatch(elements.get('status').textContent, /sem texto de referência/, 'A página em branco deve permanecer no manifesto sem inventar texto.');
elements.get('next-empty').click();
checkEqual(elements.get('file-title').textContent, '2 de 3 — pagina_2.png', 'Próxima pendente deve pular a página marcada em branco.');
elements.get('mark-illegible').click();
checkEqual(elements.get('review-state').textContent, 'Revisada: texto ilegível', 'Marcar ilegível deve atualizar o estado exibido.');
elements.get('next-empty').click();
checkEqual(elements.get('file-title').textContent, '3 de 3 — pagina_3.png', 'Próxima pendente deve pular páginas em branco e ilegíveis.');
elements.get('transcription').value = 'Referência revisada';
elements.get('transcription').dispatch('input');
checkEqual(elements.get('review-state').textContent, 'Rascunho salvo; confirme com Ctrl+Enter para concluir', 'Digitar deve criar rascunho, não confirmação.');
let prevented = false;
documentListeners.get('keydown')({ ctrlKey: true, key: 'Enter', preventDefault: () => { prevented = true; } });
checkEqual(prevented, true, 'Ctrl+Enter deve ser interceptado para confirmar localmente.');
checkEqual(elements.get('review-state').textContent, 'Transcrição conferida', 'Ctrl+Enter deve confirmar a transcrição.');
checkMatch(elements.get('status').textContent, /Transcrição confirmada/, 'A mensagem deve refletir a confirmação efetiva.');
checkEqual(elements.get('next-empty').disabled, true, 'Ao confirmar a última página pendente, o botão deve desabilitar imediatamente.');
elements.get('export').click();
checkEqual(downloads.length, 1, 'Exportar deve iniciar um download local do CSV.');
checkEqual(downloads[0].download, 'manifesto-referencias-ocr.csv', 'O CSV exportado deve ter nome previsível.');
const exportedCsv = blobs[0].parts.join('');
checkMatch(exportedCsv, /pagina_1\.png,,[^\r\n]*em_branco/, 'A página em branco deve exportar seu estado e texto vazio.');
checkMatch(exportedCsv, /pagina_2\.png,,[^\r\n]*ilegivel/, 'A página ilegível deve exportar seu estado e texto vazio.');
checkMatch(exportedCsv, /pagina_3\.png,Referência revisada,[^\r\n]*transcrito/, 'A referência confirmada deve ser exportada com seu estado.');
elements.get('clear').click();
checkEqual(elements.get('review-state').textContent, 'Ainda não revisada', 'Limpar deve retornar a imagem ao estado pendente.');
checkEqual(elements.get('next-empty').disabled, false, 'Limpar deve reabilitar a navegação de pendências.');
elements.get('zoom').value = '150';
elements.get('zoom').dispatch('input');
checkEqual(elements.get('preview').style.width, '150%', 'Zoom deve atualizar a largura da prévia.');

process.stdout.write(`OCR reference annotator: ${26 + uiChecks} checks passed (${uiChecks} DOM behavior checks; strict CSV, review states, export, zoom, and pending navigation).\n`);
