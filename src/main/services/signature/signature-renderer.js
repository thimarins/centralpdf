const fs = require('fs');
const path = require('path');
const { rgb, degrees, StandardFonts } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const { inspectImageFile } = require('../../utils');
const { SIGNATURE_FONT_MAP } = require('./field-manager');
const { normalizeQuarterTurn } = require('../../image-processing');

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
        } catch {
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

function mapVisualFieldToPage(page, field) {
  const pageWidth = page.getWidth();
  const pageHeight = page.getHeight();
  const pageRotation = normalizeQuarterTurn(page.getRotation()?.angle || 0);
  const visual = {
    x: field.xRatio,
    y: field.yRatio,
    width: field.widthRatio,
    height: field.heightRatio
  };
  let raw = visual;

  if (pageRotation === 90) {
    raw = {
      x: visual.y,
      y: 1 - (visual.x + visual.width),
      width: visual.height,
      height: visual.width
    };
  } else if (pageRotation === 180) {
    raw = {
      x: 1 - (visual.x + visual.width),
      y: 1 - (visual.y + visual.height),
      width: visual.width,
      height: visual.height
    };
  } else if (pageRotation === 270) {
    raw = {
      x: 1 - (visual.y + visual.height),
      y: visual.x,
      width: visual.height,
      height: visual.width
    };
  }

  const boxWidth = pageWidth * raw.width;
  const boxHeight = pageHeight * raw.height;
  return {
    x: pageWidth * raw.x,
    y: pageHeight - (pageHeight * raw.y) - boxHeight,
    width: boxWidth,
    height: boxHeight,
    pageRotation
  };
}

function resolveCenteredOrigin(box, drawWidth, drawHeight, rotation) {
  const angle = (rotation * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  return {
    x: centerX - (drawWidth / 2) * cos + (drawHeight / 2) * sin,
    y: centerY - (drawWidth / 2) * sin - (drawHeight / 2) * cos
  };
}

function drawTextField(page, font, field) {
  const box = mapVisualFieldToPage(page, field);
  const fontSize = computeTextFontSize(font, field.value, box.width, box.height);
  const color = toRgb(field.color);
  const textWidth = font.widthOfTextAtSize(field.value || ' ', fontSize);
  const rotation = (Number(field.rotation) || 0) - box.pageRotation;
  const origin = resolveCenteredOrigin(box, textWidth, fontSize, rotation);

  page.drawText(field.value, {
    x: origin.x,
    y: origin.y,
    size: fontSize,
    font,
    color,
    opacity: field.opacity / 100,
    rotate: degrees(rotation),
    lineHeight: fontSize * 1.1
  });
}

function drawImageField(page, image, field) {
  const box = mapVisualFieldToPage(page, field);
  const rotation = (Number(field.rotation) || 0) - box.pageRotation;
  const origin = resolveCenteredOrigin(box, box.width, box.height, rotation);

  page.drawImage(image, {
    x: origin.x,
    y: origin.y,
    width: box.width,
    height: box.height,
    opacity: field.opacity / 100,
    rotate: degrees(rotation)
  });
}

module.exports = {
  embedFont,
  embedSealImage,
  embedDrawnSignature,
  drawTextField,
  drawImageField
};
