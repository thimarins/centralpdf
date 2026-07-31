export function createQueueAndHistoryRenderer(deps) {
  const {
    state,
    dom,
    windowApi,
    icon,
    fluentIcon,
    safeProgress,
    formatDuration,
    escapeHtml,
    buildFeedbackMessage,
    QUEUE_UI_THRESHOLDS,
    addPulseTemporarily,
    toneIcon,
    notify,
    clearToast,
    showFeedbackBanner,
    clearFeedbackBanner,
    showCustomConfirmModal,
    updateRecentHistory,
    getWorkflowSuggestionActions
  } = deps;

  const actionIconMap = {
    image: 'file-image',
    sign: 'pen-line',
    convert: 'file-text',
    merge: 'merge',
    split: 'scissors',
    organize: 'layout-list',
    watermark: 'stamp',
    compress: 'zap',
    protect: 'lock',
    unlock: 'unlock',
    redact: 'eye-off'
  };
  const RECENT_HISTORY_MENU_LIMIT = 15;
  const QUEUE_START_TOAST_DELAY_MS = 450;
  const pendingQueueStartToasts = new Map();
  const announcedTerminalTasks = new Set();
  let recentHistoryMenuFilter = 'all';

  function clearPendingQueueStartToast(taskId) {
    const pending = pendingQueueStartToasts.get(taskId);
    if (!pending) return;
    window.clearTimeout(pending.timeoutId);
    pendingQueueStartToasts.delete(taskId);
  }

  function scheduleQueueStartToast(task) {
    if (!task || task.quietNotifications || pendingQueueStartToasts.has(task.id)) return;
    const timeoutId = window.setTimeout(() => {
      pendingQueueStartToasts.delete(task.id);
      const currentTask = state.queueSnapshot?.find((item) => item.id === task.id);
      if (!currentTask || currentTask.quietNotifications) return;
      if (currentTask.status !== 'running') return;
      notify({
        id: `queue-running-${task.id}`,
        tone: 'info',
        title: `${task.name} em andamento`,
        message: task.totalItems > 1
          ? `Processando ${task.totalItems} arquivo(s). A fila vai atualizando o andamento localmente.`
          : 'Processamento iniciado. A fila vai atualizando o andamento localmente.',
        duration: 5200
      });
    }, task.totalItems > 1 ? Math.max(250, QUEUE_START_TOAST_DELAY_MS - 150) : QUEUE_START_TOAST_DELAY_MS);
    pendingQueueStartToasts.set(task.id, { timeoutId });
  }

  function clearQueueTransientToasts(taskId) {
    if (!taskId || typeof clearToast !== 'function') return;
    clearToast(`queue-pending-${taskId}`, { immediate: true });
    clearToast(`queue-running-${taskId}`, { immediate: true });
  }

  async function openPathSafely(targetPath, title, fallbackMessage) {
    try {
      const result = await windowApi.openPath(targetPath);
      if (!result?.success) {
        notify({
          tone: 'error',
          title,
          message: result?.error || fallbackMessage
        });
      }
    } catch (error) {
      notify({
        tone: 'error',
        title,
        message: error?.message || fallbackMessage
      });
    }
  }

  async function revealPathSafely(targetPath, title, fallbackMessage) {
    try {
      const result = await windowApi.revealPath(targetPath);
      if (!result?.success) {
        notify({
          tone: 'warning',
          title,
          message: result?.error || fallbackMessage
        });
      }
    } catch (error) {
      notify({
        tone: 'warning',
        title,
        message: error?.message || fallbackMessage
      });
    }
  }

  function getCompletionActions(task) {
    const outputPath = task.result?.outputPath || task.result?.firstOutputPath || '';
    const outputDir = task.result?.outputDir || '';
    if (outputPath) {
      const actions = [
        {
          label: 'Abrir arquivo final',
          description: 'Abrir o documento pronto agora.',
          icon: 'document-arrow-right',
          onAction: () => openPathSafely(outputPath, 'Abrir arquivo final', 'O arquivo gerado não existe mais.')
        }
      ];

      actions.push({
        label: 'Abrir pasta',
        description: 'Ver o arquivo pronto na pasta de saída.',
        icon: 'folder-open',
        onAction: () => revealPathSafely(outputPath, 'Abrir pasta', 'A pasta do arquivo gerado não existe mais.')
      });

      return actions;
    }

    if (outputDir) {
      return [
        {
          label: 'Abrir pasta do resultado',
          description: 'Ver os arquivos gerados nesta etapa.',
          icon: 'folder-open',
          onAction: () => openPathSafely(outputDir, 'Abrir pasta do resultado', 'A pasta de saída não existe mais.')
        }
      ];
    }

    return [];
  }

  function formatOutputFileSize(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value < 0) return 'tamanho desconhecido';
    if (value < 1024) return `${value} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let size = value / 1024;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex += 1;
    }
    return `${size.toLocaleString('pt-BR', { maximumFractionDigits: 2 })} ${units[unitIndex]}`;
  }

  async function getCompletionFileDetails(task) {
    const outputPath = task.result?.outputPath || task.result?.firstOutputPath || '';
    if (!outputPath || typeof windowApi.getFileInfo !== 'function') return '';
    const info = await windowApi.getFileInfo(outputPath);
    if (!info?.success) return `Caminho completo: ${outputPath}`;
    const createdAt = info.createdAt
      ? new Date(info.createdAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'medium' })
      : 'não informado';
    const modifiedAt = info.modifiedAt
      ? new Date(info.modifiedAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'medium' })
      : 'não informado';
    return [
      `Arquivo: ${info.name || outputPath.split(/[\\/]/).pop()}`,
      `Extensão: ${info.extension || 'sem extensão'} • Tamanho: ${formatOutputFileSize(info.size)}`,
      `Criado em: ${createdAt} • Modificado em: ${modifiedAt}`,
      `Caminho completo: ${info.path || outputPath}`
    ].join('\n');
  }

  function getTaskStatusClass(task) {
    return `task-status-${task.status || 'pending'}`;
  }

  function buildHistoryErrorMessage(item) {
    return item?.errorMessage?.trim()
      || 'A operação falhou. Abra os logs para ver mais detalhes do ambiente e da execução.';
  }

  function getHistorySavedTarget(item) {
    return item?.outputPath?.trim()
      || item?.outputDir?.trim()
      || '';
  }

  function getHistoryOpenTarget(item) {
    return item?.outputPath?.trim()
      || item?.outputDir?.trim()
      || '';
  }

  function notifyMissingHistoryFile(filePath) {
    notify({
      tone: 'warning',
      title: 'Arquivo não encontrado',
      message: filePath
        ? `O arquivo deste resultado não existe mais. Caminho registrado: ${filePath}`
        : 'O arquivo deste resultado não existe mais ou não possui um caminho registrado.',
      important: true,
      duration: 7600
    });
  }

  function getHistoryStatusLabel(status = '') {
    if (status === 'sucesso') return 'Concluído';
    if (status === 'falha') return 'Falhou';
    return status || 'Processado';
  }

  function isHistoryItemFromToday(item) {
    if (!item?.timestamp) return false;
    const itemDate = new Date(item.timestamp);
    if (Number.isNaN(itemDate.getTime())) return false;
    const today = new Date();
    return itemDate.getFullYear() === today.getFullYear()
      && itemDate.getMonth() === today.getMonth()
      && itemDate.getDate() === today.getDate();
  }

  function getFilteredHistoryItems() {
    const historyItems = state.appConfig?.recentHistory || [];
    return recentHistoryMenuFilter === 'today'
      ? historyItems.filter(isHistoryItemFromToday)
      : historyItems;
  }

  function updateRecentProcessedFilterButton() {
    const button = document.getElementById('recent-processed-modal-filter-today');
    if (!button) return;

    const isActive = recentHistoryMenuFilter === 'today';
    button.classList.toggle('is-active', isActive);
    button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    button.title = isActive
      ? 'Mostrando apenas os itens de hoje. Clique para voltar ao historico completo.'
      : 'Mostrar apenas os itens de hoje.';
    button.setAttribute('aria-label', button.title);
  }
  function renderProcessedModalSkeleton() {
    return Array.from({ length: 4 }, () => `
      <div class="recent-processed-item skeleton-row" aria-hidden="true">
        <div class="recent-processed-icon-skel"></div>
        <div class="recent-processed-body-skel">
          <div class="skeleton-line long"></div>
          <div class="skeleton-line short"></div>
          <div class="skeleton-line medium"></div>
        </div>
      </div>
    `).join('');
  }

  function renderProcessedModalItem(item) {
    const statusClass = item.status === 'sucesso' ? 'success' : 'failed';
    const statusLabel = getHistoryStatusLabel(item.status);
    const savedTarget = getHistorySavedTarget(item);
    const pathExists = Boolean(item.pathExists);
    const openable = Boolean(item.openTargetExists);
    const missingState = !savedTarget || !pathExists;
    const iconName = actionIconMap[getActionType(item.action)] || 'file';
    const actionLabel = getActionLabel(item.action);
    const processedAt = item.timestamp ? new Date(item.timestamp).toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    }) : '-';

    return `
      <article class="recent-processed-item ${missingState ? 'is-missing' : ''}">
        <div class="recent-processed-icon ${missingState ? 'is-missing' : ''}">
          ${icon(iconName, { size: 18, filled: true })}
        </div>
        <div class="recent-processed-copy">
          <div class="recent-processed-head">
            <strong title="${escapeHtml(item.fileName || '')}">${escapeHtml(item.fileName || 'Arquivo sem nome')}</strong>
            <span class="history-badge ${statusClass}">${escapeHtml(statusLabel)}</span>
          </div>
          <span class="recent-processed-action">${escapeHtml(actionLabel)}</span>
          <span class="recent-processed-path ${missingState ? 'is-missing' : ''}" title="${escapeHtml(savedTarget || 'Caminho indisponível')}">
            ${escapeHtml(savedTarget || 'Caminho indisponível')}
          </span>
          <div class="recent-processed-meta">
            <span>${escapeHtml(processedAt)}</span>
            ${missingState ? '<span class="recent-processed-error">Arquivo ou pasta nao encontrado.</span>' : ''}
            ${item.errorMessage ? `<span class="recent-processed-error">${escapeHtml(item.errorMessage)}</span>` : ''}
          </div>
        </div>
        <button
          class="recent-processed-open btn-secondary btn-icon-label"
          type="button"
          data-open-recent-index="${escapeHtml(item.__index)}"
          ${openable ? '' : 'disabled'}
          title="${openable ? 'Abrir arquivo do resultado' : 'Caminho indisponível'}"
          aria-label="${openable ? 'Abrir arquivo do resultado' : 'Caminho indisponível'}"
        >
          ${icon('folder-open', { size: 16 })}
          <span>Abrir arquivo</span>
        </button>
      </article>
    `;
  }

  async function renderRecentProcessedModalList() {
    if (!dom.processedHistoryModalList) return;

    const historyItems = getFilteredHistoryItems();
    if (historyItems.length === 0) {
      dom.processedHistoryModalList.innerHTML = recentHistoryMenuFilter === 'today'
        ? '<div class="empty-state">Nenhuma operação realizada hoje.</div>'
        : '<div class="empty-state">Nenhuma atividade recente.</div>';
      const footerNote = dom.processedHistoryModal?.querySelector('.recent-processed-footer-note');
      if (footerNote) {
        footerNote.textContent = recentHistoryMenuFilter === 'today'
          ? 'Mostrando apenas os registros de hoje.'
          : 'Mostrando apenas as últimas atividades.';
      }
      return;
    }

    const visibleItems = historyItems.slice(0, RECENT_HISTORY_MENU_LIMIT);
    dom.processedHistoryModalList.innerHTML = renderProcessedModalSkeleton();

    try {
      const enrichedItems = await Promise.all(visibleItems.map(async (item, index) => {
        const savedTarget = getHistorySavedTarget(item);
        const openTarget = getHistoryOpenTarget(item);
        const [pathExistsResult, openTargetResult] = await Promise.all([
          savedTarget ? windowApi.pathExists(savedTarget) : Promise.resolve({ exists: false }),
          openTarget && openTarget !== savedTarget ? windowApi.pathExists(openTarget) : Promise.resolve({ exists: false })
        ]);

        return {
          ...item,
          __index: index,
          pathExists: Boolean(pathExistsResult?.exists),
          openTargetExists: Boolean(openTargetResult?.exists || pathExistsResult?.exists)
        };
      }));

      dom.processedHistoryModalList.innerHTML = enrichedItems.map(renderProcessedModalItem).join('');

      if (historyItems.length > RECENT_HISTORY_MENU_LIMIT) {
        dom.processedHistoryModalList.insertAdjacentHTML(
          'beforeend',
          `<div class="recent-processed-limit-note">Mostrando os ${RECENT_HISTORY_MENU_LIMIT} itens mais recentes de ${historyItems.length}.</div>`
        );
      }

      const footerNote = dom.processedHistoryModal?.querySelector('.recent-processed-footer-note');
      if (footerNote) {
        footerNote.textContent = recentHistoryMenuFilter === 'today'
          ? 'Mostrando apenas os registros de hoje.'
          : 'Mostrando apenas as últimas atividades.';
      }

      dom.processedHistoryModalList.querySelectorAll('[data-open-recent-index]').forEach((button) => {
        button.addEventListener('click', async () => {
          const item = enrichedItems[Number(button.getAttribute('data-open-recent-index'))];
          const target = item?.openTargetExists
            ? getHistoryOpenTarget(item)
            : getHistorySavedTarget(item);

          if (!target) {
            notify({
              tone: 'warning',
              title: 'Caminho indisponível',
              message: 'Esse item não tem um caminho válido para abrir.'
            });
            return;
          }

          try {
            const freshTargetCheck = await windowApi.pathExists(target);
            if (!freshTargetCheck?.exists) {
              notify({
                tone: 'warning',
                title: 'Item não encontrado',
                message: 'O arquivo ou a pasta selecionada não existe mais.'
              });
              return;
            }

            const result = await windowApi.openPath(target);

            if (!result?.success) {
              notify({
                tone: 'error',
                title: 'Abrir arquivo',
                message: result?.error || 'Não foi possível abrir o arquivo selecionado.'
              });
            }
          } catch (error) {
            notify({
              tone: 'error',
              title: 'Abrir arquivo',
              message: error.message || 'Não foi possível abrir o arquivo selecionado.'
            });
          }
        });
      });
    } catch (error) {
      dom.processedHistoryModalList.innerHTML = '<div class="empty-state">Não foi possível carregar a lista recente.</div>';
      notify({
        tone: 'error',
        title: 'Últimas atividades',
        message: error.message || 'Não foi possível carregar as últimas atividades.'
      });
    }
  }

  function closeRecentProcessedModal() {
    dom.processedHistoryModal?.classList.add('hidden');
    dom.processedHistoryModal?.removeAttribute('style');
    const historyButton = document.getElementById('btn-dashboard-processed-history');
    historyButton?.setAttribute('aria-expanded', 'false');
  }

  function positionRecentProcessedModal(anchorElement) {
    if (!dom.processedHistoryModal) return;
    const anchorRect = anchorElement?.getBoundingClientRect();
    if (!anchorRect) return;

    const viewportPadding = 12;
    const modalWidth = Math.min(560, window.innerWidth - viewportPadding * 2);
    const desiredLeft = anchorRect.right - modalWidth;
    const left = Math.max(viewportPadding, Math.min(desiredLeft, window.innerWidth - modalWidth - viewportPadding));
    const top = anchorRect.bottom + 12;
    const maxHeight = Math.max(220, window.innerHeight - top - viewportPadding);

    dom.processedHistoryModal.style.left = `${left}px`;
    dom.processedHistoryModal.style.top = `${top}px`;
    dom.processedHistoryModal.style.width = `${modalWidth}px`;
    dom.processedHistoryModal.style.maxHeight = `${Math.min(maxHeight, 720)}px`;
  }

  async function openRecentProcessedModal(anchorElement) {
    if (!dom.processedHistoryModal) return;

    const isAlreadyOpen = !dom.processedHistoryModal.classList.contains('hidden');
    if (isAlreadyOpen) {
      closeRecentProcessedModal();
      return;
    }

    dom.processedHistoryModal.classList.remove('hidden');
    positionRecentProcessedModal(anchorElement || document.getElementById('btn-dashboard-processed-history'));
    updateRecentProcessedFilterButton();
    await renderRecentProcessedModalList();
    dom.processedHistoryModalClose?.focus();
    const historyButton = document.getElementById('btn-dashboard-processed-history');
    historyButton?.setAttribute('aria-expanded', 'true');
  }

  async function clearRecentHistory() {
    const hasItems = (state.appConfig?.recentHistory || []).length > 0;
    if (!hasItems) {
      notify({
        tone: 'info',
        title: 'Histórico vazio',
        message: 'Não há atividades recentes para limpar.'
      });
      return;
    }

    const confirmed = await new Promise((resolve) => {
      if (typeof showCustomConfirmModal !== 'function') {
        resolve(window.confirm('Limpar todas as últimas atividades? Esta ação apaga apenas a lista do aplicativo.'));
        return;
      }

      showCustomConfirmModal(
        'Limpar últimas atividades',
        'Você quer apagar apenas a lista de atividades do aplicativo?\n\nIsso não remove arquivos do disco.',
        () => resolve(true),
        () => resolve(false),
        { confirmLabel: 'Limpar', cancelLabel: 'Cancelar' }
      );
    });
    if (!confirmed) return;

    try {
      const result = await windowApi.clearRecentHistory();
      if (!result?.success) {
        notify({
          tone: 'error',
          title: 'Limpar últimas atividades',
          message: 'Não foi possível limpar as últimas atividades.'
        });
        return;
      }

      state.appConfig.recentHistory = [];
      window.dispatchEvent(new Event('recent-history-updated'));
      await renderRecentProcessedModalList();
      notify({
        tone: 'success',
        title: 'Histórico limpo',
        message: 'As últimas atividades foram apagadas.'
      });
    } catch (error) {
      notify({
        tone: 'error',
          title: 'Limpar últimas atividades',
          message: error?.message || 'Não foi possível limpar as últimas atividades.'
      });
    }
  }

  async function openLogsFromHistory() {
    const aboutInfo = await windowApi.getAboutInfo();
    const logsPath = aboutInfo?.paths?.logs;
    if (!logsPath) {
      notify({
        tone: 'warning',
        title: 'Logs indisponíveis',
        message: 'A pasta de logs não está disponível neste ambiente.'
      });
      return;
    }

    const result = await windowApi.openPath(logsPath);
    if (!result?.success) {
      notify({
        tone: 'error',
        title: 'Abrir logs',
        message: result?.error || 'Não foi possível abrir a pasta de logs.'
      });
    }
  }

  async function revealLogsFromHistory() {
    const aboutInfo = await windowApi.getAboutInfo();
    const logsPath = aboutInfo?.paths?.logs;
    if (!logsPath) {
      notify({
        tone: 'warning',
        title: 'Logs indisponíveis',
        message: 'A pasta de logs não está disponível neste ambiente.'
      });
      return;
    }

    const result = await windowApi.revealPath(logsPath);
    if (!result?.success) {
      notify({
        tone: 'error',
        title: 'Mostrar logs',
        message: result?.error || 'Não foi possível localizar a pasta de logs.'
      });
    }
  }

  function getTaskNarrative(task) {
    if (task.status === 'running' && (task.elapsedMs > 45000 || task.totalItems > 8)) {
      return buildFeedbackMessage('longRunning', { seed: task.id });
    }
    if (task.status === 'running') {
      return buildFeedbackMessage('queued', { seed: task.id });
    }
    if (task.status === 'completed') {
      return buildFeedbackMessage(task.elapsedMs > 90000 || task.totalItems > 10 ? 'successLarge' : 'success', { seed: task.id });
    }
    if (task.status === 'cancelled') return buildFeedbackMessage('cancelled', { seed: task.id });
    if (task.status === 'timeout') return buildFeedbackMessage('error', { seed: `${task.id}-timeout` });
    if (task.status === 'failed') return buildFeedbackMessage('error', { seed: `${task.id}-failed` });
    if (task.status === 'interrupted') return buildFeedbackMessage('recovery', { seed: task.id });
    return buildFeedbackMessage('queued', { seed: task.id });
  }

  function syncQueueFeedback(statusList, previousStatusList = []) {
    const previousMap = new Map(previousStatusList.map((task) => [task.id, task]));
    const liveTaskIds = new Set(statusList.map((task) => task.id));

    [...announcedTerminalTasks].forEach((taskId) => {
      if (!liveTaskIds.has(taskId)) {
        announcedTerminalTasks.delete(taskId);
      }
    });

    statusList.forEach((task) => {
      if (task.status === 'running') {
        const previous = previousMap.get(task.id);
        if (!previous || previous.status !== 'running') {
          clearQueueTransientToasts(task.id);
          scheduleQueueStartToast(task);
        }
      } else {
        clearPendingQueueStartToast(task.id);
      }
    });

    if (state.feedbackBannerMode === 'queue') {
      clearFeedbackBanner('queue');
    }

    statusList.forEach((task) => {
      const previous = previousMap.get(task.id);

      if (!previous && task.status === 'interrupted') {
        if (!announcedTerminalTasks.has(task.id)) {
          announcedTerminalTasks.add(task.id);
          if (!task.quietNotifications) {
            notify({
              tone: 'warning',
              title: 'Recuperação',
              message: buildFeedbackMessage('recovery', { seed: task.id }),
              duration: 5600
            });
          }
        }
        return;
      }

      const isTerminalStatus = ['completed', 'failed', 'timeout', 'cancelled', 'interrupted'].includes(task.status);
      if (isTerminalStatus && !announcedTerminalTasks.has(task.id)) {
        announcedTerminalTasks.add(task.id);

        if (task.status === 'completed') {
          clearPendingQueueStartToast(task.id);
          clearQueueTransientToasts(task.id);
          updateRecentHistory?.(task, 'sucesso');
          const completionActions = getCompletionActions(task);
          const workflowActions = typeof getWorkflowSuggestionActions === 'function'
            ? getWorkflowSuggestionActions(task)
            : [];
          const toastActions = [...completionActions, ...workflowActions].slice(0, 4);
          const actionSections = [
            ...(completionActions.length > 0 ? [{
              title: 'ABRIR RESULTADO',
              actions: completionActions
            }] : []),
            ...(workflowActions.length > 0 ? [{
              title: workflowActions.length === 1 ? 'PRÓXIMO PASSO' : 'PRÓXIMOS PASSOS',
              actions: workflowActions
            }] : [])
          ];
          const completionMessage = workflowActions.length > 0
            ? 'Seu arquivo ficou pronto. Escolha abaixo o próximo passo que deseja fazer com este mesmo documento.'
            : completionActions.length > 0
              ? 'Seu arquivo ficou pronto. Você pode abrir o resultado agora.'
              : 'Tudo certo. A operação terminou com sucesso.';
          const announceCompletion = (message) => notify({
            id: `queue-complete-${task.id}`,
            tone: 'success',
            title: `${task.name} concluído`,
            message,
            duration: 20000,
            actions: toastActions,
            actionSections,
            layout: 'spotlight'
          });
          clearFeedbackBanner('queue');
          getCompletionFileDetails(task)
            .then((details) => announceCompletion(details ? `${completionMessage}\n\n${details}` : completionMessage))
            .catch(() => announceCompletion(completionMessage));
          addPulseTemporarily(dom.queueBar);
          return;
        }

        if (task.status === 'failed' || task.status === 'timeout') {
          clearPendingQueueStartToast(task.id);
          clearQueueTransientToasts(task.id);
          updateRecentHistory?.(task, 'falha');
          showFeedbackBanner({
            mode: 'queue',
            tone: 'error',
            title: task.name,
            message: task.status === 'timeout' ? 'A tarefa excedeu o tempo limite.' : 'A tarefa terminou com erro.',
            detail: task.error || '',
            icon: toneIcon('error', 18),
            duration: 6800
          });
          if (!task.quietNotifications) {
            notify({
              id: `queue-error-${task.id}`,
              tone: 'error',
              title: task.name,
              message: `${getTaskNarrative(task)} ${task.error || ''}`.trim(),
              important: true,
              duration: 6200
            });
          }
          return;
        }

        if (task.status === 'cancelled') {
          clearPendingQueueStartToast(task.id);
          clearQueueTransientToasts(task.id);
          if (!task.quietNotifications) {
            notify({
              id: `queue-cancelled-${task.id}`,
              tone: 'warning',
              title: task.name,
              message: getTaskNarrative(task)
            });
          }
          return;
        }

        if (task.status === 'interrupted') {
          clearPendingQueueStartToast(task.id);
          clearQueueTransientToasts(task.id);
          if (!task.quietNotifications) {
            notify({
              id: `queue-interrupted-${task.id}`,
              tone: 'warning',
              title: task.name,
              message: buildFeedbackMessage('recovery', { seed: task.id }),
              duration: 5600
            });
          }
          return;
        }
      }

      if (!previous || (previous.status === task.status && previous.attempt === task.attempt)) return;

      if (task.status === 'running' && previous.status !== 'running') {
        clearPendingQueueStartToast(task.id);
        return;
      }

      if (task.status === 'running' && Number(task.attempt) > Number(previous.attempt || 1)) {
        if (task.quietNotifications) return;
        notify({
          id: `queue-retry-${task.id}`,
          tone: 'warning',
          title: task.name,
          message: buildFeedbackMessage('retry', { seed: task.id })
        });
      }
    });
  }

  function renderTaskStatus(task) {
    if (task.status === 'running') return 'Processando';
    if (task.status === 'completed') return 'Concluido';
    if (task.status === 'failed') return 'Falhou';
    if (task.status === 'cancelled') return 'Cancelado';
    if (task.status === 'timeout') return 'Tempo excedido';
    if (task.status === 'interrupted') return 'Interrompido';
    return 'Aguardando';
  }

  function formatQueueCount(activeCount) {
    if (activeCount <= 0) return 'Sem fila';
    return activeCount === 1 ? '1 em fila' : `${activeCount} em fila`;
  }

  function buildQueueSummary(statusList) {
    const runningCount = statusList.filter((task) => task.status === 'running').length;
    const pendingCount = statusList.filter((task) => task.status === 'pending').length;
    if (runningCount > 0 && pendingCount > 0) {
      return `${runningCount} em andamento - ${pendingCount} aguardando`;
    }
    if (runningCount > 0) {
      return runningCount === 1 ? '1 em andamento' : `${runningCount} em andamento`;
    }
    if (pendingCount > 0) {
      return pendingCount === 1 ? '1 aguardando' : `${pendingCount} aguardando`;
    }
    return `${statusList.length} tarefa${statusList.length > 1 ? 's' : ''} visivel`;
  }

  function formatTaskHeadline(task) {
    if (task.totalItems > 1) {
      const safeCurrent = Math.max(1, Math.min(task.totalItems, task.currentItem || 1));
      return `${safeCurrent}/${task.totalItems} - ${task.currentItemName || 'Aguardando'}`;
    }
    return task.currentItemName || task.fileNames?.[0] || 'Aguardando';
  }

  function getDisplayProgress(task) {
    const rawProgress = safeProgress(task.progress);
    if (task.totalItems > 1 && task.currentItem > 0) {
      const completedItems = Math.max(0, Math.min(task.totalItems, (task.currentItem || 1) - 1));
      const itemRatio = Math.max(0, Math.min(1, safeProgress(task.itemProgress) / 100));
      return safeProgress(Math.round(((completedItems + itemRatio) / task.totalItems) * 100));
    }
    return rawProgress;
  }

  function formatThroughput(task) {
    if (!task.throughputItemsPerMinute || task.throughputItemsPerMinute <= 0) return '';
    return task.totalItems > 1
      ? `${task.throughputItemsPerMinute}/arquivo min`
      : `${task.throughputItemsPerMinute}%/min`;
  }

  function buildTaskMeta(task) {
    const isStalled = Number(task.stalledMs || 0) >= 12000;
    const parts = [];
    if (task.elapsedMs) parts.push(`Tempo ${formatDuration(task.elapsedMs)}`);
    if (!isStalled && Number.isFinite(task.etaSeconds) && task.etaSeconds !== null) {
      parts.push(`ETA ${formatDuration(task.etaSeconds * 1000)}`);
    }
    if (task.memoryMb) parts.push(`RAM ${task.memoryMb} MB`);
    const throughputLabel = formatThroughput(task);
    if (!isStalled && throughputLabel) parts.push(`Ritmo ${throughputLabel}`);
    if (task.maxAttempts > 1) parts.push(`Tentativa ${task.attempt}/${task.maxAttempts}`);
    return { text: parts.join(' - '), isStalled };
  }

  function renderQueue(statusList) {
    const previousSnapshot = state.queueSnapshot;
    state.queueSnapshot = statusList;
    syncQueueFeedback(statusList, previousSnapshot);
    const activeCount = statusList.filter((task) => task.status === 'running' || task.status === 'pending').length;

    if (statusList.length === 0) {
      dom.queueBar.classList.add('hidden');
      clearFeedbackBanner('queue');
      return;
    }

    dom.queueBar.classList.remove('hidden');
    dom.queueActiveCount.textContent = formatQueueCount(activeCount);
    dom.queueSummary.textContent = buildQueueSummary(statusList);

    dom.queueTasksList.innerHTML = statusList.map((task) => {
      const progress = getDisplayProgress(task);
      const itemProgress = safeProgress(task.itemProgress);
      const detailText = formatTaskHeadline(task);
      const taskMeta = buildTaskMeta(task);
      const narrative = getTaskNarrative(task);

      return `
        <div class="queue-task-item is-${escapeHtml(task.status)} ${task.status === 'running' ? 'is-running' : ''} ${task.status === 'running' && task.attempt > 1 ? 'is-retrying' : ''} ${taskMeta.isStalled ? 'is-stalled' : ''}">
          <div class="task-info-line">
            <span class="task-name">${escapeHtml(task.name)}</span>
            <span class="task-status ${escapeHtml(getTaskStatusClass(task))}">${escapeHtml(renderTaskStatus(task))}</span>
          </div>
          <div class="task-detail-line">
            <span class="task-detail task-detail--headline" title="${escapeHtml(detailText)}">${escapeHtml(detailText)}</span>
            <span class="task-detail task-detail--percent">${progress}%</span>
          </div>
          ${narrative ? `<span class="task-detail task-detail--narrative">${escapeHtml(narrative)}</span>` : ''}
          <div class="task-progress-track">
            <div class="task-progress-bar ${task.status === 'failed' || task.status === 'cancelled' ? 'failed' : task.status === 'completed' ? 'completed' : ''}" style="width:${progress}%"></div>
          </div>
          ${taskMeta.text ? `<span class="task-detail task-detail--meta">${escapeHtml(taskMeta.text)}</span>` : ''}
          ${taskMeta.isStalled ? '<span class="task-detail task-detail--hint">Etapa pesada em andamento. A porcentagem volta a subir quando essa fase terminar.</span>' : ''}
          ${task.totalItems > 1 ? `
            <div class="task-detail-line">
              <span class="task-detail">Arquivo atual</span>
              <span class="task-detail task-detail--percent">${itemProgress}%</span>
            </div>
            <div class="task-progress-track task-subprogress">
              <div class="task-progress-bar" style="width:${itemProgress}%"></div>
            </div>
          ` : ''}
          ${task.error ? `<span class="task-error-msg">${escapeHtml(task.error)}</span>` : ''}
          ${(task.status === 'running' || task.status === 'pending') ? `<button class="btn-danger-text btn-sm" data-cancel-id="${escapeHtml(task.id)}">Cancelar</button>` : ''}
        </div>
      `;
    }).join('');

    dom.queueTasksList.querySelectorAll('[data-cancel-id]').forEach((button) => {
      button.addEventListener('click', async () => {
        await windowApi.cancelOperation(button.getAttribute('data-cancel-id'));
        notify({
          tone: 'warning',
          title: 'Cancelamento solicitado',
          message: buildFeedbackMessage('cancelled', { seed: button.getAttribute('data-cancel-id') })
        });
      });
    });
  }

  function setupQueueStatus() {
    windowApi.getQueueStatus().then((status) => renderQueue(status));
    windowApi.onQueueUpdate((status) => renderQueue(status));

    if (dom.btnToggleHistory) {
      dom.btnToggleHistory.addEventListener('click', () => {
        const isCollapsed = dom.historyList.classList.toggle('collapsed');
        if (isCollapsed) {
          dom.btnToggleHistory.setAttribute("data-icon", "chevronDown");
          dom.btnToggleHistory.innerHTML = `${icon("chevronDown", { size: 14 })}<span>Ver mais</span>`;
        } else {
          dom.btnToggleHistory.setAttribute("data-icon", "chevronUp");
          dom.btnToggleHistory.innerHTML = `${icon("chevronUp", { size: 14 })}<span>Ver menos</span>`;
        }
      });
    }

    const recentFilterButton = document.getElementById('recent-processed-modal-filter-today');
    recentFilterButton?.addEventListener('click', async () => {
      recentHistoryMenuFilter = recentHistoryMenuFilter === 'today' ? 'all' : 'today';
      updateRecentProcessedFilterButton();
      await renderRecentProcessedModalList();
    });

    const recentClearButton = document.getElementById('recent-processed-modal-clear');
    recentClearButton?.addEventListener('click', () => {
      clearRecentHistory().catch(() => {});
    });

    dom.processedHistoryModalClose?.addEventListener('click', closeRecentProcessedModal);
    dom.processedHistoryModal?.addEventListener('click', (event) => {
      if (event.target === dom.processedHistoryModal) {
        closeRecentProcessedModal();
      }
    });
    document.addEventListener('click', (event) => {
      if (dom.processedHistoryModal?.classList.contains('hidden')) return;
      const button = document.getElementById('btn-dashboard-processed-history');
      if (button?.contains(event.target) || dom.processedHistoryModal?.contains(event.target)) return;
      closeRecentProcessedModal();
    }, { capture: true });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && dom.processedHistoryModal && !dom.processedHistoryModal.classList.contains('hidden')) {
        closeRecentProcessedModal();
      }
    });
  }

  function getActionType(actionLabel) {
    const normalized = (actionLabel || '').toLowerCase();
    if (normalized.includes('imagem')) return 'image';
    if (normalized.includes('assinar')) return 'sign';
    if (normalized.includes('word') || normalized.includes('converter')) return 'convert';
    if (normalized.includes('mesclar') || normalized.includes('juntar')) return 'merge';
    if (normalized.includes('separ')) return 'split';
    if (normalized.includes('reorgan') || normalized.includes('organizar')) return 'organize';
    if (normalized.includes('marca') || normalized.includes('watermark')) return 'watermark';
    if (normalized.includes('comprim') || normalized.includes('reduz')) return 'compress';
    if (normalized.includes('proteg') || normalized.includes('protect')) return 'protect';
    if (normalized.includes('desbloq') || normalized.includes('unlock') || (normalized.includes('remove') && normalized.includes('senha'))) return 'unlock';
    if (normalized.includes('ocultar') || normalized.includes('redig') || normalized.includes('redact')) return 'redact';
    return '';
  }

  function getActionLabel(actionLabel) {
    const type = getActionType(actionLabel);
    const map = {
      image: 'Converter para PDF',
      sign: 'Assinar PDF',
      convert: 'Converter para Word',
      merge: 'Mesclar',
      split: 'Separar PDFs',
      organize: 'Organizar Páginas',
      watermark: "Marca d'água",
      compress: 'Reduzir tamanho',
      protect: 'Proteger PDF',
      unlock: 'Desbloquear PDF',
      redact: 'Ocultar Dados'
    };
    return map[type] || actionLabel || 'Processamento PDF';
  }

  function renderHistory() {
    if (!dom.historyList) return;

    const historyItems = Array.isArray(state.appConfig?.recentHistory)
      ? state.appConfig.recentHistory
      : [];

    if (historyItems.length === 0) {
      dom.historyList.innerHTML = '<div class="empty-state">Nenhuma atividade recente.</div>';
      if (dom.historyExpandFooter) dom.historyExpandFooter.classList.add('hidden');
      dom.historyList.classList.remove('collapsed');
      return;
    }

    if (dom.historyExpandFooter) {
      if (historyItems.length > 5) {
        dom.historyExpandFooter.classList.remove('hidden');
      } else {
        dom.historyExpandFooter.classList.add('hidden');
        dom.historyList.classList.remove('collapsed');
      }
    }

    dom.historyList.innerHTML = historyItems.map((item, index) => {
      const formattedDate = new Date(item.timestamp).toLocaleString('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      });
      const iconName = actionIconMap[getActionType(item.action)] || 'file';
      const actionLabel = getActionLabel(item.action);
      const failedBadge = `<button class="history-badge failed is-actionable" type="button" data-history-error-index="${index}" title="Clique para ver o motivo do erro e abrir os logs">Erro</button>`;
      const successBadge = `<button class="history-badge success is-actionable" type="button" data-history-file-index="${index}" title="Abrir arquivo do resultado" aria-label="Abrir arquivo do resultado">Sucesso</button>`;
      return `
        <div class="history-item" title="${escapeHtml(item.fileName)}">
          <div class="action-file-info">
            ${icon(iconName, { size: 20, filled: true })}
            <div class="history-details">
              <span class="history-action">${escapeHtml(actionLabel)}</span>
              <span class="history-file">${escapeHtml(item.fileName)} - ${escapeHtml(formattedDate)}</span>
            </div>
          </div>
          ${item.status === 'sucesso' ? successBadge : failedBadge}
        </div>
      `;
    }).join('');

    dom.historyList.querySelectorAll('[data-history-file-index]').forEach((button) => {
      button.addEventListener('click', async () => {
        const item = state.appConfig?.recentHistory?.[Number(button.getAttribute('data-history-file-index'))];
        const filePath = item?.outputPath?.trim() || '';

        if (!filePath) {
          notifyMissingHistoryFile();
          return;
        }

        try {
          const exists = await windowApi.pathExists(filePath);
          if (!exists?.exists) {
            notifyMissingHistoryFile(filePath);
            return;
          }

          const result = await windowApi.openPath(filePath);
          if (!result?.success) {
            notify({
              tone: 'error',
              title: 'Abrir arquivo',
              message: result?.error || 'Não foi possível abrir o arquivo do resultado.'
            });
          }
        } catch (error) {
          notify({
            tone: 'error',
            title: 'Abrir arquivo',
            message: error?.message || 'Não foi possível abrir o arquivo do resultado.'
          });
        }
      });
    });

    dom.historyList.querySelectorAll('[data-history-error-index]').forEach((button) => {
      button.addEventListener('click', () => {
        const item = state.appConfig?.recentHistory?.[Number(button.getAttribute('data-history-error-index'))];
        notify({
          tone: 'error',
          title: item?.action || 'Falha na operação',
          message: buildHistoryErrorMessage(item),
          important: true,
          duration: 7600,
          actions: [
            {
              label: 'Abrir logs',
              onAction: () => {
                openLogsFromHistory().catch(() => {});
              }
            },
            {
              label: 'Mostrar logs',
              onAction: () => {
                revealLogsFromHistory().catch(() => {});
              }
            }
          ]
        });
      });
    });
  }

  return {
    setupQueueStatus,
    renderQueue,
    renderHistory,
    openRecentProcessedModal,
    closeRecentProcessedModal
  };
}








