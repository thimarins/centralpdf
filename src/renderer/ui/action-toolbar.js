const TOOLBAR_GROUP_SELECTOR = [
  '.module-action-group:not(.module-action-group--primary):not(.ocr-file-actions)',
  '.inline-actions',
  '.signature-page-nav',
  '.signature-draw-toolbar',
  '.ocr-area-actions',
  '.about-actions-bar'
].join(', ');

function buttonLabel(button) {
  return String(button.getAttribute('aria-label') || button.getAttribute('title') || button.querySelector('span:last-child')?.textContent || button.textContent || '').trim();
}

function buttonPriority(button) {
  const explicit = Number(button.dataset.toolbarPriority);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const label = `${button.id} ${buttonLabel(button)}`.toLowerCase();
  if (/excluir|apagar|remover|limpar|cancelar|descartar/.test(label)) return 10;
  if (/primeir|últim|ultima|first|last/.test(label)) return 20;
  if (/adicionar|imagem|upload|arquivo/.test(label)) return 65;
  return 45;
}

function isActionAvailable(button, windowObject) {
  if (button.hidden || button.classList.contains('hidden')) return false;
  if (button.closest('[hidden], .hidden')) return false;
  return windowObject.getComputedStyle(button).display !== 'none';
}

function createOverflowControl(documentObject, container) {
  const trigger = documentObject.createElement('button');
  trigger.type = 'button';
  trigger.className = 'btn-secondary action-overflow-trigger';
  trigger.textContent = '⋯';
  trigger.title = 'Mais ações';
  trigger.setAttribute('aria-label', 'Mais ações');
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');

  const menu = documentObject.createElement('div');
  menu.className = 'action-overflow-menu hidden';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Mais ações');
  container.append(trigger, menu);
  return { trigger, menu };
}

