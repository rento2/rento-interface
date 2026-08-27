/*
 * guest.js — страница гостя (ADR-036 п.6–7, TICKET-П6).
 *
 * Без входа: токен из URL-фрагмента (#...) → строка в опубликованном
 * CSV листа `гостевые_блобы` находится по SHA-256('rento-guest:'+токен),
 * содержимое расшифровывается AES-GCM ключом SHA-256(токен) прямо в
 * браузере гостя. Ключей к нашим файлам у страницы нет; менять гость
 * ничего не может по построению — публикация листа read-only.
 * Отрисовка — общий модуль GuestView (он же рисует превью в карточке).
 */
(() => {
  const box = () => document.getElementById('guest');

  function status(title, note) {
    const b = box();
    b.innerHTML = '';
    const card = GuestView.el('div', 'g-status');
    const logo = GuestView.el('div', 'g-logo');
    logo.style.justifyContent = 'center';
    GuestView.add(logo, GuestView.el('span', 'g-logo-dot', 'Р'));
    const word = GuestView.el('span', 'g-logo-word', 'Ренто');
    word.style.color = 'var(--ink)';
    GuestView.add(logo, word);
    GuestView.add(card, logo);
    GuestView.add(card, GuestView.el('h1', '', title));
    GuestView.add(card, GuestView.el('p', '', note));
    GuestView.add(b, card);
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
    GuestView.render(box(), payload);
  }

  document.addEventListener('DOMContentLoaded', main);
  // Смена фрагмента не перезагружает документ — а токен живёт именно
  // там. Перечитываем страницу, чтобы не показать данные по старому.
  window.addEventListener('hashchange', () => location.reload());
})();
