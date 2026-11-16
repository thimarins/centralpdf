export function inferDocumentType(fileName = '') {
  const extension = String(fileName).split('.').pop()?.toLowerCase();
  if (extension === 'pdf') return 'PDF';
  if (extension === 'png') return 'PNG';
  if (extension === 'jpg' || extension === 'jpeg') return 'JPG';
  if (extension === 'docx') return 'DOCX';
  if (extension === 'xlsx') return 'XLSX';
  return extension ? extension.toUpperCase() : 'Arquivo';
}

export function formatDocumentMeta(formatBytes, { name = '', size, pages, type } = {}) {
  const parts = [type || inferDocumentType(name)];
  if (Number.isFinite(Number(size)) && Number(size) >= 0) {
    parts.push(formatBytes(Number(size)));
  }
  if (Number.isFinite(Number(pages)) && Number(pages) > 0) {
    const pageCount = Number(pages);
    parts.push(`${pageCount} ${pageCount === 1 ? 'página' : 'páginas'}`);
  }
  return parts.join(' • ');
}
