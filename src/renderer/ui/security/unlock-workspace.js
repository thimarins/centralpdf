export function createUnlockWorkspaceController(deps) {
  const {
    state,
    document,
    notify,
    showValidationMessage,
    formatBytes
  } = deps;

  function getFormValues() {
    return {
      password: document.getElementById("unlock-password")?.value || "",
      outputName: document.getElementById("unlock-output-name")?.value.trim() || ""
    };
  }

  function getPendingMessage() {
    const values = getFormValues();
    const hasMeaningfulOutputChange = values.outputName && values.outputName !== "desbloqueado.pdf";
    if (state.unlockFile || values.password || hasMeaningfulOutputChange) {
      return "Há um arquivo ou configurações de desbloqueio pendentes. Se sairmos agora, essas alterações serão perdidas.";
    }
    return "";
  }

  function renderState() {
    const container = document.getElementById("unlock-settings-container");
    const dropzone = document.getElementById("unlock-dropzone");
    const nameEl = document.getElementById("unlock-file-name");
    const metaEl = document.getElementById("unlock-file-meta");
    const outputInput = document.getElementById("unlock-output-name");

    const hasFile = !!state.unlockFile;
    if (container) container.classList.toggle("hidden", !hasFile);
    if (dropzone) dropzone.classList.toggle("hidden", hasFile);

    if (hasFile) {
      if (nameEl) nameEl.textContent = state.unlockFile.name;
      if (metaEl) metaEl.textContent = formatBytes(state.unlockFile.size);
      const cleanName = state.unlockFile.name.replace(/\.pdf$/i, "");
      if (outputInput) outputInput.value = `${cleanName}_desbloqueado.pdf`;
    } else {
      if (nameEl) nameEl.textContent = "";
      if (metaEl) metaEl.textContent = "";
      if (outputInput) outputInput.value = "desbloqueado.pdf";
    }
  }

  function clearWorkspace() {
    state.unlockFile = null;
    const passwordField = document.getElementById("unlock-password");
    if (passwordField) passwordField.value = "";
    renderState();
  }

  function handleUnlockFile(file) {
    if (!file) return;
    state.unlockFile = {
      name: file.name,
      size: file.size,
      path: file.path || "",
      fileObject: file
    };
    renderState();
  }

  function validateBeforeQueue() {
    if (!state.unlockFile) {
      showValidationMessage("Selecione um arquivo PDF.");
      return false;
    }
    const values = getFormValues();
    if (!values.password) {
      showValidationMessage("Informe a senha do PDF para desbloquear.");
      return false;
    }
    if (!values.outputName) {
      showValidationMessage("Informe o nome do arquivo desbloqueado.");
      return false;
    }
    return true;
  }

  function getQueuePayload() {
    const values = getFormValues();
    const resolvedPath = state.unlockFile?.path || state.unlockFile?.fileObject?.path || "";
    return {
      type: "unlock",
      files: [resolvedPath],
      options: {
        password: values.password,
        outputName: values.outputName
      }
    };
  }

  function setup() {
    document.getElementById("btn-unlock-change-file")?.addEventListener("click", () => {
      clearWorkspace();
      document.getElementById("unlock-file-input")?.click();
    });
    document.getElementById("btn-unlock-clear-file")?.addEventListener("click", () => clearWorkspace());
    document.getElementById("btn-unlock-clear-password")?.addEventListener("click", () => {
      const passwordField = document.getElementById("unlock-password");
      if (passwordField) {
        passwordField.value = "";
        passwordField.focus();
      }
    });
    document.getElementById("btn-unlock-copy-password")?.addEventListener("click", async () => {
      const password = document.getElementById("unlock-password")?.value || "";
      if (!password) return;
      try {
        if (window.api?.copyText) {
          await window.api.copyText(password);
        } else {
          await navigator.clipboard.writeText(password);
        }
        notify({ tone: "success", title: "Senha copiada", message: "A senha do PDF foi copiada para a área de transferência." });
      } catch (_) {}
    });
    renderState();
  }

  return {
    setup,
    handleUnlockFile,
    getPendingMessage,
    clearWorkspace,
    validateBeforeQueue,
    getQueuePayload
  };
}
