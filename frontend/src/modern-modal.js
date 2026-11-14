import './modern-modal.css';

let modalSequence = 0;

export function showModernDialog({
  title = 'Notice',
  message = '',
  confirmText = 'OK',
  cancelText = 'Cancel',
  type = 'confirm',
  variant = 'default',
  defaultValue = '',
  placeholder = ''
} = {}) {
  return new Promise(resolve => {
    const previousFocus = document.activeElement;
    const dialog = document.createElement('dialog');
    const id = `modern-modal-title-${++modalSequence}`;
    dialog.className = `modern-modal-dialog${variant === 'danger' ? ' is-danger' : ''}${variant === 'error' ? ' is-error' : ''}`;
    dialog.setAttribute('aria-labelledby', id);
    const referralPage = document.body.classList.contains('referrals-page');
    const visualViewport = referralPage ? window.visualViewport : null;
    const syncReferralDialogViewport = () => {
      if (!referralPage) return;
      const width = visualViewport?.width ?? window.innerWidth;
      const height = visualViewport?.height ?? window.innerHeight;
      const offsetLeft = visualViewport?.offsetLeft ?? 0;
      const offsetTop = visualViewport?.offsetTop ?? 0;
      dialog.classList.toggle('is-mobile-viewport', width <= 980);
      dialog.style.setProperty('--modal-viewport-width', `${width}px`);
      dialog.style.setProperty('--modal-viewport-height', `${height}px`);
      dialog.style.setProperty('--modal-viewport-center-x', `${offsetLeft + width / 2}px`);
      dialog.style.setProperty('--modal-viewport-center-y', `${offsetTop + height / 2}px`);
    };
    const removeViewportListeners = () => {
      window.removeEventListener('resize', syncReferralDialogViewport);
      visualViewport?.removeEventListener('resize', syncReferralDialogViewport);
      visualViewport?.removeEventListener('scroll', syncReferralDialogViewport);
    };

    const form = document.createElement('form');
    form.className = 'modern-modal-form';

    const icon = document.createElement('span');
    icon.className = 'modern-modal-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = variant === 'danger' || variant === 'error' ? '!' : 'i';

    const eyebrow = document.createElement('p');
    eyebrow.className = 'modern-modal-eyebrow';
    eyebrow.textContent = variant === 'danger' ? 'Please confirm' : variant === 'error' ? 'Something went wrong' : 'ResumeOut';

    const heading = document.createElement('h2');
    heading.id = id;
    heading.textContent = title;

    const body = document.createElement('p');
    body.className = 'modern-modal-message';
    body.textContent = message;

    const actions = document.createElement('div');
    actions.className = 'modern-modal-actions';

    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'modern-modal-button modern-modal-button-secondary';
    cancelButton.textContent = cancelText;

    const confirmButton = document.createElement('button');
    confirmButton.type = 'submit';
    confirmButton.className = 'modern-modal-button modern-modal-button-primary';
    confirmButton.textContent = confirmText;
    confirmButton.autofocus = type === 'alert';

    const cancelResult = type === 'prompt' ? null : type === 'alert' ? true : false;
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      removeViewportListeners();
      if (dialog.open) dialog.close();
      dialog.remove();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
      resolve(result);
    };

    cancelButton.addEventListener('click', () => finish(cancelResult));
    form.addEventListener('submit', event => {
      event.preventDefault();
      finish(type === 'prompt' ? input.value.trim() : true);
    });
    dialog.addEventListener('cancel', event => {
      event.preventDefault();
      finish(cancelResult);
    });
    dialog.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      finish(cancelResult);
    });
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const bounds = dialog.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right
        || event.clientY < bounds.top || event.clientY > bounds.bottom) finish(cancelResult);
    });

    form.append(icon, eyebrow, heading, body);
    let input;
    if (type === 'prompt') {
      input = document.createElement('input');
      input.type = 'text';
      input.value = defaultValue;
      input.placeholder = placeholder;
      input.className = 'modern-modal-input';
      input.setAttribute('aria-label', title);
      form.append(input);
    }

    if (type !== 'alert') actions.append(cancelButton);
    actions.append(confirmButton);
    form.append(actions);
    dialog.append(form);
    document.body.append(dialog);
    syncReferralDialogViewport();
    window.addEventListener('resize', syncReferralDialogViewport);
    visualViewport?.addEventListener('resize', syncReferralDialogViewport);
    visualViewport?.addEventListener('scroll', syncReferralDialogViewport);
    dialog.showModal();
    if (type === 'prompt') {
      input.focus();
      input.select();
    } else if (type === 'alert') {
      confirmButton.focus();
    } else {
      cancelButton.focus();
    }
  });
}

export function confirmModern(options) {
  return showModernDialog({ ...options, type: 'confirm' });
}

export function alertModern(options) {
  return showModernDialog({ ...options, type: 'alert' });
}

export function promptModern(options) {
  return showModernDialog({ ...options, type: 'prompt' });
}
