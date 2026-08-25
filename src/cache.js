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
  // Справочники файла сервиса (ADR-031) — отдельный словарь: имена
  // листов двух файлов не должны молча перемешиваться.
  let serviceData = {};
  // Режим исполнителя (SERVICE_SPEC §2.4): у горничной/техника/
  // супервайзера нет доступа к боевому файлу — refresh() читает только
  // файл сервиса. Включает app.js, когда боевой batchGet вернул 403,
  // а сервисный прошёл.
  let serviceOnly = false;
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

  // Справочники файла сервиса вторым batchGet (ADR-031, TICKET-С1.1).
  async function refreshService() {
    const sheets = CONFIG.SERVICE_REFERENCE_SHEETS;
    const valueRanges = await Sheets.batchGet(sheets, CONFIG.SERVICE_SPREADSHEET_ID);
    const next = {};
    sheets.forEach((name, i) => {
      const vr = valueRanges[i];
      next[name] = rowsToObjects(vr && vr.values);
    });
    serviceData = next;
  }

  // Полный batch-запрос всех справочников. В режиме исполнителя
  // (serviceOnly) боевой файл не читается вообще — только файл сервиса;
  // кнопка «Обновить справочники» и авто-таймер работают без изменений.
  async function refresh() {
    if (serviceOnly) {
      await refreshService();
      lastUpdated = new Date();
      listeners.forEach((fn) => fn());
      return;
    }
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
    // Файл сервиса для менеджера — вспомогательный: если он не
    // расшарен или недоступен, интерфейс учёта работает как раньше.
    // Громко в консоль, но сессию не валим.
    try {
      await refreshService();
    } catch (err) {
      serviceData = {};
      console.warn('Справочники файла сервиса недоступны:', err);
    }
    listeners.forEach((fn) => fn());
  }

  // Все строки листа (без фильтров).
  function get(sheet) {
    return data[sheet] || [];
  }

  // Строки листа файла сервиса (ADR-031).
  function getService(sheet) {
    return serviceData[sheet] || [];
  }

  // Активные исполнители из спр_исполнители файла сервиса (§2.4).
  function serviceExecutors() {
    return getService('спр_исполнители').filter(isActiveRow);
  }

  // Строки листа, готовые для выпадашки: активные + актуальная версия.
  function forDropdown(sheet) {
    return get(sheet).filter((r) => isActiveRow(r) && isCurrentVersion(r));
  }

  // Активные сотрудники для выбора пользователя при входе (§2.1).
  //
  // Плюс подрядчики (мастера/горничные) с флагом `доступ_в_интерфейс = да`
  // — ограниченная роль: видят только доску задач и только свои задачи
  // (решение фаундера 14.07). Их НЕ дублируем строкой в `спр_сотрудники`:
  // подрядчик входит под своим РОДНЫМ bare-id (MST-001), тем же, что стоит
  // в `ответственный` задачи — иначе «свои задачи» не сматчились бы.
  //
  // Роль синтезируем («мастер»/«горничная») — по ней app.js решает, что
  // показывать. Форма объекта та же, что у сотрудника: id_сотрудника/фио/роль.
  // Исполнители файла сервиса как варианты входа (SERVICE_SPEC §2.4).
  // Форма объекта та же, что у сотрудника; роль из спр_исполнители
  // (горничная/техник/супервайзер) решает набор экранов в app.js.
  // id_в_учёте сохраняем: по нему дедуп с подрядчиками ADR-028 и
  // (с С1.3) резолв версии для начисления.
  function executorLoginOptions() {
    return serviceExecutors().map((r) => ({
      'id_сотрудника': r['id_исполнителя'],
      'фио': r['фио'] || r['id_исполнителя'],
      'роль': r['роль'],
      'статус': 'активный',
      'id_в_учёте': r['id_в_учёте'] || '',
      '_исполнитель': true,
    }));
  }

  function activeEmployees() {
    // Режим исполнителя: боевого файла нет, список входа — только
    // спр_исполнители файла сервиса.
    if (serviceOnly) return executorLoginOptions();

    const staff = forDropdown('спр_сотрудники');
    const CONTRACTORS = [
      ['спр_мастера', 'id_мастера', 'мастер'],
      ['спр_горничные', 'id_горничной', 'горничная'],
    ];
    const guests = [];
    CONTRACTORS.forEach(([sheet, idField, role]) => {
      forDropdown(sheet).forEach((r) => {
        const flag = String(r['доступ_в_интерфейс'] || '').trim().toLowerCase();
        if (flag !== 'да' && flag !== 'yes' && flag !== 'true') return;
        guests.push({
          'id_сотрудника': r[idField],
          'фио': r['фио'] || r[idField],
          'роль': role,
          'статус': 'активный',
        });
      });
    });
    // Переходный период С1 (ADR-028 → ADR-031): пока у подрядчика есть
    // доступ к боевому файлу, его старый вход (родной id, рабочая доска
    // задач боевого) главнее — исполнителя с тем же id_в_учёте в списке
    // не дублируем. Когда в С1.2 появится доска из файла сервиса,
    // приоритет развернётся и доступ подрядчиков к боевому отзовётся
    // (DoD С1).
    const contractorIds = new Set(guests.map((g) => g['id_сотрудника']));
    const executors = executorLoginOptions().filter(
      (e) => !contractorIds.has(e['id_в_учёте']));
    return staff.concat(guests, executors);
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
    refreshService,
    get,
    getService,
    serviceExecutors,
    forDropdown,
    activeEmployees,
    startAutoRefresh,
    stopAutoRefresh,
    onUpdate,
    getLastUpdated: () => lastUpdated,
    setServiceOnly: (flag) => { serviceOnly = !!flag; },
    isServiceOnly: () => serviceOnly,
  };
})();
