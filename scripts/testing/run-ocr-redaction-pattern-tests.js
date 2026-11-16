const assert = require('node:assert/strict');
const { createRedactionSearchPattern } = require('../../src/main/services/ocr/ocr-service');

const cases = [
  ['CPF', 'CPF 123.456.789-09', ['123.456.789-09']],
  ['CPF', 'CPF 12345678909 e outro 987.654.321-00', ['12345678909', '987.654.321-00']],
  ['CNPJ', 'CNPJ 22.755.266/0001-87', ['22.755.266/0001-87']],
  ['TELEFONE', 'Contato: (11) 98765-4321', ['(11) 98765-4321']],
  ['EMAIL', 'E-mail: pessoa.teste+doc@exemplo.com.br', ['pessoa.teste+doc@exemplo.com.br']],
  ['DATA', 'Emissão 31/12/2025; revisão 2026-01-09', ['31/12/2025', '2026-01-09']]
];

for (const [preset, text, expected] of cases) {
  const matches = text.match(createRedactionSearchPattern(preset)) || [];
  assert.deepEqual(matches, expected, `O preset ${preset} deve localizar todos os candidatos esperados.`);
}

const customPattern = createRedactionSearchPattern('Revisão + Confidencial');
assert.equal('REVISÃO   + confidencial'.match(customPattern)?.[0], 'REVISÃO   + confidencial', 'A expressão personalizada deve ignorar caixa e tolerar espaços variáveis sem interpretar pontuação como regex.');
assert.equal('Revisão x Confidencial'.match(createRedactionSearchPattern('Revisão + Confidencial')), null, 'A pontuação da expressão personalizada deve ser literal.');
assert.throws(() => createRedactionSearchPattern(''), /Informe um termo/);
assert.throws(() => createRedactionSearchPattern('x'.repeat(121)), /até 120 caracteres/);

console.log(`OCR redaction search pattern regressions passed: ${cases.length} preset cases, custom literal query, and input limits.`);
