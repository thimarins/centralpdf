const EMPTY_FILE_HINTS = ['pdf file is empty', 'file is empty', 'size is zero'];
const PROTECTED_FILE_HINTS = ['password', 'encrypted', 'protected'];
const INVALID_FILE_HINTS = ['invalid pdf', 'bad pdf', 'corrupt', 'malformed'];
const MISSING_FILE_HINTS = ['missing', 'not found', 'does not exist'];
const ACCESS_DENIED_HINTS = ['permission', 'access denied'];

export function normalizeOrganizeLoadReason(error) {
  const message = String(error?.message || error || '').trim().toLowerCase();
  const code = String(error?.code || '').toUpperCase();

  if (EMPTY_FILE_HINTS.some((hint) => message.includes(hint))) {
    return 'o PDF está vazio (tamanho zero)';
  }
  if (PROTECTED_FILE_HINTS.some((hint) => message.includes(hint))) {
    return 'o PDF está protegido por senha';
  }
  if (INVALID_FILE_HINTS.some((hint) => message.includes(hint))) {
    return 'o PDF está inválido ou corrompido';
  }
  if (MISSING_FILE_HINTS.some((hint) => message.includes(hint)) || code === 'ENOENT') {
    return 'o arquivo não existe mais ou não está acessível';
  }
  if (ACCESS_DENIED_HINTS.some((hint) => message.includes(hint)) || ['EACCES', 'EPERM'].includes(code)) {
    return 'o arquivo não pode ser lido por falta de permissão';
  }
  if (['ENOSPC', 'EDQUOT'].includes(code)) {
    return 'não há espaço suficiente no disco para preparar o arquivo';
  }
  if (code === 'EBUSY') {
    return 'o arquivo está em uso por outro programa; feche-o e tente novamente';
  }
  if (code === 'EIO') {
    return 'houve uma falha ao ler o arquivo; verifique a unidade e tente novamente';
  }

  return 'não foi possível ler o arquivo; confira se está íntegro, acessível e não está protegido por senha';
}
