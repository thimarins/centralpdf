'use strict';

/* global document */

function parseCsv(text) {
  const records = [];
  let row = [];
  let field = '';
  let quoted = false;
  let quoteClosed = false;
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted && character === '"') {
      if (source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = false;
        quoteClosed = true;
      }
      continue;
    }
    if (!quoted && character === '"') {
      if (field.length || quoteClosed) throw new Error('O CSV contém aspas em posição inválida.');
      quoted = true;
      continue;
    }
    if (!quoted && quoteClosed && character !== ',' && character !== '\n' && character !== '\r') {
      throw new Error('O CSV contém texto depois do fechamento de aspas.');
    }
    if (character === ',' && !quoted) {
      row.push(field);
      field = '';
      quoteClosed = false;
    } else if ((character === '\n' || character === '\r') && !quoted) {
      row.push(field);
      field = '';
      if (row.some((item) => item.length > 0)) records.push(row);
      row = [];
      quoteClosed = false;
      if (character === '\r' && source[index + 1] === '\n') index += 1;
    } else field += character;
  }
  if (quoted) throw new Error('O CSV termina com um campo entre aspas sem fechamento.');
  if (row.length || field.length) {
    row.push(field);
    if (row.some((item) => item.length > 0)) records.push(row);
  }
  return records;
}

const REVIEW_STATUSES = new Set(['pendente', 'rascunho', 'transcrito', 'em_branco', 'ilegivel']);
const COMPLETED_REVIEW_STATUSES = new Set(['transcrito', 'em_branco', 'ilegivel']);

function normalizeReviewStatus(value, transcription = '') {
  const normalized = String(value || '').trim().toLocaleLowerCase('pt-BR').replace(/[\s-]+/g, '_');
  if (REVIEW_STATUSES.has(normalized)) return normalized;
  return String(transcription || '').trim() ? 'transcrito' : 'pendente';
}

function isReviewedStatus(value, transcription = '') {
  return COMPLETED_REVIEW_STATUSES.has(normalizeReviewStatus(value, transcription));
}

function serializeCsv(records, headers = ['arquivo', 'texto', 'paper_type', 'defeito', 'status_revisao']) {
  const quote = (value) => {
    const text = String(value ?? '');
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [headers, ...records.map((record) => headers.map((header) => record[header] ?? ''))]
    .map((row) => row.map(quote).join(','))
    .join('\r\n') + '\r\n';
}

function findNextUnannotated(files, transcriptions, currentIndex, reviewStatuses = new Map()) {
  if (!files.length) return -1;
  for (let offset = 1; offset <= files.length; offset += 1) {
    const index = (currentIndex + offset + files.length) % files.length;
    const name = files[index].name;
    const status = reviewStatuses.has(name) ? reviewStatuses.get(name) : undefined;
    const transcription = transcriptions.get(name) || '';
    if (!isReviewedStatus(status, transcription)) return index;
  }
  return -1;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseCsv, serializeCsv, normalizeReviewStatus, isReviewedStatus, findNextUnannotated };
}

