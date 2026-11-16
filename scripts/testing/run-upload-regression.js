const fs = require('fs');
const path = require('path');
const { ROOT, assert, toMarkdownTable, writeReport } = require('./_common');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function runUploadRegression() {
  const app = read('src/renderer/app.js');
  const main = read('src/main/index.js');
  const organize = read('src/renderer/ui/organize/organize-workspace.js');
  const imagePdf = read('src/renderer/ui/image-to-pdf/image-to-pdf-workspace.js');
  const watermark = read('src/renderer/ui/watermark/watermark-workspace.js');
  const checks = [];
  const check = (name, ok, details) => {
    checks.push({ name, ok: Boolean(ok), details });
    assert.ok(ok, `${name}: ${details}`);
  };

  const dropzones = [
    'images-pdf-dropzone', 'signature-dropzone', 'pdf-to-word-dropzone',
    'merge-dropzone', 'split-dropzone', 'organize-dropzone',
    'watermark-dropzone', 'compress-dropzone', 'protect-dropzone',
    'unlock-dropzone', 'redact-dropzone', 'ocr-dropzone'
  ];
  check('Todos os dropzones estão registrados', dropzones.every((id) => app.includes(`id: "${id}"`)), `${dropzones.length} entradas verificadas`);

  const singlePreflights = [
    ['signature-dropzone', 'single-pdf'],
    ['pdf-to-word-dropzone', 'single-pdf'],
    ['split-dropzone', 'single-pdf'],
    ['compress-dropzone', 'single-pdf'],
    ['protect-dropzone', 'single-pdf'],
    ['unlock-dropzone', 'single-pdf-unlock'],
    ['redact-dropzone', 'single-pdf-or-image']
  ];
  singlePreflights.forEach(([dropzone, type]) => {
    check(`${dropzone} valida antes do handler`, app.includes(`id: "${dropzone}"`) && app.includes(`preflightType: "${type}"`), `tipo ${type}`);
  });

  check('Validação individual é global', app.includes('async function preflightSingleFile') && app.includes('await preflightSingleFile(selectedFiles[0], preflightType)'), 'input e drag-and-drop usam a mesma rotina');
  check('Upload individual mantém a identidade do módulo após pré-validação', /async function processDropzoneSelection\(\{\s*id,\s*handler,\s*filter,\s*preflightType\s*\}/.test(app), 'a rotina usa o id do dropzone para abrir a aba correspondente sem variável indefinida');
  check('Arquivos incompatíveis geram aviso', app.includes('const rejectedFiles') && app.includes('Arquivos não compatíveis'), 'seleções filtradas não desaparecem silenciosamente');
  check('Arquivos individuais válidos geram sucesso', app.includes('title: "Arquivo adicionado"') && app.includes('foi verificado e está pronto'), 'sucesso aparece antes da abertura do módulo');
  check('Atalhos rápidos usam pré-validação', app.includes('getSingleFilePreflightType(action)') && app.includes('preflightSingleFile(file, preflightType)'), 'Dashboard e launch request não pulam a validação');

  check('Mesclar valida no upload', app.includes('type: "merge"') && app.includes('validationStatus') && app.includes('Arquivos adicionados com atenção'), 'status por arquivo e toast de resultado presentes');
  check('Converter para PDF valida no upload', imagePdf.includes('type: "files-to-pdf"') && imagePdf.includes('Arquivos adicionados com atenção'), 'imagens e documentos têm retorno após o lote');
  check('Arquivos recentes de Converter para PDF limitam formatos suportados',
    /"images-to-pdf": \["\.jpg", "\.jpeg", "\.png", "\.docx", "\.xlsx"\]/.test(app) &&
      app.includes('if (!accepts.some((extension) => fileName.toLowerCase().endsWith(extension))) continue;') &&
      app.includes('if (!accepts.some((extension) => fileName.toLowerCase().endsWith(extension))) {'),
    'a lista, ação individual e ação de lote só encaminham JPG, JPEG, PNG, DOCX e XLSX');
  check('Marca d’água valida no upload', watermark.includes('type: "watermark"') && watermark.includes('Arquivos adicionados com atenção'), 'lote não espera o botão Aplicar');
  check('OCR valida no upload', app.includes('id: "ocr-dropzone"') && app.includes('type: \'ocr\'') && app.includes('Reconhecimento enviado'), 'PDFs e imagens são verificados antes da fila');
  check('OCR seletor e arrastar/soltar compartilham o fluxo', /input\.addEventListener\("change", async \(event\) => \{[\s\S]*?processDropzoneSelection\(\{ id, handler, filter, preflightType \}, event\.target\.files\)/.test(app) && /dropzone\.addEventListener\("drop", \(event\) => \{[\s\S]*?processDropzoneSelection\(\{ id, handler, filter, preflightType \}, event\.dataTransfer\.files\)/.test(app), 'ambos os caminhos usam o mesmo filtro, normalização e handler OCR');
  check('Organizar informa lote e falhas agrupadas', organize.includes('formatBatchSummary') && organize.includes('groupedFailures') && organize.includes('Alguns arquivos não foram adicionados'), 'fluxo próprio já informa sucesso e falhas');
  check('Organizar impede estado antigo sobrescrever o novo', organize.includes('organizeLoadToken') && organize.includes('loadToken !== organizeLoadToken'), 'carregamentos concorrentes são invalidados');
  check('Organizar inicializa com arquivo válido remanescente', organize.includes('if (state.organizePages.length === 0') && organize.includes('await handleOrganizeFile(candidate)'), 'falha do primeiro item não deixa o dropzone preso');

  const preflightTypes = ['merge', 'watermark', 'files-to-pdf', 'ocr', 'single-pdf', 'single-pdf-or-image', 'single-pdf-unlock'];
  check('Processo principal conhece todos os tipos de pré-validação', preflightTypes.every((type) => main.includes(`'${type}'`)), `${preflightTypes.length} contratos IPC validados`);
  check('Pré-validação limita concorrência', /while \(validationConcurrency < 8[\s\S]*?const chunk = uniqueFiles\.slice\(start, start \+ validationConcurrency\)[\s\S]*?Promise\.all\(chunk\.map/.test(main), 'máximo de 8 arquivos verificados simultaneamente por bloco; TIFF OCR permanece serializado');
  check('Desbloqueio aceita PDF protegido', main.includes("!['unlock', 'single-pdf-unlock'].includes(type)"), 'proteção é válida como entrada desse módulo');

  const reportPath = writeReport('upload-regression.md', [
    '# Upload Regression Suite',
    '',
    `Gerado em ${new Date().toISOString()}.`,
    '',
    ...toMarkdownTable(['Verificação', 'Status', 'Detalhes'], checks.map((item) => [item.name, item.ok ? 'ok' : 'erro', item.details]))
  ]);
  return { ok: checks.every((item) => item.ok), checks, reportPath };
}

if (require.main === module) {
  try {
    const summary = runUploadRegression();
    console.log(`Upload regression tests passed: ${summary.checks.length}`);
  } catch (error) {
    console.error(error.stack || String(error));
    process.exit(1);
  }
}

module.exports = { runUploadRegression };
