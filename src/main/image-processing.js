const AUTO_IMAGE_MAX_DIMENSION = 2200;
const AUTO_JPEG_QUALITY = 82;

function normalizeQuarterTurn(value) {
  const normalized = ((Number(value) || 0) % 360 + 360) % 360;
  return [0, 90, 180, 270].includes(normalized) ? normalized : 0;
}

module.exports = {
  AUTO_IMAGE_MAX_DIMENSION,
  AUTO_JPEG_QUALITY,
  normalizeQuarterTurn
};
