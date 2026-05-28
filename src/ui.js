/*
 * ui.js — общие примитивы интерфейса: DOM-хелпер, логотип, индикатор
 * очереди, модальное окно. Используется screens.js и forms.js.
 */
window.UI = (() => {
  // Создать DOM-узел. attrs: class | text | on<Event> | прочие атрибуты.
  function h(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [key, value] of Object.entries(attrs)) {
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key.startsWith('on') && typeof value === 'function') {
          node.addEventListener(key.slice(2), value);
        } else if (value !== null && value !== undefined && value !== false) {
          node.setAttribute(key, value);
        }
      }
    }
    for (const child of children) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function clear(node) {
    node.innerHTML = '';
  }

  function logo() {
    return h('div', { class: 'logo' },
      h('span', { class: 'logo-mark' }),
      h('span', { class: 'logo-text' }, 'РЕНТО'));
  }

  // Индикатор очереди отправки (§5.3). Приоритет: провал > ошибка >
  // отправка > всё ок. status — объект Queue.getStatus().
  function queueIndicator(status, retrySeconds) {
    let cls, text;
    if (status.failed > 0) {
      cls = 'queue-failed';
      text = status.failed + ' операц. не удалось отправить';
    } else if (status.error > 0) {
      cls = 'queue-retry';
      text = retrySeconds != null
        ? 'Ошибка отправки, повтор через ' + retrySeconds + ' с'
        : 'Ошибка отправки, повторяем';
    } else if (status.pending + status.sending > 0) {
      cls = 'queue-sending';
      text = 'Отправляется ' + (status.pending + status.sending);
    } else {
      cls = 'queue-ok';
      text = 'Всё отправлено';
    }
    return h('div', { class: 'queue-chip ' + cls },
      h('span', { class: 'queue-dot' }),
      h('span', {}, text));
  }

  // Модальное окно. Возвращает { root, close }.
  // Формы переведены на полноэкранные экраны (ADR-006); модалки
  // остаются только под короткие подтверждения («Откатить?», «Сохранить?»)
  // — их вынесут сюда в Инкременте 3.
  function modal(title, contentNode, opts) {
    const options = opts || {};
    function close() {
      overlay.remove();
      if (options.onClose) options.onClose();
    }
    const closeBtn = h('button', { class: 'modal-close', type: 'button' }, '✕');
    closeBtn.addEventListener('click', close);

    const card = h('div', { class: 'modal-card' },
      h('div', { class: 'modal-head' },
        h('h2', { class: 'h2' }, title),
        closeBtn),
      contentNode);

    const overlay = h('div', { class: 'modal-overlay' }, card);
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) close(); // клик по фону закрывает
    });
    document.body.append(overlay);
    return { root: overlay, close };
  }

  return { h, clear, logo, queueIndicator, modal };
})();
