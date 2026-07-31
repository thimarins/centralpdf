export function shouldUseOptimizedImageMode(files = []) {
  const totalBytes = files.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
  return files.length >= 24 || totalBytes >= 150 * 1024 * 1024;
}

export function getImagePreviewLimit(files = []) {
  return shouldUseOptimizedImageMode(files) ? 18 : 48;
}

export function createImagePreviewUrl(file) {
  return URL.createObjectURL(file);
}

export function revokeImagePreviewUrl(url) {
  if (!url) return;
  URL.revokeObjectURL(url);
}
