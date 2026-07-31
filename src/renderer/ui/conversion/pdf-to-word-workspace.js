export function createPdfToWordWorkspaceController(deps) {
  const {
    state,
    document,
    toneIcon,
    clearFeedbackBanner,
    formatBytes
  } = deps;

  function getStatusBanner() {
    return document.getElementById('pdf-to-word-status');
  }

  function syncVisibility() {
    const hasFile = !!state.pdfToWordFile;
    document.getElementById('pdf-to-word-dropzone')?.classList.toggle('hidden', hasFile);
    document.getElementById('pdf-to-word-settings-container')?.classList.toggle('hidden', !hasFile);
  }

  function getFormat() {
    return document.querySelector('input[name="pdf-to-word-format"]:checked').value || 'docx';
  }

  function updateOutputName() {
    if (!state.pdfToWordFile) return;
    const format = getFormat();
    const extension = format === 'text' ? '.txt' : '.docx';
    const outputInput = document.getElementById('pdf-to-word-output-name');
    if (outputInput) {
      outputInput.value = `${state.pdfToWordFile.name.replace(/\.pdf$/i, '')}_convertido${extension}`;
    }
  }

  function handleFile(file) {
    state.pdfToWordFile = {
      name: file.name,
      size: file.size,
      path: file.path || "",
      fileObject: file
    };
    const fileName = document.getElementById('pdf-to-word-file-name');
    const fileMeta = document.getElementById('pdf-to-word-file-meta');
    if (fileName) fileName.textContent = file.name;
    if (fileMeta) fileMeta.textContent = formatBytes(file.size);
    syncVisibility();
    updateOutputName();
  }

  function clearWorkspace() {
    state.pdfToWordFile = null;
    clearFeedbackBanner('pdf-to-word');
    clearStatus();
    syncVisibility();
  }

  function clearStatus() {
    const banner = getStatusBanner();
    if (!banner) return;
    banner.classList.add('hidden');
    banner.innerHTML = '';
  }

  function showStatus({ tone = 'info', title = '', message = '' } = {}) {
    const banner = getStatusBanner();
    if (!banner) return;
    banner.className = 'inline-optimized-hint pdf-to-word-status';
    banner.dataset.tone = tone;
    banner.innerHTML = `
      <span aria-hidden="true">${toneIcon(tone, 18)}</span>
      <div>
        <strong>${title}</strong>
        <span>${message}</span>
      </div>
    `;
    banner.classList.remove('hidden');
  }

  function getPendingMessage() {
    if (state.pdfToWordFile) {
      return 'Há um PDF carregado em PDF para Word. Se sairmos agora, essa preparação será perdida.';
    }
    return '';
  }

  function getQueuePayload() {
    const resolvedPath = state.pdfToWordFile.path || state.pdfToWordFile.fileObject.path || '';
    return {
      type: 'pdf-to-word',
      files: [resolvedPath],
      options: {
        format: getFormat(),
        outputName: document.getElementById('pdf-to-word-output-name').value.trim()
      }
    };
  }

  function setup() {
    document.getElementById('btn-pdf-to-word-change-file')?.addEventListener('click', clearWorkspace);
    document.querySelectorAll('input[name="pdf-to-word-format"]').forEach((radio) => {
      radio.addEventListener('change', updateOutputName);
    });
  }

  return {
    setup,
    handleFile,
    clearWorkspace,
    getPendingMessage,
    getQueuePayload,
    showStatus,
    clearStatus
  };
}
