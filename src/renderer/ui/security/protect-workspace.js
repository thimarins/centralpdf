export function createProtectWorkspaceController(deps) {
  const {
    state,
    document,
    formatBytes,
    showValidationMessage
  } = deps;

  function getFormValues() {
    return {
      password: document.getElementById("protect-password")?.value || "",
      ownerPassword: "",
      algorithm: document.getElementById("protect-algorithm")?.value || "AES-256",
      allowPrinting: document.getElementById("protect-perm-print")?.checked ?? true,
      allowCopying: document.getElementById("protect-perm-copy")?.checked ?? true,
      allowModifying: document.getElementById("protect-perm-modify")?.checked ?? true,
      allowExtraction: document.getElementById("protect-perm-extract")?.checked ?? true,
      allowAnnotating: document.getElementById("protect-perm-annotate")?.checked ?? true,
      allowFillingForms: document.getElementById("protect-perm-fill")?.checked ?? true,
      allowAssembly: document.getElementById("protect-perm-assembly")?.checked ?? true,
      allowHighQualityPrint: document.getElementById("protect-perm-print-high")?.checked ?? true
    };
  }

  function updatePasswordStrength(value) {
    const strengthContainer = document.getElementById("protect-password-strength-container");
    const strengthLabel = document.getElementById("protect-password-strength-label");
    const bar1 = document.getElementById("protect-password-strength-bar-1");
    const bar2 = document.getElementById("protect-password-strength-bar-2");
    const bar3 = document.getElementById("protect-password-strength-bar-3");

    if (!value) {
      if (strengthContainer) strengthContainer.style.display = "none";
      [bar1, bar2, bar3].forEach((bar) => {
        if (bar) bar.style.backgroundColor = "transparent";
      });
      if (strengthLabel) {
        strengthLabel.textContent = "Fraca";
        strengthLabel.style.color = "#d9534f";
      }
      return;
    }

    if (strengthContainer) strengthContainer.style.display = "block";

    let score = 0;
    if (value.length >= 6) score += 1;
    if (value.length >= 10) score += 1;
    if (/[A-Z]/.test(value) && /[a-z]/.test(value)) score += 1;
    if (/[0-9]/.test(value)) score += 1;
    if (/[^A-Za-z0-9]/.test(value)) score += 1;

    [bar1, bar2, bar3].forEach((bar) => {
      if (bar) bar.style.backgroundColor = "transparent";
    });

    if (score <= 2) {
      if (strengthLabel) {
        strengthLabel.textContent = "Fraca";
        strengthLabel.style.color = "#d9534f";
      }
      if (bar1) bar1.style.backgroundColor = "#d9534f";
      return;
    }

    if (score <= 4) {
      if (strengthLabel) {
        strengthLabel.textContent = "Média";
        strengthLabel.style.color = "#f0ad4e";
      }
      if (bar1) bar1.style.backgroundColor = "#f0ad4e";
      if (bar2) bar2.style.backgroundColor = "#f0ad4e";
      return;
    }

    if (strengthLabel) {
      strengthLabel.textContent = "Forte";
      strengthLabel.style.color = "#5cb85c";
    }
    if (bar1) bar1.style.backgroundColor = "#5cb85c";
    if (bar2) bar2.style.backgroundColor = "#5cb85c";
    if (bar3) bar3.style.backgroundColor = "#5cb85c";
  }

  function generateRandomPassword(length = 16) {
    const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%&*+?";
    const cryptoApi = globalThis.crypto;

    if (cryptoApi?.getRandomValues) {
      const values = new Uint32Array(length);
      cryptoApi.getRandomValues(values);
      return Array.from(values, (value) => chars[value % chars.length]).join("");
    }

    let password = "";
    for (let index = 0; index < length; index += 1) {
      password += chars[Math.floor(Math.random() * chars.length)];
    }
    return password;
  }

  function getPendingMessage() {
    const values = getFormValues();
    const hasActiveFile = !!state.protectFile;
    const isDirty = values.password !== ""
      || values.algorithm !== "AES-256"
      || !values.allowPrinting
      || !values.allowCopying
      || !values.allowModifying
      || !values.allowExtraction
      || !values.allowAnnotating
      || !values.allowFillingForms
      || !values.allowAssembly
      || !values.allowHighQualityPrint;

    if (hasActiveFile || isDirty) {
      return "Há um arquivo ou configurações de proteção pendentes. Se sairmos agora, essas alterações serão perdidas.";
    }
    return "";
  }

  function getQueuePayload() {
    const values = getFormValues();
    const outputName = document.getElementById("protect-output-name").value.trim();
    const resolvedPath = state.protectFile?.path || state.protectFile?.fileObject?.path || "";

    return {
      type: "protect",
      files: [resolvedPath],
      options: {
        password: values.password,
        ownerPassword: values.ownerPassword || values.password,
        algorithm: values.algorithm,
        allowPrinting: values.allowPrinting,
        allowCopying: values.allowCopying,
        allowModifying: values.allowModifying,
        allowExtraction: values.allowExtraction,
        allowAnnotating: values.allowAnnotating,
        allowFillingForms: values.allowFillingForms,
        allowAssembly: values.allowAssembly,
        allowHighQualityPrint: values.allowHighQualityPrint,
        outputName
      }
    };
  }

  function handleProtectFile(file) {
    state.protectFile = {
      name: file.name,
      size: file.size,
      path: file.path || "",
      fileObject: file
    };
    renderState();
  }

  function renderState() {
    const container = document.getElementById("protect-settings-container");
    const dropzone = document.getElementById("protect-dropzone");
    const nameEl = document.getElementById("protect-file-name");
    const metaEl = document.getElementById("protect-file-meta");
    const outputInput = document.getElementById("protect-output-name");

    const hasFile = !!state.protectFile;
    container?.classList.toggle("hidden", !hasFile);
    dropzone?.classList.toggle("hidden", hasFile);

    if (hasFile) {
      if (nameEl) nameEl.textContent = state.protectFile.name;
      if (metaEl) metaEl.textContent = formatBytes(state.protectFile.size);
      const cleanName = state.protectFile.name.replace(/\.pdf$/i, "");
      if (outputInput) outputInput.value = `${cleanName}_protegido.pdf`;
    } else {
      if (nameEl) nameEl.textContent = "";
      if (metaEl) metaEl.textContent = "";
      if (outputInput) outputInput.value = "protegido.pdf";
    }
  }

  function clearWorkspace() {
    state.protectFile = null;
    const passwordField = document.getElementById("protect-password");
    const algorithmField = document.getElementById("protect-algorithm");
    const permissions = [
      "protect-perm-print",
      "protect-perm-copy",
      "protect-perm-modify",
      "protect-perm-extract",
      "protect-perm-annotate",
      "protect-perm-fill",
      "protect-perm-assembly",
      "protect-perm-print-high"
    ];
    if (passwordField) passwordField.value = "";
    if (algorithmField) algorithmField.value = "AES-256";
    permissions.forEach((id) => {
      const checkbox = document.getElementById(id);
      if (checkbox) checkbox.checked = true;
    });
    updatePasswordStrength("");
    renderState();
  }

  function validateBeforeQueue() {
    if (!state.protectFile) {
      showValidationMessage("Selecione um arquivo PDF.");
      return false;
    }
    const values = getFormValues();
    if (!values.password) {
      showValidationMessage("Informe uma senha para proteger o PDF.");
      return false;
    }
    const outputName = document.getElementById("protect-output-name").value.trim();
    if (!outputName) {
      showValidationMessage("Informe o nome do arquivo protegido.");
      return false;
    }
    return true;
  }

  function setup() {
    document.getElementById("btn-protect-change-file")?.addEventListener("click", () => {
      clearWorkspace();
      document.getElementById("protect-file-input")?.click();
    });
    document.getElementById("btn-protect-clear-file")?.addEventListener("click", clearWorkspace);

    const pwField = document.getElementById("protect-password");
    pwField?.addEventListener("input", () => {
      updatePasswordStrength(pwField.value);
    });

    document.getElementById("btn-protect-generate-password")?.addEventListener("click", () => {
      const password = generateRandomPassword();
      if (!pwField) return;
      pwField.value = password;
      updatePasswordStrength(password);
      pwField.dispatchEvent(new Event("input", { bubbles: true }));
      pwField.focus();
    });

    document.getElementById("btn-protect-copy-password")?.addEventListener("click", async () => {
      if (!pwField?.value) return;

      try {
        if (window.api?.copyText) {
          await window.api.copyText(pwField.value);
        } else {
          await navigator.clipboard.writeText(pwField.value);
        }
        const btn = document.getElementById("btn-protect-copy-password");
        if (!btn) return;
        const oldSvg = btn.innerHTML;
        btn.innerHTML = "<svg width=\"18\" height=\"18\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#4f9a57\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><polyline points=\"20 6 9 17 4 12\"></polyline></svg>";
        setTimeout(() => {
          btn.innerHTML = oldSvg;
        }, 1500);
      } catch (error) {
        console.error("Erro ao copiar:", error);
      }
    });

    updatePasswordStrength(pwField?.value || "");
    renderState();
  }

  return {
    setup,
    handleProtectFile,
    getPendingMessage,
    getQueuePayload,
    clearWorkspace,
    validateBeforeQueue
  };
}