function setupActionBar(container, { document: documentObject, window: windowObject, iconOnly = false }) {
  const buttons = [...container.querySelectorAll('button.btn-icon-label, button.btn-icon')]
    .filter((button) => !button.classList.contains('action-overflow-trigger') && !button.classList.contains('btn-primary'));
  if (!buttons.length) return;

  buttons.forEach((button) => {
    const label = buttonLabel(button);
    if (label) {
      if (!button.hasAttribute('aria-label')) button.setAttribute('aria-label', label);
      if (!button.hasAttribute('title')) button.setAttribute('title', label);
    }
  });

  container.classList.add('has-action-overflow');
  if (iconOnly) container.classList.add('action-toolbar-icon-only');
  const { trigger, menu } = createOverflowControl(documentObject, container);
  let updateFrame = 0;

  function hiddenButtons() {
    return buttons.filter((button) => button.classList.contains('action-overflow-hidden'));
  }

  function updateMenu() {
    container.querySelectorAll('[data-toolbar-separator]').forEach((separator) => {
      const previousButton = separator.previousElementSibling;
      const nextButton = separator.nextElementSibling;
      const visible = previousButton?.tagName === 'BUTTON'
        && nextButton?.tagName === 'BUTTON'
        && isActionAvailable(previousButton, windowObject)
        && isActionAvailable(nextButton, windowObject)
        && !previousButton.classList.contains('action-overflow-hidden')
        && !nextButton.classList.contains('action-overflow-hidden');
      separator.classList.toggle('hidden', !visible);
    });
    menu.replaceChildren();
    hiddenButtons().forEach((button) => {
      if (!isActionAvailable(button, windowObject)) return;
      const item = documentObject.createElement('button');
      item.type = 'button';
      item.className = `action-overflow-item${button.classList.contains('btn-critical') || button.classList.contains('btn-danger') ? ' action-overflow-item--critical' : ''}`;
      item.setAttribute('role', 'menuitem');
      item.disabled = button.disabled;
      const svg = button.querySelector('svg');
      if (svg) item.append(svg.cloneNode(true));
      const label = documentObject.createElement('span');
      label.textContent = buttonLabel(button);
      item.append(label);
      item.addEventListener('click', () => {
        menu.classList.add('hidden');
        trigger.setAttribute('aria-expanded', 'false');
        button.click();
      });
      menu.append(item);
    });
    trigger.classList.toggle('hidden', menu.childElementCount === 0);
  }

  let lastAvailable = -1;

  function fitActions() {
    const available = container.clientWidth;
    if (available === lastAvailable && available > 0) return;
    lastAvailable = available;

    const candidates = buttons.filter((button) => isActionAvailable(button, windowObject));
    candidates.forEach((button) => button.classList.remove('action-overflow-hidden', 'action-icon-only'));
    trigger.classList.add('hidden');
    menu.classList.add('hidden');
    if (iconOnly) {
      container.classList.add('action-toolbar-icon-only');
    } else {
      container.classList.remove('action-toolbar-icon-only');
    }

    windowObject.requestAnimationFrame(() => {
      const available = container.clientWidth;
      const isOverflowing = () => container.scrollWidth > available + 1;

      // Keep labels on the most useful actions. Collapse only as many lower
      // priority labels as needed; avoid turning the entire toolbar into icons.
      if (!iconOnly) {
        const compactOrder = [...candidates].sort((a, b) => buttonPriority(b) - buttonPriority(a));
        for (const button of compactOrder) {
          if (!isOverflowing()) break;
          button.classList.add('action-icon-only');
        }
      }

      // If icons still do not fit, move the least important actions into ⋯.
      if (isOverflowing()) {
        const overflowOrder = [...candidates].sort((a, b) => buttonPriority(a) - buttonPriority(b));
        trigger.classList.remove('hidden');
        for (const button of overflowOrder) {
          if (!isOverflowing()) break;
          button.classList.add('action-overflow-hidden');
        }
      }
      updateMenu();
    });
  }

  function scheduleFit() {
    windowObject.cancelAnimationFrame(updateFrame);
    updateFrame = windowObject.requestAnimationFrame(fitActions);
  }

  trigger.addEventListener('click', (event) => {
    event.stopPropagation();
    const open = menu.classList.contains('hidden');
    if (open) updateMenu();
    menu.classList.toggle('hidden', !open);
    trigger.setAttribute('aria-expanded', String(open));
  });
  documentObject.addEventListener('click', (event) => {
    if (container.contains(event.target)) return;
    menu.classList.add('hidden');
    trigger.setAttribute('aria-expanded', 'false');
  });
  documentObject.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || menu.classList.contains('hidden')) return;
    menu.classList.add('hidden');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.focus();
  });

  const resizeObserver = new windowObject.ResizeObserver(scheduleFit);
  resizeObserver.observe(container);
  const mutationObserver = new windowObject.MutationObserver((records) => {
    const availabilityChanged = records.some((record) => {
      if (record.target === menu || menu.contains(record.target) || record.target === trigger) return false;
      if (record.target === container && record.attributeName === 'class') return false;
      if (record.attributeName === 'class') {
        const oldHidden = String(record.oldValue || '').split(/\s+/).includes('hidden');
        const newHidden = record.target.classList.contains('hidden');
        return oldHidden !== newHidden;
      }
      return ['hidden', 'disabled', 'data-selection'].includes(record.attributeName);
    });
    if (availabilityChanged) scheduleFit();
  });
  mutationObserver.observe(container, {
    subtree: true,
    attributes: true,
    attributeOldValue: true,
    attributeFilter: ['class', 'hidden', 'disabled', 'data-selection']
  });
  scheduleFit();
}

export function initializeActionToolbars(documentObject = document, windowObject = window) {
  const toolbarRoots = [...documentObject.querySelectorAll('[data-action-toolbar]')];
  toolbarRoots.forEach((container) => setupActionBar(container, {
    document: documentObject,
    window: windowObject,
    iconOnly: container.dataset.actionToolbar === 'true'
  }));

  const groups = [...documentObject.querySelectorAll(TOOLBAR_GROUP_SELECTOR)];
  groups.forEach((container) => {
    // The page organizer uses a hand-laid-out grouped toolbar. Its nested
    // button rows must not each become independent overflow toolbars.
    if (container.closest('.organize-toolbar-actions')) return;
    if (container.closest('.organize-selection-actions')) return;
    if (container.closest('.file-selection-actions')) return;
    if (container.closest('[data-action-toolbar]')) return;
    setupActionBar(container, { document: documentObject, window: windowObject });
  });
}