if (typeof document !== 'undefined') {
  const byId = (id) => document.getElementById(id);
  const folderInput = byId('folder-input');
  const manifestInput = byId('manifest-input');
  const preview = byId('preview');
  const title = byId('file-title');
  const metadata = byId('metadata');
  const transcription = byId('transcription');
  const reviewState = byId('review-state');
  const stats = byId('stats');
  const status = byId('status');
  const previous = byId('previous');
  const next = byId('next');
  const nextEmpty = byId('next-empty');
  const exportButton = byId('export');
  const clearButton = byId('clear');
  const markBlankButton = byId('mark-blank');
  const markIllegibleButton = byId('mark-illegible');
  const zoom = byId('zoom');
  const zoomLabel = byId('zoom-label');
  const imageExtensions = /\.(png|jpe?g|webp)$/i;
  let imageFiles = [];
  let metadataByName = new Map();
  let transcriptionByName = new Map();
  let reviewStatusByName = new Map();
  let currentIndex = -1;
  let activeUrl = null;
  let activeFolderKey = null;

  function updateStats() {
    const completed = imageFiles.filter((file) => isReviewedStatus(
      reviewStatusByName.get(file.name), transcriptionByName.get(file.name)
    )).length;
    stats.textContent = imageFiles.length
      ? `${imageFiles.length} imagens · ${completed} revisadas · ${imageFiles.length - completed} pendentes`
      : 'Nenhuma imagem carregada';
  }

  function getReviewStatus(fileName) {
    const status = reviewStatusByName.get(fileName);
    if (REVIEW_STATUSES.has(status)) return status;
    return normalizeReviewStatus('', transcriptionByName.get(fileName));
  }

  function updateReviewControls(fileName) {
    const hasFile = Boolean(fileName);
    for (const button of [markBlankButton, markIllegibleButton, clearButton]) {
      if (button) button.disabled = !hasFile;
    }
    if (!reviewState) return;
    const labels = {
      pendente: 'Ainda não revisada',
      rascunho: 'Rascunho salvo; confirme com Ctrl+Enter para concluir',
      transcrito: 'Transcrição conferida',
      em_branco: 'Revisada: página em branco',
      ilegivel: 'Revisada: texto ilegível'
    };
    reviewState.textContent = hasFile ? labels[getReviewStatus(fileName)] : '';
  }

  function renderCurrent() {
    const file = imageFiles[currentIndex];
    const hasFiles = Boolean(file);
    for (const button of [previous, next, nextEmpty, exportButton]) button.disabled = !imageFiles.length;
    transcription.disabled = !hasFiles;
    zoom.disabled = !hasFiles;
    if (!hasFiles) {
      if (activeUrl) URL.revokeObjectURL(activeUrl);
      activeUrl = null;
      preview.hidden = true;
      title.textContent = 'Selecione uma pasta para começar';
      metadata.textContent = '';
      transcription.value = '';
      updateReviewControls('');
      updateStats();
      return;
    }
    if (activeUrl) URL.revokeObjectURL(activeUrl);
    activeUrl = URL.createObjectURL(file);
    preview.src = activeUrl;
    preview.alt = `Prévia de ${file.name}`;
    preview.hidden = false;
    title.textContent = `${currentIndex + 1} de ${imageFiles.length} — ${file.name}`;
    const details = metadataByName.get(file.name) || {};
    metadata.textContent = [details.paper_type && `Formato: ${details.paper_type}`, details.defeito && `Condição: ${details.defeito}`]
      .filter(Boolean).join(' · ');
    transcription.value = transcriptionByName.get(file.name) || '';
    updateReviewControls(file.name);
    previous.disabled = currentIndex <= 0;
    next.disabled = currentIndex >= imageFiles.length - 1;
    nextEmpty.disabled = !imageFiles.some((item) => !isReviewedStatus(reviewStatusByName.get(item.name), transcriptionByName.get(item.name)));
    status.textContent = '';
    updateStats();
  }

  function loadImages(fileList) {
    const files = [...fileList].filter((file) => imageExtensions.test(file.name));
    const duplicateNames = files.map((file) => file.name.toLocaleLowerCase('pt-BR'))
      .filter((name, index, all) => all.indexOf(name) !== index);
    if (duplicateNames.length) {
      status.textContent = 'Há imagens com nomes repetidos em subpastas. Selecione uma pasta sem nomes duplicados para manter o CSV compatível.';
      return;
    }
    const folderKey = files[0]?.webkitRelativePath?.split(/[\\/]/)[0] || null;
    if (activeFolderKey && folderKey && activeFolderKey !== folderKey) {
      metadataByName = new Map();
      transcriptionByName = new Map();
      reviewStatusByName = new Map();
    }
    if (folderKey) activeFolderKey = folderKey;
    imageFiles = files.sort((left, right) => left.name.localeCompare(right.name, 'pt-BR', { numeric: true }));
    currentIndex = imageFiles.length ? 0 : -1;
    const warning = files.length !== fileList.length
      ? 'Alguns itens não são imagens PNG, JPG, JPEG ou WEBP e foram ignorados. Converta TIFFs para um desses formatos em uma cópia do corpus.'
      : '';
    renderCurrent();
    if (warning) status.textContent = warning;
  }

  async function loadManifest(file) {
    if (!file) return;
    try {
      const parsed = parseCsv(await file.text());
      const headers = (parsed.shift() || []).map((value) => value.trim());
      const fileColumn = headers.find((value) => /^(arquivo|file|filename|nome_arquivo)$/i.test(value));
      if (!fileColumn) throw new Error('O CSV precisa ter uma coluna `arquivo`.');
      if (headers.some((header) => !header)) throw new Error('O cabeçalho do CSV contém uma coluna sem nome.');
      const normalizedHeaders = headers.map((header) => header.toLocaleLowerCase('pt-BR'));
      if (new Set(normalizedHeaders).size !== normalizedHeaders.length) throw new Error('O cabeçalho do CSV contém nomes de coluna repetidos.');
      const findColumn = (pattern) => headers.find((header) => pattern.test(header));
      const textColumn = findColumn(/^(texto|transcricao|transcrição|ground.?truth|referencia|referência)$/i);
      const paperColumn = findColumn(/^(paper_type|formato|tipo_papel)$/i);
      const defectColumn = findColumn(/^(defeito|condicao|condição|quality)$/i);
      const reviewColumn = findColumn(/^(status_revisao|status|revisao|revisão)$/i);
      const nextMetadata = new Map();
      const nextText = new Map(transcriptionByName);
      const nextReviewStatuses = new Map(reviewStatusByName);
      for (const values of parsed) {
        if (values.length !== headers.length) throw new Error('O CSV tem uma linha com quantidade de colunas diferente do cabeçalho.');
        const row = Object.fromEntries(headers.map((header, index) => [header, values[index] || '']));
        const name = String(row[fileColumn] || '').trim().split(/[\\/]/).pop();
        if (!name || name !== row[fileColumn].trim()) throw new Error('O CSV contém caminho de arquivo; use apenas o nome do arquivo na coluna `arquivo`.');
        if (nextMetadata.has(name)) throw new Error(`O CSV contém mais de uma linha para ${name}.`);
        nextMetadata.set(name, {
          paper_type: paperColumn ? row[paperColumn] : '',
          defeito: defectColumn ? row[defectColumn] : ''
        });
        const importedText = textColumn ? row[textColumn] || '' : '';
        if (textColumn && (importedText.trim() || !nextText.has(name))) nextText.set(name, importedText);
        if (reviewColumn && row[reviewColumn]?.trim()) {
          const importedStatus = row[reviewColumn].trim().toLocaleLowerCase('pt-BR').replace(/[\s-]+/g, '_');
          if (!REVIEW_STATUSES.has(importedStatus)) throw new Error(`Status de revisão inválido na linha de ${name}. Use pendente, rascunho, transcrito, em_branco ou ilegivel.`);
          nextReviewStatuses.set(name, importedStatus);
          if (importedStatus === 'em_branco' || importedStatus === 'ilegivel') nextText.set(name, '');
        } else if (importedText.trim()) {
          nextReviewStatuses.set(name, 'transcrito');
        } else if (!nextReviewStatuses.has(name) && !String(nextText.get(name) || '').trim()) {
          nextReviewStatuses.set(name, 'pendente');
        }
      }
      metadataByName = nextMetadata;
      transcriptionByName = nextText;
      reviewStatusByName = nextReviewStatuses;
      if (imageFiles.length) renderCurrent();
      status.textContent = `${parsed.length} linhas importadas do manifesto. Transcrições existentes foram preservadas na memória.`;
    } catch (error) {
      status.textContent = error?.message || 'Não foi possível ler esse CSV.';
    }
  }

  function goTo(index) {
    if (index < 0 || index >= imageFiles.length) return;
    currentIndex = index;
    renderCurrent();
  }

  folderInput.addEventListener('change', (event) => loadImages(event.target.files || []));
  manifestInput.addEventListener('change', (event) => loadManifest(event.target.files?.[0]));
  transcription.addEventListener('input', () => {
    const file = imageFiles[currentIndex];
    if (!file) return;
    transcriptionByName.set(file.name, transcription.value);
    reviewStatusByName.set(file.name, transcription.value.trim() ? 'rascunho' : 'pendente');
    updateReviewControls(file.name);
    updateStats();
    nextEmpty.disabled = !imageFiles.some((item) => !isReviewedStatus(reviewStatusByName.get(item.name), transcriptionByName.get(item.name)));
  });
  previous.addEventListener('click', () => goTo(currentIndex - 1));
  next.addEventListener('click', () => goTo(currentIndex + 1));
  nextEmpty.addEventListener('click', () => {
    const index = findNextUnannotated(imageFiles, transcriptionByName, currentIndex, reviewStatusByName);
    if (index >= 0) goTo(index);
    else status.textContent = 'Todas as imagens já foram revisadas.';
  });
  clearButton.addEventListener('click', () => {
    const file = imageFiles[currentIndex];
    if (!file) return;
    transcriptionByName.set(file.name, '');
    reviewStatusByName.set(file.name, 'pendente');
    transcription.value = '';
    updateReviewControls(file.name);
    updateStats();
    nextEmpty.disabled = !imageFiles.some((item) => !isReviewedStatus(reviewStatusByName.get(item.name), transcriptionByName.get(item.name)));
    status.textContent = 'Revisão removida; esta imagem voltou para a lista de pendências.';
  });
  markBlankButton.addEventListener('click', () => markReviewedWithoutText('em_branco', 'Página marcada como em branco.'));
  markIllegibleButton.addEventListener('click', () => markReviewedWithoutText('ilegivel', 'Página marcada como ilegível.'));

  function markReviewedWithoutText(reviewStatus, message) {
    const file = imageFiles[currentIndex];
    if (!file) return;
    transcriptionByName.set(file.name, '');
    reviewStatusByName.set(file.name, reviewStatus);
    transcription.value = '';
    updateReviewControls(file.name);
    updateStats();
    nextEmpty.disabled = !imageFiles.some((item) => !isReviewedStatus(reviewStatusByName.get(item.name), transcriptionByName.get(item.name)));
    status.textContent = `${message} A imagem continuará disponível no CSV, sem texto de referência.`;
  }
  zoom.addEventListener('input', () => {
    preview.style.width = `${zoom.value}%`;
    preview.style.maxWidth = 'none';
    preview.style.maxHeight = 'none';
    zoomLabel.textContent = `${zoom.value}%`;
  });
  exportButton.addEventListener('click', () => {
    if (!imageFiles.length) return;
    const rows = imageFiles.map((file) => ({
      arquivo: file.name,
      texto: transcriptionByName.get(file.name) || '',
      paper_type: metadataByName.get(file.name)?.paper_type || '',
      defeito: metadataByName.get(file.name)?.defeito || '',
      status_revisao: getReviewStatus(file.name)
    }));
    const blob = new Blob(['\uFEFF', serializeCsv(rows)], { type: 'text/csv;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'manifesto-referencias-ocr.csv';
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    status.textContent = `CSV exportado com ${rows.filter((row) => row.texto.trim()).length} transcrições. Guarde-o em local autorizado; ele contém texto de referência.`;
  });
  zoom.addEventListener('change', () => {
    if (Number(zoom.value) === 100) {
      preview.style.width = '';
      preview.style.maxWidth = '100%';
      preview.style.maxHeight = '100%';
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.altKey && event.key === 'ArrowLeft') { event.preventDefault(); goTo(currentIndex - 1); }
    if (event.altKey && event.key === 'ArrowRight') { event.preventDefault(); goTo(currentIndex + 1); }
    if (event.ctrlKey && event.key === 'Enter' && imageFiles[currentIndex]) {
      event.preventDefault();
      transcriptionByName.set(imageFiles[currentIndex].name, transcription.value);
      reviewStatusByName.set(imageFiles[currentIndex].name, transcription.value.trim() ? 'transcrito' : 'pendente');
      updateReviewControls(imageFiles[currentIndex].name);
      const hasTranscription = transcription.value.trim().length > 0;
      status.textContent = hasTranscription
        ? 'Transcrição confirmada e mantida na memória desta aba.'
        : 'A transcrição está vazia; esta imagem continua pendente.';
      updateStats();
      nextEmpty.disabled = !imageFiles.some((file) => !isReviewedStatus(
        reviewStatusByName.get(file.name), transcriptionByName.get(file.name)
      ));
    }
  });
}
