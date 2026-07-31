export function bindAboutDiagnosticActions({ container, aboutInfo, windowApi, notify, showFeedbackBanner, toneIcon }) {
    if (!container || !aboutInfo) return;

  const formatModeLabel = (modeLabel = "") => {
    const normalized = String(modeLabel).trim().toLowerCase();
    if (normalized === "installed mode") return "Modo instalado";
    if (normalized === "portable mode") return "Modo portátil";
    return modeLabel || "-";
  };

  const supportPathsSummary = [
    `Logs: ${aboutInfo.paths.logs || "Não disponível"}`,
    `Configuração: ${aboutInfo.paths.config || "Não disponível"}`
  ].join("\n");

  const runtimePathsSummary = [
    `Temporários: ${aboutInfo.paths.temp || "Não disponível"}`,
    `Política: ${aboutInfo.paths.policy || "Não disponível"}`
  ].join("\n");

  const openFolder = async (targetPath, fallbackTitle) => {
    if (!targetPath) {
      notify({
        tone: "warning",
        title: fallbackTitle,
        message: "Esse caminho não está disponível neste ambiente."
      });
      return;
    }

    try {
      const result = await windowApi.openPath(targetPath);
      if (!result.success) {
        notify({
          tone: "error",
          title: fallbackTitle,
          message: result.error || "Não foi possível abrir o caminho informado."
        });
      }
    } catch (error) {
      notify({
        tone: "error",
        title: fallbackTitle,
        message: error.message || "Não foi possível abrir o caminho informado."
      });
    }
  };

  const revealPath = async (targetPath, fallbackTitle, fallbackDirectory = "") => {
    if (!targetPath) {
      notify({
        tone: "warning",
        title: fallbackTitle,
        message: "Esse caminho não está disponível neste ambiente."
      });
      return;
    }

    try {
      const result = await windowApi.revealPath(targetPath);
      if (!result.success) {
        notify({
          tone: "error",
          title: fallbackTitle,
          message: result.error || "Não foi possível localizar o item informado."
        });
      }
    } catch {
      await openFolder(fallbackDirectory || targetPath, fallbackTitle);
    }
  };

  const copySystemInfo = async () => {
    const lines = [
      `${aboutInfo.app.name}`,
      `Versão: ${aboutInfo.app.version}`,
      `Build: ${aboutInfo.app.buildLabel}`,
      `Modo: ${formatModeLabel(aboutInfo.app.modeLabel)}`,
      `Arquitetura: ${aboutInfo.app.architectureLabel}`,
      `Sistema: ${aboutInfo.system.platformLabel}`,
      `Memória: ${aboutInfo.system.memory.totalMb} MB totais / ${aboutInfo.system.memory.freeMb} MB livres`,
      `Logs: ${aboutInfo.paths.logs}`,
      `Configurações: ${aboutInfo.paths.config}`,
      `Temporários: ${aboutInfo.paths.temp}`,
      `Políticas: ${aboutInfo.paths.policy}`
    ].join("\n");

    await windowApi.copyText(lines);
    notify({
      tone: "success",
      title: "Resumo copiado",
      message: "As informações do ambiente foram copiadas para a área de transferência."
    });
  };

  container.querySelector("[data-about-copy-system]").addEventListener("click", () => {
    copySystemInfo().catch((error) => {
      notify({
        tone: "error",
        title: "Copiar informações",
        message: error.message || "Não foi possível copiar as informações do sistema."
      });
    });
  });

  container.querySelector("[data-about-copy-support-paths]").addEventListener("click", async () => {
    await windowApi.copyText(supportPathsSummary);
    notify({
      tone: "success",
      title: "Caminhos copiados",
      message: "Logs e configuração foram copiados para a área de transferência."
    });
  });

  container.querySelector("[data-about-copy-runtime-paths]").addEventListener("click", async () => {
    await windowApi.copyText(runtimePathsSummary);
    notify({
      tone: "success",
      title: "Caminhos copiados",
      message: "Temporários e política foram copiados para a área de transferência."
    });
  });

  container.querySelector("[data-about-open-logs]").addEventListener("click", () => {
    openFolder(aboutInfo.paths.logs, "Pasta de logs");
  });

  container.querySelector("[data-about-open-configs]").addEventListener("click", () => {
    openFolder(aboutInfo.paths.configDirectory, "Pasta de configurações");
  });

  container.querySelector("[data-about-open-temp]").addEventListener("click", () => {
    openFolder(aboutInfo.paths.temp, "Pasta temporária");
  });

  container.querySelector("[data-about-export-basic]").addEventListener("click", async () => {
    const result = await windowApi.exportBasicDiagnostics();
    if (result.success) {
      notify({
        tone: "success",
        title: "Diagnóstico básico exportado",
        message: "Pacote preparado para suporte e governança."
      });
      showFeedbackBanner({
        mode: "info",
        tone: "success",
        title: "Diagnóstico básico pronto",
        message: "O pacote foi exportado com informações úteis para suporte.",
        detail: result.path,
        icon: toneIcon("success", 18)
      });
      return;
    }

    if (result.reason === "canceled") return;

    notify({
      tone: "error",
      title: "Diagnóstico básico",
      message: result.error || "Não foi possível exportar o diagnóstico básico."
    });
  });
}




