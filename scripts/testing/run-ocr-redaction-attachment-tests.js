const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createCanvas } = require('@napi-rs/canvas');
const { PDFDocument, PDFName, PDFString, rgb } = require('pdf-lib');
const { redactPdf } = require('../../src/main/pdf-service');
const { createPdfWorkerExecution } = require('../../src/main/worker-runtime');
const { extractStructuredText } = require('../../src/main/services/conversion/text-extractor');
const { createTempDir } = require('./_common');

async function runRedactionAttachmentTest() {
  const workspace = createTempDir('ocr-redaction-attachment');
  try {
    const sourcePdf = await PDFDocument.create();
    const page = sourcePdf.addPage([600, 150]);
    const scanCanvas = createCanvas(1200, 300);
    const scanContext = scanCanvas.getContext('2d');
    scanContext.fillStyle = '#fff';
    scanContext.fillRect(0, 0, 1200, 300);
    scanContext.fillStyle = '#111';
    scanContext.font = '64px Arial';
    scanContext.fillText('CPF: 123.456.789-09', 50, 150);
    const scanImage = await sourcePdf.embedPng(scanCanvas.toBuffer('image/png'));
    page.drawImage(scanImage, { x: 0, y: 0, width: 600, height: 150 });
    page.drawText('CPF: 123.456.789-09', { x: 12, y: 8, size: 8, color: rgb(1, 1, 1) });
    const preservedPage = sourcePdf.addPage([600, 150]);
    for (let line = 0; line < 5; line += 1) {
      preservedPage.drawText('CONTEUDO NATIVO DA PAGINA PRESERVADO SEM ALTERACOES', {
        x: 30, y: 120 - line * 22, size: 9
      });
    }
    sourcePdf.setTitle('Documento reservado CPF 123.456.789-09');
    sourcePdf.setAuthor('Titular 123.456.789-09');
    sourcePdf.setSubject('Assunto reservado 123.456.789-09');
    sourcePdf.setKeywords(['CPF 123.456.789-09', 'confidencial']);
    sourcePdf.setCreator('Central PDF - 123.456.789-09');
    sourcePdf.setProducer('Produtor - 123.456.789-09');
    const outlinesRef = sourcePdf.context.nextRef();
    const outlineItemRef = sourcePdf.context.nextRef();
    sourcePdf.context.assign(outlineItemRef, sourcePdf.context.obj({
      Title: PDFString.of('CPF 123.456.789-09'),
      Parent: outlinesRef,
      Dest: sourcePdf.context.obj([page.ref, PDFName.of('XYZ'), null, null, null])
    }));
    sourcePdf.context.assign(outlinesRef, sourcePdf.context.obj({
      Type: PDFName.of('Outlines'), First: outlineItemRef, Last: outlineItemRef, Count: 1
    }));
    sourcePdf.catalog.set(PDFName.of('Outlines'), outlinesRef);
    await sourcePdf.attach(Buffer.from('CONTEUDO SINTETICO 123.456.789-09'), 'registro-reservado.txt', {
      mimeType: 'text/plain', description: 'Fixture de regressão, sem dado real'
    });
    const formField = sourcePdf.getForm().createTextField('dados.cpf');
    formField.setText('123.456.789-09');
    formField.addToPage(page, { x: 20, y: 20, width: 180, height: 24 });
    const sourcePath = path.join(workspace, 'origem-com-anexo.pdf');
    fs.writeFileSync(sourcePath, await sourcePdf.save());
    const originalHash = crypto.createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex');
    const qpdfPath = path.resolve(__dirname, '..', '..', 'vendor', 'qpdf', 'bin', 'qpdf.exe');
    const listAttachments = (pdfPath) => execFileSync(qpdfPath, ['--list-attachments', pdfPath], {
      cwd: path.resolve(__dirname, '..', '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
    });
    const sourceAttachmentsBeforeOcr = listAttachments(sourcePath);
    assert.match(sourceAttachmentsBeforeOcr, /registro-reservado\.txt/i,
      `O fixture deve conter o anexo antes da busca OCR. qpdf devolveu ${JSON.stringify(sourceAttachmentsBeforeOcr)}.`);

    const search = await createPdfWorkerExecution({
      type: 'ocr-search-document', files: [sourcePath],
      options: { query: '123.456.789-09', language: 'por+eng' }, outputDir: workspace
    }, () => {}).promise;
    assert.ok(search.matches.length > 0, 'A busca OCR de preparação não encontrou o texto sintético do fixture.');
    const redactionCandidates = await createPdfWorkerExecution({
      type: 'redact-ocr-search', files: [sourcePath],
      options: { query: 'CPF', language: 'por+eng' }, outputDir: workspace
    }, () => {}).promise;
    assert.ok(redactionCandidates.candidates.length > 0, 'A busca de candidatos não encontrou o rótulo sintético CPF.');
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex'), originalHash,
      'As buscas OCR não podem alterar os bytes da origem antes da ocultação.');
    const sourceAttachmentsAfterOcr = listAttachments(sourcePath);
    assert.match(sourceAttachmentsAfterOcr, /registro-reservado\.txt/i,
      `A busca OCR não pode alterar/remover anexos da origem. qpdf devolveu ${JSON.stringify(sourceAttachmentsAfterOcr)}.`);

    const stampCanvas = createCanvas(600, 150);
    const stampContext = stampCanvas.getContext('2d');
    stampContext.fillStyle = '#000';
    stampContext.fillRect(0, 0, 600, 150);
    const stampPath = path.join(workspace, 'pagina-ocultada.png');
    fs.writeFileSync(stampPath, stampCanvas.toBuffer('image/png'));

    const outputPath = path.join(workspace, 'saida-ocultada.pdf');
    await redactPdf(sourcePath, outputPath, {
      outputName: 'saida-ocultada.pdf',
      redactedPages: [{ pageIndex: 0, imagePath: stampPath }]
    });

    const sourceList = listAttachments(sourcePath);
    const redactedList = listAttachments(outputPath);
    assert.match(sourceList, /registro-reservado\.txt/i,
      `O fixture deve ter anexo; qpdf devolveu ${JSON.stringify(sourceList)}.`);
    assert.match(redactedList, /no embedded files/i,
      `A saída ocultada não pode reter anexos; qpdf devolveu ${JSON.stringify(redactedList)}.`);
    const redactedPdf = await PDFDocument.load(fs.readFileSync(outputPath));
    assert.equal(redactedPdf.getPageCount(), 2, 'A ocultação removeu a página que não continha a tarja.');
    const redactedText = await extractStructuredText(outputPath);
    assert.match(redactedText.pages[1].text, /CONTEUDO NATIVO DA PAGINA PRESERVADO/,
      'A camada textual da página não ocultada não foi preservada.');
    assert.equal(redactedPdf.getForm().getFields().length, 0, 'O formulário sintético não foi removido da saída ocultada.');
    assert.equal(redactedPdf.catalog.get(PDFName.of('Outlines')), undefined, 'Os marcadores potencialmente sensíveis permaneceram na saída.');
    assert.doesNotMatch([
      redactedPdf.getTitle(), redactedPdf.getAuthor(), redactedPdf.getSubject(), redactedPdf.getKeywords(),
      redactedPdf.getCreator(), redactedPdf.getProducer()
    ].filter(Boolean).join(' '), /123\s*456\s*789\s*09/, 'Metadados do fixture permaneceram na saída ocultada.');
    console.log(`qpdf redaction attachment test passed: origem=[${sourceList.trim()}], saída=[${redactedList.trim()}].`);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

runRedactionAttachmentTest().catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
