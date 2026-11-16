const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeHeading, prepareHeadings, suggestSplitStarts } = require('../../src/main/services/ocr/split-start-suggestions');

function page(pageNumber, lines) {
  return { pageNumber, lines: lines.map(([text, yRatio, source]) => ({ text, yRatio, source })) };
}

const split = suggestSplitStarts([
  page(1, [['ACME CORPORATION', 0.06], ['Invoice 1001', 0.12]]),
  page(2, [['ACME CORPORATION', 0.06], ['Invoice 1001', 0.12]]),
  page(3, [['ACME CORPORATION', 0.06], ['SERVICE ORDER 2026', 0.12, 'OCR']]),
  page(4, [['ACME CORPORATION', 0.06], ['SERVICE ORDER 2026', 0.12, 'OCR']]),
  page(5, [['ACME CORPORATION', 0.06], ['One-off appendix', 0.12]])
], { totalPages: 5 });
assert.deepEqual(split.suggestions.map(({ pageNumber }) => pageNumber), [3]);
assert.equal(split.suggestions[0].heading, 'SERVICE ORDER 2026');
assert.equal(split.suggestions[0].source, 'OCR');
assert.equal(split.suggestions[0].frequency, 0.4);

const commonHeaderOnly = suggestSplitStarts([
  page(1, [['Acme Corporation', 0.05]]),
  page(2, [['ACME CORPORATION', 0.05]]),
  page(3, [['Acme Corporation', 0.05]])
], { totalPages: 3 });
assert.equal(commonHeaderOnly.suggestions.length, 0, 'Cabeçalho presente em todas as páginas não deve sugerir cortes em série.');

const isolatedHeading = suggestSplitStarts([
  page(1, [['Documento inicial', 0.05]]),
  page(2, [['Anexo exclusivo', 0.05]]),
  page(3, [['Conclusão exclusiva', 0.05]])
], { totalPages: 3 });
assert.equal(isolatedHeading.suggestions.length, 0, 'Título que aparece uma vez não deve ser tratado como recorrente.');

assert.equal(normalizeHeading('  Fatura Nº 42 — São Paulo  '), 'fatura nº 42 sao paulo');
assert.deepEqual(prepareHeadings(page(1, [
  ['Título válido de seção', 0.12],
  ['Texto fora da área de título', 0.6],
  ['Página 3 de 10', 0.08],
  ['Título válido de seção', 0.2]
])).map(({ text }) => text), ['Título válido de seção']);

const capped = suggestSplitStarts([
  page(1, [['Formulário Alpha', 0.1]]),
  page(2, [['Formulário Alpha', 0.1]]),
  page(3, [['Formulário Beta', 0.1]]),
  page(4, [['Formulário Beta', 0.1]]),
  page(5, [['Formulário Gamma', 0.1]]),
  page(6, [['Formulário Gamma', 0.1]])
], { totalPages: 6, maxSuggestions: 1 });
assert.equal(capped.suggestions.length, 1);
assert.equal(capped.truncated, true);
assert.equal(capped.suggestions[0].pageNumber, 3);

const html = fs.readFileSync(path.join(__dirname, '../../src/renderer/index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(__dirname, '../../src/renderer/app.js'), 'utf8');
assert.match(html, /id="btn-split-content-suggest"[^>]*>Sugerir por títulos/);
assert.match(renderer, /bindClick\("btn-split-content-suggest",\s*\(\)\s*=>\s*analyzeSplitContent\(\{\s*suggestSplitStarts:\s*true\s*\}\)\)/);
assert.match(renderer, /checkbox\.checked\s*=\s*!suggestSplitStarts/);
assert.match(renderer, /btn-split-content-cancel/);

console.log('Split title suggestion checks passed: repeated headings, common-header suppression, OCR label, one-off suppression, bounds, result cap, UI wiring, unchecked review and cancellation control.');
