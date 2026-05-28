/*
 * journal.js — доменный слой журналов: чтение, append-запись,
 * идемпотентность, генерация id_операции, лог действий.
 *
 * Журналы — append-only event log (принцип §1.2): строки не удаляются
 * и не редактируются. Единственная правка — смена статуса при откате
 * (§15), и она тоже переписывает только нужные ячейки строки.
 *
 * Транспорт — Sheets; здесь только доменная логика журналов.
 */
window.Journal = (() => {
  const CONFIG = window.RENTO_CONFIG;

  // Индекс колонки -> буква A1 (0 -> A, 25 -> Z, 26 -> AA).
  function colLetter(index) {
    let s = '';
    let i = index + 1;
    while (i > 0) {
      const m = (i - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      i = Math.floor((i - 1) / 26);
    }
    return s;
  }

  // Сегодняшняя дата клиента в формате YYYY-MM-DD (для OP-id, §4.1).
  function todayStr() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  // ISO-строка относится к сегодняшнему дню (по локальному времени)?
  function isToday(isoString) {
    if (!isoString) return false;
    const d = new Date(isoString);
    if (isNaN(d)) return false;
    const now = new Date();
    return d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
  }

  // Разобрать сырые values листа в { headers, records }.
  // record = { data: {колонка: значение}, rowNumber: номер строки листа }.
  // Строка 1 листа — заголовки, первая запись — строка 2.
  function parseValues(values) {
    if (!values || !values.length) return { headers: [], records: [] };
    const headers = values[0];
    const records = values.slice(1).map((row, i) => {
      const data = {};
      headers.forEach((h, c) => { data[h] = row[c] !== undefined ? row[c] : ''; });
      return { data, rowNumber: i + 2 };
    });
    return { headers, records };
  }

  // Прочитать журнал целиком: { headers, records }.
  async function read(sheetName) {
    return parseValues(await Sheets.getValues(sheetName));
  }

  // Прочитать несколько журналов одним batchGet (для секции «сегодня»,
  // которая в Инкременте 3 собирает записи из всех журналов сразу).
  // Возвращает { имя_листа: { headers, records } }.
  async function readMany(sheetNames) {
    const valueRanges = await Sheets.batchGet(sheetNames);
    const result = {};
    sheetNames.forEach((name, i) => {
      const vr = valueRanges[i];
      result[name] = parseValues(vr && vr.values);
    });
    return result;
  }

  // Записи журнала, внесённые сегодня (по `дата_внесения`).
  function todayRecords(records) {
    return records.filter((r) => isToday(r.data['дата_внесения']));
  }

  // Следующий id_операции формата OP-YYYY-MM-DD-NNN.
  // Считает только OP-* за сегодня, MAN-* игнорирует (ADR-003).
  function nextOpId(records) {
    const date = todayStr();
    const re = new RegExp('^OP-' + date + '-(\\d{3})$');
    let max = 0;
    for (const r of records) {
      const m = re.exec(String(r.data['id_операции'] || ''));
      if (m) {
        const n = parseInt(m[1], 10);
        if (n > max) max = n;
      }
    }
    return `OP-${date}-${String(max + 1).padStart(3, '0')}`;
  }

  // Собрать массив строки в порядке заголовков листа.
  function buildRow(headers, dataObject) {
    return headers.map((h) => {
      const v = dataObject[h];
      return v !== undefined && v !== null ? v : '';
    });
  }

  // Идемпотентная запись операции в журнал (§4.3).
  //
  // id_операции — сквозной счётчик за день по всем 9 журналам (ADR-009):
  // читаем весь набор журналов одним batchGet, NNN = максимум среди всех
  // OP-* за дату + 1. Тот же batchGet обслуживает и проверку дубля по
  // client_uuid (в целевом журнале), лишних запросов нет.
  //
  // Если строка с таким client_uuid уже есть — возвращает её
  // id_операции, дубликат не пишет. Иначе генерирует id_операции,
  // дописывает строку и возвращает новый id.
  //
  // opts.requireActiveRoot — id корня цепочки корректировок (TICKET-6.1,
  // REVIEW-6 #6). Используется sender'ом 'корректировка', чтобы убедиться,
  // что между submit'ом в UI и фактической записью корень не был
  // отменён (а ретрай не доставил бы корректировку к уже неактивной
  // операции). Если корень не найден в журнале — кидаем ошибку до
  // записи; если найден но статус='отменена' — кидаем тоже. Проверка
  // идёт по тому же batchGet, лишних запросов нет.
  async function appendOperation(sheetName, dataObject, opts) {
    const byJournal = await readMany(CONFIG.JOURNALS);
    const target = byJournal[sheetName] || { headers: [], records: [] };

    const uuid = dataObject['client_uuid'];
    if (uuid) {
      const existing = target.records.find(
        (r) => r.data['client_uuid'] === uuid);
      if (existing) return existing.data['id_операции'];
    }

    const requireActiveRoot = opts && opts.requireActiveRoot;
    if (requireActiveRoot) {
      const root = target.records.find(
        (r) => r.data['id_операции'] === requireActiveRoot);
      if (!root) {
        throw new Error('Корень корректировки ' + requireActiveRoot +
          ' не найден в листе ' + sheetName +
          ' — корректировка не может быть записана.');
      }
      if (String(root.data['статус']).trim() === 'отменена') {
        throw new Error('Корень корректировки ' + requireActiveRoot +
          ' отменён — корректировка к отменённой операции бессмысленна. ' +
          'Если нужно изменить операцию, заведите новую вместо ' +
          'корректировки.');
      }
    }

    // Сквозной NNN — по объединённому набору записей всех журналов.
    const allRecords = [];
    CONFIG.JOURNALS.forEach((name) => {
      if (byJournal[name]) allRecords.push(...byJournal[name].records);
    });
    const idOperation = nextOpId(allRecords);
    const row = { ...dataObject, 'id_операции': idOperation };
    await Sheets.appendRow(sheetName, buildRow(target.headers, row));
    return idOperation;
  }

  // Применить патч к существующей операции (откат — §15).
  //
  // Пишем не всю строку, а только непрерывный диапазон колонок, который
  // патч затрагивает. Колонки отката (`статус`, `отменена_кем`,
  // `отменена_когда`) во всех журналах идут подряд — выходит одна узкая
  // запись. Так автоформулы журнала (`чистая_выручка_₽` и т.п.) не
  // затираются статичными значениями: их ячейки в диапазон не попадают.
  async function updateOperation(sheetName, idOperation, patch) {
    const { headers, records } = await read(sheetName);
    const rec = records.find((r) => r.data['id_операции'] === idOperation);
    if (!rec) {
      throw new Error('Операция ' + idOperation + ' не найдена в ' + sheetName);
    }
    const cols = Object.keys(patch)
      .map((k) => headers.indexOf(k))
      .filter((i) => i >= 0);
    if (!cols.length) return;

    const min = Math.min(...cols);
    const max = Math.max(...cols);
    // Внутри диапазона: значение из патча, иначе — текущее значение
    // строки (для колонок, оказавшихся между патч-полями).
    const merged = { ...rec.data, ...patch };
    const spanValues = [];
    for (let c = min; c <= max; c += 1) {
      const v = merged[headers[c]];
      spanValues.push(v !== undefined && v !== null ? v : '');
    }
    const range = sheetName + '!' + colLetter(min) + rec.rowNumber + ':' +
      colLetter(max) + rec.rowNumber;
    await Sheets.updateRange(range, spanValues);
  }

  // Транзакция «+ Заселение» (§7.6): одна строка в `журнал_поступления`
  // + N связанных строк в `журнал_выплаты` / `журнал_хоз_расходы`.
  //
  // Google Sheets API не даёт транзакций. Порядок (TICKET-4.2, грабли #1):
  // сначала все связанные строки, потом родитель. Сбой пакета связанных →
  // родителя нет; сбой родителя после связанных → «сироты», ретрай
  // дописывает родителя — меньшее зло.
  //
  // Идемпотентность (грабли #2): client_uuid родителя = txUuid, связанной
  // строки i = `txUuid#i`. На ретрае каждая строка проверяется по своему
  // client_uuid — записанные пропускаются, недостающие дописываются, без
  // дублей. parentId восстанавливается из id_связанной_операции уже
  // записанного ребёнка, если родителя ещё нет (иначе дети-сироты
  // ссылались бы на один id, а новый родитель получил бы другой).
  //
  // parentData — поля журнала_поступления; lines — [{ journal, data }];
  // у строк `журнал_выплаты` поле `назначение` проставляется здесь
  // (нужен id родителя). Возвращает { idOperation, lineIds }.
  async function appendIncasementTx(parentData, lines, txUuid) {
    const byJournal = await readMany(CONFIG.JOURNALS);
    const recordsOf = (j) => (byJournal[j] && byJournal[j].records) || [];
    const headersOf = (j) => (byJournal[j] && byJournal[j].headers) || [];
    const PJ = CONFIG.JOURNAL_ПОСТУПЛЕНИЯ;

    // Защита (REVIEW-4, критичное #1): связанная строка обязана нести
    // id_связанной_операции — на ней держится и каскадный откат, и показ
    // под заселением. Если в журнале нет такой колонки (предусловие
    // ADR-012 не выполнено), buildRow молча отбросил бы поле, и
    // хоз-расход заселения тихо отвязался бы от родителя. Прерываем
    // транзакцию ДО любой записи — операция уйдёт в очередь как failed,
    // индикатор покажет сбой громко.
    for (const line of lines) {
      if (!headersOf(line.journal).includes('id_связанной_операции')) {
        throw new Error('В листе «' + line.journal + '» нет колонки ' +
          '«id_связанной_операции» — строку распределения заселения ' +
          'не к чему привязать (предусловие ADR-012 не выполнено). ' +
          'Добавьте колонку в лист и повторите.');
      }
    }

    // Родитель уже записан? id восстанавливаем (ретрай).
    const parentRec = recordsOf(PJ).find((r) => r.data['client_uuid'] === txUuid);
    let parentId = parentRec ? parentRec.data['id_операции'] : null;
    if (!parentId) {
      // Родителя нет, но связанные могли записаться — берём его id оттуда.
      for (const j of CONFIG.JOURNALS) {
        const child = recordsOf(j).find((r) =>
          String(r.data['client_uuid']).startsWith(txUuid + '#'));
        if (child) { parentId = child.data['id_связанной_операции']; break; }
      }
    }

    // Сквозной аллокатор OP-id за день по всем 8 журналам (ADR-009).
    const date = todayStr();
    const re = new RegExp('^OP-' + date + '-(\\d{3})$');
    let cursor = 0;
    CONFIG.JOURNALS.forEach((j) => recordsOf(j).forEach((r) => {
      const m = re.exec(String(r.data['id_операции'] || ''));
      if (m) cursor = Math.max(cursor, parseInt(m[1], 10));
    }));
    const allocId = () => `OP-${date}-${String(++cursor).padStart(3, '0')}`;

    if (!parentId) parentId = allocId();

    // Связанные строки — первыми.
    const lineIds = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const lineUuid = txUuid + '#' + (i + 1);
      const existing = recordsOf(line.journal).find(
        (r) => r.data['client_uuid'] === lineUuid);
      if (existing) { lineIds.push(existing.data['id_операции']); continue; }
      const id = allocId();
      const row = {
        ...line.data,
        'id_операции': id,
        'id_связанной_операции': parentId,
        'client_uuid': lineUuid,
      };
      // Выплате нужен автотекст назначения со ссылкой на родителя.
      if (line.journal === CONFIG.JOURNAL_ВЫПЛАТЫ) {
        row['назначение'] = 'доля от заселения ' + parentId;
      }
      await Sheets.appendRow(line.journal, buildRow(headersOf(line.journal), row));
      lineIds.push(id);
    }

    // Родитель — последним.
    if (!parentRec) {
      const row = { ...parentData, 'id_операции': parentId, 'client_uuid': txUuid };
      await Sheets.appendRow(PJ, buildRow(headersOf(PJ), row));
    }
    return { idOperation: parentId, lineIds };
  }

  // Идемпотентный append в несобытийный лист (без id_операции): пишет
  // строку только если строки с теми же значениями опорных колонок ещё
  // нет. Для `_категории_на_модерации` (§14) и аудита предложений в
  // `_лог_действий` — там нет client_uuid, дедуп по смыслу записи.
  async function appendUnique(sheetName, dataObject, keyColumns) {
    const { headers, records } = await read(sheetName);
    const dup = records.some((r) => keyColumns.every(
      (col) => String(r.data[col]) === String(dataObject[col])));
    if (dup) return false;
    await Sheets.appendRow(sheetName, buildRow(headers, dataObject));
    return true;
  }

  // Идемпотентная запись строки в `_лог_действий` (§20; REVIEW-2,
  // критичное #2).
  //
  // `_лог_действий` — append-only аудит, дубли из него нельзя вычистить
  // чисто. А ретрай операции (в т.ч. повторная отправка уже доехавшей
  // записи после восстановления зависшего 'sending', см.
  // queue.recoverStuck) прогоняет sender повторно: appendOperation
  // дедуплицирует журнал по client_uuid, но logAction раньше делал
  // безусловный append → вторая строка «создание»/«откат».
  //
  // Опорный ключ — пара (id_операции, действие): на одну операцию ровно
  // одно «создание» и одно «откат» (контракт §8.4 / §15.3). id_операции
  // уникален во всей системе за день (ADR-009 — сквозной счётчик), так
  // что пары достаточно. Тот же read обслуживает проверку дубля.
  async function logAction(actionData) {
    const values = await Sheets.getValues(CONFIG.LOG_SHEET);
    const headers = values.length ? values[0] : [];

    const idCol = headers.indexOf('id_операции');
    const actionCol = headers.indexOf('действие');
    const id = actionData['id_операции'];
    const action = actionData['действие'];

    if (idCol !== -1 && actionCol !== -1 && id && action) {
      const dup = values.slice(1).some(
        (row) => row[idCol] === id && row[actionCol] === action);
      if (dup) return; // строка уже есть — повторно не пишем
    } else {
      // Без опорных колонок дедуп невозможен — пишем, но предупреждаем.
      console.warn('logAction: нет колонок id_операции/действие в ' +
        CONFIG.LOG_SHEET + ' — запись лога без защиты от дублей.');
    }
    await Sheets.appendRow(CONFIG.LOG_SHEET, buildRow(headers, actionData));
  }

  return {
    read,
    readMany,
    todayRecords,
    isToday,
    nextOpId,
    appendOperation,
    appendIncasementTx,
    updateOperation,
    appendUnique,
    logAction,
  };
})();
