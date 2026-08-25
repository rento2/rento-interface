/*
 * operations.js — реестр типов операций.
 *
 * Инкремент 3 ввёл 5 новых форм. Чтобы не плодить ветвления по типу
 * операции в очереди, секции «сегодня» и откате, общие свойства каждого
 * типа собраны здесь в одном месте:
 *   - в какой журнал пишется,
 *   - как подписать тип и описать строку в списке «сегодня»,
 *   - доступен ли только основателю.
 *
 * Очередь (queue.js) и формы (forms.js) остаются journal-agnostic:
 * берут журнал и метаданные отсюда, а не хардкодят.
 */
window.Operations = (() => {
  const CONFIG = window.RENTO_CONFIG;

  // --- резолверы справочников (для человекочитаемых описаний) ----------

  function objectName(idVersion) {
    if (!idVersion) return 'без объекта';
    const o = Cache.get('спр_объекты')
      .find((r) => r['id_версии'] === idVersion);
    return o ? o['название_короткое'] : idVersion;
  }

  function categoryName(idCategory) {
    const id = String(idCategory || '');
    // PENDING:<название> — категория на модерации (§14), названия в
    // справочнике ещё нет.
    if (id.startsWith('PENDING:')) return id.slice('PENDING:'.length) + ' (на модерации)';
    const c = Cache.get('спр_категории')
      .find((r) => r['id_категории'] === id);
    return c ? c['название'] : (id || '—');
  }

  function masterName(idVersion) {
    const m = Cache.get('спр_мастера')
      .find((r) => r['id_версии'] === idVersion);
    return m ? m['фио'] : (idVersion || '—');
  }

  // Имя получателя выплаты по типу и стабильному id (§12.2).
  function receiverName(type, id) {
    if (!id) return '—';
    const map = {
      'горничная': ['спр_горничные', 'id_горничной', 'фио'],
      'мастер': ['спр_мастера', 'id_мастера', 'фио'],
      'сотрудник': ['спр_сотрудники', 'id_сотрудника', 'фио'],
      'собственник': ['спр_собственники', 'id_собственника', 'фио'],
      'кредитор': ['спр_кредиторы', 'id_кредитора', 'фио'],
    };
    const ref = map[type];
    if (!ref) return id; // «прочее» — свободный ввод, id и есть имя
    const row = Cache.get(ref[0]).find((r) => r[ref[1]] === id);
    return row ? row[ref[2]] : id;
  }

  function withTail(head, tail) {
    const t = String(tail || '').trim();
    return t ? head + ' — ' + t : head;
  }

  // --- реестр ----------------------------------------------------------
  // describe(data) -> короткая строка для колонки «описание» в «сегодня».

  const TYPES = [
    {
      key: 'уборка',
      journal: CONFIG.JOURNAL_УБОРКИ,
      label: 'Уборка',
      founderOnly: false,
      describe: (d) => withTail(
        objectName(d['id_объекта_версии']), d['тип_уборки']),
    },
    {
      key: 'мастер',
      journal: CONFIG.JOURNAL_МАСТЕР,
      label: 'Мастер',
      founderOnly: false,
      describe: (d) => withTail(
        masterName(d['id_мастера']) + ', ' + objectName(d['id_объекта_версии']),
        d['тип_записи']),
    },
    {
      // ADR-032: сдельные начисления супервайзера. Пишутся только
      // подтверждением задачи на доске сервиса (sender
      // 'сервис_подтверждение') — своей формы у типа нет.
      key: 'супервайзер',
      journal: CONFIG.JOURNAL_СУПЕРВАЙЗЕР,
      label: 'Супервайзер',
      founderOnly: false,
      describe: (d) => withTail(
        receiverName('сотрудник', d['id_супервайзера']) + ', ' +
        objectName(d['id_объекта_версии']), d['описание']),
    },
    {
      key: 'хоз_расход',
      journal: CONFIG.JOURNAL_ХОЗ_РАСХОДЫ,
      label: 'Хоз-расход',
      founderOnly: false,
      // Только самостоятельные хоз-расходы. Строки, порождённые
      // распределением заселения, несут id_связанной_операции и
      // показываются под своим заселением, не отдельно.
      match: (d) => !String(d['id_связанной_операции'] || '').trim(),
      describe: (d) => withTail(
        objectName(d['id_объекта_версии']) + ', ' + categoryName(d['id_категории']),
        d['описание']),
    },
    {
      key: 'прочий_расход',
      journal: CONFIG.JOURNAL_ПРОЧИЕ_РАСХОДЫ,
      label: 'Прочее · расход',
      founderOnly: false,
      describe: (d) => withTail(categoryName(d['id_категории']), d['описание']),
    },
    {
      key: 'прочий_доход',
      journal: CONFIG.JOURNAL_ПРОЧИЕ_ДОХОДЫ,
      label: 'Прочее · доход',
      founderOnly: false,
      describe: (d) => withTail(categoryName(d['id_категории']), d['описание']),
    },
    {
      key: 'выплата',
      journal: CONFIG.JOURNAL_ВЫПЛАТЫ,
      label: 'Выплата',
      founderOnly: true,
      // Только самостоятельные выплаты; связанные строки заселения
      // (id_связанной_операции заполнен) идут под своим заселением.
      match: (d) => !String(d['id_связанной_операции'] || '').trim(),
      describe: (d) => withTail(
        receiverName(d['тип_получателя'], d['id_получателя']), d['назначение']),
    },
    {
      key: 'заселение',
      journal: CONFIG.JOURNAL_ПОСТУПЛЕНИЯ,
      label: 'Заселение',
      founderOnly: false,
      match: (d) => String(d['тип_записи']) === 'заселение',
      sumField: 'сумма_бронирования_₽',
      describe: (d) => objectName(d['id_объекта_версии']) +
        ', ' + (d['дата_с'] || '?') + ' – ' + (d['дата_по'] || '?'),
    },
    {
      key: 'batch_площадки',
      journal: CONFIG.JOURNAL_ПОСТУПЛЕНИЯ,
      label: 'Batch площадки',
      founderOnly: true,
      // журнал_поступления хранит и заселения — от этого типа берём
      // только строки batch'а.
      match: (d) => String(d['тип_записи']) === 'batch_площадки',
      sumField: 'сумма_бронирования_₽',
      describe: (d) => 'Площадка: ' + (d['канал_брони'] || '—'),
    },
    {
      // ADR-015: кассовые движения заселения. Самостоятельных строк в
      // журнал_касса быть не может — все несут id_связанной_операции и
      // показываются под своим заселением. На верхний уровень не
      // выводим (match всегда false); тип нужен, чтобы findChildren
      // в «сегодня» мог их подобрать и подписать.
      key: 'касса_заселения',
      journal: CONFIG.JOURNAL_КАССА,
      label: 'Касса',
      founderOnly: false,
      match: () => false,
      describe: (d) => 'Касса · ' + (d['тип_кассы'] || '—'),
    },
  ];

  const byKey = {};
  TYPES.forEach((t) => { byKey[t.key] = t; });

  // Все типы, чьи журналы нужно прочитать в секции «сегодня».
  // founderOnly-журналы менеджеру читать незачем — там не его строки.
  function listForToday(isFounder) {
    return TYPES.filter((t) => isFounder || !t.founderOnly);
  }

  function get(key) { return byKey[key] || null; }

  // Поле суммы записи (у журнала_поступления — своё имя).
  function sumOf(type, data) {
    return Number(data[type.sumField || 'сумма_₽']) || 0;
  }

  return { list: () => TYPES, listForToday, get, sumOf, categoryName, receiverName };
})();
