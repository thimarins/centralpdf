const { Document, Packer, Paragraph, TextRun } = require('docx');

const WORD_FONT_FAMILY = 'Calibri';
const WORD_BODY_SIZE = 22;
const WORD_HEADING_SIZE = 26;

function buildRun(text, options = {}) {
  return new TextRun({
    text,
    font: WORD_FONT_FAMILY,
    size: options.size || WORD_BODY_SIZE,
    bold: options.bold || false,
    italics: options.italics || false,
    color: options.color || '111111'
  });
}

function classifyLine(line = '') {
  const trimmed = String(line).trim();
  if (!trimmed) return { type: 'empty', value: '' };
  if (/^[-*]\s+/.test(trimmed) || /^\d+[.)]\s+/.test(trimmed)) return { type: 'list', value: trimmed };
  if (trimmed.length <= 60 && trimmed === trimmed.toUpperCase()) return { type: 'heading', value: trimmed };
  return { type: 'paragraph', value: trimmed };
}

function buildParagraphsFromPages(pages = []) {
  const children = [];
  pages.forEach((page, pageIndex) => {
    page.lines.forEach((line) => {
      const classified = classifyLine(line);
      if (classified.type === 'empty') {
        children.push(new Paragraph({ text: '' }));
      } else if (classified.type === 'heading') {
        children.push(new Paragraph({
          children: [buildRun(classified.value, { bold: true, size: WORD_HEADING_SIZE })],
          spacing: { after: 120 }
        }));
      } else if (classified.type === 'list') {
        children.push(new Paragraph({
          children: [buildRun(classified.value)],
          bullet: { level: 0 },
          spacing: { after: 80 }
        }));
      } else {
        children.push(new Paragraph({
          children: [buildRun(classified.value)],
          spacing: { after: 80 }
        }));
      }
    });

    if (pageIndex < pages.length - 1) {
      children.push(new Paragraph({ text: '', pageBreakBefore: true }));
    }
  });
  return children;
}

async function buildDocxBuffer(extractionResult, sourceName) {
  const doc = new Document({
    creator: 'Central PDF',
    title: sourceName,
    description: 'Conversão operacional de PDF textual para Word sem OCR.',
    styles: {
      default: {
        document: {
          run: {
            font: WORD_FONT_FAMILY,
            size: WORD_BODY_SIZE,
            color: '111111'
          },
          paragraph: {
            spacing: {
              after: 80
            }
          }
        }
      }
    },
    sections: [{ children: buildParagraphsFromPages(extractionResult.pages || []) }]
  });
  return Packer.toBuffer(doc);
}

module.exports = {
  buildDocxBuffer,
  WORD_FONT_FAMILY
};

