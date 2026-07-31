const fs = require('fs');
const path = require('path');
const { rgb, degrees, StandardFonts } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const { inspectImageFile } = require('../../utils');
const { SIGNATURE_FONT_MAP } = require('./field-manager');

const PDF_LIB_FONT_MAP = {
  Helvetica: StandardFonts.Helvetica,
  HelveticaBold: StandardFonts.HelveticaBold,
  HelveticaOblique: StandardFonts.HelveticaOblique,
  HelveticaBoldOblique: StandardFonts.HelveticaBoldOblique,
  TimesRoman: StandardFonts.TimesRoman,
  TimesRomanItalic: StandardFonts.TimesRomanItalic,
  Courier: StandardFonts.Courier,
  CourierOblique: StandardFonts.CourierOblique
};

const SYSTEM_FONT_FILES = {
  SegoeScript: ['segoesc.ttf', 'SEGOESC.TTF'],
  SegoePrint: ['segoepr.ttf', 'SEGOEPR.TTF'],
  LucidaHandwriting: ['lhandw.ttf', 'LHANDW.TTF', 'lhandw.TTF'],
  MonotypeCorsiva: ['mtcorsva.ttf', 'MTCORSVA.TTF'],
  BrushScript: ['brushsci.ttf', 'BRUSHSCI.TTF'],
  InkFree: ['inkfree.ttf', 'Inkfree.ttf', 'INKFREE.TTF']
};

function toRgb(colorHex) {
  const safeHex = /^#[0-9a-fA-F]{6}$/.test(String(colorHex || '')) ? colorHex.slice(1) : '000000';
  const value = parseInt(safeHex, 16);
  return rgb(((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255);
}

function resolveFontName(fontFamily) {
  return PDF_LIB_FONT_MAP[SIGNATURE_FONT_MAP[fontFamily] || fontFamily] || StandardFonts.Helvetica;
}

async function embedFont(pdfDoc, fontFamily) {
  const files = SYSTEM_FONT_FILES[fontFamily];
  if (files) {
    const fontsDir = 'C:/Windows/Fonts';
    for (const file of files) {
      const fullPath = path.join(fontsDir, file);
      if (fs.existsSync(fullPath)) {
        try {
          const fontBytes = await fs.promises.readFile(fullPath);
          pdfDoc.registerFontkit(fontkit);
          return await pdfDoc.embedFont(fontBytes);
        } catch (err) {
          // Fail silently and try next file or fall back
        }
      }
    }
  }
  return pdfDoc.embedFont(resolveFontName(fontFamily));
}


async function embedSealImage(pdfDoc, imagePath) {
  const inspection = inspectImageFile(imagePath);
  if (!inspection.ok || !['png', 'jpeg', 'svg'].includes(inspection.kind)) {
    throw new Error(`Selo inválido ou inseguro: ${path.basename(imagePath)}`);
  }

  if (inspection.kind === 'svg') {
    throw new Error('Selo em SVG ainda não é suportado na assinatura simples. Use PNG ou JPG.');
  }

  const bytes = await fs.promises.readFile(imagePath);
  return inspection.kind === 'png' ? pdfDoc.embedPng(bytes) : pdfDoc.embedJpg(bytes);
}

async function embedDrawnSignature(pdfDoc, imageDataUrl) {
  const raw = String(imageDataUrl || '');
  const match = raw.match(/^data:image\/(png|jpeg);base64,(.+)$/i);
  if (!match) {
    throw new Error('A assinatura desenhada está em um formato inválido.');
  }

  const kind = match[1].toLowerCase();
  const bytes = Buffer.from(match[2], 'base64');
  return kind === 'png' ? pdfDoc.embedPng(bytes) : pdfDoc.embedJpg(bytes);
}

function computeTextFontSize(font, text, boxWidth, boxHeight) {
  const safeText = text || ' ';
  let fontSize = Math.max(10, Math.min(52, boxHeight * 0.72));
  for (; fontSize >= 10; fontSize -= 1) {
    const width = font.widthOfTextAtSize(safeText, fontSize);
    if (width <= boxWidth * 0.94) {
      return fontSize;
    }
  }
  return 10;
}

function drawTextField(page, font, field) {
  const pageWidth = page.getWidth();
  const pageHeight = page.getHeight();
  const boxWidth = pageWidth * field.widthRatio;
  const boxHeight = pageHeight * field.heightRatio;
  const x = pageWidth * field.xRatio;
  const topY = pageHeight * field.yRatio;
  const y = pageHeight - topY - boxHeight;
  const fontSize = computeTextFontSize(font, field.value, boxWidth, boxHeight);
  const color = toRgb(field.color);

  page.drawText(field.value, {
    x,
    y: y + (boxHeight - fontSize) / 2,
    size: fontSize,
    font,
    color,
    opacity: field.opacity / 100,
    rotate: degrees(field.rotation || 0),
    lineHeight: fontSize * 1.1
  });
}

function drawImageField(page, image, field) {
  const pageWidth = page.getWidth();
  const pageHeight = page.getHeight();
  const x = pageWidth * field.xRatio;
  const topY = pageHeight * field.yRatio;
  const width = pageWidth * field.widthRatio;
  const height = pageHeight * field.heightRatio;
  const y = pageHeight - topY - height;

  page.drawImage(image, {
    x,
    y,
    width,
    height,
    opacity: field.opacity / 100,
    rotate: degrees(field.rotation || 0)
  });
}

module.exports = {
  embedFont,
  embedSealImage,
  embedDrawnSignature,
  drawTextField,
  drawImageField
};
