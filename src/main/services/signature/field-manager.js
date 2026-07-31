const path = require('path');

const SIGNATURE_FIELD_TYPES = new Set(['signature', 'drawn', 'initials', 'date', 'text', 'seal']);
const SIGNATURE_FONT_MAP = {
  SegoeScript: 'HelveticaOblique',
  LucidaHandwriting: 'HelveticaOblique',
  MonotypeCorsiva: 'TimesRomanItalic',
  SegoePrint: 'HelveticaOblique',
  BrushScript: 'HelveticaBoldOblique',
  CorporateSans: 'Helvetica',
  CorporateSerif: 'TimesRoman',
  Monospace: 'Courier'
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeField(rawField = {}, index = 0) {
  if (!rawField || typeof rawField !== 'object') {
    throw new Error(`Campo de assinatura inválido na posição ${index + 1}.`);
  }

  const type = String(rawField.type || '').trim();
  if (!SIGNATURE_FIELD_TYPES.has(type)) {
    throw new Error(`Tipo de campo de assinatura inválido: ${type || 'desconhecido'}.`);
  }

  const pageIndex = Number(rawField.pageIndex);
  if (!Number.isInteger(pageIndex) || pageIndex < 0) {
    throw new Error('Página do campo de assinatura inválida.');
  }

  const normalized = {
    id: String(rawField.id || `signature_field_${index + 1}`),
    type,
    pageIndex,
    xRatio: clamp(Number(rawField.xRatio) || 0.1, 0, 0.95),
    yRatio: clamp(Number(rawField.yRatio) || 0.1, 0, 0.95),
    widthRatio: clamp(Number(rawField.widthRatio) || (type === 'seal' ? 0.22 : 0.28), 0.05, 0.92),
    heightRatio: clamp(Number(rawField.heightRatio) || (type === 'seal' ? 0.12 : 0.08), 0.03, 0.5),
    rotation: clamp(Number(rawField.rotation) || 0, -180, 180),
    opacity: clamp(Number(rawField.opacity) || 100, 10, 100),
    color: /^#[0-9a-fA-F]{6}$/.test(String(rawField.color || '')) ? String(rawField.color) : '#000000',
    value: String(rawField.value || '').trim(),
    label: String(rawField.label || '').trim(),
    fontFamily: String(rawField.fontFamily || 'SegoeScript'),
    imagePath: rawField.imagePath ? path.resolve(String(rawField.imagePath)) : '',
    imageDataUrl: String(rawField.imageDataUrl || '').trim()
  };

  if (!['seal', 'drawn'].includes(type) && normalized.value.length === 0) {
    throw new Error(`O campo ${index + 1} precisa de um conteúdo textual.`);
  }

  if (type === 'seal' && normalized.imagePath.length === 0 && normalized.imageDataUrl.length === 0) {
    throw new Error('O selo da empresa precisa de uma imagem válida.');
  }

  if (type === 'drawn' && normalized.imageDataUrl.length === 0) {
    throw new Error('A assinatura desenhada precisa de um desenho válido.');
  }

  return normalized;
}

function normalizeSignatureOptions(options = {}) {
  const fields = Array.isArray(options.fields) ? options.fields.map(normalizeField) : [];
  if (fields.length === 0) {
    throw new Error('Adicione pelo menos um campo de assinatura antes de aplicar.');
  }

  return {
    outputName: String(options.outputName || 'assinado.pdf').trim() || 'assinado.pdf',
    fields,
    outputSuffix: String(options.outputSuffix || '_assinado').trim() || '_assinado'
  };
}

module.exports = {
  SIGNATURE_FIELD_TYPES,
  SIGNATURE_FONT_MAP,
  normalizeSignatureOptions,
  normalizeField
};
