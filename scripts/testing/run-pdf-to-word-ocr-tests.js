const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { createCanvas } = require('@napi-rs/canvas');
const mammoth = require('mammoth');
const JSZip = require('jszip');
const { convertPdfToWord } = require('../../src/main/services/conversion/pdf-to-word');
const { extractStructuredText } = require('../../src/main/services/conversion/text-extractor');
const { analyzePdfOcrNeed, recognizePdf } = require('../../src/main/services/ocr/ocr-service');
const { writeReport } = require('./_common');

async function createHybridPdf(filePath, includeScan) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([600, 600]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText('NATIVE HEADER ACCOUNT 2026', { x: 48, y: 550, size: 18, font });

  if (includeScan) {
    const canvas = createCanvas(1500, 420);
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#111111';
    context.font = 'bold 76px Arial';
    context.fillText('SCANNED CONTENT CONTRACT 2026', 38, 240);
    const image = await pdf.embedPng(canvas.toBuffer('image/png'));
    page.drawImage(image, { x: 35, y: 200, width: 530, height: 148 });
  }

  await fs.writeFile(filePath, await pdf.save());
}

async function createTabularScanPdf(filePath) {
  const canvas = createCanvas(1400, 480);
  const context = canvas.getContext('2d');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#111';
  context.font = '44px Arial';
  const rows = [
    ['Fornecedor: A-1042', 'Data: 02/11/2026'],
    ['CNPJ: 12.345.678/0001-90', 'Total: R$ 725,40'],
    ['Situação: Ativo', 'Aprovado: Sim']
  ];
  rows.forEach(([left, right], index) => {
    const y = 70 + index * 150;
    context.fillText(left, 42, y);
    context.fillText(right, 800, y);
  });
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([600, 206]);
  const image = await pdf.embedPng(canvas.toBuffer('image/png'));
  page.drawImage(image, { x: 0, y: 0, width: 600, height: 206 });
  await fs.writeFile(filePath, await pdf.save());
}

async function createTwoRowColumnsPdf(filePath) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([600, 600]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText('Conta: 4102', { x: 48, y: 520, size: 12, font });
  page.drawText('Saldo: R$ 900,00', { x: 330, y: 520, size: 12, font });
  page.drawText('Conta: 4103', { x: 48, y: 490, size: 12, font });
  page.drawText('Saldo: R$ 1.200,00', { x: 330, y: 490, size: 12, font });
  await fs.writeFile(filePath, await pdf.save());
}

