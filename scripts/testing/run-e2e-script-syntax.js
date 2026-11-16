const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const acorn = require('acorn');
const assert = require('node:assert/strict');
const { writeReport } = require('./_common');

const sourcePath = path.resolve(__dirname, '../../src/main/index.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
const declaration = ast.body.find((node) => node.type === 'FunctionDeclaration' && node.id?.name === 'buildRendererE2EScript');

if (!declaration) throw new Error('Não foi encontrada a função que gera o script E2E do renderer.');

const context = { process: { env: {} }, JSON };
vm.runInNewContext(`${source.slice(declaration.start, declaration.end)}; this.buildRendererE2EScript = buildRendererE2EScript;`, context);

const generated = context.buildRendererE2EScript({ manifest: { files: {} }, outputDir: 'C:\\temp\\central-pdf-e2e' });
new vm.Script(generated, { filename: 'renderer-e2e-generated.js' });

const runnerPath = path.resolve(__dirname, 'run-ui-app-e2e.js');
const runnerSource = fs.readFileSync(runnerPath, 'utf8');
const commonPath = path.resolve(__dirname, '_common.js');
const commonSource = fs.readFileSync(commonPath, 'utf8');
assert.match(runnerSource, /mkdtempSync\(path\.join\(os\.tmpdir\(\), 'central-pdf-ui-e2e-assets-'\)\)/,
  'Cada execução E2E deve possuir pasta exclusiva de fixtures.');
assert.match(runnerSource, /CENTRAL_PDF_TEST_ASSETS_DIR\s*=\s*path\.join\(e2eTestAssetsRoot, 'test-assets'\)/,
  'A pasta de fixtures exclusiva deve ser configurada antes de carregar os helpers.');
assert.match(commonSource, /process\.env\.CENTRAL_PDF_TEST_ASSETS_DIR\s*\|\|\s*path\.join\(ROOT, 'test-assets'\)/,
  'Os demais testes devem continuar podendo usar o diretório compartilhado padrão.');
assert.match(runnerSource, /CENTRAL_PDF_E2E_ASSETS_MANIFEST:\s*path\.join\(TEST_ASSETS_DIR, 'manifest\.json'\)/,
  'O renderer E2E deve receber o manifesto da execução isolada.');
assert.match(runnerSource, /process\.exitCode\s*=\s*result\.ok\s*\?\s*0\s*:\s*1/,
  'O runner deve permitir que finally limpe fixtures e processos filhos.');
assert.match(runnerSource, /function waitForChildExit\s*\(/,
  'O runner deve verificar a saída do processo sem aguardar o fechamento de todos os pipes.');
assert.match(runnerSource, /child\.once\('exit', onExit\)/,
  'A validação de saída não deve confundir subprocessos que herdaram stdout/stderr com Electron ativo.');
assert.doesNotMatch(runnerSource, /function waitForChildClose\s*\(/,
  'O runner não deve usar o evento close como prova de que o processo Electron ainda está ativo.');

const reportPath = writeReport('e2e-script-syntax-report.md', [
  '# E2E Renderer Script Syntax',
  '',
  `Gerado em ${new Date().toISOString()}.`,
  '',
  '- OK — a função do processo principal gerou JavaScript válido para executar no renderer.',
  '- OK — manifest, diretório de saída e senha de teste foram interpolados sem invalidar a sintaxe.',
  '- OK — fixtures e manifesto do E2E são isolados por execução; limpeza não é interrompida por process.exit.',
  '- OK — encerramento do Electron usa o evento do processo e evita falso negativo por pipes herdados.',
  '',
  `Resultado: aprovado. (${generated.length} caracteres verificados).`
]);

console.log(`E2E generated-script syntax and isolation: passed; report: ${reportPath}`);
