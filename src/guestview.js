/*
 * guestview.js — отрисовка пути гостя (ADR-036 п.6–7).
 *
 * Один и тот же рендер используют два потребителя:
 *   - guest.html (страница гостя: расшифровала блоб → render);
 *   - карточка квартиры (переключатель «Путь гостя» — превью из
 *     текущего паспорта, без ссылки и публикации).
 *
 * Вся отрисовка — createElement/textContent (никакого innerHTML с
 * данными): содержимое хоть и наше, но правило — не доверять.
 */
window.GuestView = (() => {
  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null && text !== '') node.textContent = text;
    return node;
  }
  function add(parent, node) { parent.appendChild(node); return node; }

  function fmtDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
    return m ? m[3] + '.' + m[2] + '.' + m[1] : String(s || '');
  }

  const SEC_TITLES = {
    'заселение': 'Как добраться',
    'техника': 'Как пользоваться',
    'быт': 'Полезное в квартире',
    'район': 'Что рядом',
    'аварийное': 'Если что-то случилось',
    'выезд': 'Выезд',
    'faq': 'Частые вопросы',
  };

  function render(container, p) {
    container.innerHTML = '';
    const wrap = add(container, el('div', 'g-wrap'));
    const f = p['факты'] || {};
    const instr = p['инструкции'] || [];
    const bySec = (name) => instr.filter((i) => i['раздел'] === name);

    // --- шапка ---
    const hero = add(wrap, el('div', 'g-hero'));
    const logo = add(hero, el('div', 'g-logo'));
    add(logo, el('span', 'g-logo-dot', 'Р'));
    add(logo, el('span', 'g-logo-word', 'Ренто'));
    add(hero, el('h1', '', 'Добро пожаловать!'));
    const kv = p['квартира'] || {};
    add(hero, el('p', '', [kv['адрес'],
      kv['этаж'] ? kv['этаж'] + ' этаж' : ''].filter(Boolean).join(' · ')));
    add(hero, el('p', '', 'Ваши даты: ' + fmtDate(p['заезд']) + ' — ' +
      fmtDate(p['выезд'])));
    const chips = add(hero, el('div', 'g-hero-chips'));
    if (f['заезд_с']) add(chips, el('span', 'g-hero-chip', 'Заезд с ' + f['заезд_с']));
    if (f['выезд_до']) add(chips, el('span', 'g-hero-chip', 'Выезд до ' + f['выезд_до']));
    if (String(f['бесконтактное']).toLowerCase() === 'да') {
      add(chips, el('span', 'g-hero-chip', 'Бесконтактное заселение'));
    }

    // --- заселение ---
    const sIn = add(wrap, el('section', 'g-sec'));
    add(sIn, el('h2', '', 'Заселение'));
    const codes = add(sIn, el('div', 'g-codes'));
    const code = (lbl, val, plain) => {
      if (!val) return;
      const c = add(codes, el('div', 'g-code' + (plain ? ' g-code-plain' : '')));
      add(c, el('span', 'lbl', lbl));
      add(c, el('div', 'val', val));
    };
    code('Код подъезда', f['код_подъезда']);
    code('Код замка', f['код_замка']);
    if (f['тип_замка']) code('Замок', f['тип_замка'], true);
    if (f['парковка']) code('Парковка', f['парковка'], true);
    bySec('заселение').forEach((i) =>
      add(sIn, el('p', 'g-note', (i['заголовок'] ? i['заголовок'] + '. ' : '') + i['текст'])));

    // --- wi-fi ---
    if (f['wifi_сеть'] || f['wifi_пароль']) {
      const sWifi = add(wrap, el('section', 'g-sec'));
      add(sWifi, el('h2', '', 'Wi-Fi'));
      const wcodes = add(sWifi, el('div', 'g-codes'));
      const wc = (lbl, val) => {
        if (!val) return;
        const c = add(wcodes, el('div', 'g-code g-code-plain'));
        add(c, el('span', 'lbl', lbl));
        add(c, el('div', 'val', val));
      };
      wc('Сеть', f['wifi_сеть']);
      wc('Пароль', f['wifi_пароль']);
      if (f['роутер']) add(sWifi, el('p', 'g-note', 'Роутер: ' + f['роутер']));
    }

    // --- инструкции по разделам ---
    ['техника', 'быт', 'район', 'faq'].forEach((secName) => {
      const items = bySec(secName);
      if (!items.length) return;
      const s = add(wrap, el('section', 'g-sec'));
      add(s, el('h2', '', SEC_TITLES[secName]));
      items.forEach((i) => {
        const d = add(s, el('details', 'g-item'));
        const sum = add(d, el('summary', '', i['заголовок'] || '…'));
        add(sum, el('span', 'g-arrow', '▸'));
        add(d, el('div', 'g-item-body', i['текст']));
      });
    });

    // --- правила ---
    const sRules = add(wrap, el('section', 'g-sec'));
    add(sRules, el('h2', '', 'Правила дома'));
    const rules = add(sRules, el('div', 'g-rules'));
    const rule = (ok, text) => {
      const r = add(rules, el('div', 'g-rule'));
      add(r, el('span', ok ? 'yes' : 'no', ok ? '✓' : '✕'));
      add(r, el('span', '', text));
    };
    const yes = (v) => String(v || '').trim().toLowerCase();
    if (f['дети']) rule(yes(f['дети']) !== 'нельзя' && yes(f['дети']) !== 'нет', 'Дети: ' + f['дети']);
    if (f['питомцы']) rule(yes(f['питомцы']) !== 'нельзя' && yes(f['питомцы']) !== 'нет', 'Питомцы: ' + f['питомцы']);
    if (f['курение']) rule(false, 'Курение: ' + f['курение']);
    if (f['вечеринки']) rule(false, 'Вечеринки: ' + f['вечеринки']);
    if (f['макс_гостей']) rule(true, 'До ' + f['макс_гостей'] + ' гостей');
    if (f['залог']) rule(true, 'Залог ' + f['залог'] + ' ₽ — вернём при выезде');
    if (f['мин_возраст']) rule(true, 'Заезд с ' + f['мин_возраст'] + ' лет');

    // --- мусор и «что где лежит» ---
    if (f['мусор'] || f['бельё_гостям'] || f['полотенца']) {
      const sHome = add(wrap, el('section', 'g-sec'));
      add(sHome, el('h2', '', 'Бытовое'));
      if (f['мусор']) add(sHome, el('p', 'g-note', 'Мусор: ' + f['мусор']));
      if (f['бельё_гостям']) add(sHome, el('p', 'g-note', 'Дополнительный комплект белья: ' + f['бельё_гостям']));
      if (f['полотенца']) add(sHome, el('p', 'g-note', 'Полотенца: ' + f['полотенца']));
    }

    // --- честно о квартире ---
    const defs = p['дефекты'] || [];
    if (defs.length) {
      const sHon = add(wrap, el('section', 'g-sec'));
      add(sHon, el('h2', '', 'Честно о квартире'));
      defs.forEach((d) => {
        const c = add(sHon, el('div', 'g-honest', d['описание']));
        if (d['статус'] === 'в_работе') {
          add(c, el('div', 'fixing', 'Уже чиним — зафиксировано до вашего заезда.'));
        } else {
          add(c, el('div', 'fixing', 'Зафиксировано до вашего заезда — это не к вам.'));
        }
      });
    }

    // --- акт приёмки ---
    const act = p['акт'] || [];
    if (act.length) {
      const sAct = add(wrap, el('section', 'g-sec'));
      add(sAct, el('h2', '', 'Акт приёмки'));
      add(sAct, el('p', 'g-note',
        'Вместе с квартирой вы принимаете имущество по списку ниже — ' +
        'с заселения и до выезда оно под вашей ответственностью ' +
        '(пункт договора аренды). Всё, что было не идеально до вас, ' +
        'уже зафиксировано выше.'));
      let pos = 0;
      let qty = 0;
      act.forEach((g) => g.p.forEach((i) => { pos += 1; qty += (Number(i.k) || 1); }));
      add(sAct, el('p', 'g-act-total',
        'Всего: ' + pos + ' поз. · ' + qty + ' шт — на дату заезда'));
      act.forEach((g) => {
        const d = add(sAct, el('details', 'g-item'));
        const sum = add(d, el('summary', '',
          g.n + ' · ' + g.p.length + ' поз.'));
        add(sum, el('span', 'g-arrow', '▸'));
        const bodyEl = add(d, el('div', 'g-item-body'));
        bodyEl.style.whiteSpace = 'normal';
        g.p.forEach((i) => {
          const r = add(bodyEl, el('div', 'g-act-row'));
          add(r, el('span', '', i.n));
          add(r, el('span', 'g-act-qty',
            '× ' + (i.k || 1) + (i.s ? ' · ' + i.s : '')));
        });
      });
    }

    // --- аварийное + выезд + контакт ---
    const tail = bySec('аварийное').concat(bySec('выезд'));
    if (tail.length) {
      const sTail = add(wrap, el('section', 'g-sec'));
      add(sTail, el('h2', '', 'Выезд и на всякий случай'));
      tail.forEach((i) => add(sTail, el('p', 'g-note',
        (i['заголовок'] ? i['заголовок'] + '. ' : '') + i['текст'])));
    }
    const sC = add(wrap, el('section', 'g-sec'));
    add(sC, el('h2', '', 'Связь с нами'));
    add(sC, el('p', 'g-note', p['контакт'] ||
      'Напишите менеджеру — контакт в подтверждении брони.'));

    add(wrap, el('p', 'g-footer',
      'Страница собрана из паспорта квартиры и действует до ' +
      fmtDate(p['выезд']) + ' (+' + (p['грейс_дни'] || 2) + ' дн.). ' +
      'Показывается только то, что предназначено гостю.'));
  }

  return { render, el, add };
})();
