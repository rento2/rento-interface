/*
 * guest.js — путь гостя (ADR-036 п.6–7, TICKET-П6).
 *
 * Страница без входа: токен из URL-фрагмента (#...) → строка в
 * опубликованном CSV листа `гостевые_блобы` находится по
 * SHA-256('rento-guest:'+токен), содержимое расшифровывается
 * AES-GCM ключом SHA-256(токен) прямо в браузере гостя. Никаких
 * ключей к нашим файлам у страницы нет; менять гость ничего не может
 * по построению — публикация листа read-only.
 *
 * Вся отрисовка — createElement/textContent (никакого innerHTML с
 * данными): содержимое блоба хоть и наше, но правило — не доверять.
 */
(() => {
  const box = () => document.getElementById('guest');

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null && text !== '') node.textContent = text;
    return node;
  }
  function add(parent, node) { parent.appendChild(node); return node; }

  function status(title, note, mark) {
    const b = box();
    b.innerHTML = '';
    const card = el('div', 'g-status');
    const logo = el('div', 'g-logo');
    logo.style.justifyContent = 'center';
    add(logo, el('span', 'g-logo-dot', 'Р'));
    add(logo, el('span', 'g-logo-word', 'Ренто'));
    logo.querySelector('.g-logo-word').style.color = 'var(--ink)';
    add(card, logo);
    add(card, el('h1', '', title));
    add(card, el('p', '', note));
    if (mark) add(card, el('p', '', mark));
    add(b, card);
  }

  async function sha256Hex(s) {
    const d = await crypto.subtle.digest('SHA-256',
      new TextEncoder().encode(s));
    return [...new Uint8Array(d)]
      .map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  function b64ToBuf(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  async function decrypt(token, ivB64, blobB64) {
    const keyBytes = await crypto.subtle.digest('SHA-256',
      new TextEncoder().encode(token));
    const key = await crypto.subtle.importKey('raw', keyBytes,
      'AES-GCM', false, ['decrypt']);
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBuf(ivB64) }, key, b64ToBuf(blobB64));
    return JSON.parse(new TextDecoder().decode(pt));
  }

  // Минимальный CSV-парсер с поддержкой кавычек (публикация Google).
  function parseCsv(text) {
    const rows = [];
    let row = [];
    let cell = '';
    let inQ = false;
    for (let i = 0; i < text.length; i += 1) {
      const c = text[i];
      if (inQ) {
        if (c === '"') {
          if (text[i + 1] === '"') { cell += '"'; i += 1; } else inQ = false;
        } else cell += c;
      } else if (c === '"') {
        inQ = true;
      } else if (c === ',') {
        row.push(cell); cell = '';
      } else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i += 1;
        row.push(cell); cell = '';
        rows.push(row); row = [];
      } else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

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

  function render(p) {
    const b = box();
    b.innerHTML = '';
    const wrap = add(b, el('div', 'g-wrap'));
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
    bySec('аварийное').concat(bySec('выезд')).forEach((i, idx, arr) => {
      if (idx === 0) {
        const s = add(wrap, el('section', 'g-sec'));
        s.id = 'g-last-sec';
        add(s, el('h2', '', 'Выезд и на всякий случай'));
      }
      const s = document.getElementById('g-last-sec');
      add(s, el('p', 'g-note',
        (i['заголовок'] ? i['заголовок'] + '. ' : '') + i['текст']));
    });
    const sC = add(wrap, el('section', 'g-sec'));
    add(sC, el('h2', '', 'Связь с нами'));
    add(sC, el('p', 'g-note', p['контакт'] ||
      'Напишите менеджеру — контакт в подтверждении брони.'));

    add(wrap, el('p', 'g-footer',
      'Страница собрана из паспорта квартиры и действует до ' +
      fmtDate(p['выезд']) + ' (+' + (p['грейс_дни'] || 2) + ' дн.). ' +
      'Показывается только то, что предназначено гостю.'));
  }

  async function main() {
    const CONFIG = window.RENTO_CONFIG || {};
    const token = (location.hash || '').replace(/^#/, '').trim();
    if (!token) {
      status('Ссылка неполная', 'Похоже, ссылка обрезалась при пересылке. ' +
        'Попросите менеджера прислать её ещё раз.');
      return;
    }
    if (!CONFIG.GUEST_BLOBS_CSV_URL) {
      status('Страница ещё настраивается',
        'Попросите менеджера прислать ссылку чуть позже.');
      return;
    }
    status('Открываем…', 'Секунду, загружаем данные квартиры.');
    let rows;
    try {
      const res = await fetch(CONFIG.GUEST_BLOBS_CSV_URL, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      rows = parseCsv(await res.text());
    } catch (err) {
      status('Не получилось загрузить',
        'Проверьте интернет и обновите страницу. Если не помогает — ' +
        'напишите менеджеру.');
      return;
    }
    const headers = rows.length ? rows[0] : [];
    const hIdx = headers.indexOf('hash');
    const ivIdx = headers.indexOf('iv');
    const bIdx = headers.indexOf('blob');
    const hash = (await sha256Hex('rento-guest:' + token)).slice(0, 32);
    const row = rows.slice(1).find((r) => (r[hIdx] || '').trim() === hash);
    if (!row || !(row[bIdx] || '').trim()) {
      status('Ссылка не активна',
        'Ссылка погашена или ещё не успела опубликоваться (до ~5 минут ' +
        'после создания). Если вы только что её получили — обновите ' +
        'страницу чуть позже.');
      return;
    }
    let payload;
    try {
      payload = await decrypt(token, row[ivIdx].trim(), row[bIdx].trim());
    } catch (err) {
      status('Ссылка не читается',
        'Похоже, ссылка повреждена при пересылке. Попросите менеджера ' +
        'прислать её ещё раз.');
      return;
    }
    // Срок действия: выезд + грейс-дни.
    const out = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(payload['выезд'] || ''));
    if (out) {
      const until = new Date(+out[1], +out[2] - 1, +out[3]);
      until.setDate(until.getDate() + (Number(payload['грейс_дни']) || 2));
      if (new Date() > until) {
        status('Срок действия ссылки истёк',
          'Надеемся, вам у нас понравилось! По любым вопросам — ' +
          (payload['контакт'] || 'напишите менеджеру.'));
        return;
      }
    }
    render(payload);
  }

  document.addEventListener('DOMContentLoaded', main);
  // Смена фрагмента не перезагружает документ — а токен живёт именно
  // там. Перечитываем страницу, чтобы не показать данные по старому.
  window.addEventListener('hashchange', () => location.reload());
})();
