/*
 * cache.js — кеш справочников в памяти страницы.
 *
 * При старте сессии (и далее по кнопке / по таймеру) одним batchGet
 * грузятся все 14 листов-справочников. Кеш живёт только в памяти —
 * при перезагрузке страницы пропадает и грузится заново (это норма,
 * TICKET-1.2, грабли #3).
 *
 * Фильтры выпадашек (INTERFACE_DATA_SPEC §3.2):
 *  - где есть `статус` / `активна` — только активные;
 *  - версионированные (есть `действует_по`) — только актуальная версия.
 */
window.Cache = (() => {
  const CONFIG = window.RENTO_CONFIG;

  // sheetName -> массив строк-объектов { заголовок: значение }
  let data = {};
  let lastUpdated = null;
  let refreshTimer = null;
  const listeners = [];

  // Первая строка листа = заголовки, остальные — записи.
  function rowsToObjects(values) {
    if (!values || values.length < 2) return [];
    const headers = values[0];
    // Две колонки с одинаковым заголовком молча перезаписали бы друг
    // друга — предупреждаем (REVIEW-1.2, замечание #5).
    const seen = new Set();
    for (const hdr of headers) {
      if (seen.has(hdr)) {
        console.warn('Cache: повторяющийся заголовок «' + hdr +
          '» — данные одной из колонок будут потеряны.');
      }
      seen.add(hdr);
    }
    return values.slice(1).map((row) => {
      const obj = {};
      headers.forEach((header, i) => {
        obj[header] = row[i] !== undefined ? row[i] : '';
      });
      return obj;
    });
  }

  // Значение трактуется как «активно». Справочники используют разные
  // формы слова: сотрудники — «активный», горничные — «активная»,
  // объекты — «активен», категории — «активна»/«да» (FINANCE_SPEC §4).
  function isActiveValue(value) {
    const s = String(value || '').trim().toLowerCase();
    return ['активный', 'активная', 'активен', 'активна',
      'да', 'yes', 'true', '1'].includes(s);
  }

  // Строка справочника активна (по полю `статус` или `активна`).
  // Если поля активности нет — строка показывается всегда.
  function isActiveRow(row) {
    if ('статус' in row && String(row['статус']).trim()) {
      return isActiveValue(row['статус']);
    }
    if ('активна' in row && String(row['активна']).trim()) {
      return isActiveValue(row['активна']);
    }
    return true;
  }

  // Строка — актуальная версия (нет колонки `действует_по` либо она пуста).
  function isCurrentVersion(row) {
    if (!('действует_по' in row)) return true;
    return !String(row['действует_по']).trim();
  }

  // Полный batch-запрос всех справочников.
  async function refresh() {
    const sheets = CONFIG.REFERENCE_SHEETS;
    const valueRanges = await Sheets.batchGet(sheets);
    const next = {};
    // valueRanges возвращаются в порядке запрошенных ranges.
    sheets.forEach((name, i) => {
      const vr = valueRanges[i];
      next[name] = rowsToObjects(vr && vr.values);
    });
    data = next;
    lastUpdated = new Date();
    listeners.forEach((fn) => fn());
  }

  // Все строки листа (без фильтров).
  function get(sheet) {
    return data[sheet] || [];
  }

  // Строки листа, готовые для выпадашки: активные + актуальная версия.
  function forDropdown(sheet) {
    return get(sheet).filter((r) => isActiveRow(r) && isCurrentVersion(r));
  }

  // Активные сотрудники для выбора пользователя при входе (§2.1).
  function activeEmployees() {
    return forDropdown('спр_сотрудники');
  }

  // Запуск авто-обновления каждые 30 минут (§3.1).
  // onError(err) — обработчик ошибок таймера (app.js передаёт сюда
  // общий handleSheetsError, чтобы 401 после протухания токена не
  // терялся молча, а вёл на переподключение — REVIEW-1.2, правка 2).
  function startAutoRefresh(onError) {
    stopAutoRefresh();
    refreshTimer = setInterval(() => {
      refresh().catch((err) => {
        if (typeof onError === 'function') onError(err);
        else console.error('Авто-обновление кеша:', err);
      });
    }, CONFIG.REFRESH_INTERVAL_MS);
  }

  function stopAutoRefresh() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  // Подписка на обновление кеша (для перерисовки UI).
  function onUpdate(fn) {
    listeners.push(fn);
  }

  return {
    refresh,
    get,
    forDropdown,
    activeEmployees,
    startAutoRefresh,
    stopAutoRefresh,
    onUpdate,
    getLastUpdated: () => lastUpdated,
  };
})();
