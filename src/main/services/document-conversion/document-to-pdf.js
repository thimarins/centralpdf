const fs = require('fs');
const path = require('path');
const { BrowserWindow } = require('electron');
const mammoth = require('mammoth');
const XLSX = require('xlsx');

const DOCUMENT_EXTENSIONS = new Set(['.docx', '.xlsx']);

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getDocumentExtension(filePath) {
  return path.extname(String(filePath || '')).toLowerCase();
}

function assertSupportedDocument(filePath) {
  const extension = getDocumentExtension(filePath);
  if (!DOCUMENT_EXTENSIONS.has(extension)) {
    throw new Error(`Formato não suportado para conversão: ${extension || 'desconhecido'}.`);
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`Arquivo não encontrado: ${path.basename(filePath)}.`);
  }
  return extension;
}

async function buildDocxHtml(filePath) {
  const result = await mammoth.convertToHtml({
    path: filePath,
    convertImage: mammoth.images.imgElement((image) => image.read('base64').then((base64) => ({
      src: `data:${image.contentType};base64,${base64}`
    })))
  });

  const warnings = result.messages?.map((message) => message.message).filter(Boolean) || [];
  return {
    title: path.basename(filePath),
    body: result.value,
    warnings
  };
}

async function buildXlsxHtml(filePath) {
  const workbook = XLSX.readFile(filePath, { cellStyles: true, cellDates: true });
  const sheets = workbook.SheetNames.map((sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    return `<section class="sheet"><h2>${escapeHtml(sheetName)}</h2>${XLSX.utils.sheet_to_html(sheet, {
      id: `sheet-${escapeHtml(sheetName)}`,
      editable: false
    })}</section>`;
  }).join('');

  return {
    title: path.basename(filePath),
    body: sheets,
    warnings: []
  };
}

function buildPrintableHtml({ title, body }) {
  return `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8">
    <title>${escapeHtml(title)}</title>
    <style>
      @page { size: A4; margin: 14mm; }
      * { box-sizing: border-box; }
      body { margin: 0; color: #1f2937; font-family: Arial, "Segoe UI", sans-serif; font-size: 10pt; line-height: 1.4; }
      h1 { margin: 0 0 16px; font-size: 18pt; color: #111827; }
      h2 { margin: 18px 0 8px; font-size: 13pt; color: #374151; page-break-after: avoid; }
      p { margin: 0 0 8px; }
      img { max-width: 100%; height: auto; }
      table { width: 100%; border-collapse: collapse; margin: 0 0 16px; font-size: 8.5pt; page-break-inside: auto; }
      tr { page-break-inside: avoid; page-break-after: auto; }
      th, td { border: 1px solid #9ca3af; padding: 5px 6px; vertical-align: top; text-align: left; }
      th { background: #e5e7eb; font-weight: 700; }
      .sheet { page-break-before: always; }
      .sheet:first-child { page-break-before: auto; }
      .sheet > table { margin-bottom: 0; }
      ul, ol { margin-top: 4px; }
    </style>
  </head>
  <body>
    <h1>${escapeHtml(title)}</h1>
    ${body}
  </body>
</html>`;
}

async function convertDocumentToPdf(filePath, outputPath) {
  const extension = assertSupportedDocument(filePath);
  const documentData = extension === '.docx'
    ? await buildDocxHtml(filePath)
    : await buildXlsxHtml(filePath);
  const html = buildPrintableHtml(documentData);
  const window = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true }
  });

  try {
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    const pdfBuffer = await window.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      margins: { marginType: 'default' }
    });
    await fs.promises.writeFile(outputPath, pdfBuffer);
    return { outputPath, warnings: documentData.warnings };
  } finally {
    if (!window.isDestroyed()) window.destroy();
  }
}

module.exports = {
  DOCUMENT_EXTENSIONS,
  convertDocumentToPdf,
  getDocumentExtension
};
