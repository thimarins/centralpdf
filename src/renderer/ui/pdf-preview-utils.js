export function normalizeBinaryData(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return new Uint8Array(data);
  if (data?.buffer instanceof ArrayBuffer) {
    return new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength || data.buffer.byteLength);
  }
  return new Uint8Array();
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Reads an image File, downscales it if it exceeds maxDimension, re-encodes
 * as JPEG at the given quality, and resolves the base64 payload (no data:
 * URL prefix).
 */
export function downsampleImageAsBase64(fileObject, maxDimension = 2200, quality = 0.82, errorMessage = 'Não foi possível preparar a imagem.') {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      const image = new Image();
      image.onload = () => {
        let width = image.width;
        let height = image.height;
        if (width > maxDimension || height > maxDimension) {
          if (width > height) {
            height = Math.round((height * maxDimension) / width);
            width = maxDimension;
          } else {
            width = Math.round((width * maxDimension) / height);
            height = maxDimension;
          }
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context) {
          reject(new Error(errorMessage));
          return;
        }
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, width, height);
        context.drawImage(image, 0, 0, width, height);
        const dataUrl = canvas.toDataURL('image/jpeg', quality);
        const commaIndex = dataUrl.indexOf(',');
        resolve(commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl);
      };
      image.onerror = (error) => reject(error);
      image.src = String(event.target?.result || '');
    };
    reader.onerror = (error) => reject(error);
    reader.readAsDataURL(fileObject);
  });
}