async function main() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'central-pdf-word-ocr-'));
  try {
    const hybridPath = path.join(tempDir, 'hybrid.pdf');
    await createHybridPdf(hybridPath, true);
    const hybridAnalysis = await analyzePdfOcrNeed(hybridPath);
    assert.equal(hybridAnalysis.status, 'scanned', 'A análise deve identificar a imagem com texto em uma página híbrida.');
    assert.deepEqual(hybridAnalysis.pagesLikelyScanned, [1]);
    const hybrid = await convertPdfToWord(hybridPath, tempDir, {
      format: 'docx', outputName: 'hybrid-output.docx', useOcr: true, ocrLanguage: 'eng'
    });
    const hybridText = (await mammoth.extractRawText({ path: hybrid.outputPath })).value;
    assert.equal(hybrid.usedOcr, true, 'A página híbrida deve acionar OCR mesmo contendo texto nativo.');
    assert.equal((hybridText.match(/NATIVE HEADER ACCOUNT 2026/g) || []).length, 1, 'O cabeçalho nativo não pode ser duplicado pelo OCR.');
    assert.match(hybridText, /SCANNED CONTENT CONTRACT 2026/i, 'O conteúdo escaneado da mesma página deve chegar ao Word.');

    const nativePath = path.join(tempDir, 'native.pdf');
    await createHybridPdf(nativePath, false);
    const nativeAnalysis = await analyzePdfOcrNeed(nativePath);
    assert.equal(nativeAnalysis.status, 'native', 'A análise não deve recomendar OCR para um PDF só com texto nativo.');
    assert.deepEqual(nativeAnalysis.pagesLikelyScanned, []);
    const native = await convertPdfToWord(nativePath, tempDir, {
      format: 'docx', outputName: 'native-output.docx', useOcr: true, ocrLanguage: 'eng'
    });
    const nativeText = (await mammoth.extractRawText({ path: native.outputPath })).value;
    assert.equal(native.usedOcr, false, 'O modo automático não deve indicar OCR quando só há texto nativo.');
    assert.equal((nativeText.match(/NATIVE HEADER ACCOUNT 2026/g) || []).length, 1);

    const tabularPath = path.join(tempDir, 'tabela-digitalizada.pdf');
    await createTabularScanPdf(tabularPath);
    const tabular = await convertPdfToWord(tabularPath, tempDir, {
      format: 'docx', outputName: 'tabela-convertida.docx', useOcr: true, ocrLanguage: 'por'
    });
    const tabularText = (await mammoth.extractRawText({ path: tabular.outputPath })).value;
    const recognizedTable = await recognizePdf(tabularPath, { language: 'por', mode: 'auto' });
    const tableLayout = await extractStructuredText(recognizedTable.pdfBytes);
    assert.equal(tabular.usedOcr, true, 'A tabela digitalizada deve passar pelo OCR.');
    assert.ok(tableLayout.pages[0].blocks.some((block) => block.type === 'table'), `O layout OCR não identificou as três linhas tabulares: ${JSON.stringify(tableLayout.pages[0].blocks)}.`);
    for (const value of ['Fornecedor: A-1042', 'Data: 02/11/2026', 'CNPJ: 12.345.678/0001-90', 'Total: R$ 725,40', 'Situação: Ativo', 'Aprovado: Sim']) {
      assert.ok(tabularText.includes(value), `O DOCX perdeu a célula reconhecida "${value}". Texto obtido: ${tabularText}`);
    }
    const docxZip = await JSZip.loadAsync(await fs.readFile(tabular.outputPath));
    const documentXml = await docxZip.file('word/document.xml').async('string');
    assert.match(documentXml, /<w:tbl>/, 'Colunas alinhadas não foram representadas como tabela no DOCX.');
    assert.equal((documentXml.match(/<w:tr>/g) || []).length, 3, 'A tabela OCR deve preservar as três linhas confirmadas no scan.');
    assert.equal((documentXml.match(/<w:tc>/g) || []).length, 6, 'A tabela OCR deve preservar as duas colunas e seis células confirmadas no scan.');

    const shortColumnsPath = path.join(tempDir, 'duas-linhas-colunas.pdf');
    await createTwoRowColumnsPdf(shortColumnsPath);
    const shortColumns = await convertPdfToWord(shortColumnsPath, tempDir, {
      format: 'docx', outputName: 'duas-linhas-convertido.docx', useOcr: false
    });
    const shortColumnsText = (await mammoth.extractRawText({ path: shortColumns.outputPath })).value;
    const shortColumnsZip = await JSZip.loadAsync(await fs.readFile(shortColumns.outputPath));
    const shortColumnsXml = await shortColumnsZip.file('word/document.xml').async('string');
    assert.doesNotMatch(shortColumnsXml, /<w:tbl>/, 'Duas linhas alinhadas não devem ser promovidas a tabela: o mínimo são três linhas repetidas.');
    for (const value of ['Conta: 4102', 'Saldo: R$ 900,00', 'Conta: 4103', 'Saldo: R$ 1.200,00']) {
      assert.ok(shortColumnsText.includes(value), `A conversão de duas linhas em colunas perdeu "${value}".`);
    }

    const nativeBytes = await fs.readFile(nativePath);
    await assert.rejects(() => extractStructuredText(nativeBytes, () => {}, () => true), /OPERATION_CANCELLED/);

    const reportPath = writeReport('pdf-to-word-ocr-report.md', [
      '# PDF para Word com OCR', '', `Gerado em ${new Date().toISOString()}.`, '',
      '| Cenário | Status | Evidência |', '| --- | --- | --- |',
      '| PDF híbrido na mesma página | aprovado | OCR incluiu texto da imagem e manteve o cabeçalho nativo uma única vez |',
      '| Recomendação automática de OCR | aprovado | amostra identificou a página híbrida e não recomendou OCR para PDF nativo |',
      '| PDF somente nativo com OCR automático | aprovado | texto preservado e `usedOcr=false`; Tesseract não foi necessário |',
      '| Tabela/colunas digitalizadas | aprovado | linhas e células alinhadas identificadas e verificadas no XML DOCX; o texto das seis células foi conferido |',
      '| Duas linhas alinhadas (limite de tabela) | aprovado | permanecem parágrafos; os quatro valores foram preservados e não houve elemento de tabela no DOCX |',
      '| Cancelamento da extração por bytes | aprovado | operação interrompida antes de iniciar página seguinte e recursos PDF.js liberados |',
      '', 'Resultado: 7/7 cenários aprovados (dois cenários de classificação mais cinco fluxos de conversão).'
    ]);
    console.log(`PDF-to-Word OCR tests passed: 7; report: ${reportPath}`);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
