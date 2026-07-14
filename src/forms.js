/*
 * forms.js — формы ввода операций.
 *   Инкремент 2: «+ Уборка» (§8).
 *   Инкремент 3: «+ Мастер» (§9), «+ Хоз-расход» (§10), «+ Прочее» (§11),
 *                «+ Batch площадки» (§13), «+ Выплата» (§12),
 *                поток новой категории на модерации (§14).
 *
 * Форма не пишет в Sheets напрямую: собирает и валидирует данные, кладёт
 * операцию в очередь (Queue.add). Доставку, идемпотентность, генерацию
 * id_операции и лог берёт на себя общий pipeline (queue.js + journal.js +
 * generic-отправитель в app.js). Журнал и метаданные операции форма
 * передаёт служебными ключами `_journal` / `_logType` / `_shortDesc` /
 * `_managerId` — отправитель один на все формы, ветвлений по типу нет.
 */
window.Forms = (() => {
  const h = UI.h;
  const CONFIG = window.RENTO_CONFIG;

  // Кассы — фиксированный список (§10.1, §12.1, §13.1). Канон из ДВУХ
  // значений (10.06.2026, решение Морган): р/с и безнал — один счёт ООО
  // 'р/с ООО Сингуляр', под него настроена формула ДДС. Раньше тут было
  // 'р/с Ренто' → формы хоз-расход/прочее/выплата писали неканоничную
  // метку в поле касса. Третьего типа быть не должно (см. INTERFACE_DATA_SPEC).
  const KASSA = ['р/с ООО Сингуляр', 'карта физлица'];

  function ymd(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  function today() { return ymd(new Date()); }
  function tomorrow() {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return ymd(d);
  }
  function nowISO() { return new Date().toISOString(); }
  function num(v) { return Number(v) || 0; }
  function money(v) {
    const n = Number(v);
    return (isNaN(n) ? v : n.toLocaleString('ru-RU')) + ' ₽';
  }
  // Значение справочника трактуется как «да» (см. cache.isActiveValue).
  function isYes(v) {
    return ['да', 'yes', 'true', '1', 'активна', 'активен', 'активный']
      .includes(String(v || '').trim().toLowerCase());
  }

  // --- черновик формы (§6.3) -------------------------------------------
  function draftKey(formType) { return 'draft_' + formType; }
  function loadDraft(formType) {
    try { return JSON.parse(localStorage.getItem(draftKey(formType))); }
    catch (_) { return null; }
  }
  function saveDraft(formType, data) {
    localStorage.setItem(draftKey(formType), JSON.stringify(data));
  }
  function clearDraft(formType) {
    localStorage.removeItem(draftKey(formType));
  }

  // --- поля формы ------------------------------------------------------
  // Поле: подпись (+ опц. приписка справа) + контрол + опц. хинт + ошибка.
  // Возвращает узел-обёртку; ._error — место под текст ошибки.
  function field(label, control, opts) {
    opts = opts || {};
    const error = h('div', { class: 'field-error', style: 'display:none' });
    const labelNode = opts.aside
      ? h('div', { class: 'field-label-row' },
          h('span', { class: 'field-label' }, label),
          h('span', { class: 'field-aside' }, opts.aside))
      : h('span', { class: 'field-label' }, label);
    const kids = [labelNode, control];
    if (opts.hint) kids.push(opts.hint);
    kids.push(error);
    const wrap = h('div', { class: 'field' }, ...kids);
    wrap._error = error;
    return wrap;
  }
  function showError(fieldWrap, message) {
    fieldWrap._error.textContent = message;
    fieldWrap._error.style.display = '';
  }
  function clearError(fieldWrap) { fieldWrap._error.style.display = 'none'; }

  // --- контролы --------------------------------------------------------
  function dateInput() {
    const el = h('input', { class: 'field-input', type: 'date' });
    el.value = today();
    return el;
  }
  function numberInput() {
    return h('input',
      { class: 'field-input', type: 'number', min: '0', step: '1' });
  }
  function textInput(placeholder) {
    return h('input',
      { class: 'field-input', type: 'text', placeholder: placeholder || '' });
  }
  function textarea(placeholder) {
    return h('textarea', {
      class: 'field-input field-textarea', rows: '3',
      placeholder: placeholder || '',
    });
  }
  function selectInput() {
    return h('select', { class: 'field-input field-select' });
  }
  // Наполнить <select> опциями. options: [{ value, text }].
  function fillSelect(select, options, placeholder) {
    select.innerHTML = '';
    if (placeholder !== false) {
      select.append(h('option', { value: '' }, placeholder || 'Выберите…'));
    }
    options.forEach((o) => {
      select.append(h('option', { value: o.value }, o.text));
    });
  }

  // --- источники выпадашек --------------------------------------------
  // Объекты для выпадашки: { value: id_версии, text: название }.
  function objectOptions() {
    return Cache.forDropdown('спр_объекты')
      .map((o) => ({ value: o['id_версии'], text: o['название_короткое'] }));
  }

  // Получатели — объединённый список из справочников команды. value —
  // стабильный id (не версия): по нему считается долг в «+ Выплата».
  // includeOwners — добавлять ли собственников: в «+ Хоз-расход» их нет
  // (правка Инкремента 3), в «+ Прочее» — есть (компенсации собственнику).
  function receiverOptions(includeOwners) {
    const groups = [
      ['спр_горничные', 'id_горничной', 'горничная'],
      ['спр_мастера', 'id_мастера', 'мастер'],
      ['спр_сотрудники', 'id_сотрудника', 'сотрудник'],
    ];
    if (includeOwners) {
      groups.push(['спр_собственники', 'id_собственника', 'собственник']);
    }
    const out = [];
    groups.forEach(([sheet, idField, tag]) => {
      Cache.forDropdown(sheet).forEach((r) => {
        out.push({ value: r[idField], text: r['фио'] + ' · ' + tag });
      });
    });
    return out;
  }

  // Категории под журнал и тип (§10.2 / §11.2), отсортированы по
  // порядок_сортировки.
  function categoryOptions(journalName, type) {
    return Cache.get('спр_категории')
      .filter((c) =>
        String(c['тип']).trim() === type &&
        String(c['куда_разносится']).trim() === journalName &&
        isYes(c['активна']) &&
        String(c['статус_модерации']).trim() === 'подтверждена')
      .sort((a, b) => num(a['порядок_сортировки']) - num(b['порядок_сортировки']))
      .map((c) => ({ value: c['id_категории'], text: c['название'] }));
  }

  // Карта id_версии -> стабильный id (для резолва версионных справочников).
  function versionMap(sheet, versionField, stableField) {
    const map = {};
    Cache.get(sheet).forEach((r) => { map[r[versionField]] = r[stableField]; });
    return map;
  }

  // --- сборка формы (общий каркас) -------------------------------------
  // Собирает <form class=op-form>: черновик-нота, поля, разделитель,
  // футер с подсказкой и кнопками. submit: блокировка от двойной
  // отправки (§6.4), валидация, постановка в очередь, выход.
  // cfg: { formType, opts, fieldNodes, topNote?, draftNote,
  //        validate(), collect(), queueKey }
  function composeForm(cfg) {
    const submitBtn = h('button',
      { class: 'btn-primary btn-auto', type: 'submit' }, 'Сохранить');
    const cancelBtn = h('button',
      { class: 'btn-ghost', type: 'button' }, 'Отмена');
    // «Отмена» уводит с экрана, но черновик не трогает (§6.3).
    cancelBtn.addEventListener('click', () => cfg.opts.onExit());

    const footer = h('div', { class: 'op-footer' },
      h('span', { class: 'op-footer-hint' }, '⌥ Enter — чтобы сохранить'),
      h('div', { class: 'op-footer-actions' }, cancelBtn, submitBtn));

    const children = [cfg.draftNote];
    if (cfg.topNote) children.push(cfg.topNote);
    cfg.fieldNodes.forEach((n) => children.push(n));
    children.push(h('div', { class: 'op-divider' }), footer);
    const form = h('form', { class: 'op-form' }, ...children);

    // ⌥ Enter сохраняет (в textarea Enter — перенос строки).
    form.addEventListener('keydown', (e) => {
      if (e.altKey && e.key === 'Enter') {
        e.preventDefault();
        form.requestSubmit();
      }
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      submitBtn.disabled = true;
      if (!cfg.validate()) { submitBtn.disabled = false; return; }
      Queue.add(cfg.queueKey, cfg.collect());
      clearDraft(cfg.formType);
      // Операция в очереди — уходим на главный экран (app.js перерисует
      // индикатор и секцию «сегодня»).
      cfg.opts.onExit();
    });
    return { form, submitBtn };
  }

  // Подключить черновик к собранной форме. persist слушает форму через
  // делегирование: input/change всплывают, поэтому ловятся и контролы,
  // добавленные позже (строки распределения §7.4). restore наполняет
  // форму (restore({}) — сброс к значениям по умолчанию).
  function setupDraft(formType, form, snapshot, restore, draftNote) {
    const persist = () => saveDraft(formType, snapshot());
    form.addEventListener('input', persist);
    form.addEventListener('change', persist);
    const draft = loadDraft(formType);
    if (!draft) return;
    // Пустой черновик (нет ни одного значимого поля) — молча убираем.
    // Раньше открытие формы создавало «пустой» черновик из дефолтов;
    // он лежит в localStorage у уже игравших с формой. Не показываем
    // плашку «Восстановлен черновик», когда восстанавливать нечего.
    if (isDraftEmpty(draft)) {
      clearDraft(formType);
      return;
    }
    restore(draft);
    const resetBtn = h('button',
      { class: 'link-btn', type: 'button' }, 'Начать заново');
    resetBtn.addEventListener('click', () => {
      clearDraft(formType);
      restore({});
      draftNote.style.display = 'none';
    });
    draftNote.append(h('span', {}, '↩ Восстановлен черновик. '), resetBtn);
    draftNote.style.display = '';
  }

  // Считаем черновик «пустым», если ни одно его поле не несёт значения.
  // Даты не учитываются (заезд/выезд проставляются сегодня/завтра по
  // дефолту — это не данные, а заготовка). Строки распределения —
  // считаются «непустыми», только если в любой из них есть тип,
  // получатель или сумма.
  function isDraftEmpty(draft) {
    if (!draft || typeof draft !== 'object') return true;
    const skipKeys = new Set(['заезд', 'выезд', 'дата', 'строки']);
    for (const [key, value] of Object.entries(draft)) {
      if (skipKeys.has(key)) continue;
      if (value !== '' && value !== null && value !== undefined) return false;
    }
    if (Array.isArray(draft['строки'])) {
      for (const r of draft['строки']) {
        if (!r) continue;
        if ((r['тип'] && r['тип'] !== '') ||
            (r['получатель'] && r['получатель'] !== '') ||
            (r['сумма'] && r['сумма'] !== '')) return false;
      }
    }
    return true;
  }

  // ============================ «+ Уборка» =============================
  // Открывает полноэкранный экран формы (ADR-006).
  // opts: { employee, onExit, onRefresh, onLogout }
  function openУборка(opts) {
    const employee = opts.employee;
    const formType = 'уборка';

    const cleaners = Cache.forDropdown('спр_горничные');
    const objects = Cache.forDropdown('спр_объекты');
    // Ставки — все версии: нужная определяется по дате уборки (§8.2).
    const rates = Cache.get('спр_ставки_уборок');

    const objectsByVersion = {};
    objects.forEach((o) => { objectsByVersion[o['id_версии']] = o; });

    const dateEl = h('input', { class: 'field-input', type: 'date' });
    dateEl.value = today();

    const cleanerSelect = h('select', { class: 'field-input field-select' },
      h('option', { value: '' }, 'Выберите...'));
    cleaners.forEach((c) => {
      cleanerSelect.append(h('option', { value: c['id_версии'] }, c['фио']));
    });

    const objectSelect = h('select', { class: 'field-input field-select' },
      h('option', { value: '' }, 'Выберите...'));
    objects.forEach((o) => {
      objectSelect.append(
        h('option', { value: o['id_версии'] }, o['название_короткое']));
    });

    const typeSelect = h('select', { class: 'field-input field-select' },
      h('option', { value: '' }, 'Выберите...'),
      h('option', { value: 'плановая' }, 'плановая'),
      h('option', { value: 'генеральная' }, 'генеральная'));

    const sumInput = numberInput();
    const sumHint = h('div', { class: 'field-hint' });
    const commentInput = textInput('Комментарий');

    const fDate = field('Дата уборки', dateEl);
    const fCleaner = field('Горничная', cleanerSelect);
    const fObject = field('Объект', objectSelect);
    const fType = field('Тип уборки', typeSelect);
    const fSum = field('Сумма ₽',
      h('div', { class: 'field-stack' }, sumInput, sumHint));
    const fComment = field('Комментарий', commentInput);

    let currentDefault = null;

    function recomputeDefault() {
      const obj = objectsByVersion[objectSelect.value];
      const type = typeSelect.value;
      const date = dateEl.value;
      if (!obj || !type || !date) {
        currentDefault = null;
        sumHint.textContent = '';
        return;
      }
      const idObj = obj['id_объекта'];
      const matching = rates.filter((r) => {
        if (r['id_объекта'] !== idObj) return false;
        if (r['тип_уборки'] !== type) return false;
        const from = String(r['действует_с'] || '');
        const to = String(r['действует_по'] || '').trim();
        return from <= date && (!to || date <= to);
      });
      if (!matching.length) {
        currentDefault = null;
        sumHint.textContent = 'ставка не найдена — впишите сумму вручную';
        return;
      }
      matching.sort((a, b) =>
        String(b['действует_с']).localeCompare(String(a['действует_с'])));
      currentDefault = Number(matching[0]['сумма_₽']);
      sumInput.value = currentDefault;
      sumHint.textContent = 'дефолт из ставок: ' + currentDefault + ' ₽';
    }

    [dateEl, cleanerSelect, objectSelect, typeSelect].forEach((el) => {
      el.addEventListener('change', recomputeDefault);
    });

    const draftNote = h('div', { class: 'draft-note', style: 'display:none' });

    function snapshot() {
      return {
        дата: dateEl.value, id_горничной: cleanerSelect.value,
        id_объекта: objectSelect.value, тип: typeSelect.value,
        сумма: sumInput.value, комментарий: commentInput.value,
      };
    }
    function restore(d) {
      dateEl.value = d.дата || today();
      cleanerSelect.value = d.id_горничной || '';
      objectSelect.value = d.id_объекта || '';
      typeSelect.value = d.тип || '';
      commentInput.value = d.комментарий || '';
      sumInput.value = '';
      recomputeDefault();              // выставит дефолт, если хватает полей
      if (d.сумма) sumInput.value = d.сумма; // ручной ввод важнее дефолта
    }

    function validate() {
      [fDate, fCleaner, fObject, fType, fSum, fComment].forEach(clearError);
      let ok = true;
      if (!dateEl.value) { showError(fDate, 'Укажите дату'); ok = false; }
      if (!cleanerSelect.value) { showError(fCleaner, 'Выберите горничную'); ok = false; }
      if (!objectSelect.value) { showError(fObject, 'Выберите объект'); ok = false; }
      if (!typeSelect.value) { showError(fType, 'Выберите тип уборки'); ok = false; }
      const sum = Number(sumInput.value);
      if (!sumInput.value || !(sum > 0)) {
        showError(fSum, 'Сумма должна быть больше 0'); ok = false;
      }
      // Перебитая сумма — комментарий обязателен (§8.3, грабли #3).
      const overridden = currentDefault != null && sum !== currentDefault;
      if (overridden && !commentInput.value.trim()) {
        showError(fComment, 'Сумма отличается от ставки — нужен комментарий');
        ok = false;
      }
      return ok;
    }

    function collect() {
      const obj = objectsByVersion[objectSelect.value];
      const cleaner = cleaners.find((c) => c['id_версии'] === cleanerSelect.value);
      const sum = Number(sumInput.value);
      const описание = 'Уборка ' + (obj ? obj['название_короткое'] : '') +
        ', ' + (cleaner ? cleaner['фио'] : '') + ', ' + sum + ' ₽';
      return {
        // `дата_внесения` — момент постановки в очередь (ADR-007).
        'дата_внесения': nowISO(),
        'id_менеджера': employee['id_сотрудника'], // стабильный ID, ADR-005
        'дата_уборки': dateEl.value,
        // Канон id_горничной — ГОЛЫЙ id (как в справочнике и журнал_выплаты),
        // не id_версии. Иначе SUMIFS в отчёт_сальдо_подрядчики не привяжет
        // уборку (он ищет голый CLN-xxx, а -v1 пролетает мимо).
        'id_горничной': cleaner ? cleaner['id_горничной'] : cleanerSelect.value,
        'id_объекта_версии': objectSelect.value,
        'тип_уборки': typeSelect.value,
        'сумма_₽': sum,
        'комментарий': commentInput.value.trim(),
        'статус': 'активна',
        'отменена_кем': '', 'отменена_когда': '', 'id_исходной_операции': '',
        '_journal': CONFIG.JOURNAL_УБОРКИ,
        '_logType': 'уборка',
        '_shortDesc': описание,
        '_managerId': employee['id_сотрудника'],
      };
    }

    const built = composeForm({
      formType, opts, draftNote, queueKey: 'уборка', validate, collect,
      fieldNodes: [fDate, fCleaner, fObject, fType, fSum, fComment],
    });
    setupDraft(formType, built.form, snapshot, restore, draftNote);

    return Screens.formScreen({
      employee, title: '+ Уборка',
      subtitle: 'Внести операцию уборки. Сумма подставится автоматически ' +
        'по ставке объекта.',
      content: built.form,
      onBack: () => opts.onExit(),
      onRefresh: opts.onRefresh, onLogout: opts.onLogout,
      onOpenHelp: opts.onOpenHelp,
    });
  }

  // ============================ «+ Мастер» =============================
  // §9. Две роли записи (выход / материалы) и опциональный объект.
  function openМастер(opts) {
    const employee = opts.employee;
    const formType = 'мастер';

    const masters = Cache.forDropdown('спр_мастера');
    const mastersByVersion = {};
    masters.forEach((m) => { mastersByVersion[m['id_версии']] = m; });

    const dateEl = dateInput();
    const masterSelect = selectInput();
    fillSelect(masterSelect, masters.map((m) => ({
      value: m['id_версии'],
      text: m['фио'] + (m['специализация'] ? ' — ' + m['специализация'] : ''),
    })));
    const typeSelect = selectInput();
    fillSelect(typeSelect, [
      { value: 'выход', text: 'выход' },
      { value: 'материалы', text: 'материалы' },
    ]);
    // Объект: первый пункт — «без объекта» (грабли 3.1), пустое значение.
    const objectSelect = selectInput();
    fillSelect(objectSelect, objectOptions(), '—— без объекта ——');
    const descInput = textInput('Что делал мастер / что куплено');
    const sumInput = numberInput();
    const sumHint = h('div', { class: 'field-hint' });
    const commentInput = textarea('Например: менял смеситель, гарантия 6 мес');

    const fDate = field('Дата', dateEl);
    const fMaster = field('Мастер', masterSelect);
    const fType = field('Тип записи', typeSelect);
    const fObject = field('Объект', objectSelect,
      { aside: 'обязателен для выхода' });
    const fDesc = field('Описание', descInput,
      { aside: 'обязательно для материалов' });
    const fSum = field('Сумма ₽',
      h('div', { class: 'field-stack' }, sumInput, sumHint));
    const fComment = field('Комментарий', commentInput, { aside: 'необязательно' });

    // Сумма по выходу — дефолт из ставки мастера (§9.1), перебивается.
    function recomputeSum() {
      const m = mastersByVersion[masterSelect.value];
      if (typeSelect.value === 'выход' && m) {
        const def = num(m['ставка_дефолт_₽']);
        sumInput.value = def || '';
        sumHint.textContent = def
          ? 'ставка мастера: ' + def + ' ₽ — можно перебить'
          : 'у мастера нет ставки по умолчанию — впишите сумму';
      } else {
        sumHint.textContent = typeSelect.value === 'материалы'
          ? 'сумма закупки — впишите вручную' : '';
      }
    }
    masterSelect.addEventListener('change', recomputeSum);
    typeSelect.addEventListener('change', recomputeSum);

    const draftNote = h('div', { class: 'draft-note', style: 'display:none' });

    function snapshot() {
      return {
        дата: dateEl.value, id_мастера: masterSelect.value,
        тип: typeSelect.value, id_объекта: objectSelect.value,
        описание: descInput.value, сумма: sumInput.value,
        комментарий: commentInput.value,
      };
    }
    function restore(d) {
      dateEl.value = d.дата || today();
      masterSelect.value = d.id_мастера || '';
      typeSelect.value = d.тип || '';
      objectSelect.value = d.id_объекта || '';
      descInput.value = d.описание || '';
      commentInput.value = d.комментарий || '';
      sumInput.value = '';
      recomputeSum();                  // дефолт по ставке, если тип = выход
      if (d.сумма) sumInput.value = d.сумма; // ручной ввод важнее дефолта
    }

    function validate() {
      [fDate, fMaster, fType, fObject, fDesc, fSum].forEach(clearError);
      let ok = true;
      if (!dateEl.value) { showError(fDate, 'Укажите дату'); ok = false; }
      if (!masterSelect.value) { showError(fMaster, 'Выберите мастера'); ok = false; }
      if (!typeSelect.value) { showError(fType, 'Выберите тип записи'); ok = false; }
      if (typeSelect.value === 'выход' && !objectSelect.value) {
        showError(fObject, 'Для выхода объект обязателен'); ok = false;
      }
      if (typeSelect.value === 'материалы' && !descInput.value.trim()) {
        showError(fDesc, 'Для материалов опишите, что куплено'); ok = false;
      }
      if (!(num(sumInput.value) > 0)) {
        showError(fSum, 'Сумма должна быть больше 0'); ok = false;
      }
      return ok;
    }

    function collect() {
      const m = mastersByVersion[masterSelect.value];
      const sum = num(sumInput.value);
      const описание = 'Мастер ' + (m ? m['фио'] : '') + ', ' +
        typeSelect.value + ', ' + sum + ' ₽';
      return {
        'дата_внесения': nowISO(),
        'id_менеджера': employee['id_сотрудника'],
        'дата': dateEl.value,
        'id_мастера': masterSelect.value,             // id_версии (§9.3)
        'id_объекта_версии': objectSelect.value,       // '' = без объекта
        'тип_записи': typeSelect.value,
        'описание': descInput.value.trim(),
        'сумма_₽': sum,
        'комментарий': commentInput.value.trim(),
        'статус': 'активна',
        'отменена_кем': '', 'отменена_когда': '', 'id_исходной_операции': '',
        '_journal': CONFIG.JOURNAL_МАСТЕР,
        '_logType': 'мастер',
        '_shortDesc': описание,
        '_managerId': employee['id_сотрудника'],
      };
    }

    const built = composeForm({
      formType, opts, draftNote, queueKey: 'мастер', validate, collect,
      fieldNodes: [fDate, fMaster, fType, fObject, fDesc, fSum, fComment],
    });
    setupDraft(formType, built.form, snapshot, restore, draftNote);

    return Screens.formScreen({
      employee, title: '+ Мастер',
      subtitle: 'Выезд мастера или закупка материалов. Сумма по выезду — ' +
        'из ставки мастера, перебивается.',
      content: built.form,
      onBack: () => opts.onExit(),
      onRefresh: opts.onRefresh, onLogout: opts.onLogout,
      onOpenHelp: opts.onOpenHelp,
    });
  }

  // --- поле «Категория»: выпадашка + кнопка предложить (§10, §14) ------
  // Возвращает { node, select, setOptions, addPending }.
  // onPropose(addPending) — вызывается по кнопке «+ предложить категорию».
  function categoryControl(onPropose) {
    const select = h('select', { class: 'field-input field-select' });

    function setOptions(list) {
      select.innerHTML = '';
      select.append(h('option', { value: '' }, 'Выберите категорию…'));
      list.forEach((o) => {
        select.append(h('option', { value: o.value }, o.text));
      });
    }
    // Категория на модерации (§14): добавить PENDING-пункт и выбрать.
    function addPending(name) {
      const value = 'PENDING:' + name;
      select.append(h('option', { value }, name + ' (на модерации)'));
      select.value = value;
    }

    const proposeBtn = h('button',
      { class: 'link-btn propose-link', type: 'button' },
      '+ предложить новую категорию');
    proposeBtn.addEventListener('click', () => onPropose(addPending));

    const node = h('div', { class: 'field-stack' }, select, proposeBtn);
    return { node, select, setOptions, addPending };
  }

  // ========================== «+ Хоз-расход» ===========================
  // §10. Расход с привязкой к объекту.
  function openХозРасход(opts) {
    const employee = opts.employee;
    const formType = 'хоз_расход';

    const dateEl = dateInput();
    const objectSelect = selectInput();
    fillSelect(objectSelect, objectOptions());

    const cat = categoryControl((addPending) => {
      openCategoryModal({
        employee, contextType: 'расход',
        onProposed: (name) => addPending(name),
      });
    });
    cat.setOptions(categoryOptions(CONFIG.JOURNAL_ХОЗ_РАСХОДЫ, 'расход'));

    const descInput = textInput('Описание расхода');
    const sumInput = numberInput();
    const receiverSelect = selectInput();
    // Получатель хоз-расхода — горничные/мастера/сотрудники, без
    // собственников (правка Инкремента 3): это компенсация члену команды.
    fillSelect(receiverSelect, receiverOptions(false), '— не выбран —');
    const kassaSelect = selectInput();
    fillSelect(kassaSelect, KASSA.map((k) => ({ value: k, text: k })));
    const commentInput = textarea('Комментарий');

    const fDate = field('Дата', dateEl);
    const fObject = field('Объект', objectSelect);
    const fCat = field('Категория', cat.node);
    const fDesc = field('Описание', descInput, { aside: 'необязательно' });
    const fSum = field('Сумма ₽', sumInput);
    const fReceiver = field('Получатель', receiverSelect,
      { aside: 'необязательно' });
    const fKassa = field('Касса', kassaSelect);
    const fComment = field('Комментарий', commentInput, { aside: 'необязательно' });

    const draftNote = h('div', { class: 'draft-note', style: 'display:none' });

    function snapshot() {
      return {
        дата: dateEl.value, id_объекта: objectSelect.value,
        id_категории: cat.select.value, описание: descInput.value,
        сумма: sumInput.value, id_получателя: receiverSelect.value,
        касса: kassaSelect.value, комментарий: commentInput.value,
      };
    }
    function restore(d) {
      dateEl.value = d.дата || today();
      objectSelect.value = d.id_объекта || '';
      // PENDING-категория из черновика — вернуть пунктом списка.
      if (d.id_категории && String(d.id_категории).startsWith('PENDING:')) {
        cat.addPending(String(d.id_категории).slice('PENDING:'.length));
      } else {
        cat.select.value = d.id_категории || '';
      }
      descInput.value = d.описание || '';
      sumInput.value = d.сумма || '';
      receiverSelect.value = d.id_получателя || '';
      kassaSelect.value = d.касса || '';
      commentInput.value = d.комментарий || '';
    }

    function validate() {
      [fDate, fObject, fCat, fSum, fKassa].forEach(clearError);
      let ok = true;
      if (!dateEl.value) { showError(fDate, 'Укажите дату'); ok = false; }
      if (!objectSelect.value) { showError(fObject, 'Выберите объект'); ok = false; }
      if (!cat.select.value) { showError(fCat, 'Выберите категорию'); ok = false; }
      if (!(num(sumInput.value) > 0)) {
        showError(fSum, 'Сумма должна быть больше 0'); ok = false;
      }
      if (!kassaSelect.value) { showError(fKassa, 'Выберите кассу'); ok = false; }
      return ok;
    }

    function collect() {
      const sum = num(sumInput.value);
      const pending = String(cat.select.value).startsWith('PENDING:');
      let comment = commentInput.value.trim();
      // Категория на модерации — пометка для основателя (§14.2).
      if (pending) {
        comment = comment ? 'нужна категоризация. ' + comment
          : 'нужна категоризация';
      }
      const описание = 'Хоз-расход ' +
        Operations.categoryName(cat.select.value) + ', ' + sum + ' ₽';
      return {
        'дата_внесения': nowISO(),
        'id_менеджера': employee['id_сотрудника'],
        'дата': dateEl.value,
        'id_объекта_версии': objectSelect.value,
        'id_категории': cat.select.value,
        'описание': descInput.value.trim(),
        'сумма_₽': sum,
        'id_получателя': receiverSelect.value,
        'касса': kassaSelect.value,
        'комментарий': comment,
        'статус': 'активна',
        'отменена_кем': '', 'отменена_когда': '', 'id_исходной_операции': '',
        '_journal': CONFIG.JOURNAL_ХОЗ_РАСХОДЫ,
        '_logType': 'хоз_расход',
        '_shortDesc': описание,
        '_managerId': employee['id_сотрудника'],
      };
    }

    const built = composeForm({
      formType, opts, draftNote, queueKey: 'хоз_расход', validate, collect,
      fieldNodes: [fDate, fObject, fCat, fDesc, fSum, fReceiver, fKassa, fComment],
    });
    setupDraft(formType, built.form, snapshot, restore, draftNote);

    return Screens.formScreen({
      employee, title: '+ Хоз-расход',
      subtitle: 'Расход с привязкой к объекту.',
      content: built.form,
      onBack: () => opts.onExit(),
      onRefresh: opts.onRefresh, onLogout: opts.onLogout,
      onOpenHelp: opts.onOpenHelp,
    });
  }

  // ============================ «+ Прочее» =============================
  // §11. Прочие доходы и расходы без привязки к объекту.
  function openПрочее(opts) {
    const employee = opts.employee;
    const formType = 'прочее';

    const typeSelect = selectInput();
    fillSelect(typeSelect, [
      { value: 'расход', text: 'расход' },
      { value: 'доход', text: 'доход' },
    ]);
    const dateEl = dateInput();
    const descInput = textInput('Описание');
    const sumInput = numberInput();
    const receiverSelect = selectInput();
    // В «+ Прочее» получатель/плательщик может быть и собственником
    // (например, компенсация от собственника) — список со собственниками.
    fillSelect(receiverSelect, receiverOptions(true), '— не выбран —');
    const kassaSelect = selectInput();
    fillSelect(kassaSelect, KASSA.map((k) => ({ value: k, text: k })), '— не выбрана —');
    const commentInput = textarea('Комментарий');

    const cat = categoryControl((addPending) => {
      openCategoryModal({
        employee,
        // Тип категории определяется текущим переключателем (§14.1).
        contextType: typeSelect.value === 'доход' ? 'доход' : 'расход',
        onProposed: (name) => addPending(name),
      });
    });

    const fType = field('Тип', typeSelect);
    const fDate = field('Дата', dateEl);
    const fCat = field('Категория', cat.node);
    const fDesc = field('Описание', descInput, { aside: 'необязательно' });
    const fSum = field('Сумма ₽', sumInput);
    const fReceiver = field('Получатель / плательщик', receiverSelect,
      { aside: 'необязательно' });
    const fKassa = field('Касса', kassaSelect, { aside: 'необязательно' });
    const fComment = field('Комментарий', commentInput, { aside: 'необязательно' });

    function journalFor() {
      return typeSelect.value === 'доход'
        ? CONFIG.JOURNAL_ПРОЧИЕ_ДОХОДЫ : CONFIG.JOURNAL_ПРОЧИЕ_РАСХОДЫ;
    }
    // Переключатель типа меняет фильтр категорий (§11.2) и подпись поля
    // получателя/плательщика.
    function syncType() {
      const type = typeSelect.value;
      if (type) cat.setOptions(categoryOptions(journalFor(), type));
      else cat.setOptions([]);
      fReceiver.querySelector('.field-label').textContent =
        type === 'доход' ? 'Плательщик' : 'Получатель';
    }
    typeSelect.addEventListener('change', syncType);
    syncType();

    const draftNote = h('div', { class: 'draft-note', style: 'display:none' });

    function snapshot() {
      return {
        тип: typeSelect.value, дата: dateEl.value,
        id_категории: cat.select.value, описание: descInput.value,
        сумма: sumInput.value, получатель: receiverSelect.value,
        касса: kassaSelect.value, комментарий: commentInput.value,
      };
    }
    function restore(d) {
      typeSelect.value = d.тип || '';
      syncType(); // перестроить категории под тип ДО установки значения
      dateEl.value = d.дата || today();
      if (d.id_категории && String(d.id_категории).startsWith('PENDING:')) {
        cat.addPending(String(d.id_категории).slice('PENDING:'.length));
      } else {
        cat.select.value = d.id_категории || '';
      }
      descInput.value = d.описание || '';
      sumInput.value = d.сумма || '';
      receiverSelect.value = d.получатель || '';
      kassaSelect.value = d.касса || '';
      commentInput.value = d.комментарий || '';
    }

    function validate() {
      [fType, fDate, fCat, fSum].forEach(clearError);
      let ok = true;
      if (!typeSelect.value) { showError(fType, 'Выберите тип'); ok = false; }
      if (!dateEl.value) { showError(fDate, 'Укажите дату'); ok = false; }
      if (!cat.select.value) { showError(fCat, 'Выберите категорию'); ok = false; }
      if (!(num(sumInput.value) > 0)) {
        showError(fSum, 'Сумма должна быть больше 0'); ok = false;
      }
      return ok;
    }

    function collect() {
      const type = typeSelect.value;
      const sum = num(sumInput.value);
      const pending = String(cat.select.value).startsWith('PENDING:');
      let comment = commentInput.value.trim();
      if (pending) {
        comment = comment ? 'нужна категоризация. ' + comment
          : 'нужна категоризация';
      }
      const описание = 'Прочее (' + type + ') ' +
        Operations.categoryName(cat.select.value) + ', ' + sum + ' ₽';
      // Расход — id_получателя, доход — id_плательщика (§4.20 / §4.21).
      const data = {
        'дата_внесения': nowISO(),
        'id_менеджера': employee['id_сотрудника'],
        'дата': dateEl.value,
        'id_категории': cat.select.value,
        'описание': descInput.value.trim(),
        'сумма_₽': sum,
        'касса': kassaSelect.value,
        'комментарий': comment,
        'статус': 'активна',
        'отменена_кем': '', 'отменена_когда': '', 'id_исходной_операции': '',
        '_journal': journalFor(),
        '_logType': type === 'доход' ? 'прочий_доход' : 'прочий_расход',
        '_shortDesc': описание,
        '_managerId': employee['id_сотрудника'],
      };
      if (type === 'доход') data['id_плательщика'] = receiverSelect.value;
      else data['id_получателя'] = receiverSelect.value;
      return data;
    }

    const built = composeForm({
      formType, opts, draftNote, queueKey: 'прочее', validate, collect,
      fieldNodes: [fType, fDate, fCat, fDesc, fSum, fReceiver, fKassa, fComment],
    });
    setupDraft(formType, built.form, snapshot, restore, draftNote);

    return Screens.formScreen({
      employee, title: '+ Прочее',
      subtitle: 'Прочий доход или расход без привязки к объекту.',
      content: built.form,
      onBack: () => opts.onExit(),
      onRefresh: opts.onRefresh, onLogout: opts.onLogout,
      onOpenHelp: opts.onOpenHelp,
    });
  }

  // ======================= «+ Batch площадки» ==========================
  // §13. Разноска batch-выплаты от Авито / Яндекс. Только основатель.
  function openBatch(opts) {
    const employee = opts.employee;
    const formType = 'batch';

    const dateEl = dateInput();
    const platformSelect = selectInput();
    fillSelect(platformSelect, [
      { value: 'авито', text: 'Авито' },
      { value: 'яндекс', text: 'Яндекс' },
    ]);
    const sumInput = numberInput();
    const fromEl = h('input', { class: 'field-input', type: 'date' });
    const toEl = h('input', { class: 'field-input', type: 'date' });
    const kassaSelect = selectInput();
    fillSelect(kassaSelect, KASSA.map((k) => ({ value: k, text: k })));
    const commentInput = textarea('Комментарий');

    const fDate = field('Дата получения', dateEl);
    const fPlatform = field('Площадка', platformSelect);
    const fSum = field('Сумма ₽', sumInput);
    const fPeriod = field('Период покрытия',
      h('div', { class: 'field-row-2' },
        h('div', { class: 'field-stack' },
          h('span', { class: 'field-sub' }, 'с'), fromEl),
        h('div', { class: 'field-stack' },
          h('span', { class: 'field-sub' }, 'по'), toEl)),
      { aside: 'необязательно' });
    const fKassa = field('Касса', kassaSelect);
    const fComment = field('Комментарий', commentInput, { aside: 'необязательно' });

    const draftNote = h('div', { class: 'draft-note', style: 'display:none' });

    function snapshot() {
      return {
        дата: dateEl.value, площадка: platformSelect.value,
        сумма: sumInput.value, с: fromEl.value, по: toEl.value,
        касса: kassaSelect.value, комментарий: commentInput.value,
      };
    }
    function restore(d) {
      dateEl.value = d.дата || today();
      platformSelect.value = d.площадка || '';
      sumInput.value = d.сумма || '';
      fromEl.value = d.с || '';
      toEl.value = d.по || '';
      kassaSelect.value = d.касса || '';
      commentInput.value = d.комментарий || '';
    }

    function validate() {
      [fDate, fPlatform, fSum, fKassa].forEach(clearError);
      let ok = true;
      if (!dateEl.value) { showError(fDate, 'Укажите дату получения'); ok = false; }
      if (!platformSelect.value) { showError(fPlatform, 'Выберите площадку'); ok = false; }
      if (!(num(sumInput.value) > 0)) {
        showError(fSum, 'Сумма должна быть больше 0'); ok = false;
      }
      if (!kassaSelect.value) { showError(fKassa, 'Выберите кассу'); ok = false; }
      return ok;
    }

    function collect() {
      const sum = num(sumInput.value);
      let comment = commentInput.value.trim();
      // Период покрытия — в комментарий (§13.2).
      if (fromEl.value || toEl.value) {
        const period = 'период: с ' + (fromEl.value || '—') +
          ' по ' + (toEl.value || '—');
        comment = comment ? period + '. ' + comment : period;
      }
      const платформа = platformSelect.value === 'яндекс' ? 'Яндекс' : 'Авито';
      return {
        'дата_внесения': nowISO(),
        'id_менеджера': employee['id_сотрудника'],
        'тип_записи': 'batch_площадки',
        'дата_операции': dateEl.value,
        'id_объекта_версии': '',
        'дата_с': '', 'дата_по': '',
        'канал_брони': platformSelect.value,        // авито / яндекс
        'сумма_бронирования_₽': sum,
        'комиссия_площадки_₽': '', 'площадка_должна_₽': '',
        'касса': kassaSelect.value,
        'комментарий': comment,
        'статус': 'активна',
        'отменена_кем': '', 'отменена_когда': '', 'id_исходной_операции': '',
        '_journal': CONFIG.JOURNAL_ПОСТУПЛЕНИЯ,
        '_logType': 'batch_площадки',
        '_shortDesc': 'Batch ' + платформа + ', ' + sum + ' ₽',
        '_managerId': employee['id_сотрудника'],
      };
    }

    const built = composeForm({
      formType, opts, draftNote, queueKey: 'batch_площадки', validate, collect,
      fieldNodes: [fDate, fPlatform, fSum, fPeriod, fKassa, fComment],
    });
    setupDraft(formType, built.form, snapshot, restore, draftNote);

    return Screens.formScreen({
      employee, title: '+ Batch площадки',
      subtitle: 'Разноска batch-выплаты от Авито или Яндекс.',
      content: built.form,
      onBack: () => opts.onExit(),
      onRefresh: opts.onRefresh, onLogout: opts.onLogout,
      onOpenHelp: opts.onOpenHelp,
    });
  }

  // ============================ «+ Выплата» ============================
  // §12. Закрытие обязательств перед получателями. Только основатель.
  function openВыплата(opts) {
    const employee = opts.employee;
    const formType = 'выплата';

    // Источник получателей по типу: [справочник, поле id].
    const RECEIVER_SRC = {
      'горничная': ['спр_горничные', 'id_горничной'],
      'мастер': ['спр_мастера', 'id_мастера'],
      'сотрудник': ['спр_сотрудники', 'id_сотрудника'],
      'собственник': ['спр_собственники', 'id_собственника'],
      'кредитор': ['спр_кредиторы', 'id_кредитора'],
    };
    // Реквизиты по типу: [справочник реквизитов, поле id владельца].
    const REQ_SRC = {
      'горничная': ['спр_реквизиты_горничных', 'id_горничной'],
      'мастер': ['спр_реквизиты_мастеров', 'id_мастера'],
      'сотрудник': ['спр_реквизиты_сотрудников', 'id_сотрудника'],
      'собственник': ['спр_реквизиты_собственников', 'id_собственника'],
    };

    const dateEl = dateInput();
    const typeSelect = selectInput();
    fillSelect(typeSelect, ['горничная', 'мастер', 'сотрудник',
      'собственник', 'кредитор', 'прочее'].map((t) => ({ value: t, text: t })));
    // Получатель: для известных типов — выпадашка, для «прочее» — ввод.
    // Оба контрола живут в DOM всегда (черновик вешается на них один
    // раз), переключается только видимость.
    const receiverSelect = selectInput();
    const receiverText = textInput('ФИО или название получателя');
    receiverText.style.display = 'none';
    const reqSelect = selectInput();
    // ADR-016: для выплаты собственнику нужно знать, по какому из его
    // объектов идёт платёж (у собственника может быть несколько объектов
    // — сальдо считается по каждому отдельно). Для прочих типов поле
    // скрыто и в данные не пишется.
    const objectSelect = selectInput();
    const debtHint = h('div', { class: 'field-hint debt-hint' });
    const commentInput = textarea('Комментарий');
    const purposeInput = textInput('За что выплата');
    const sumInput = numberInput();
    const kassaSelect = selectInput();
    fillSelect(kassaSelect, KASSA.map((k) => ({ value: k, text: k })));

    const fDate = field('Дата выплаты', dateEl);
    const fType = field('Тип получателя', typeSelect);
    const fReceiver = field('Получатель',
      h('div', { class: 'field-stack' }, receiverSelect, receiverText, debtHint));
    const fObject = field('Объект', objectSelect,
      { aside: 'по какому объекту платим' });
    fObject.style.display = 'none';                  // показывается только для собственника
    const fReq = field('Реквизиты', reqSelect);
    const fSum = field('Сумма ₽', sumInput);
    const fPurpose = field('Назначение', purposeInput);
    const fKassa = field('Касса', kassaSelect);
    const fComment = field('Комментарий', commentInput, { aside: 'необязательно' });

    // --- журналы для подсчёта долга (§12.4) — лениво, один раз --------
    let debtJournals = null;
    let debtLoading = null;
    function ensureDebtJournals() {
      if (debtJournals) return Promise.resolve(debtJournals);
      if (debtLoading) return debtLoading;
      debtLoading = Journal.readMany([
        CONFIG.JOURNAL_УБОРКИ, CONFIG.JOURNAL_МАСТЕР, CONFIG.JOURNAL_ВЫПЛАТЫ,
      ]).then((res) => { debtJournals = res; return res; });
      return debtLoading;
    }

    // Сумма активных строк журнала по предикату.
    function sumActive(records, matchFn, sumField) {
      let total = 0;
      records.forEach((r) => {
        if (String(r.data['статус']).trim() === 'отменена') return;
        if (matchFn(r.data)) total += num(r.data[sumField]);
      });
      return total;
    }

    // Долг = начислено − выплачено (упрощённо, §12.4 / грабли 3.5).
    // Возвращает число либо null (данных недостаточно).
    function computeDebt(type, recipientId, journals) {
      if (!recipientId) return null;
      const paid = sumActive(journals[CONFIG.JOURNAL_ВЫПЛАТЫ].records,
        (d) => d['тип_получателя'] === type &&
          d['id_получателя'] === recipientId &&
          String(d['источник']).trim() === 'со счёта Ренто', 'сумма_₽');

      if (type === 'горничная') {
        const ver = versionMap('спр_горничные', 'id_версии', 'id_горничной');
        const accrued = sumActive(journals[CONFIG.JOURNAL_УБОРКИ].records,
          (d) => (ver[d['id_горничной']] || d['id_горничной']) === recipientId,
          'сумма_₽');
        return accrued - paid;
      }
      if (type === 'мастер') {
        const ver = versionMap('спр_мастера', 'id_версии', 'id_мастера');
        const accrued = sumActive(journals[CONFIG.JOURNAL_МАСТЕР].records,
          (d) => (ver[d['id_мастера']] || d['id_мастера']) === recipientId,
          'сумма_₽');
        return accrued - paid;
      }
      // Сотрудник / собственник / кредитор: журналов начислений в
      // Инкременте 3 ещё нет — честно показываем «нет данных» (§12.4).
      return null;
    }

    function renderDebt() {
      const type = typeSelect.value;
      const id = currentReceiverId();
      if (!type || !id || type === 'прочее') { debtHint.textContent = ''; return; }
      debtHint.textContent = 'Считаем текущий долг…';
      ensureDebtJournals().then((journals) => {
        // Получатель мог смениться, пока шла загрузка.
        if (typeSelect.value !== type || currentReceiverId() !== id) return;
        const debt = computeDebt(type, id, journals);
        if (debt == null) {
          debtHint.textContent = 'Текущий долг: нет данных';
        } else if (debt > 0) {
          debtHint.textContent = 'Текущий долг перед получателем: ' + money(debt);
        } else if (debt < 0) {
          debtHint.textContent = 'Переплата получателю: ' + money(-debt);
        } else {
          debtHint.textContent = 'Долга перед получателем нет';
        }
      }).catch(() => { debtHint.textContent = 'Текущий долг: нет данных'; });
    }

    // Текущий id получателя (из выпадашки или поля ввода).
    function currentReceiverId() {
      return typeSelect.value === 'прочее'
        ? receiverText.value.trim() : receiverSelect.value;
    }

    // Перестроить выпадашку реквизитов под выбранного получателя (§12.3).
    function rebuildReqs() {
      const type = typeSelect.value;
      const id = receiverSelect.value;
      const src = REQ_SRC[type];
      if (!src || !id) {
        fillSelect(reqSelect, []);
        // У кредитора/прочего реквизитов в системе нет — скрываем поле.
        fReq.style.display = (type && !src) ? 'none' : '';
        return;
      }
      fReq.style.display = '';
      const rows = Cache.get(src[0])
        .filter((r) => r[src[1]] === id && isYes(r['активен']));
      fillSelect(reqSelect, rows.map((r) => ({
        value: r['id_реквизита'],
        text: r['название'] + (r['банк'] ? ' · ' + r['банк'] : ''),
      })), rows.length ? 'Выберите…' : '— реквизитов нет —');
      const def = rows.find((r) => isYes(r['по_умолчанию']));
      if (def) reqSelect.value = def['id_реквизита'];
    }

    // Перестроить выпадашку получателя под выбранный тип (§12.2).
    function rebuildReceivers() {
      const type = typeSelect.value;
      if (type === 'прочее') {
        receiverSelect.style.display = 'none';
        receiverText.style.display = '';
        fReq.style.display = 'none';
      } else {
        receiverSelect.style.display = '';
        receiverText.style.display = 'none';
        const src = RECEIVER_SRC[type];
        const rows = src ? Cache.forDropdown(src[0]) : [];
        fillSelect(receiverSelect, rows.map((r) => ({
          value: r[src[1]], text: r['фио'],
        })));
        rebuildReqs();
      }
      rebuildObjects();
      debtHint.textContent = '';
    }

    // ADR-016: список объектов выбранного собственника (стабильный
    // id_объекта). Видимо только для тип_получателя='собственник'.
    // Дубль по id_объекта (если у собственника две версии одного и
    // того же объекта) — снимаем по последней встретившейся версии,
    // достаточно для выпадашки.
    function rebuildObjects() {
      if (typeSelect.value !== 'собственник') {
        fObject.style.display = 'none';
        objectSelect.value = '';
        return;
      }
      fObject.style.display = '';
      const ownerId = receiverSelect.value;
      if (!ownerId) {
        fillSelect(objectSelect, [], '— сначала выберите собственника —');
        return;
      }
      const seen = {};
      Cache.forDropdown('спр_объекты').forEach((o) => {
        if (o['id_собственника'] === ownerId) {
          seen[o['id_объекта']] = o['название_короткое'];
        }
      });
      const opts = Object.keys(seen).map((id) => ({ value: id, text: seen[id] }));
      fillSelect(objectSelect, opts,
        opts.length ? 'Выберите объект…' : '— у собственника нет объектов —');
    }

    typeSelect.addEventListener('change', () => {
      rebuildReceivers();
      renderDebt();
    });
    receiverSelect.addEventListener('change', () => {
      rebuildReqs();
      rebuildObjects();
      renderDebt();
    });
    receiverText.addEventListener('change', renderDebt);
    rebuildReceivers();

    const draftNote = h('div', { class: 'draft-note', style: 'display:none' });

    function snapshot() {
      return {
        дата: dateEl.value, тип: typeSelect.value,
        получатель: receiverSelect.value, получательТекст: receiverText.value,
        объект: objectSelect.value,
        реквизит: reqSelect.value, сумма: sumInput.value,
        назначение: purposeInput.value, касса: kassaSelect.value,
        комментарий: commentInput.value,
      };
    }
    function restore(d) {
      dateEl.value = d.дата || today();
      typeSelect.value = d.тип || '';
      rebuildReceivers();             // перестроить под тип
      receiverSelect.value = d.получатель || '';
      receiverText.value = d.получательТекст || '';
      rebuildReqs();                  // под выбранного получателя
      rebuildObjects();               // под выбранного собственника
      reqSelect.value = d.реквизит || reqSelect.value;
      objectSelect.value = d.объект || '';
      sumInput.value = d.сумма || '';
      purposeInput.value = d.назначение || '';
      kassaSelect.value = d.касса || '';
      commentInput.value = d.комментарий || '';
      renderDebt();
    }

    function validate() {
      [fDate, fType, fReceiver, fObject, fSum, fPurpose, fKassa].forEach(clearError);
      let ok = true;
      if (!dateEl.value) { showError(fDate, 'Укажите дату'); ok = false; }
      if (!typeSelect.value) { showError(fType, 'Выберите тип получателя'); ok = false; }
      if (!currentReceiverId()) {
        showError(fReceiver, 'Укажите получателя'); ok = false;
      }
      // ADR-016: для выплаты собственнику объект обязателен.
      if (typeSelect.value === 'собственник' && !objectSelect.value) {
        showError(fObject, 'Выберите объект, по которому идёт выплата'); ok = false;
      }
      if (!(num(sumInput.value) > 0)) {
        showError(fSum, 'Сумма должна быть больше 0'); ok = false;
      }
      if (!purposeInput.value.trim()) {
        showError(fPurpose, 'Укажите назначение выплаты'); ok = false;
      }
      if (!kassaSelect.value) { showError(fKassa, 'Выберите кассу'); ok = false; }
      return ok;
    }

    function collect() {
      const sum = num(sumInput.value);
      const id = currentReceiverId();
      const имя = Operations.receiverName(typeSelect.value, id);
      return {
        'дата_внесения': nowISO(),
        'id_менеджера_внёс': employee['id_сотрудника'],
        'дата_выплаты': dateEl.value,
        'тип_получателя': typeSelect.value,
        'id_получателя': id,                       // стабильный id / текст
        // ADR-016: id_объекта только для собственника (стабильный id);
        // для остальных типов поле в листе остаётся пустым.
        'id_объекта': typeSelect.value === 'собственник' ? objectSelect.value : '',
        'id_реквизита': typeSelect.value === 'прочее' ? '' : reqSelect.value,
        'сумма_₽': sum,
        'источник': 'со счёта Ренто',              // §12.5
        'назначение': purposeInput.value.trim(),
        'id_связанной_операции': '',               // §12.5
        'касса': kassaSelect.value,
        'комментарий': commentInput.value.trim(),
        'статус': 'активна',
        'отменена_кем': '', 'отменена_когда': '', 'id_исходной_операции': '',
        '_journal': CONFIG.JOURNAL_ВЫПЛАТЫ,
        '_logType': 'выплата',
        '_shortDesc': 'Выплата ' + имя + ', ' + sum + ' ₽',
        '_managerId': employee['id_сотрудника'],
      };
    }

    const built = composeForm({
      formType, opts, draftNote, queueKey: 'выплата', validate, collect,
      // ADR-016: fObject между fReceiver и fReq, виден только для
      // тип_получателя='собственник'.
      fieldNodes: [fDate, fType, fReceiver, fObject, fReq, fSum, fPurpose, fKassa, fComment],
    });
    setupDraft(formType, built.form, snapshot, restore, draftNote);

    return Screens.formScreen({
      employee, title: '+ Выплата',
      subtitle: 'Выплата получателю со счёта Ренто. Под получателем — ' +
        'подсказка по текущему долгу.',
      content: built.form,
      onBack: () => opts.onExit(),
      onRefresh: opts.onRefresh, onLogout: opts.onLogout,
      onOpenHelp: opts.onOpenHelp,
    });
  }

  // =========================== «+ Заселение» ===========================
  // §7. Самая сложная форма: расчёт чистой выручки и долей + блок
  // распределения (10 типов строк) + многожурнальная запись (§7.6).

  // 10 типов строк распределения (§7.4 / TICKET-4.2).
  //  recipient: вид контрола получателя — справочник / 'категория' /
  //             'текст' / 'из_квартиры' (авто-собственник, ADR-014 п.1) /
  //             null (получателя нет — для строк «Поступит от площадки»).
  //  журнал:    'выплаты' / 'хоз_расходы' / 'касса' / null (записи нет).
  //  типПолуч:  значение тип_получателя для журнал_выплаты.
  //  типКассы:  значение тип_кассы для журнал_касса (ADR-015).
  const DIST_TYPES = [
    { value: 'собственник', text: 'Собственнику напрямую от гостя',
      recipient: 'из_квартиры', журнал: 'выплаты', типПолуч: 'собственник' },
    // Р/с и безнал — один счёт ООО (решение Морган): оба способа
    // поступления пишут один тип_кассы 'р/с ООО Сингуляр'. Отдельного
    // пункта «безнал» НЕТ — иначе два пункта писали бы один тип_кассы и
    // реконструкция при правке заселения не различала бы их. Канон сверён
    // по выписке мая, под него настроена формула ДДС.
    { value: 'ренто_рс', text: 'Ренто на р/с / безнал (счёт ООО)',
      recipient: null, журнал: 'касса', типКассы: 'р/с ООО Сингуляр' },
    { value: 'ренто_карта', text: 'Ренто на карту физлица (касса)',
      recipient: null, журнал: 'касса', типКассы: 'карта физлица' },
    // Тип «Поступит от площадки» убран (INTERFACE_DATA_SPEC v1.6):
    // batch от площадки фиксируется полем «Площадка должна Ренто ₽»
    // в шапке — дублировать строкой распределения не нужно.
    { value: 'горничная', text: 'Горничной напрямую от гостя',
      recipient: 'спр_горничные', журнал: 'выплаты', типПолуч: 'горничная' },
    { value: 'мастер', text: 'Мастеру напрямую от гостя',
      recipient: 'спр_мастера', журнал: 'выплаты', типПолуч: 'мастер' },
    { value: 'сотрудник', text: 'Сотруднику — зарплата',
      recipient: 'спр_сотрудники', журнал: 'выплаты', типПолуч: 'сотрудник' },
    { value: 'хоз_расход', text: 'Хоз-расход',
      recipient: 'категория', журнал: 'хоз_расходы' },
    { value: 'прочее', text: 'Прочее',
      recipient: 'текст', журнал: 'выплаты', типПолуч: 'прочее' },
  ];
  // справочник получателя -> [лист, поле стабильного id].
  const RECIPIENT_SRC = {
    'спр_собственники': ['спр_собственники', 'id_собственника'],
    'спр_горничные': ['спр_горничные', 'id_горничной'],
    'спр_мастера': ['спр_мастера', 'id_мастера'],
    'спр_сотрудники': ['спр_сотрудники', 'id_сотрудника'],
  };

  // Поле-«читалка»: значение, которое нельзя править (чистая выручка,
  // доход Ренто — §7.2). Возвращает узел с ._value для записи текста.
  function readoutBox() {
    const value = h('span', { class: 'readout-value' }, '—');
    const box = h('div', { class: 'field-readout' }, value);
    box._value = value;
    return box;
  }

  function openЗаселение(opts) {
    const employee = opts.employee;
    // Режим правки заселения (opts.editOf = строка журнал_поступления из
    // поиска). Append-only: «правка» = замещение — старое заселение
    // каскадно откатывается, отредактированное уходит новым (sender
    // 'правка_заселения'). Форма предзаполняется родителем + связанными
    // строками. Черновик в этом режиме не ведём.
    const editOf = opts.editOf || null;
    const formType = editOf ? 'правка_заселения' : 'заселение';

    const objects = Cache.forDropdown('спр_объекты');
    const objectsByVersion = {};
    objects.forEach((o) => { objectsByVersion[o['id_версии']] = o; });
    const models = Cache.get('спр_модели_расчёта');

    // --- БРОНИРОВАНИЕ ---
    const objectSelect = selectInput();
    fillSelect(objectSelect, objects.map((o) => ({
      value: o['id_версии'], text: o['название_короткое'],
    })));
    const inEl = dateInput();                       // заезд = сегодня
    const outEl = h('input', { class: 'field-input', type: 'date' });
    outEl.value = tomorrow();                       // выезд = завтра
    const channelSelect = selectInput();
    fillSelect(channelSelect, ['прямая', 'суточно', 'авито', 'яндекс',
      'островок'].map((c) => ({ value: c, text: c })));

    // --- ФИНАНСЫ ---
    const sumInput = numberInput();
    const commissionInput = numberInput();
    const commissionHint = h('div', { class: 'field-hint' });
    const netBox = readoutBox();
    const ownerInput = numberInput();
    const ownerHint = h('div', { class: 'field-hint' });
    const rentoBox = readoutBox();
    const platformInput = numberInput();
    // Доп.оплата (продление / ранний-поздний выезд) — Опция A (DEVLOG
    // 04.06): входит в чистую выручку, доход собственника считается без
    // неё, вся доп.оплата уходит в доход Ренто.
    const extraInput = numberInput();
    const extraHint = h('div', { class: 'field-hint' });

    // --- РАСПРЕДЕЛЕНИЕ ---
    const rowsBox = h('div', { class: 'dist-rows' });
    const counter = h('span', { class: 'dist-counter' });
    let rows = [];

    // --- КОММЕНТАРИЙ ---
    // Касса из шапки убрана (ADR-014 п.3, ADR-015): касса задаётся
    // типом строки распределения, движения уходят в журнал_касса.
    const commentInput = textarea('Комментарий');

    // --- поля-обёртки ---
    const fObject = field('Объект', objectSelect);
    const fIn = field('Заезд', inEl);
    const fOut = field('Выезд', outEl);
    const fChannel = field('Канал брони', channelSelect);
    const fSum = field('Сумма брони ₽', sumInput);
    const fCommission = field('Комиссия площадки ₽',
      h('div', { class: 'field-stack' }, commissionInput, commissionHint));
    const fExtra = field('Доп. оплата ₽',
      h('div', { class: 'field-stack' }, extraInput, extraHint));
    const fNet = field('Чистая выручка ₽', netBox, { aside: 'авто' });
    const fOwner = field('Доход собственника ₽',
      h('div', { class: 'field-stack' }, ownerInput, ownerHint));
    const fRento = field('Доход Ренто ₽', rentoBox, { aside: 'авто' });
    const fPlatform = field('Площадка должна Ренто ₽', platformInput);
    const fComment = field('Комментарий', commentInput, { aside: 'необязательно' });

    // ------------------------- расчёты (§7.1, §7.3) ----------------------
    // base — выручка от брони за вычетом комиссии площадки. Доход
    // собственника считается ТОЛЬКО от неё (Опция A). net — чистая
    // выручка: base + доп.оплата; доп целиком оседает в доходе Ренто.
    function base() {
      return Math.max(0, num(sumInput.value) - num(commissionInput.value));
    }
    function net() {
      return base() + num(extraInput.value);
    }
    function modelOf() {
      const obj = objectsByVersion[objectSelect.value];
      if (!obj) return null;
      return models.find((m) => m['id_модели'] === obj['id_модели']) || null;
    }
    // Дефолт дохода собственника по модели объекта (§7.3).
    function ownerDefault() {
      const m = modelOf();
      if (!m) return null;
      if (String(m['тип']).trim().toLowerCase() === 'фикс') return 0;
      const share = num(m['доля_ренто_%']);
      // Опция A: доля собственника — от base (без доп.оплаты).
      return Math.round(base() * (1 - share / 100));
    }
    let lastOwnerDefault = null;
    let lastPlatformDefault = null;

    // Распределено X / Y — счётчик контроля (§7.4).
    function distSum() {
      return rows.reduce((s, r) => s + r.sum(), 0);
    }
    function syncCounter() {
      const y = net();
      // Контроль (INTERFACE_DATA_SPEC v1.6): строки + площадка_должна_₽
      // = чистая выручка. Поле «Площадка должна Ренто ₽» входит
      // отдельным слагаемым, не дублируется строкой распределения.
      const x = distSum() + num(platformInput.value);
      const delta = y - x;
      const ok = delta === 0;
      let text = (ok ? '✓ ' : '') +
        x.toLocaleString('ru-RU') + ' / ' + y.toLocaleString('ru-RU') + ' ₽';
      if (delta > 0) {
        text += ' — ещё ' + delta.toLocaleString('ru-RU') + ' ₽';
      } else if (delta < 0) {
        text += ' — лишних ' + Math.abs(delta).toLocaleString('ru-RU') + ' ₽';
      }
      counter.textContent = text;
      counter.className = 'dist-counter ' + (ok ? 'dist-ok' : 'dist-bad');
    }

    // Пересчёт всех производных полей.
    function recompute() {
      const n = net();
      netBox._value.textContent = money(n);

      // M4 (Фикс): доля собственника не применяется — собственнику платится
      // фикс отдельно (обязательство считается в юнит-витрине, колонка O).
      // Поле дохода собственника скрываем и фиксируем 0, чтобы вся чистая
      // выручка ушла в доход Ренто (канон, DEVLOG 12.06). Менеджер не сможет
      // случайно вписать долю на фикс-заселение.
      const mNow = modelOf();
      const isFix = mNow && String(mNow['тип']).trim().toLowerCase() === 'фикс';
      fOwner.style.display = isFix ? 'none' : '';
      if (isFix && num(ownerInput.value) !== 0) ownerInput.value = 0;

      const def = ownerDefault();
      if (def != null) {
        // Не перебито — подставляем дефолт.
        if (ownerInput.value === '' ||
            num(ownerInput.value) === lastOwnerDefault) {
          ownerInput.value = def;
        }
        lastOwnerDefault = def;
      }
      // Доход Ренто = чистая − доход собственника (§7.2). Доп.оплата
      // входит в чистую (n) и потому целиком попадает в доход Ренто.
      const rento = n - num(ownerInput.value);
      rentoBox._value.textContent = money(rento);

      // Яндекс: предзаполняем «Площадка должна Ренто ₽» базовой чистой
      // выручкой — Яндекс платит batch'ом после выезда, живых денег
      // брони при заселении нет (правило DEVLOG 12.06). Авто-значение
      // следит за base() как дефолт дохода собственника: перебитое
      // руками не трогаем; при уходе с канала «яндекс» авто-значение
      // снимаем (ручное остаётся).
      const pdef = channelSelect.value === 'яндекс' ? base() : null;
      if (pdef != null) {
        if (platformInput.value === '' ||
            num(platformInput.value) === lastPlatformDefault) {
          platformInput.value = pdef;
        }
        lastPlatformDefault = pdef;
      } else if (lastPlatformDefault != null) {
        if (num(platformInput.value) === lastPlatformDefault) {
          platformInput.value = '';
        }
        lastPlatformDefault = null;
      }

      // Подсказка по доп.оплате (Опция A) — куда она уходит.
      if (num(extraInput.value) > 0) {
        extraHint.textContent = 'вся сумма идёт в доход Ренто';
        extraHint.className = 'field-hint';
      } else {
        extraHint.textContent = '';
        extraHint.className = 'field-hint';
      }

      // Подсказка по доходу собственника (§7.3).
      const m = modelOf();
      if (def == null) {
        ownerHint.textContent = 'выберите объект — подставим долю по модели';
        ownerHint.className = 'field-hint';
      } else if (num(ownerInput.value) !== def) {
        ownerHint.textContent = 'отличается от модели на ' +
          money(Math.abs(num(ownerInput.value) - def));
        ownerHint.className = 'field-hint hint-warn';
      } else {
        ownerHint.textContent = 'по модели ' +
          (m ? m['название'] : '') + ' = ' + money(def);
        ownerHint.className = 'field-hint';
      }
      // Канал «прямая» — комиссия ожидается 0 (§7.5: предупреждение,
      // не блокировка сохранения).
      if (channelSelect.value === 'прямая' && num(commissionInput.value) !== 0) {
        commissionHint.textContent = 'для канала «прямая» комиссия обычно 0';
        commissionHint.className = 'field-hint hint-warn';
      } else {
        commissionHint.textContent = '';
        commissionHint.className = 'field-hint';
      }
      syncCounter();
    }

    [sumInput, commissionInput, ownerInput, extraInput].forEach((el) => {
      el.addEventListener('input', recompute);
    });
    objectSelect.addEventListener('change', () => {
      // Сменилась квартира → пересобрать строки-«собственник»
      // (ADR-014 п.1: получатель и реквизит привязаны к квартире).
      rows.forEach((r) => r.syncFromObject && r.syncFromObject());
      recompute();
    });
    channelSelect.addEventListener('change', recompute);
    // Платформа входит в контроль суммы распределения
    // (INTERFACE_DATA_SPEC v1.6: строки + площадка_должна_₽ = чистая).
    platformInput.addEventListener('input', syncCounter);

    // --------------------- строка распределения (§7.4) -------------------
    function makeDistRow() {
      const typeSelect = selectInput();
      fillSelect(typeSelect, DIST_TYPES.map((t) => ({
        value: t.value, text: t.text,
      })));
      const recipientSlot = h('div', { class: 'dist-recipient' });
      let recipientControl = null;
      // Для типа 'собственник' (ADR-014 п.1) получатель и реквизит
      // подставляются из выбранной квартиры; держим их отдельно.
      let derivedOwnerId = '';
      let derivedRequisiteId = '';
      const sumEl = numberInput();
      sumEl.classList.add('dist-sum');
      const xBtn = h('button', { class: 'dist-x', type: 'button' }, '×');

      const row = {
        node: null,
        typeDef: () => DIST_TYPES.find((t) => t.value === typeSelect.value),
        type: () => typeSelect.value,
        recipient: () => {
          const t = row.typeDef();
          if (t && t.recipient === 'из_квартиры') return derivedOwnerId;
          return recipientControl ? recipientControl.value : '';
        },
        requisiteId: () => derivedRequisiteId,
        sum: () => num(sumEl.value),
        serialize: () => ({
          тип: typeSelect.value,
          получатель: recipientControl ? recipientControl.value : '',
          сумма: sumEl.value,
        }),
      };

      // Перестроить контрол получателя под выбранный тип строки.
      function syncRecipient() {
        recipientSlot.innerHTML = '';
        recipientControl = null;
        derivedOwnerId = '';
        derivedRequisiteId = '';
        const t = row.typeDef();
        if (!t || !t.recipient) {
          recipientSlot.append(h('span', { class: 'dist-norecip' }, '—'));
          return;
        }
        if (t.recipient === 'из_квартиры') {
          renderOwnerSlot();
          return;
        }
        if (t.recipient === 'текст') {
          recipientControl = textInput('Кому / за что');
        } else if (t.recipient === 'категория') {
          recipientControl = selectInput();
          fillSelect(recipientControl,
            categoryOptions(CONFIG.JOURNAL_ХОЗ_РАСХОДЫ, 'расход'));
        } else {
          recipientControl = selectInput();
          const src = RECIPIENT_SRC[t.recipient];
          fillSelect(recipientControl, Cache.forDropdown(src[0]).map((r) => ({
            value: r[src[1]], text: r['фио'],
          })));
        }
        recipientControl.classList.add('dist-recipient-ctl');
        recipientSlot.append(recipientControl);
      }

      // Рендер слота получателя для строки «Собственнику напрямую»
      // (ADR-014 п.1): авто-собственник + реквизит «по умолчанию» + копия.
      function renderOwnerSlot() {
        recipientSlot.innerHTML = '';
        derivedOwnerId = '';
        derivedRequisiteId = '';
        const obj = objectsByVersion[objectSelect.value];
        if (!obj) {
          recipientSlot.append(h('div', { class: 'dist-owner empty' },
            '— сначала выберите квартиру —'));
          return;
        }
        const ownerId = obj['id_собственника'];
        const owner = ownerId && Cache.get('спр_собственники')
          .find((o) => o['id_собственника'] === ownerId);
        if (!owner) {
          recipientSlot.append(h('div', { class: 'dist-owner empty' },
            'у квартиры не указан собственник'));
          return;
        }
        derivedOwnerId = ownerId;
        const reqs = Cache.get('спр_реквизиты_собственников')
          .filter((r) => r['id_собственника'] === ownerId && isYes(r['активен']));
        const def = reqs.find((r) => isYes(r['по_умолчанию']));
        if (!def) {
          // Карты «по умолчанию» нет. Заселение это БОЛЬШЕ не блокирует
          // (решение фаундера 15.06): можно сохранить без реквизита либо
          // завести карту прямо отсюда. Кнопка ведёт в форму реквизита с
          // предвыбранным собственником; черновик заселения сохраняется и
          // восстановится по возвращении.
          const addBtn = h('button',
            { class: 'link-btn', type: 'button' }, '+ добавить карту');
          if (opts.onOpenНовыйРеквизит) {
            addBtn.addEventListener('click', () =>
              opts.onOpenНовыйРеквизит(ownerId));
          } else {
            addBtn.disabled = true;
          }
          recipientSlot.append(h('div', { class: 'dist-owner' },
            h('div', { class: 'owner-name' }, owner['фио']),
            h('div', { class: 'owner-req empty' },
              'карты нет — можно сохранить без неё или завести:'),
            addBtn));
          return;
        }
        derivedRequisiteId = def['id_реквизита'];
        const reqText = [def['номер'], def['банк'], def['получатель']]
          .filter((s) => String(s || '').trim()).join(' · ');
        const copyBtn = h('button',
          { class: 'copy-btn', type: 'button', title: 'Скопировать реквизит' },
          'копировать');
        copyBtn.addEventListener('click', () => {
          if (!navigator.clipboard) { copyBtn.textContent = 'нет clipboard'; return; }
          navigator.clipboard.writeText(reqText).then(() => {
            const prev = copyBtn.textContent;
            copyBtn.textContent = '✓ скопировано';
            setTimeout(() => { copyBtn.textContent = prev; }, 1500);
          }).catch(() => { copyBtn.textContent = 'ошибка копирования'; });
        });
        recipientSlot.append(
          h('div', { class: 'dist-owner' },
            h('div', { class: 'owner-name' }, owner['фио']),
            h('div', { class: 'owner-req-row' },
              h('div', { class: 'owner-req', title: reqText }, reqText),
              copyBtn)));
      }
      // Внешние перерисовки (смена квартиры): только для строк-собственника.
      row.syncFromObject = () => {
        const t = row.typeDef();
        if (t && t.recipient === 'из_квартиры') renderOwnerSlot();
      };

      typeSelect.addEventListener('change', () => { syncRecipient(); recompute(); });
      sumEl.addEventListener('input', syncCounter);
      xBtn.addEventListener('click', () => removeRow(row));
      syncRecipient();

      row.node = h('div', { class: 'dist-row' },
        typeSelect, recipientSlot, sumEl, xBtn);
      row.restore = (d) => {
        typeSelect.value = d.тип || '';
        syncRecipient();
        if (recipientControl) recipientControl.value = d.получатель || '';
        sumEl.value = d.сумма || '';
      };
      return row;
    }

    // Флаг «форма проинициализирована». Пока false (на старте, во время
    // setupDraft.restore) — addRow/removeRow НЕ сохраняют черновик.
    // Иначе addRow() начальной пустой строки создавал «черновик», и
    // плашка «Восстановлен черновик» висела на каждом первом открытии.
    let formInited = false;
    function addRow(data) {
      const row = makeDistRow();
      rows.push(row);
      rowsBox.append(row.node);
      if (data) row.restore(data);
      syncCounter();
      if (formInited && !editOf) saveDraft(formType, snapshot());
    }
    function removeRow(row) {
      rows = rows.filter((r) => r !== row);
      row.node.remove();
      syncCounter();
      if (formInited && !editOf) saveDraft(formType, snapshot());
    }

    const addBtn = h('button', { class: 'dist-add', type: 'button' },
      '+ Добавить строку распределения');
    addBtn.addEventListener('click', () => addRow());

    // ---------------------------- секции ---------------------------------
    function section(eyebrow, ...nodes) {
      return h('div', { class: 'form-section' },
        h('span', { class: 'eyebrow' }, eyebrow), ...nodes);
    }
    const bookingSection = section('БРОНИРОВАНИЕ',
      fObject,
      h('div', { class: 'field-row-2' }, fIn, fOut),
      fChannel);
    // Поля ФИНАНСОВ — по 2 в ряд, все одной ширины (половина строки).
    // Чистая выручка — первой в своей паре, доп.оплата рядом. Площадка
    // нечётная — в паре с пустым спейсером, чтобы остаться половинной.
    const financeSection = section('ФИНАНСЫ',
      h('div', { class: 'field-row-2' }, fSum, fCommission),
      h('div', { class: 'field-row-2' }, fNet, fExtra),
      h('div', { class: 'field-row-2' }, fOwner, fRento),
      h('div', { class: 'field-row-2' }, fPlatform, h('div', { class: 'field' })));
    const distSection = section('РАСПРЕДЕЛЕНИЕ',
      // Подпись «Где деньги физически — сумма строк = чистой выручке»
      // убрана (ADR-014 п.4). Счётчик сошлось/не сошлось остаётся —
      // он функциональный.
      h('div', { class: 'dist-head' }, counter),
      rowsBox, addBtn);

    // ----------------------------- черновик ------------------------------
    const draftNote = h('div', { class: 'draft-note', style: 'display:none' });

    function snapshot() {
      return {
        объект: objectSelect.value, заезд: inEl.value, выезд: outEl.value,
        канал: channelSelect.value, сумма: sumInput.value,
        комиссия: commissionInput.value, доходС: ownerInput.value,
        площадка: platformInput.value, доп: extraInput.value,
        комментарий: commentInput.value,
        строки: rows.map((r) => r.serialize()),
      };
    }
    function restore(d) {
      objectSelect.value = d.объект || '';
      inEl.value = d.заезд || today();
      outEl.value = d.выезд || tomorrow();
      channelSelect.value = d.канал || '';
      sumInput.value = d.сумма || '';
      commissionInput.value = d.комиссия || '';
      platformInput.value = d.площадка || '';
      extraInput.value = d.доп || '';
      commentInput.value = d.комментарий || '';
      // строки распределения
      rows.forEach((r) => r.node.remove());
      rows = [];
      // Старые черновики могли нести тип `площадка` — он удалён в
      // INTERFACE_DATA_SPEC v1.6 (платформа теперь только поле в шапке).
      // Не восстанавливаем такие строки, иначе типа в селекторе нет и
      // строка остаётся «битой».
      const validTypes = new Set(DIST_TYPES.map((t) => t.value));
      (d.строки || []).forEach((rd) => {
        if (!validTypes.has(rd.тип)) return;
        addRow(rd);
      });
      ownerInput.value = '';
      recompute();                       // дефолт дохода собственника
      if (d.доходС) ownerInput.value = d.доходС; // ручной ввод важнее
      recompute();
    }

    // ---------------------------- валидации (§7.5) -----------------------
    function validate() {
      [fObject, fIn, fOut, fChannel, fSum, fExtra, fNet, fOwner].forEach(clearError);
      rows.forEach((r) => r.node.classList.remove('dist-row-error'));
      let ok = true;
      const fail = (fw, msg) => { showError(fw, msg); ok = false; };

      if (!objectSelect.value) fail(fObject, 'Выберите объект');
      if (!channelSelect.value) fail(fChannel, 'Выберите канал брони');
      if (!inEl.value) fail(fIn, 'Укажите дату заезда');
      if (!outEl.value) fail(fOut, 'Укажите дату выезда');
      if (inEl.value && outEl.value && outEl.value <= inEl.value) {
        fail(fOut, 'Выезд должен быть позже заезда');
      }
      if (!(num(sumInput.value) > 0)) fail(fSum, 'Сумма брони должна быть больше 0');

      // Доп.оплата не может быть отрицательной (Опция A).
      if (num(extraInput.value) < 0) fail(fExtra, 'Доп.оплата не может быть меньше 0');

      const n = net();
      if (!(n > 0)) fail(fNet, 'Чистая выручка должна быть больше 0');

      // Канал «прямая» с ненулевой комиссией не блокирует — это лишь
      // предупреждение (§7.5), оно показано в подсказке под комиссией.

      // Доход собственника в [0; base] (§5.4 + Опция A: доп.оплата
      // собственнику не достаётся, потолок — выручка без доп).
      const owner = num(ownerInput.value);
      if (owner < 0 || owner > base()) {
        fail(fOwner, 'Доход собственника — от 0 до (сумма − комиссия)');
      }

      // Распределение. Строки НЕ обязательны, когда «Площадка должна
      // Ренто ₽» покрывает чистую выручку целиком — типовой яндекс-кейс:
      // вся базовая выручка придёт batch'ем после выезда, распределять
      // при заселении нечего (DEVLOG 12.06; жёсткое требование строки
      // здесь и толкало менеджера проводить деньги кассой — инцидент
      // OP-2026-06-05-001). Транзакция без связанных строк валидна:
      // пишется только родитель в журнал_поступления.
      const distTotal0 = distSum() + num(platformInput.value);
      if (!rows.length && distTotal0 !== n) {
        fail(fNet, 'Добавьте строку распределения — «Площадка должна ' +
          'Ренто» (' + distTotal0 + ') не покрывает чистую выручку (' +
          n + ')');
      }
      rows.forEach((r) => {
        const t = r.typeDef();
        let bad = false;
        if (!t) bad = true;
        if (t && t.recipient && !r.recipient()) bad = true;
        // Реквизит собственника БОЛЬШЕ НЕ обязателен (решение фаундера
        // 15.06): у собственника может не быть карты в справочнике, и
        // это не повод блокировать заселение. Если карты нет — её можно
        // завести прямо из строки («+ карту») либо сохранить без неё
        // (id_реквизита уйдёт пустым). Раньше тут стоял жёсткий блок
        // (ADR-014 п.1) — снят.
        if (!(r.sum() > 0)) bad = true;
        if (bad) { r.node.classList.add('dist-row-error'); ok = false; }
      });
      // Контроль (INTERFACE_DATA_SPEC v1.6): строки + площадка_должна_₽
      // = чистая выручка. Платформа отдельным слагаемым, без строки-
      // дубля «Поступит от площадки».
      const distTotal = distSum() + num(platformInput.value);
      if (rows.length && distTotal !== n) {
        fail(fNet, 'Сумма распределения и «Площадка должна Ренто» (' +
          distTotal + ') не равна чистой выручке (' + n + ')');
      }
      // Яндекс платит batch'ом «выезд + 5 дней» — живых денег брони при
      // заселении нет (DEVLOG 12.06, инцидент OP-2026-06-05-001: кассовая
      // строка при заселении дала двойной счёт в ДДС). Кассовые строки
      // сверх доп.оплаты — почти наверняка ошибка, но не всегда:
      // доп.оплата легитимно приходит живыми деньгами, поэтому
      // предупреждение-confirm, не жёсткий блок (как дубль адреса, 8.2).
      if (ok && channelSelect.value === 'яндекс') {
        const cashSum = rows.reduce((s, r) => {
          const t = r.typeDef();
          return s + (t && t.журнал === 'касса' ? r.sum() : 0);
        }, 0);
        if (cashSum > num(extraInput.value)) {
          if (!confirm('Яндекс платит после выезда (примерно выезд + ' +
            '5 дней) — живых денег брони при заселении ещё нет.\n\n' +
            'Деньги уже реально на счёте/карте Ренто?\nЕсли нет — ' +
            'укажите их в поле «Площадка должна Ренто ₽», а не ' +
            'кассовой строкой.\n\nВсё равно сохранить с кассовой строкой?')) {
            ok = false;
          }
        }
      }
      return ok;
    }

    // ----------------------- что уходит в очередь (§7.6) -----------------
    function collect() {
      const n = net();
      const obj = objectsByVersion[objectSelect.value];
      const objName = obj ? obj['название_короткое'] : '';

      const parent = {
        'дата_внесения': nowISO(),
        'id_менеджера': employee['id_сотрудника'],
        'тип_записи': 'заселение',
        'дата_операции': inEl.value,
        'id_объекта_версии': objectSelect.value,
        'дата_с': inEl.value,
        'дата_по': outEl.value,
        'канал_брони': channelSelect.value,
        'сумма_бронирования_₽': num(sumInput.value),
        'комиссия_площадки_₽': num(commissionInput.value),
        'площадка_должна_₽': num(platformInput.value),
        // Опция A (DEVLOG 04.06): доп.оплата — отдельная колонка; чистая
        // выручка = (сумма−комиссия)+доп, доп целиком в доходе Ренто.
        'доп_оплата_₽': num(extraInput.value),
        'чистая_выручка_₽': n,
        'доход_собственника_₽': num(ownerInput.value),
        'доход_ренто_₽': n - num(ownerInput.value),
        // Колонка `касса` для тип_записи='заселение' не используется —
        // движения уходят в журнал_касса (ADR-015). Оставляем пустой;
        // у batch_площадки эта же колонка по-прежнему заполняется.
        'касса': '',
        'комментарий': commentInput.value.trim(),
        'статус': 'активна',
        'отменена_кем': '', 'отменена_когда': '', 'id_исходной_операции': '',
      };

      // Связанные строки — только типы, порождающие запись (§7.6,
      // ADR-015: добавлены строки журнал_касса для ренто_*).
      const lines = [];
      rows.forEach((r) => {
        const t = r.typeDef();
        if (!t || !t.журнал) return;
        if (t.журнал === 'выплаты') {
          lines.push({ journal: CONFIG.JOURNAL_ВЫПЛАТЫ, data: {
            'дата_внесения': nowISO(),
            'id_менеджера_внёс': employee['id_сотрудника'],
            'дата_выплаты': inEl.value,
            'тип_получателя': t.типПолуч,
            'id_получателя': r.recipient(),
            // ADR-016: id_объекта пишется только для собственника
            // (для горничной/мастера/сотрудника/прочего выплата к
            // объекту не привязана). Стабильный id, не версия.
            'id_объекта': t.типПолуч === 'собственник'
              ? (obj ? obj['id_объекта'] : '') : '',
            // Для собственника — id реквизита «по умолчанию» из
            // выбранной квартиры (ADR-014 п.1); для остальных пусто.
            'id_реквизита': r.requisiteId() || '',
            'сумма_₽': r.sum(),
            'источник': 'гостем при заселении',
            // `назначение` проставит Journal.appendIncasementTx (нужен
            // id родителя).
            'касса': '',
            'комментарий': '',
            'статус': 'активна',
            'отменена_кем': '', 'отменена_когда': '',
            'id_исходной_операции': '',
          } });
        } else if (t.журнал === 'хоз_расходы') {
          // хоз-расход (§7.6): пишется в журнал_хоз_расходы, объект —
          // объект заселения, id_связанной_операции проставит tx (ADR-012).
          lines.push({ journal: CONFIG.JOURNAL_ХОЗ_РАСХОДЫ, data: {
            'дата_внесения': nowISO(),
            'id_менеджера': employee['id_сотрудника'],
            'дата': inEl.value,
            'id_объекта_версии': objectSelect.value,
            'id_категории': r.recipient(),
            'описание': 'Хоз-расход при заселении ' + objName,
            'сумма_₽': r.sum(),
            'id_получателя': '',
            'касса': '',
            'комментарий': '',
            'статус': 'активна',
            'отменена_кем': '', 'отменена_когда': '',
            'id_исходной_операции': '',
          } });
        } else if (t.журнал === 'касса') {
          // ADR-015: ренто_рс / ренто_карта → журнал_касса.
          // тип_кассы зашит в DIST_TYPES: 'р/с ООО Сингуляр' / 'карта физлица'
          // (безнал схлопнут в р/с — один счёт ООО).
          lines.push({ journal: CONFIG.JOURNAL_КАССА, data: {
            'дата_внесения': nowISO(),
            'id_менеджера': employee['id_сотрудника'],
            'тип_кассы': t.типКассы,
            'сумма_₽': r.sum(),
            'дата': inEl.value,
            'статус': 'активна',
            'отменена_кем': '', 'отменена_когда': '',
          } });
        }
      });

      return {
        parent, lines,
        '_shortDesc': 'Заселение ' + objName + ', ' +
          inEl.value + '–' + outEl.value + ', ' + num(sumInput.value) + ' ₽',
        '_managerId': employee['id_сотрудника'],
      };
    }

    // -------- режим правки: предзаполнение + замещающий collect ----------
    // Обратный маппинг связанных строк → типы строк распределения.
    const PAYTYPE_TO_DIST = {
      'собственник': 'собственник', 'горничная': 'горничная',
      'мастер': 'мастер', 'сотрудник': 'сотрудник', 'прочее': 'прочее',
    };
    const KASSA_TO_DIST = {
      // Все метки счёта ООО (историческая 'р/с', схлопнутая 'безнал' и
      // канон 'р/с ООО Сингуляр') → один тип строки 'ренто_рс'.
      'р/с': 'ренто_рс', 'р/с ООО Сингуляр': 'ренто_рс', 'безнал': 'ренто_рс',
      'карта физлица': 'ренто_карта',
    };

    // Заполнить поля шапки из строки журнал_поступления.
    function fillEditParent(d) {
      objectSelect.value = d['id_объекта_версии'] || '';
      inEl.value = d['дата_с'] || today();
      outEl.value = d['дата_по'] || tomorrow();
      channelSelect.value = d['канал_брони'] || '';
      sumInput.value = d['сумма_бронирования_₽'] || '';
      commissionInput.value = d['комиссия_площадки_₽'] || '';
      platformInput.value = d['площадка_должна_₽'] || '';
      extraInput.value = d['доп_оплата_₽'] || '';
      commentInput.value = d['комментарий'] || '';
      ownerInput.value = '';
      recompute();                          // дефолт дохода собственника
      // Доход собственника из исходной важнее дефолта (как в restore).
      const ds = d['доход_собственника_₽'];
      if (ds !== '' && ds != null) ownerInput.value = ds;
      recompute();
    }

    // Подгрузить активные связанные строки и пересобрать распределение.
    async function loadEditChildren(parentId) {
      rows.forEach((r) => r.node.remove());
      rows = [];
      let byJ;
      try {
        byJ = await Journal.readMany([
          CONFIG.JOURNAL_ВЫПЛАТЫ, CONFIG.JOURNAL_ХОЗ_РАСХОДЫ, CONFIG.JOURNAL_КАССА]);
      } catch (err) {
        console.error('Правка заселения — загрузка связанных строк:', err);
        addRow();                           // фолбэк: одна пустая строка
        recompute();
        return;
      }
      const active = (j) => ((byJ[j] && byJ[j].records) || []).filter((rec) =>
        rec.data['id_связанной_операции'] === parentId &&
        String(rec.data['статус']).trim() !== 'отменена');
      const dist = [];
      active(CONFIG.JOURNAL_ВЫПЛАТЫ).forEach((rec) => {
        const t = PAYTYPE_TO_DIST[String(rec.data['тип_получателя']).trim()];
        if (t) dist.push({ тип: t, получатель: rec.data['id_получателя'] || '',
          сумма: rec.data['сумма_₽'] });
      });
      active(CONFIG.JOURNAL_ХОЗ_РАСХОДЫ).forEach((rec) => {
        dist.push({ тип: 'хоз_расход', получатель: rec.data['id_категории'] || '',
          сумма: rec.data['сумма_₽'] });
      });
      active(CONFIG.JOURNAL_КАССА).forEach((rec) => {
        const t = KASSA_TO_DIST[String(rec.data['тип_кассы']).trim()];
        if (t) dist.push({ тип: t, получатель: '', сумма: rec.data['сумма_₽'] });
      });
      if (!dist.length) addRow(); else dist.forEach((rd) => addRow(rd));
      recompute();
    }

    // Замещающий collect: тот же payload заселения + id старого для отката.
    function collectEdit() {
      const base = collect();
      return {
        oldId: editOf.data['id_операции'],
        parent: base.parent,
        lines: base.lines,
        '_shortDesc': 'Правка заселения ' + editOf.data['id_операции'] +
          ' → ' + base['_shortDesc'],
        '_managerId': base['_managerId'],
      };
    }

    // Стартовая строка распределения — одна пустая (§7.4: минимум 1).
    addRow();
    recompute();

    const editBanner = editOf ? h('div', { class: 'draft-note' },
      'Правка заменит заселение ' + editOf.data['id_операции'] +
      ': старое будет отменено, сохранится новая версия. ' +
      'Это изменит цифры периода.') : null;

    const built = composeForm({
      formType, opts, draftNote,
      topNote: editBanner,
      queueKey: editOf ? 'правка_заселения' : 'заселение',
      validate,
      collect: editOf ? collectEdit : collect,
      fieldNodes: [bookingSection, financeSection, distSection, fComment],
    });
    if (editOf) {
      // Режим правки: шапку заполняем сразу, строки — после загрузки
      // связанных. Черновик не подключаем (правка — разовое замещение).
      fillEditParent(editOf.data);
      loadEditChildren(editOf.data['id_операции']);
      formInited = true;
    } else {
      setupDraft(formType, built.form, snapshot, restore, draftNote);
      // С этого момента дальнейшие add/removeRow — реальные
      // пользовательские действия, их можно сохранять в черновик.
      formInited = true;
    }

    return Screens.formScreen({
      employee,
      title: editOf ? 'Изменить заселение' : '+ Заселение',
      subtitle: editOf
        ? 'Поменяйте что нужно и сохраните — старое заселение заменится новым.'
        : 'Гость заехал — опишите, как были распределены деньги. ' +
          'Система подскажет по расчёту сумм.',
      content: built.form,
      onBack: () => opts.onExit(),
      onRefresh: opts.onRefresh, onLogout: opts.onLogout,
      onOpenHelp: opts.onOpenHelp,
    });
  }

  // ================= модалка «Предложить категорию» (§14) ==============
  // cfg: { employee, contextType: 'расход'|'доход', onProposed(name) }
  function openCategoryModal(cfg) {
    const nameInput = textInput('Например: Ремонт сантехники');
    const whyInput = textarea('Для каких операций нужна эта категория');
    const fName = field('Название категории', nameInput, { aside: 'обязательно' });
    const fWhy = field('Зачем нужна', whyInput, { aside: 'обязательно' });

    const ctxNote = h('div', { class: 'modal-ctx' },
      h('span', {}, '🏷️ Тип категории — '),
      h('strong', {}, cfg.contextType),
      h('span', {}, ' (определён формой)'));
    const pendingNote = h('div', { class: 'pending-note' },
      '⚠ До одобрения операция сохранится с пометкой PENDING — ' +
      'основатель пересчитает её при апруве.');

    const submitBtn = h('button',
      { class: 'btn-primary', type: 'submit' }, 'Отправить заявку');
    const form = h('form', { class: 'modal-form' },
      ctxNote, fName, fWhy, pendingNote, submitBtn);

    const modal = UI.modal('Предложить категорию', form);

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      [fName, fWhy].forEach(clearError);
      let ok = true;
      if (!nameInput.value.trim()) { showError(fName, 'Введите название'); ok = false; }
      if (!whyInput.value.trim()) {
        showError(fWhy, 'Объясните, зачем нужна категория'); ok = false;
      }
      if (!ok) return;
      submitBtn.disabled = true;
      // Заявка идёт через очередь — отправитель «предложение_категории»
      // (app.js) пишет в _категории_на_модерации и в _лог_действий.
      Queue.add('предложение_категории', {
        'timestamp': nowISO(),
        'id_менеджера': cfg.employee['id_сотрудника'],
        'название': nameInput.value.trim(),
        'тип': cfg.contextType,
        'зачем': whyInput.value.trim(),
      });
      cfg.onProposed(nameInput.value.trim());
      modal.close();
    });
  }

  // ================ «Отчёт собственнику» (§17, TICKET-5.2) =============
  //
  // Поток: главный → форма параметров → (чтение журнала + сборка
  // текста) → экран превью → «Копировать» (clipboard + лог) → главный.
  //
  // Блок выплат реализован полностью (§17.2 п.3 для агентских / п.2
  // для M4). Семантика id_объекта — стабильный id (ADR-018), на это
  // ссылаются и openЗаселение.collect, и openВыплата.collect.

  // Кол-во полных дней между двумя датами YYYY-MM-DD, включительно.
  function daysInclusive(fromStr, toStr) {
    if (!fromStr || !toStr) return 0;
    const a = new Date(fromStr + 'T00:00:00');
    const b = new Date(toStr + 'T00:00:00');
    return Math.max(0, Math.round((b - a) / 86400000) + 1);
  }
  // Длительность брони (выезд − заезд), как в посуточной аренде.
  function stayDays(fromStr, toStr) {
    if (!fromStr || !toStr) return 0;
    const a = new Date(fromStr + 'T00:00:00');
    const b = new Date(toStr + 'T00:00:00');
    return Math.max(0, Math.round((b - a) / 86400000));
  }
  // Ночи брони с пересечением с периодом отчёта. Бронь занимает
  // ночи [дата_с, дата_по) — день выезда не ночь. Период отчёта —
  // даты включительно [periodFrom, periodTo]; следующая «ночь» после
  // periodTo — это уже periodTo+1 утром, так что верхняя граница
  // пересечения = periodTo+1day (исключая).
  function clippedNights(stayFrom, stayTo, periodFrom, periodTo) {
    if (!stayFrom || !stayTo) return 0;
    const a0 = new Date(stayFrom + 'T00:00:00').getTime();
    const a1 = new Date(stayTo + 'T00:00:00').getTime();
    const p0 = new Date(periodFrom + 'T00:00:00').getTime();
    const p1 = new Date(periodTo + 'T00:00:00').getTime() + 86400000;
    const lo = Math.max(a0, p0);
    const hi = Math.min(a1, p1);
    return Math.max(0, Math.round((hi - lo) / 86400000));
  }
  // Дней в месяце даты YYYY-MM-DD: EOMONTH(дата,0).getDate().
  // Используется как знаменатель пропорции M4: реальная длительность
  // месяца (28/29/30/31), а не условные «31 день» как было раньше.
  function daysInMonth(dateStr) {
    if (!dateStr) return 31;
    const d = new Date(dateStr + 'T00:00:00');
    return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  }
  // Бронь пересекается с периодом, если её дата_с ИЛИ дата_по в нём
  // (§17.2 шаг 1 — "дата_с или дата_по попадает в период").
  function broneInPeriod(rec, from, to) {
    const ds = String(rec['дата_с'] || '');
    const dp = String(rec['дата_по'] || '');
    const dsIn = ds && from <= ds && ds <= to;
    const dpIn = dp && from <= dp && dp <= to;
    return dsIn || dpIn;
  }

  // Сборка текста отчёта по одному объекту собственника. Возвращает
  // строку — кусок отчёта; склейку секций делает caller.
  // incomeRecords — записи журнала_поступления;
  // paymentRecords — записи журнала_выплаты;
  // ownerHasSingleObject — у собственника всего один объект (тогда
  //   выплаты без id_объекта однозначно его, мы их подхватываем как
  //   фолбэк для исторических записей до ADR-016).
  function renderObjectSection(args) {
    const { owner, object, model, periodFrom, periodTo,
      incomeRecords, paymentRecords, ownerHasSingleObject } = args;
    const isFix = String(model['тип'] || '').trim().toLowerCase() === 'фикс';
    // Все версии этого объекта (на агрегацию по периоду).
    const versions = Cache.get('спр_объекты')
      .filter((o) => o['id_объекта'] === object['id_объекта'])
      .map((o) => o['id_версии']);
    const versionSet = new Set(versions);

    // Активные заселения этого объекта в периоде.
    const stays = incomeRecords.filter((rec) => {
      const d = rec.data;
      if (String(d['статус']).trim() === 'отменена') return false;
      if (String(d['тип_записи']) !== 'заселение') return false;
      if (!versionSet.has(d['id_объекта_версии'])) return false;
      return broneInPeriod(d, periodFrom, periodTo);
    });

    const sumBookings = stays.reduce(
      (s, r) => s + num(r.data['сумма_бронирования_₽']), 0);
    const sumCommission = stays.reduce(
      (s, r) => s + num(r.data['комиссия_площадки_₽']), 0);
    const sumNet = stays.reduce(
      (s, r) => s + num(r.data['чистая_выручка_₽']), 0);
    const sumRento = stays.reduce(
      (s, r) => s + num(r.data['доход_ренто_₽']), 0);
    const sumOwner = stays.reduce(
      (s, r) => s + num(r.data['доход_собственника_₽']), 0);
    const arrivals = stays.length;
    // Загрузка: считаем ночи с обрезанием по периоду (брони, которые
    // частью лежат вне периода, попадают только пересечением). >100%
    // не обрезаем — если две брони пересеклись на одном объекте, это
    // аномалия данных, и она должна быть видна (не маскироваться).
    const stayDaysTotal = stays.reduce(
      (s, r) => s + clippedNights(
        r.data['дата_с'], r.data['дата_по'], periodFrom, periodTo), 0);
    const periodDays = daysInclusive(periodFrom, periodTo);
    const loadPct = periodDays
      ? Math.round((stayDaysTotal / periodDays) * 100) : 0;

    // Заголовок секции: «ФИО — Объект».
    const header = owner['фио'] + ' — ' + object['название_короткое'] + '\n' +
      'Отчётный период: ' + periodFrom + ' — ' + periodTo + '\n';

    // Колоночный формат: справа — суммы. Простая раскладка
    // padEnd(40)+padStart(15). Точный отступ ради читаемости при
    // вставке в Telegram/WhatsApp (моноширинный или нет).
    const fmt = (label, value) =>
      String(label).padEnd(38) + ' ' + String(value).padStart(15);
    const fmtMoney = (label, value, signed) => {
      const v = signed ? '−' + money(value) : money(value);
      return fmt(label, v);
    };

    // --- Блок выплат (§17.2 шаг 3 для агентских, шаг 2 для M4) -------
    // Источники для агентских — оба (со счёта Ренто + гостем при
    // заселении). Для M4 — только со счёта Ренто (гость напрямую
    // собственнику не платит). id_объекта — стабильный (ADR-018).
    const allowedSources = isFix
      ? new Set(['со счёта Ренто'])
      : new Set(['со счёта Ренто', 'гостем при заселении']);
    const objId = object['id_объекта'];
    const ownerId = owner['id_собственника'];
    const matchedPayments = paymentRecords.filter((rec) => {
      const d = rec.data;
      if (String(d['статус']).trim() === 'отменена') return false;
      if (d['тип_получателя'] !== 'собственник') return false;
      if (d['id_получателя'] !== ownerId) return false;
      if (!allowedSources.has(String(d['источник']).trim())) return false;
      const pd = String(d['дата_выплаты'] || '');
      if (!(pd >= periodFrom && pd <= periodTo)) return false;
      const recObj = String(d['id_объекта'] || '').trim();
      // Точное совпадение по объекту — берём. Пустой id_объекта —
      // берём только если у собственника всего один объект (тогда
      // привязка однозначна, это страховка от исторических записей
      // до ADR-016).
      if (recObj === objId) return true;
      if (recObj === '' && ownerHasSingleObject) return true;
      return false;
    });
    // Группировка по дате выплаты, итог.
    const byDate = {};
    matchedPayments.forEach((rec) => {
      const d = rec.data;
      const key = String(d['дата_выплаты'] || '');
      byDate[key] = (byDate[key] || 0) + num(d['сумма_₽']);
    });
    const paymentDates = Object.keys(byDate).sort();
    const paidTotal = paymentDates.reduce((s, k) => s + byDate[k], 0);

    function paidBlock(toAmount) {
      const out = ['ВЫПЛАЧЕНО:'];
      if (!paymentDates.length) {
        out.push('   (за период выплат не было)');
      } else {
        paymentDates.forEach((dt) => {
          out.push('   ' + fmt(dt, money(byDate[dt])));
        });
      }
      out.push('   ' + fmt('ИТОГО:', money(paidTotal)));
      out.push('');
      const debt = toAmount - paidTotal;
      if (debt > 0) {
        out.push(fmt('Долг Ренто:', money(debt)));
      } else if (debt < 0) {
        out.push(fmt('Долг Ренто:', '0 ₽ (переплата ' + money(-debt) + ')'));
      } else {
        out.push(fmt('Долг Ренто:', money(0)));
      }
      return out;
    }

    const lines = [header];
    if (isFix) {
      const fix = num(object['фикс_₽']);
      // Пропорция дней: знаменатель — реальная длительность месяца
      // даты-начала периода (DAY(EOMONTH(periodFrom,0))), не условные
      // «31». Февральский отчёт за полный месяц = фикс целиком,
      // а за две недели февраля = фикс × 14/28 (или 29 в високосный).
      const monthDays = daysInMonth(periodFrom);
      const payoutCalc = Math.round(fix * periodDays / monthDays);
      const payoutLabel = periodDays === monthDays
        ? 'Фиксированный платёж по договору:'
        : 'Фикс по договору (' + periodDays + ' дн. из ' + monthDays + '):';
      lines.push(fmt(payoutLabel, money(payoutCalc)));
      lines.push('');
      lines.push(...paidBlock(payoutCalc));
      lines.push('');
      lines.push('Справочно (не идёт в расчёт):');
      lines.push('   ' + fmt('Заездов:', arrivals));
      lines.push('   ' + fmt('Загрузка:', loadPct + '%'));
      lines.push('   ' + fmt('Сумма броней:', money(sumBookings)));
    } else {
      const share = num(model['доля_ренто_%']);
      lines.push(fmt('Общая сумма бронирований', money(sumBookings)));
      lines.push(fmtMoney('Комиссия площадок', sumCommission, true));
      lines.push(fmt('Фактический доход', money(sumNet)));
      lines.push(fmtMoney('Наша комиссия (' + share + '%)', sumRento, true));
      lines.push(fmt('К выплате собственнику', money(sumOwner)));
      lines.push('');
      lines.push(...paidBlock(sumOwner));
      lines.push('');
      lines.push(fmt('Заездов:', arrivals));
      lines.push(fmt('Загрузка:', loadPct + '%'));
    }
    return lines.join('\n');
  }

  // Полная сборка текста отчёта: одна секция на объект + разделители.
  function buildReportText(args) {
    const { owner, objects, periodFrom, periodTo,
      incomeRecords, paymentRecords, models } = args;
    const ownerHasSingleObject = objects.length === 1;
    const sections = objects.map((obj) => {
      const model = models.find((m) => m['id_модели'] === obj['id_модели']);
      if (!model) {
        return owner['фио'] + ' — ' + obj['название_короткое'] + '\n' +
          'Модель расчёта не найдена в справочнике — отчёт собрать нельзя.';
      }
      return renderObjectSection({
        owner, object: obj, model, periodFrom, periodTo,
        incomeRecords, paymentRecords, ownerHasSingleObject,
      });
    });

    // Орфан-выплаты: записи собственнику без id_объекта при нескольких
    // объектах в отчёте — в посекционные суммы они не попали и могут
    // ввести в заблуждение. Перечисляем их явно одним блоком в конце.
    let orphanBlock = '';
    if (!ownerHasSingleObject) {
      const objIds = new Set(objects.map((o) => o['id_объекта']));
      const orphans = paymentRecords.filter((rec) => {
        const d = rec.data;
        if (String(d['статус']).trim() === 'отменена') return false;
        if (d['тип_получателя'] !== 'собственник') return false;
        if (d['id_получателя'] !== owner['id_собственника']) return false;
        const pd = String(d['дата_выплаты'] || '');
        if (!(pd >= periodFrom && pd <= periodTo)) return false;
        const recObj = String(d['id_объекта'] || '').trim();
        return recObj === '' || !objIds.has(recObj);
      });
      if (orphans.length) {
        const total = orphans.reduce((s, r) => s + num(r.data['сумма_₽']), 0);
        const lines = ['Внимание: ' + orphans.length +
          ' выплат(ы) собственнику не привязаны к объектам этого отчёта,',
          'в суммы выше не вошли:'];
        orphans.forEach((r) => {
          const d = r.data;
          lines.push('   ' +
            String(d['дата_выплаты'] || '—').padEnd(12) + ' ' +
            money(num(d['сумма_₽'])).padStart(12) + '   ' +
            (d['назначение'] || ''));
        });
        lines.push('   ИТОГО орфан: ' + money(total));
        orphanBlock = '\n\n' + lines.join('\n');
      }
    }

    // Несколько объектов — добавим вводную «Все объекты собственника (N)».
    if (objects.length > 1) {
      const intro = owner['фио'] + ' — Все объекты собственника (' +
        objects.length + ')\n' +
        'Отчётный период: ' + periodFrom + ' — ' + periodTo + '\n';
      return intro + '\n' + sections.join('\n\n— — —\n\n') + orphanBlock;
    }
    return sections[0] + orphanBlock;
  }

  function openОтчётСобственнику(opts) {
    const employee = opts.employee;

    const ownerSelect = selectInput();
    fillSelect(ownerSelect, Cache.forDropdown('спр_собственники').map((o) => ({
      value: o['id_собственника'], text: o['фио'],
    })));
    const objectSelect = selectInput();
    const fromEl = h('input', { class: 'field-input', type: 'date' });
    const toEl = h('input', { class: 'field-input', type: 'date' });

    const fOwner = field('Собственник', ownerSelect);
    const fObject = field('Объект', objectSelect,
      { aside: 'или «все объекты собственника»' });
    const fFrom = field('Период с', fromEl);
    const fTo = field('Период по', toEl);

    // Все актуальные версии объектов выбранного собственника — для
    // выпадашки. Значение опции — стабильный id_объекта.
    function rebuildObjects() {
      const ownerId = ownerSelect.value;
      if (!ownerId) {
        fillSelect(objectSelect, [], '— сначала выберите собственника —');
        return;
      }
      // Уникальные id_объекта (стабильный), название из актуальной версии.
      const seen = {};
      Cache.forDropdown('спр_объекты').forEach((o) => {
        if (o['id_собственника'] === ownerId) {
          seen[o['id_объекта']] = o['название_короткое'];
        }
      });
      const opts2 = [{ value: '__all__', text: 'Все объекты собственника' }]
        .concat(Object.keys(seen).map((id) => ({ value: id, text: seen[id] })));
      objectSelect.innerHTML = '';
      objectSelect.append(h('option', { value: '' }, 'Выберите…'));
      opts2.forEach((o) => objectSelect.append(
        h('option', { value: o.value }, o.text)));
    }
    ownerSelect.addEventListener('change', rebuildObjects);
    rebuildObjects();

    const submitBtn = h('button',
      { class: 'btn-primary btn-auto', type: 'submit' }, 'Собрать отчёт');
    const cancelBtn = h('button',
      { class: 'btn-ghost', type: 'button' }, 'Отмена');
    cancelBtn.addEventListener('click', () => opts.onExit());

    const footer = h('div', { class: 'op-footer' },
      h('span', { class: 'op-footer-hint' }, ''),
      h('div', { class: 'op-footer-actions' }, cancelBtn, submitBtn));

    const form = h('form', { class: 'op-form' },
      fOwner, fObject,
      h('div', { class: 'field-row-2' }, fFrom, fTo),
      h('div', { class: 'op-divider' }), footer);

    function validate() {
      [fOwner, fObject, fFrom, fTo].forEach(clearError);
      let ok = true;
      if (!ownerSelect.value) { showError(fOwner, 'Выберите собственника'); ok = false; }
      if (!objectSelect.value) { showError(fObject, 'Выберите объект или «все»'); ok = false; }
      if (!fromEl.value) { showError(fFrom, 'Укажите начало периода'); ok = false; }
      if (!toEl.value) { showError(fTo, 'Укажите конец периода'); ok = false; }
      if (fromEl.value && toEl.value && fromEl.value > toEl.value) {
        showError(fTo, 'Конец периода раньше начала'); ok = false;
      }
      return ok;
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      submitBtn.disabled = true;
      if (!validate()) { submitBtn.disabled = false; return; }
      submitBtn.textContent = 'Читаю журналы…';
      try {
        const both = await Journal.readMany([
          CONFIG.JOURNAL_ПОСТУПЛЕНИЯ, CONFIG.JOURNAL_ВЫПЛАТЫ,
        ]);
        const incomeRecords =
          (both[CONFIG.JOURNAL_ПОСТУПЛЕНИЯ] && both[CONFIG.JOURNAL_ПОСТУПЛЕНИЯ].records) || [];
        const paymentRecords =
          (both[CONFIG.JOURNAL_ВЫПЛАТЫ] && both[CONFIG.JOURNAL_ВЫПЛАТЫ].records) || [];
        const owner = Cache.get('спр_собственники')
          .find((o) => o['id_собственника'] === ownerSelect.value);
        const models = Cache.get('спр_модели_расчёта');
        // Объекты для отчёта.
        const allOwnerObjects = (() => {
          const seen = {};
          Cache.forDropdown('спр_объекты').forEach((o) => {
            if (o['id_собственника'] === ownerSelect.value) {
              seen[o['id_объекта']] = o;
            }
          });
          return Object.values(seen);
        })();
        const objects = objectSelect.value === '__all__'
          ? allOwnerObjects
          : allOwnerObjects.filter((o) => o['id_объекта'] === objectSelect.value);
        const text = buildReportText({
          owner, objects, periodFrom: fromEl.value, periodTo: toEl.value,
          incomeRecords, paymentRecords, models,
        });
        openPreview({
          employee, owner, periodFrom: fromEl.value, periodTo: toEl.value,
          objectsCount: objects.length, originalText: text,
          onExit: opts.onExit,
          onRefresh: opts.onRefresh, onLogout: opts.onLogout,
      onOpenHelp: opts.onOpenHelp,
        });
      } catch (err) {
        console.error('Сборка отчёта:', err);
        submitBtn.disabled = false;
        submitBtn.textContent = 'Собрать отчёт';
        alert('Не удалось собрать отчёт: ' + (err.message || err));
      }
    });

    return Screens.formScreen({
      employee, title: 'Отчёт собственнику',
      subtitle: 'Выберите собственника, объект и период — система соберёт ' +
        'текст отчёта, его можно будет отредактировать и скопировать.',
      breadcrumb: 'Отчёты',
      content: form,
      onBack: () => opts.onExit(),
      onRefresh: opts.onRefresh, onLogout: opts.onLogout,
      onOpenHelp: opts.onOpenHelp,
    });
  }

  // ----- Экран превью (полноэкранный, не модалка — ADR-006) -----------
  function openPreview(cfg) {
    const textArea = h('textarea',
      { class: 'field-input field-textarea report-area', rows: '18' });
    textArea.value = cfg.originalText;

    const sourceHint = h('div', { class: 'field-hint' },
      'исходные цифры из системы — текст можно отредактировать перед отправкой');

    const copyBtn = h('button',
      { class: 'btn-primary btn-auto', type: 'button' }, 'Копировать');
    const cancelBtn = h('button',
      { class: 'btn-ghost', type: 'button' }, 'Отмена');
    cancelBtn.addEventListener('click', () => cfg.onExit());

    // Простой однострочный diff: считаем, текст изменён или нет, а
    // строки отличия складываем в комментарий для лога. Глубокий diff
    // лога не несёт смысла — основатель сам видит текст в превью.
    function isEdited() { return textArea.value !== cfg.originalText; }
    function shortDescription() {
      return cfg.owner['фио'] + ', ' +
        cfg.periodFrom + ' — ' + cfg.periodTo + ', ' +
        'объектов: ' + cfg.objectsCount + ', ' +
        'текст изменён: ' + (isEdited() ? 'да' : 'нет');
    }

    copyBtn.addEventListener('click', async () => {
      copyBtn.disabled = true;
      try {
        if (navigator.clipboard) {
          await navigator.clipboard.writeText(textArea.value);
        } else {
          textArea.select();
          document.execCommand('copy');
        }
      } catch (err) {
        copyBtn.disabled = false;
        alert('Не удалось скопировать в буфер: ' + (err.message || err));
        return;
      }
      // Лог факта генерации (§17.5) — через очередь, ретраи бесплатно.
      Queue.add('отчёт_собственнику', {
        'timestamp': nowISO(),
        'id_менеджера': cfg.employee['id_сотрудника'],
        'краткое_описание': shortDescription(),
      });
      cfg.onExit();
    });

    const footer = h('div', { class: 'op-footer' },
      h('span', { class: 'op-footer-hint' }, 'Текст уже в нужном формате — ' +
        'можно править перед отправкой собственнику'),
      h('div', { class: 'op-footer-actions' }, cancelBtn, copyBtn));

    const body = h('div', { class: 'op-form' },
      sourceHint, textArea,
      h('div', { class: 'op-divider' }), footer);

    return Screens.formScreen({
      employee: cfg.employee,
      title: 'Превью отчёта',
      subtitle: 'Проверьте текст и нажмите «Копировать», чтобы отправить ' +
        'собственнику. Сам факт копирования запишется в лог действий.',
      breadcrumb: 'Отчёты',
      content: body,
      onBack: cfg.onExit,
      onRefresh: cfg.onRefresh, onLogout: cfg.onLogout,
    });
  }

  // ===================== «Поиск операций» (§16, §18.2) =================
  // Полноэкранный экран основателя (ADR-006). Только для основателя
  // (см. FOUNDER_ONLY_FORMS в app.js). Тикет 6.1 — каркас:
  //
  // По букве §16 корректируется любая операция «новой строкой в том же
  // журнале». На практике многожурнальные операции (заселение и его
  // связанные строки выплат/касс/хоз-расходов) ломают инвариант §7
  // («сумма строк распределения = чистой выручке»), а §16 не описывает,
  // как считается «дельта чистой выручки при сохранённом распределении».
  // Поэтому в скоупе 6.1 — только одножурнальные операции:
  //   - журнал_уборки, журнал_мастер
  //   - журнал_хоз_расходы / журнал_выплаты без id_связанной_операции
  //   - журнал_прочие_расходы / журнал_прочие_доходы
  //   - журнал_поступления для тип_записи=batch_площадки
  // Заселение, связанные строки заселения и кассовые движения — не
  // корректируются здесь (если понадобится — отдельный ADR + правки §16).
  //
  // Список таких журналов держим один раз: и для batchGet поиска, и для
  // фильтрации «корректируемых» строк.
  const CORRECTABLE_JOURNALS = [
    CONFIG.JOURNAL_УБОРКИ,
    CONFIG.JOURNAL_МАСТЕР,
    CONFIG.JOURNAL_ХОЗ_РАСХОДЫ,
    CONFIG.JOURNAL_ПРОЧИЕ_РАСХОДЫ,
    CONFIG.JOURNAL_ПРОЧИЕ_ДОХОДЫ,
    CONFIG.JOURNAL_ВЫПЛАТЫ,
    CONFIG.JOURNAL_ПОСТУПЛЕНИЯ,
  ];

  // Тип операции для записи (по реестру Operations) — нужен для подписи
  // в списке поиска и в форме корректировки. Учитывает match-предикаты
  // реестра: для одной строки журнала_поступления это либо «заселение»,
  // либо «batch_площадки»; для журнал_выплаты — «выплата» (если строка
  // самостоятельная) или «касса_заселения» (не сюда). Возвращает null,
  // если строка не сматчилась ни одним типом — такие отсеиваются ещё
  // на этапе поиска.
  function opTypeFor(journal, data) {
    for (const t of Operations.list()) {
      if (t.journal !== journal) continue;
      if (t.match && !t.match(data)) continue;
      return t;
    }
    return null;
  }

  function isCorrectable(op, data) {
    if (!op) return false;
    // Кассовые строки заселения — служебные, отдельно не правятся.
    // Заселение теперь доступно в поиске: правится замещением (откат +
    // новое) через форму заселения, не дельта-корректировкой —
    // действие разводится в рендере результатов (isЗаселение).
    if (op.key === 'касса_заселения') return false;
    // Уже отменённую корректировать бессмысленно — она и так не идёт в
    // витрины. Откат отменённой — невозможен (по «Моим внесениям»).
    if (String(data['статус']).trim() === 'отменена') return false;
    return true;
  }

  // Поле журнала, в котором лежит id менеджера-автора. У журнал_выплаты
  // — id_менеджера_внёс (ADR-016 / §4.22), у остальных — id_менеджера.
  function managerFieldOf(headers) {
    return headers.indexOf('id_менеджера_внёс') !== -1
      ? 'id_менеджера_внёс' : 'id_менеджера';
  }

  function openПоискОпераций(opts) {
    const employee = opts.employee;

    const idInput = textInput('OP-2026-05-...');
    const fromInput = h('input', { class: 'field-input', type: 'date' });
    const toInput = h('input', { class: 'field-input', type: 'date' });
    const searchBtn = h('button',
      { class: 'btn-primary btn-auto', type: 'submit' }, 'Найти');

    const fId = field('ID операции', idInput,
      { aside: 'полностью или фрагмент' });
    const fFrom = field('Внесена с', fromInput, { aside: 'необязательно' });
    const fTo = field('Внесена по', toInput, { aside: 'необязательно' });

    const fieldsRow = h('div', { class: 'op-search-fields' }, fId, fFrom, fTo);
    const resultsBox = h('div', { class: 'op-search-results' });
    const hintBox = h('p', { class: 'muted' },
      'Введите ID операции (или его фрагмент) и/или диапазон дат внесения, ' +
      'затем нажмите «Найти». Поиск идёт по операциям: уборка, мастер, ' +
      'хоз-расход, прочее, выплата, batch площадки — для них корректировка; ' +
      'и заселения — для них правка через форму (старое заменяется новым). ' +
      'Служебные кассовые строки заселения отдельно не показываются.');
    resultsBox.append(hintBox);

    function setStatus(text, cls) {
      UI.clear(resultsBox);
      resultsBox.append(h('p', { class: cls || 'muted' }, text));
    }

    function withinPeriod(iso) {
      if (!iso) return false;
      const day = String(iso).slice(0, 10);
      if (fromInput.value && day < fromInput.value) return false;
      if (toInput.value && day > toInput.value) return false;
      return true;
    }

    async function runSearch() {
      const idQuery = idInput.value.trim();
      const hasFrom = !!fromInput.value;
      const hasTo = !!toInput.value;
      if (!idQuery && !hasFrom && !hasTo) {
        setStatus('Заполните хотя бы одно поле — иначе вернётся слишком много.',
          'error-banner');
        return;
      }
      if (hasFrom && hasTo && fromInput.value > toInput.value) {
        setStatus('Дата «с» позже даты «по» — поправьте.', 'error-banner');
        return;
      }
      setStatus('Ищем...');

      let byJournal;
      try {
        byJournal = await Journal.readMany(CORRECTABLE_JOURNALS);
      } catch (err) {
        console.error('Поиск операций:', err);
        setStatus('Не удалось прочитать журналы: ' +
          ((err && err.message) || 'ошибка сети') + '.', 'error-banner');
        return;
      }

      const lowerId = idQuery.toLowerCase();
      const rows = [];
      CORRECTABLE_JOURNALS.forEach((journal) => {
        const j = byJournal[journal];
        if (!j) return;
        j.records.forEach((rec) => {
          const data = rec.data;
          const id = String(data['id_операции'] || '');
          if (!id) return;
          const op = opTypeFor(journal, data);
          if (!isCorrectable(op, data)) return;
          if (lowerId && !id.toLowerCase().includes(lowerId)) return;
          if ((hasFrom || hasTo) && !withinPeriod(data['дата_внесения'])) return;
          rows.push({ journal, op, data });
        });
      });

      // Свежие — сверху.
      rows.sort((a, b) => String(b.data['дата_внесения'])
        .localeCompare(String(a.data['дата_внесения'])));

      UI.clear(resultsBox);
      if (!rows.length) {
        resultsBox.append(h('p', { class: 'muted' },
          'Ничего не нашлось. Попробуйте более широкий период или другой ID.'));
        return;
      }
      resultsBox.append(h('p', { class: 'muted' },
        'Найдено: ' + rows.length + '.'));

      const table = h('div', { class: 'today-table' });
      table.append(h('div', { class: 'today-row today-thead' },
        h('div', { class: 'tc tc-id' }, 'ID'),
        h('div', { class: 'tc tc-type' }, 'ТИП'),
        h('div', { class: 'tc tc-desc' }, 'ОПИСАНИЕ'),
        h('div', { class: 'tc tc-sum' }, 'СУММА'),
        h('div', { class: 'tc tc-status' }, 'ДЕЙСТВИЕ')));

      rows.forEach((entry) => {
        const { op, data } = entry;
        // Заселение многожурнальное — правится замещением (откат+новое)
        // через форму заселения, а не дельта-корректировкой.
        const isЗаселение = op.key === 'заселение';
        const actionBtn = h('button',
          { class: 'link-btn', type: 'button' },
          isЗаселение ? 'Изменить заселение' : 'Создать корректировку');
        actionBtn.addEventListener('click', () => {
          if (isЗаселение) opts.onOpenПравкаЗаселения(entry);
          else opts.onOpenКорректировка(entry);
        });
        table.append(h('div', { class: 'today-row' },
          h('div', { class: 'tc tc-id' }, data['id_операции']),
          h('div', { class: 'tc tc-type' }, op.label),
          h('div', { class: 'tc tc-desc' }, op.describe(data)),
          h('div', { class: 'tc tc-sum' }, money(Operations.sumOf(op, data))),
          h('div', { class: 'tc tc-status' }, actionBtn)));
      });

      resultsBox.append(table);
    }

    const form = h('form', { class: 'op-form op-search-form' },
      fieldsRow,
      h('div', { class: 'op-footer' },
        h('span', { class: 'op-footer-hint' },
          'Поиск читает 7 журналов одним запросом.'),
        h('div', { class: 'op-footer-actions' }, searchBtn)),
      h('div', { class: 'op-divider' }),
      resultsBox);
    form.addEventListener('submit', (e) => { e.preventDefault(); runSearch(); });

    return Screens.formScreen({
      employee, title: 'Поиск операций',
      subtitle: 'Раздел для корректировок задним числом (старше дня). ' +
        'Найдите операцию и нажмите «Создать корректировку».',
      breadcrumb: 'Корректировки',
      content: form,
      onBack: () => opts.onExit(),
      onRefresh: opts.onRefresh, onLogout: opts.onLogout,
      onOpenHelp: opts.onOpenHelp,
    });
  }

  // ======================= «Корректировка» (§16) =======================
  // Полноэкранный экран (ADR-006). Создаётся из «Поиск операций» —
  // не из главного меню, поэтому в FORM_OPENERS не сидит.
  //
  // §16.3 v1.7: новая строка в ТОМ ЖЕ журнале, что исходная; исходная
  // не редактируется; в новой строке — `id_исходной_операции` ссылается
  // на КОРЕНЬ цепочки (rootId — вычислен ниже, плоская цепочка),
  // `сумма_₽` = дельта (Морган #8), комментарий начинается с
  // «КОРРЕКТИРОВКА к [id_корня]: [причина]». Структурные поля
  // (объект, получатель, дата_операции) копируются из исходной — в
  // форме они read-only (решение Абдулы 28.05.2026: смена идентичности
  // операции = отмена + новая, не корректировка). Поле `тип_записи`
  // тоже наследуется (НЕ ставим `корректировка`) — признак корректировки
  // = непустое `id_исходной_операции`; это сохраняет видимость
  // корректировки batch_площадки в реестре Operations.
  //
  // opts:
  //   { employee, original: { journal, op, data }, onExit, onRefresh, onLogout }
  function openКорректировка(opts) {
    const employee = opts.employee;
    const { journal, op, data: originalData } = opts.original;
    const sumField = op.sumField || 'сумма_₽';
    const originalId = originalData['id_операции'];
    // §16.3 v1.7: id_исходной_операции корректировки указывает на КОРЕНЬ
    // цепочки, не на непосредственного предшественника. Если корректируем
    // оригинал — корень это он сам; если корректируем уже корректировку —
    // её id_исходной_операции уже указывает на корень, копируем. Итог:
    // плоский список, витрины собирают всё одноуровневым SUMIFS (§16.4).
    const existingRoot = String(originalData['id_исходной_операции'] || '').trim();
    const rootId = existingRoot || originalId;
    const isChainedCorrection = !!existingRoot;

    // #3 (DEVLOG 04.06) — реклассификация. Для журналов с категорией
    // (хоз/прочие расходы, прочие доходы) корректировку можно сделать не
    // суммой-дельтой, а сменой категории: пишем дельту 0 (деньги не
    // двигаем) + новую id_категории. Витрина переносит сумму корня из
    // старой категории в новую (зона Морган). Реклассификация
    // распознаётся как строка с непустым id_исходной_операции и суммой 0
    // — нормальная сумма-корректировка нулём быть не может (валидация).
    const RECLASS_TYPE = {};
    RECLASS_TYPE[CONFIG.JOURNAL_ХОЗ_РАСХОДЫ] = 'расход';
    RECLASS_TYPE[CONFIG.JOURNAL_ПРОЧИЕ_РАСХОДЫ] = 'расход';
    RECLASS_TYPE[CONFIG.JOURNAL_ПРОЧИЕ_ДОХОДЫ] = 'доход';
    const supportsReclass = ('id_категории' in originalData) &&
      !!RECLASS_TYPE[journal];
    const currentCategory = String(originalData['id_категории'] || '');

    // §16.5: превью «итог после корректировки» считается ОТ КОРНЯ
    // цепочки, не от корректируемой строки. rootTotal = sum активных
    // записей с id_операции = rootId ИЛИ id_исходной_операции = rootId.
    // Загружается лениво при открытии формы (отдельный read журнала —
    // sender 'корректировка' тоже читает byJournal через appendOperation,
    // но это два разных момента: тут — для UI, там — для записи; они
    // не делят кэш по дизайну). Пока грузим — превью и сводка
    // отображают «Загружаем итог по корню...».
    let rootTotal = null;
    let rootTotalError = null;
    const rootTotalValueEl = h('span', { class: 'op-summary-value' },
      'Загружаем…');

    Journal.read(journal).then(({ records }) => {
      let total = 0;
      for (const r of records) {
        if (String(r.data['статус']).trim() === 'отменена') continue;
        const id = String(r.data['id_операции'] || '');
        const ref = String(r.data['id_исходной_операции'] || '').trim();
        if (id === rootId || ref === rootId) {
          total += Operations.sumOf(op, r.data);
        }
      }
      rootTotal = total;
      rootTotalValueEl.textContent = money(rootTotal);
      recomputePreview();
    }).catch((err) => {
      rootTotalError = err;
      rootTotalValueEl.textContent = 'не удалось загрузить — попробуйте обновить';
      recomputePreview();
    });

    // Сводка исходной (read-only).
    function row(label, value) {
      return h('div', { class: 'op-summary-row' },
        h('span', { class: 'op-summary-label' }, label),
        h('span', { class: 'op-summary-value' }, value));
    }
    // Если корректируем уже корректировку — отдельной строкой показываем
    // корень цепочки, чтобы основатель понимал: новая запись будет
    // ссылаться на корень, не на эту промежуточную (§16.3). Главное
    // число в сводке — «Текущий итог по корню» (§16.5), а НЕ сумма
    // строки: в плоской цепочке строка-корректировка несёт только
    // дельту, и её сумма не равна тому, что увидит витрина.
    const summaryRows = [
      row('Тип операции', op.label),
      row('ID этой записи', originalId),
    ];
    if (isChainedCorrection) {
      summaryRows.push(row('Корень цепочки', rootId));
    }
    summaryRows.push(
      row('Описание', op.describe(originalData)),
      h('div', { class: 'op-summary-row' },
        h('span', { class: 'op-summary-label' }, 'Текущий итог по корню'),
        rootTotalValueEl));
    const summary = h('div', { class: 'op-summary' }, ...summaryRows);

    // Поле дельты + итог.
    const deltaInput = h('input', {
      class: 'field-input', type: 'number', step: '1',
      placeholder: 'например, -2000',
    });
    const sumPreview = h('div', { class: 'field-hint' },
      'Итог после корректировки: загружаем итог по корню…');
    function recomputePreview() {
      const raw = deltaInput.value;
      if (raw === '' || raw === '-') {
        sumPreview.textContent = rootTotal == null
          ? 'Итог после корректировки: загружаем итог по корню…'
          : 'Итог после корректировки: —';
        return;
      }
      const delta = Number(raw);
      if (isNaN(delta)) {
        sumPreview.textContent = 'Дельта должна быть числом.';
        return;
      }
      if (rootTotal == null) {
        if (rootTotalError) {
          sumPreview.textContent =
            'Не удалось загрузить итог по корню — обновите страницу. ' +
            'Без него превью посчитать нельзя.';
        } else {
          sumPreview.textContent = 'Загружаем итог по корню…';
        }
        return;
      }
      const total = rootTotal + delta;
      const sign = delta > 0 ? '+' : '−';
      sumPreview.textContent = 'Итог после корректировки: ' +
        money(rootTotal) + ' ' + sign + ' ' + money(Math.abs(delta)) +
        ' = ' + money(total);
    }
    deltaInput.addEventListener('input', recomputePreview);

    const reasonInput = textarea(
      'Например: «Гость доплатил 2000 ₽ за поздний выезд»');

    const fDelta = field('Дельта ₽',
      h('div', { class: 'field-stack' }, deltaInput, sumPreview),
      { aside: 'отрицательная — убавить' });
    const fReason = field('Причина корректировки', reasonInput,
      { aside: 'обязательно' });

    // --- режим корректировки (только для журналов с категорией) ---------
    // «Сумма» — дельта (старое поведение). «Категория» — реклассификация
    // (дельта 0 + новая категория). Для журналов без категории контролы
    // не создаются, форма работает как раньше.
    let kindSelect = null;
    let categorySelect = null;
    let fKind = null;
    let fCategory = null;
    const reclassActive = () =>
      !!kindSelect && kindSelect.value === 'категория';
    if (supportsReclass) {
      kindSelect = selectInput();
      fillSelect(kindSelect, [
        { value: 'сумма', text: 'Исправить сумму (дельта)' },
        { value: 'категория', text: 'Сменить категорию' },
      ]);
      kindSelect.value = 'сумма';
      categorySelect = selectInput();
      fillSelect(categorySelect, categoryOptions(journal, RECLASS_TYPE[journal]));
      categorySelect.value = currentCategory;
      fKind = field('Что корректируем', kindSelect);
      fCategory = field('Новая категория', categorySelect,
        { aside: 'сейчас: ' + Operations.categoryName(currentCategory) });
      const syncKind = () => {
        const reclass = reclassActive();
        fDelta.style.display = reclass ? 'none' : '';
        fCategory.style.display = reclass ? '' : 'none';
      };
      kindSelect.addEventListener('change', syncKind);
      syncKind();
    }

    function validate() {
      [fDelta, fReason].forEach(clearError);
      if (fCategory) clearError(fCategory);
      let ok = true;
      if (reclassActive()) {
        // Реклассификация: дельты нет, проверяем смену категории.
        if (!categorySelect.value) {
          showError(fCategory, 'Выберите новую категорию'); ok = false;
        } else if (categorySelect.value === currentCategory) {
          showError(fCategory, 'Категория не изменилась — выберите другую');
          ok = false;
        }
      } else {
        const raw = deltaInput.value.trim();
        if (raw === '') {
          showError(fDelta, 'Укажите дельту'); ok = false;
        } else {
          const delta = Number(raw);
          if (isNaN(delta)) {
            showError(fDelta, 'Дельта должна быть числом'); ok = false;
          } else if (delta === 0) {
            showError(fDelta, 'Дельта 0 — нечего корректировать'); ok = false;
          }
        }
      }
      if (!reasonInput.value.trim()) {
        showError(fReason, 'Опишите причину корректировки'); ok = false;
      }
      return ok;
    }

    function collect() {
      const reason = reasonInput.value.trim();
      const reclass = reclassActive();
      // Стартуем от исходной и переопределяем только то, что должно
      // отличаться у корректирующей записи. Структурные поля (объект,
      // получатель, дата_операции) сохраняются — корректировка не
      // «передумывает» операцию, а правит её цифру или категорию.
      const row = { ...originalData };
      // id_операции — пусто, allocates в Journal.appendOperation
      // через сквозной NNN (ADR-009).
      row['id_операции'] = '';
      row['client_uuid'] = '';                            // sender проставит
      row['дата_внесения'] = nowISO();                    // ADR-007
      // Автор корректировки — текущий основатель, не автор исходной.
      // Имя колонки определяется журналом (id_менеджера vs
      // id_менеджера_внёс) — берём то, что было в исходной строке.
      if ('id_менеджера_внёс' in originalData) {
        row['id_менеджера_внёс'] = employee['id_сотрудника'];
      } else {
        row['id_менеджера'] = employee['id_сотрудника'];
      }
      // §16.3 v1.7: ссылка на корень, не на непосредственного предка.
      // rootId вычислен наверху функции; для оригинала = его id, для
      // корректировки = её id_исходной_операции (тоже id корня).
      row['id_исходной_операции'] = rootId;
      row['статус'] = 'активна';
      row['отменена_кем'] = '';
      row['отменена_когда'] = '';

      let shortDesc;
      if (reclass) {
        // Реклассификация: сумма-дельта 0 (деньги не двигаем), меняется
        // категория. Витрина переносит сумму корня в новую категорию
        // (распознаётся по сумма=0 + непустой id_исходной_операции).
        const oldName = Operations.categoryName(currentCategory);
        const newName = Operations.categoryName(categorySelect.value);
        row[sumField] = 0;
        row['id_категории'] = categorySelect.value;
        row['комментарий'] = 'РЕКЛАССИФИКАЦИЯ к ' + rootId + ': ' +
          oldName + ' → ' + newName + '. ' + reason;
        shortDesc = 'Реклассификация к ' + rootId + ' (' + op.label + '): ' +
          oldName + ' → ' + newName;
      } else {
        const delta = Number(deltaInput.value);
        row[sumField] = delta;                            // §16.3, Морган #8
        row['комментарий'] = 'КОРРЕКТИРОВКА к ' + rootId + ': ' + reason;
        const sign = delta > 0 ? '+' : '−';
        shortDesc = 'Корректировка к ' + rootId + ' (' + op.label + '): ' +
          sign + money(Math.abs(delta));
      }
      return {
        journalSheet: journal,
        opKey: op.key,
        row,
        managerId: employee['id_сотрудника'],
        shortDesc,
      };
    }

    const submitBtn = h('button',
      { class: 'btn-primary btn-auto', type: 'submit' }, 'Сохранить корректировку');
    const cancelBtn = h('button',
      { class: 'btn-ghost', type: 'button' }, 'Отмена');
    cancelBtn.addEventListener('click', () => opts.onExit());
    const footer = h('div', { class: 'op-footer' },
      h('span', { class: 'op-footer-hint' },
        'Исходная строка не меняется. Корректировка — отдельная запись ' +
        'в том же журнале со ссылкой на исходную.'),
      h('div', { class: 'op-footer-actions' }, cancelBtn, submitBtn));

    // Поля формы: для журналов с категорией добавляем переключатель
    // режима и селект категории (скрыт/показан по режиму).
    const formFields = [summary];
    if (fKind) formFields.push(fKind);
    formFields.push(fDelta);
    if (fCategory) formFields.push(fCategory);
    formFields.push(fReason, h('div', { class: 'op-divider' }), footer);
    const form = h('form', { class: 'op-form' }, ...formFields);

    form.addEventListener('keydown', (e) => {
      if (e.altKey && e.key === 'Enter') {
        e.preventDefault();
        form.requestSubmit();
      }
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      submitBtn.disabled = true;
      if (!validate()) { submitBtn.disabled = false; return; }
      Queue.add('корректировка', collect());
      opts.onExit();
    });

    return Screens.formScreen({
      employee, title: 'Корректировка',
      subtitle: 'Исходная запись остаётся как есть. Новая строка добавится ' +
        'в тот же журнал и встанет «поверх» суммой-дельтой.',
      breadcrumb: 'Корректировки',
      content: form,
      onBack: () => opts.onExit(),
      onRefresh: opts.onRefresh, onLogout: opts.onLogout,
      onOpenHelp: opts.onOpenHelp,
    });
  }

  // ====================== «Помощь» (§5.11, TICKET-6.2) =================
  // Полноэкранный экран справки. Доступен по кнопке «?» в шапке — со
  // всех экранов (главный + любая форма). Контент — раскрывающиеся
  // блоки <details>: короткий заголовок + развёрнутое описание. Чтобы
  // дополнять описание форм было дёшево, контент держим как массив
  // объектов; раздел «Корректировки» добавится сюда же, когда TICKET-6.1
  // примут (тикет 6.2: «до тех пор без него»).
  function openПомощь(opts) {
    const employee = opts.employee;
    const founder = String(employee['роль'] || '').trim().toLowerCase()
      .replace(/\s/g, '');
    const isFounder = founder === 'ген.дир' || founder === 'основатель';

    // [title, paragraphs[], founderOnly?]
    const FORMS_HELP = [
      ['+ Заселение',
        ['Оформление новой брони. Заполните даты заезда/выезда, объект, ' +
         'канал брони, сумму бронирования и комиссию площадки. Программа ' +
         'сама посчитает чистую выручку и долю Ренто.',
         'Внизу — блок распределения: куда уходит каждая часть денег ' +
         '(собственнику напрямую, на счёт Ренто, горничной налом и т.п.). ' +
         'Касса задаётся типом строки распределения. Сумма всех строк ' +
         'должна сойтись с чистой выручкой — индикатор подсветит, ' +
         'если что-то не сходится.',
         'Для строки «Собственнику напрямую» карта подставляется из ' +
         'справочника. Если карты у собственника нет — заселение можно ' +
         'сохранить и без неё, а саму карту завести по ссылке ' +
         '«+ добавить карту» прямо в строке (или через «Справочники → ' +
         'Реквизит собственника»). Чтобы новая карта подставлялась сама, ' +
         'отметьте её «по умолчанию».',
         'Брони с Яндекса: деньги при заселении кассой НЕ проводятся — ' +
         'Яндекс всегда перечисляет их сам, на р/с, примерно через ' +
         '5 дней после выезда. Базовая выручка такой брони указывается ' +
         'в поле «Площадка должна Ренто ₽» (форма подставит её сама), ' +
         'кассовой строкой проходит только доп.оплата (продление, ' +
         'ранний заезд), если гость платил живыми деньгами при ' +
         'заселении.']],
      ['+ Задача по сервису',
        ['Обратная связь гостя, по которой нужно что-то исправить: ' +
         'выберите квартиру и запишите, что сказал гость. Ответственного ' +
         'можно не указывать — назначите позже.',
         'Задача сразу уходит уведомлением основателю и появляется на ' +
         '«Доске задач» — доске из трёх колонок: новые → в работе → ' +
         'выполнено. Карточку двигают кнопками или перетаскиванием ' +
         'мышью. Двигать может любой сотрудник; кто двигал — записывается.']],
      ['+ Уборка',
        ['Запись об уборке: дата, горничная, объект, тип (плановая ' +
         'или генеральная). Сумма подставится автоматически из ставки ' +
         'объекта; если её перебить — нужно дать комментарий, что ' +
         'произошло (например, доплата за грязь).']],
      ['+ Мастер',
        ['Работа мастера: «выход» (объект обязателен) или «материалы» ' +
         '(нужно описание, что куплено). Дефолтная ставка мастера ' +
         'подставится для выходов; материалы — сумма руками.']],
      ['+ Хоз-расход',
        ['Расходы по объекту: средства уборки, мелочёвка, расходники. ' +
         'Категория обязательна. Получатель — горничная, мастер или ' +
         'сотрудник; собственника здесь нет (для денег собственнику ' +
         'есть свой канал — доход от заселений).',
         'Если нужной категории нет в списке — кнопка ' +
         '«+ предложить новую категорию»: основатель потом подтвердит ' +
         'её в Sheets.']],
      ['+ Прочее',
        ['Доходы и расходы без привязки к объекту: возвраты, бонусы, ' +
         'мелкие операционные траты, по которым нет отдельной формы. ' +
         'Тип (доход/расход) выбираете сверху; список категорий ' +
         'подстраивается под выбор.']],
      ['+ Выплата',
        ['Только для основателя. Выплата получателю со счёта Ренто. ' +
         'Под получателем — подсказка по текущему долгу: сколько ' +
         'начислено и сколько уже выплачено. Для выплаты собственнику ' +
         'обязательно указать объект — сальдо считается по каждому ' +
         'объекту отдельно.'], true],
      ['+ Batch площадки',
        ['Только для основателя. Разноска batch-выплаты от Авито/Яндекса ' +
         '— одной операцией закрывается несколько броней. ' +
         'Указываете канал, сумму поступления и (при необходимости) ' +
         'комиссию площадки.'], true],
    ];

    const MISTAKES = [
      ['Связь упала, операция не отправилась',
        'Программа сама положит её в очередь и повторит. Не нужно ' +
        'повторно нажимать «Сохранить» — защита от дублей сработает по ' +
        'внутреннему идентификатору, но без неё всё равно лучше не ' +
        'плодить попытки. Следите за индикатором очереди в шапке: пока ' +
        'там «Отправляется N» — данные ещё не в таблице.'],
      ['Сумма уборки/выплаты введена ошибочно',
        'Сегодняшние операции можно откатить из секции «Сегодня» на ' +
        'главном экране (отметить чекбоксы и «Откатить выбранные»). ' +
        'Старше дня — только корректировка задним числом, это умеет ' +
        'основатель.'],
      ['Не открывается форма «+ Выплата» / «+ Batch» / «Отчёт собственнику»',
        'Эти формы доступны только основателю. Менеджеру они не ' +
        'нужны и в его меню не показываются.'],
      ['Перебитая сумма уборки — требует комментарий',
        'Если сумма уборки отличается от ставки объекта, программа ' +
        'попросит комментарий. Это специально: чтобы потом было видно, ' +
        'почему именно вы её изменили.'],
    ];

    function detailsBlock(summary, ...nodes) {
      const det = h('details', { class: 'help-details' },
        h('summary', { class: 'help-summary' }, summary),
        ...nodes);
      return det;
    }

    const formsBlocks = FORMS_HELP
      .filter(([, , founderOnly]) => !founderOnly || isFounder)
      .map(([title, paragraphs]) => {
        const body = h('div', { class: 'help-body' },
          ...paragraphs.map((p) => h('p', { class: 'help-text' }, p)));
        return detailsBlock(title, body);
      });

    const mistakesBlocks = MISTAKES.map(([title, text]) =>
      detailsBlock(title, h('div', { class: 'help-body' },
        h('p', { class: 'help-text' }, text))));

    const content = h('div', { class: 'help-content' },
      h('div', { class: 'help-section' },
        h('h2', { class: 'h2' }, 'Формы ввода'),
        ...formsBlocks),
      h('div', { class: 'help-section' },
        h('h2', { class: 'h2' }, 'Частые ошибки'),
        ...mistakesBlocks));

    return Screens.formScreen({
      employee, title: 'Помощь',
      subtitle: 'Короткая памятка по формам и частым ошибкам. ' +
        'Раскройте нужный блок, чтобы посмотреть подробности.',
      breadcrumb: 'Справка',
      content,
      onBack: () => opts.onExit(),
      onRefresh: opts.onRefresh, onLogout: opts.onLogout,
      onOpenHelp: opts.onOpenHelp,
      // На самой странице помощи кнопка «?» в шапке не нужна —
      // appHeader не отрендерит её, если onOpenHelp не передан.
    });
  }

  // ============== Справочники: формы Инкремента 8 (ADR-026) ============
  //
  // Эти формы пишут НЕ в журналы, а в справочники (`спр_собственники`,
  // `спр_объекты`, `спр_сотрудники`). Только основатель (через
  // FOUNDER_ONLY_FORMS в app.js). Записывают единичную строку через
  // `Journal.appendUnique` (дедуп по содержательному ключу — защита от
  // ретраев очереди); ID нового справочного объекта генерится
  // sender'ом по факту чтения свежего листа (см. `nextRefId` ниже).
  //
  // ID-генератор: следующий свободный NNN среди записей с тем же
  // префиксом в указанной колонке. Игнорирует пустые значения.
  // Поддерживает любую длину NNN (>=1 цифр), формат padStart(3).
  function nextRefId(rows, prefix, idField) {
    const re = new RegExp('^' + prefix + '-(\\d+)$');
    let max = 0;
    for (const r of rows) {
      const m = re.exec(String(r[idField] || '').trim());
      if (m) {
        const n = parseInt(m[1], 10);
        if (n > max) max = n;
      }
    }
    return prefix + '-' + String(max + 1).padStart(3, '0');
  }

  // ===================== «+ Собственник» (TICKET-8.1) ==================
  // ADR-026 (упрощено решением Абдулы 28.05.2026): реквизиты
  // опционально, форма пишет только в `спр_собственники` одной строкой.
  // Реквизиты позже отдельной формой если понадобится.
  //
  // Обязательно: ФИО. Опционально: телефон, email, мессенджер,
  // комментарий. Системные поля: id_собственника (генерится в sender,
  // OWN-NNN), дата_первого_договора (сегодня — иначе витрина может
  // плохо считать «новых собственников за период»), статус (активный).
  function openНовыйСобственник(opts) {
    const employee = opts.employee;
    const formType = 'новый_собственник';

    const fioInput = textInput('Иванов Иван Иванович');
    const phoneInput = textInput('+7 999 123 45 67');
    const messengerInput = textInput('Telegram @ivan / MAX @ivan');
    const emailInput = textInput('ivan@example.com');
    const commentInput = textarea('Заметки по собственнику (необязательно)');

    const fFio = field('ФИО', fioInput);
    const fPhone = field('Телефон', phoneInput, { aside: 'необязательно' });
    const fMsg = field('Мессенджер', messengerInput, { aside: 'необязательно' });
    const fEmail = field('Email', emailInput, { aside: 'необязательно' });
    const fComment = field('Комментарий', commentInput, { aside: 'необязательно' });

    // Предупреждение по дублю ФИО (Cache.get кеш, читается мгновенно).
    // Не блокирует сохранение — это явный выбор основателя (двое с
    // одинаковыми ФИО возможны, хоть и редко).
    const dupHint = h('div', { class: 'field-hint' });
    function checkDup() {
      const fio = fioInput.value.trim().toLowerCase();
      if (!fio) { dupHint.textContent = ''; return; }
      const dup = Cache.get('спр_собственники')
        .find((r) => String(r['фио'] || '').trim().toLowerCase() === fio);
      dupHint.textContent = dup
        ? '⚠ Уже есть собственник с таким ФИО: ' + dup['id_собственника'] +
          '. Если это другой человек — можно завести; иначе отмените.'
        : '';
    }
    fioInput.addEventListener('input', checkDup);
    fFio._error.style.display = '';
    fFio.append(dupHint);

    const draftNote = h('div', { class: 'draft-note', style: 'display:none' });

    function snapshot() {
      return {
        фио: fioInput.value, телефон: phoneInput.value,
        мессенджер: messengerInput.value, email: emailInput.value,
        комментарий: commentInput.value,
      };
    }
    function restore(d) {
      fioInput.value = d.фио || '';
      phoneInput.value = d.телефон || '';
      messengerInput.value = d.мессенджер || '';
      emailInput.value = d.email || '';
      commentInput.value = d.комментарий || '';
      checkDup();
    }
    function validate() {
      [fFio].forEach(clearError);
      if (!fioInput.value.trim()) {
        showError(fFio, 'ФИО обязательно');
        return false;
      }
      return true;
    }
    function collect() {
      const fio = fioInput.value.trim();
      return {
        sheet: 'спр_собственники',
        keyColumns: ['фио', 'телефон'],
        row: {
          'фио': fio,
          'телефон': phoneInput.value.trim(),
          'мессенджер_основной': messengerInput.value.trim(),
          'email': emailInput.value.trim(),
          'дата_первого_договора': today(),
          'статус': 'активный',
          'комментарий': commentInput.value.trim(),
        },
        idPrefix: 'OWN',
        idField: 'id_собственника',
        logType: 'собственник',
        shortDesc: 'Новый собственник: ' + fio,
        managerId: employee['id_сотрудника'],
      };
    }

    const built = composeForm({
      formType, opts, draftNote, queueKey: 'новый_собственник',
      validate, collect,
      fieldNodes: [fFio, fPhone, fMsg, fEmail, fComment],
    });
    setupDraft(formType, built.form, snapshot, restore, draftNote);

    return Screens.formScreen({
      employee, title: '+ Собственник',
      subtitle: 'Новая запись в спр_собственники. После сохранения ' +
        'собственник появится в выпадашках (квартира, выплата).',
      breadcrumb: 'Справочники',
      content: built.form,
      onBack: () => opts.onExit(),
      onRefresh: opts.onRefresh, onLogout: opts.onLogout,
      onOpenHelp: opts.onOpenHelp,
    });
  }

  // ============== «+ Реквизит собственника» (15.06.2026) ===============
  // Карта/счёт собственника для выплат. Пишет строку в
  // `спр_реквизиты_собственников` через тот же refSender, что и прочие
  // справочники (id REQ-OWN-NNN). Раньше реквизиты заводились только
  // руками в Sheets (ADR-026 отложил форму) — теперь доступно из
  // интерфейса, в т.ч. прямо из строки распределения заселения, где у
  // собственника не оказалось карты.
  //
  // Обязательно: собственник + номер карты/счёта. Опц.: название, тип,
  // банк, получатель, комментарий. «По умолчанию» = да по дефолту —
  // строка распределения заселения берёт именно дефолтный реквизит.
  function openНовыйРеквизитСобственника(opts) {
    const employee = opts.employee;
    const formType = 'новый_реквизит';

    const owners = Cache.forDropdown('спр_собственники');
    const ownerSelect = selectInput();
    fillSelect(ownerSelect, owners.map((o) => ({
      value: o['id_собственника'], text: o['фио'],
    })), owners.length ? 'Выберите…' : '— нет собственников, заведите сначала —');
    if (opts.prefillOwnerId) ownerSelect.value = opts.prefillOwnerId;

    const nameInput = textInput('Карта');
    nameInput.value = 'Карта';
    const typeSelect = selectInput();
    fillSelect(typeSelect, [
      { value: 'карта', text: 'карта' },
      { value: 'счёт', text: 'счёт' },
    ], false);
    const numberInputEl = textInput('5280 4137 5303 9853 / номер счёта');
    const bankInput = textInput('Сбербанк');
    const receiverInput = textInput('ФИО получателя (как в банке)');
    const defaultSelect = selectInput();
    fillSelect(defaultSelect, [
      { value: 'да', text: 'да — использовать по умолчанию' },
      { value: 'нет', text: 'нет' },
    ], false);
    const commentInput = textarea('Заметки по реквизиту (необязательно)');

    const fOwner = field('Собственник', ownerSelect);
    const fName = field('Название', nameInput, { aside: 'необязательно' });
    const fType = field('Тип', typeSelect);
    const fNumber = field('Номер карты / счёта', numberInputEl);
    const fBank = field('Банк', bankInput, { aside: 'необязательно' });
    const fReceiver = field('Получатель', receiverInput, { aside: 'необязательно' });
    const fDefault = field('По умолчанию', defaultSelect);
    const fComment = field('Комментарий', commentInput, { aside: 'необязательно' });

    // Подсказка: у собственника уже есть дефолтный реквизит — новый «да»
    // его не отменит автоматически (в Sheets два «по умолчанию» уживутся,
    // строка распределения возьмёт первый). Предупреждаем, не блокируем.
    const dupHint = h('div', { class: 'field-hint' });
    function checkDefault() {
      const oid = ownerSelect.value;
      if (!oid || defaultSelect.value !== 'да') { dupHint.textContent = ''; return; }
      const has = Cache.get('спр_реквизиты_собственников').find((r) =>
        r['id_собственника'] === oid && isYes(r['по_умолчанию']) && isYes(r['активен']));
      dupHint.textContent = has
        ? '⚠ У собственника уже есть реквизит «по умолчанию» (' +
          (has['id_реквизита'] || '') + '). Два дефолта уживутся, но ' +
          'распределение возьмёт прежний. Снимите старый флаг в Sheets, ' +
          'если новый должен стать основным.'
        : '';
    }
    ownerSelect.addEventListener('change', checkDefault);
    defaultSelect.addEventListener('change', checkDefault);
    fDefault.append(dupHint);

    const draftNote = h('div', { class: 'draft-note', style: 'display:none' });

    function snapshot() {
      return {
        собственник: ownerSelect.value, название: nameInput.value,
        тип: typeSelect.value, номер: numberInputEl.value,
        банк: bankInput.value, получатель: receiverInput.value,
        по_умолчанию: defaultSelect.value, комментарий: commentInput.value,
      };
    }
    function restore(d) {
      ownerSelect.value = d.собственник || opts.prefillOwnerId || '';
      nameInput.value = d.название != null ? d.название : 'Карта';
      typeSelect.value = d.тип || 'карта';
      numberInputEl.value = d.номер || '';
      bankInput.value = d.банк || '';
      receiverInput.value = d.получатель || '';
      defaultSelect.value = d.по_умолчанию || 'да';
      commentInput.value = d.комментарий || '';
      checkDefault();
    }
    function validate() {
      [fOwner, fNumber].forEach(clearError);
      let ok = true;
      if (!ownerSelect.value) { showError(fOwner, 'Выберите собственника'); ok = false; }
      if (!numberInputEl.value.trim()) {
        showError(fNumber, 'Укажите номер карты или счёта'); ok = false;
      }
      return ok;
    }
    function collect() {
      const oid = ownerSelect.value;
      const ownerName = (owners.find((o) => o['id_собственника'] === oid) || {})['фио'] || oid;
      return {
        sheet: 'спр_реквизиты_собственников',
        keyColumns: ['id_собственника', 'номер'],
        row: {
          'id_собственника': oid,
          'название': nameInput.value.trim() || 'Карта',
          'тип': typeSelect.value || 'карта',
          'номер': numberInputEl.value.trim(),
          'банк': bankInput.value.trim(),
          'получатель': receiverInput.value.trim(),
          'по_умолчанию': defaultSelect.value || 'да',
          'активен': 'да',
          'комментарий': commentInput.value.trim(),
        },
        idPrefix: 'REQ-OWN',
        idField: 'id_реквизита',
        logType: 'реквизит',
        shortDesc: 'Новый реквизит собственника: ' + ownerName,
        managerId: employee['id_сотрудника'],
      };
    }

    const built = composeForm({
      formType, opts, draftNote, queueKey: 'новый_реквизит',
      validate, collect,
      fieldNodes: [fOwner, fName, fType, fNumber, fBank, fReceiver, fDefault, fComment],
    });
    setupDraft(formType, built.form, snapshot, restore, draftNote);
    checkDefault();

    return Screens.formScreen({
      employee, title: '+ Реквизит собственника',
      subtitle: 'Карта или счёт собственника для выплат. После сохранения ' +
        'появится в распределении заселения и форме выплаты.',
      breadcrumb: 'Справочники',
      content: built.form,
      onBack: () => opts.onExit(),
      onRefresh: opts.onRefresh, onLogout: opts.onLogout,
      onOpenHelp: opts.onOpenHelp,
    });
  }

  // ===================== «+ Квартира» (TICKET-8.2) =====================
  // Самая строгая форма (ADR-026): собственник из списка (не текст),
  // модель из списка, фикс обязателен для M4, при совпадении адреса —
  // предупреждение «новый объект или вернулась старая?». Создаёт
  // только V1; версионирование V2+ — вручную в Sheets (зафиксированный
  // риск ADR-026).
  function openНоваяКвартира(opts) {
    const employee = opts.employee;
    const formType = 'новая_квартира';

    const owners = Cache.forDropdown('спр_собственники');
    const models = Cache.get('спр_модели_расчёта');  // активность — нет поля, берём все
    const categories = Cache.forDropdown('спр_категории_объектов');

    const ownerSelect = selectInput();
    fillSelect(ownerSelect, owners.map((o) => ({
      value: o['id_собственника'], text: o['фио'],
    })), owners.length ? 'Выберите…' : '— нет собственников, заведите сначала —');

    const shortNameInput = textInput('Кривоарбатский 1-5');
    const addressInput = textInput('Москва, ул. Кривоарбатская, д.1 кв.5');

    const modelSelect = selectInput();
    fillSelect(modelSelect, models.map((m) => ({
      value: m['id_модели'],
      text: m['название'] + ' (' + m['тип'] + ')',
    })));

    const fixInput = numberInput();
    const categorySelect = selectInput();
    fillSelect(categorySelect, categories.map((c) => ({
      value: c['id_категории'], text: c['название'],
    })));
    const commentInput = textarea('Заметки по объекту (необязательно)');

    const fOwner = field('Собственник', ownerSelect);
    const fShortName = field('Короткое название', shortNameInput,
      { aside: 'для выпадашек' });
    const fAddress = field('Полный адрес', addressInput);
    const fModel = field('Модель расчёта', modelSelect);
    const fFix = field('Фикс ₽/мес', fixInput, { aside: 'для модели Фикс' });
    fFix.style.display = 'none';
    const fCategory = field('Категория объекта', categorySelect,
      { aside: 'необязательно' });
    const fComment = field('Комментарий', commentInput,
      { aside: 'необязательно' });

    // Фикс показывается только для модели типа «Фикс».
    function isModelFix() {
      const m = models.find((r) => r['id_модели'] === modelSelect.value);
      return m && String(m['тип']).trim().toLowerCase() === 'фикс';
    }
    modelSelect.addEventListener('change', () => {
      fFix.style.display = isModelFix() ? '' : 'none';
      if (!isModelFix()) fixInput.value = '';
    });

    // Предупреждение по дублю адреса (полный или короткое название).
    // Не блокирует — пользователь подтверждает в модалке при сохранении.
    const dupHint = h('div', { class: 'field-hint' });
    function checkDupAddr() {
      const addr = addressInput.value.trim().toLowerCase();
      if (!addr) { dupHint.textContent = ''; return; }
      const dup = Cache.get('спр_объекты').find((r) =>
        String(r['адрес_полный'] || '').trim().toLowerCase() === addr);
      dupHint.textContent = dup
        ? '⚠ Адрес уже есть у объекта ' + dup['id_объекта'] +
          ' («' + dup['название_короткое'] + '»). Новый объект или ' +
          'вернулась старая квартира?'
        : '';
    }
    addressInput.addEventListener('input', checkDupAddr);
    fAddress.append(dupHint);

    // Версионирование — банер с подсказкой (риск ADR-026).
    const versionNote = h('div', { class: 'draft-note' },
      'Эта форма создаёт НОВУЮ квартиру (версию V1). Для смены условий ' +
      'существующего объекта (новый % собственнику, новая модель) — ' +
      'не пользуйтесь этой формой, заведите V2 вручную в листе ' +
      'спр_объекты (закрыть V1 датой «действует_по», добавить V2 с тем ' +
      'же id_объекта, новым id_версии).');

    const draftNote = h('div', { class: 'draft-note', style: 'display:none' });

    function snapshot() {
      return {
        собственник: ownerSelect.value, короткое: shortNameInput.value,
        адрес: addressInput.value, модель: modelSelect.value,
        фикс: fixInput.value, категория: categorySelect.value,
        комментарий: commentInput.value,
      };
    }
    function restore(d) {
      ownerSelect.value = d.собственник || '';
      shortNameInput.value = d.короткое || '';
      addressInput.value = d.адрес || '';
      modelSelect.value = d.модель || '';
      fFix.style.display = isModelFix() ? '' : 'none';
      fixInput.value = d.фикс || '';
      categorySelect.value = d.категория || '';
      commentInput.value = d.комментарий || '';
      checkDupAddr();
    }
    function validate() {
      [fOwner, fShortName, fAddress, fModel, fFix].forEach(clearError);
      let ok = true;
      if (!ownerSelect.value) {
        showError(fOwner, 'Выберите собственника'); ok = false;
      }
      if (!shortNameInput.value.trim()) {
        showError(fShortName, 'Короткое название обязательно'); ok = false;
      }
      if (!addressInput.value.trim()) {
        showError(fAddress, 'Полный адрес обязательно'); ok = false;
      }
      if (!modelSelect.value) {
        showError(fModel, 'Выберите модель расчёта'); ok = false;
      } else if (isModelFix() && !(num(fixInput.value) > 0)) {
        showError(fFix, 'Для модели Фикс — фикс ₽/мес обязателен и > 0');
        ok = false;
      }
      // Дубль адреса — модалка-подтверждение, не блок (тикет 8.2).
      if (ok && dupHint.textContent) {
        if (!confirm(dupHint.textContent +
          '\n\nВсё равно создать новый объект?')) {
          ok = false;
        }
      }
      return ok;
    }
    function collect() {
      const fix = isModelFix() ? num(fixInput.value) : '';
      return {
        sheet: 'спр_объекты',
        keyColumns: ['адрес_полный', 'id_собственника'],
        row: {
          // id_версии и id_объекта генерятся в sender (sender знает
          // префикс и поля; sender читает справочник и берёт max+1).
          // Здесь не подставляем — оставляем sender'у.
          'название_короткое': shortNameInput.value.trim(),
          'адрес_полный': addressInput.value.trim(),
          'действует_с': today(),
          'действует_по': '',
          'id_модели': modelSelect.value,
          'фикс_₽': fix,
          'id_собственника': ownerSelect.value,
          'id_категории_объекта': categorySelect.value,
          'статус': 'активен',
          'комментарий': commentInput.value.trim(),
        },
        // Объект — версионированный (id_объекта + id_версии).
        // Sender генерит OBJ-NNN (max по id_объекта дедупом по
        // стабильным id) и составляет id_версии = OBJ-NNN-V1.
        idPrefix: 'OBJ',
        idField: 'id_объекта',
        versionedField: 'id_версии',
        versionSuffix: '-V1',
        logType: 'квартира',
        shortDesc: 'Новая квартира: ' + shortNameInput.value.trim(),
        managerId: employee['id_сотрудника'],
      };
    }

    const built = composeForm({
      formType, opts, draftNote, queueKey: 'новая_квартира',
      validate, collect,
      topNote: versionNote,
      fieldNodes: [fOwner, fShortName, fAddress, fModel, fFix, fCategory, fComment],
    });
    setupDraft(formType, built.form, snapshot, restore, draftNote);

    return Screens.formScreen({
      employee, title: '+ Квартира',
      subtitle: 'Новая запись в спр_объекты (версия V1). После сохранения ' +
        'квартира появится в выпадашках операций.',
      breadcrumb: 'Справочники',
      content: built.form,
      onBack: () => opts.onExit(),
      onRefresh: opts.onRefresh, onLogout: opts.onLogout,
      onOpenHelp: opts.onOpenHelp,
    });
  }

  // ===================== «+ Сотрудник» (TICKET-8.3) ====================
  // Минимально по тикету: id (генерится EMP-NNN), имя, роль —
  // обязательны. Системные: id_версии=EMP-NNN-V1, действует_с=сегодня,
  // статус=активный. Остальные поля справочника (телефон/ставка/тип) —
  // опционально, фаундер потом дополнит руками если надо.
  function openНовыйСотрудник(opts) {
    const employee = opts.employee;
    const formType = 'новый_сотрудник';

    const fioInput = textInput('Иванов Иван Иванович');
    const roleSelect = selectInput();
    fillSelect(roleSelect, [
      { value: 'менеджер', text: 'менеджер' },
      { value: 'ген.дир', text: 'ген.дир' },
      { value: 'маркетолог', text: 'маркетолог' },
      { value: 'бухгалтер', text: 'бухгалтер' },
      { value: 'другое', text: 'другое' },
    ]);
    const phoneInput = textInput('+7 999 123 45 67');
    const rateInput = numberInput();
    const rateTypeSelect = selectInput();
    fillSelect(rateTypeSelect, [
      { value: 'за смену', text: 'за смену' },
      { value: 'в месяц', text: 'в месяц' },
    ]);
    const commentInput = textarea('Заметки (необязательно)');

    const fFio = field('ФИО', fioInput);
    const fRole = field('Роль', roleSelect);
    const fPhone = field('Телефон', phoneInput, { aside: 'необязательно' });
    const fRate = field('Ставка ₽', rateInput, { aside: 'необязательно' });
    const fRateType = field('Тип ставки', rateTypeSelect,
      { aside: 'необязательно' });
    const fComment = field('Комментарий', commentInput, { aside: 'необязательно' });

    const draftNote = h('div', { class: 'draft-note', style: 'display:none' });

    function snapshot() {
      return {
        фио: fioInput.value, роль: roleSelect.value, телефон: phoneInput.value,
        ставка: rateInput.value, тип_ставки: rateTypeSelect.value,
        комментарий: commentInput.value,
      };
    }
    function restore(d) {
      fioInput.value = d.фио || '';
      roleSelect.value = d.роль || '';
      phoneInput.value = d.телефон || '';
      rateInput.value = d.ставка || '';
      rateTypeSelect.value = d.тип_ставки || '';
      commentInput.value = d.комментарий || '';
    }
    function validate() {
      [fFio, fRole].forEach(clearError);
      let ok = true;
      if (!fioInput.value.trim()) {
        showError(fFio, 'ФИО обязательно'); ok = false;
      }
      if (!roleSelect.value) {
        showError(fRole, 'Выберите роль'); ok = false;
      }
      return ok;
    }
    function collect() {
      const fio = fioInput.value.trim();
      return {
        sheet: 'спр_сотрудники',
        keyColumns: ['фио', 'роль'],
        row: {
          'фио': fio,
          'роль': roleSelect.value,
          'телефон': phoneInput.value.trim(),
          'действует_с': today(),
          'действует_по': '',
          'ставка_базовая_₽': rateInput.value ? num(rateInput.value) : '',
          'ставка_тип': rateTypeSelect.value,
          'тип': '',
          'статус': 'активный',
          'комментарий': commentInput.value.trim(),
        },
        idPrefix: 'EMP',
        idField: 'id_сотрудника',
        versionedField: 'id_версии',
        versionSuffix: '-V1',
        logType: 'сотрудник',
        shortDesc: 'Новый сотрудник: ' + fio + ' (' + roleSelect.value + ')',
        managerId: employee['id_сотрудника'],
      };
    }

    const built = composeForm({
      formType, opts, draftNote, queueKey: 'новый_сотрудник',
      validate, collect,
      fieldNodes: [fFio, fRole, fPhone, fRate, fRateType, fComment],
    });
    setupDraft(formType, built.form, snapshot, restore, draftNote);

    return Screens.formScreen({
      employee, title: '+ Сотрудник',
      subtitle: 'Новая запись в спр_сотрудники. После сохранения ' +
        'сотрудник появится в выпадашках операций и в списке «Кто вы?».',
      breadcrumb: 'Справочники',
      content: built.form,
      onBack: () => opts.onExit(),
      onRefresh: opts.onRefresh, onLogout: opts.onLogout,
      onOpenHelp: opts.onOpenHelp,
    });
  }

  // ===================== «+ Горничная» (Инкр.8 доп.) ===================
  // Отдельный справочник `спр_горничные` (FINANCE_SPEC §4.6) — не
  // часть спр_сотрудники. Версионируется, формат id_версии =
  // `CLN-NNN-v1` (lowercase v — расходится с OBJ-NNN-V1 и EMP-NNN-V1
  // у объектов/сотрудников; формат поддерживается через
  // `versionSuffix: '-v1'`).
  //
  // Обязательно: ФИО + тип (основная/подработка). Системные:
  // id_горничной=CLN-NNN, id_версии=CLN-NNN-v1, действует_с=сегодня,
  // статус=активная. Опц.: телефон, комментарий. Реквизиты — отдельный
  // лист `спр_реквизиты_горничных`, в этой форме не записываются.
  function openНоваяГорничная(opts) {
    const employee = opts.employee;
    const formType = 'новая_горничная';

    const fioInput = textInput('Иванова Анна');
    const typeSelect = selectInput();
    fillSelect(typeSelect, [
      { value: 'основная', text: 'основная' },
      { value: 'подработка', text: 'подработка' },
    ]);
    const phoneInput = textInput('+7 999 123 45 67');
    const commentInput = textarea('Заметки (необязательно)');

    const fFio = field('ФИО', fioInput);
    const fType = field('Тип', typeSelect);
    const fPhone = field('Телефон', phoneInput, { aside: 'необязательно' });
    const fComment = field('Комментарий', commentInput, { aside: 'необязательно' });

    const draftNote = h('div', { class: 'draft-note', style: 'display:none' });

    function snapshot() {
      return {
        фио: fioInput.value, тип: typeSelect.value,
        телефон: phoneInput.value, комментарий: commentInput.value,
      };
    }
    function restore(d) {
      fioInput.value = d.фио || '';
      typeSelect.value = d.тип || '';
      phoneInput.value = d.телефон || '';
      commentInput.value = d.комментарий || '';
    }
    function validate() {
      [fFio, fType].forEach(clearError);
      let ok = true;
      if (!fioInput.value.trim()) {
        showError(fFio, 'ФИО обязательно'); ok = false;
      }
      if (!typeSelect.value) {
        showError(fType, 'Выберите тип'); ok = false;
      }
      return ok;
    }
    function collect() {
      const fio = fioInput.value.trim();
      return {
        sheet: 'спр_горничные',
        keyColumns: ['фио', 'тип'],
        row: {
          'фио': fio,
          'телефон': phoneInput.value.trim(),
          'действует_с': today(),
          'действует_по': '',
          'тип': typeSelect.value,
          'статус': 'активная',
          'комментарий': commentInput.value.trim(),
        },
        idPrefix: 'CLN',
        idField: 'id_горничной',
        versionedField: 'id_версии',
        versionSuffix: '-v1',          // боевой формат — lowercase v
        logType: 'горничная',
        shortDesc: 'Новая горничная: ' + fio + ' (' + typeSelect.value + ')',
        managerId: employee['id_сотрудника'],
      };
    }

    const built = composeForm({
      formType, opts, draftNote, queueKey: 'новая_горничная',
      validate, collect,
      fieldNodes: [fFio, fType, fPhone, fComment],
    });
    setupDraft(formType, built.form, snapshot, restore, draftNote);

    return Screens.formScreen({
      employee, title: '+ Горничная',
      subtitle: 'Новая запись в спр_горничные. После сохранения горничная ' +
        'появится в выпадашках операций (уборка, выплата, заселение).',
      breadcrumb: 'Справочники',
      content: built.form,
      onBack: () => opts.onExit(),
      onRefresh: opts.onRefresh, onLogout: opts.onLogout,
      onOpenHelp: opts.onOpenHelp,
    });
  }

  // ============ «Отчёт по сотрудникам» (#4) ============================
  // Детальный отчёт по ОДНОМУ сотруднику за период. Выбираем период +
  // сотрудника (горничная / мастер / сотрудник). Данные читаем построчно
  // из сырых журналов (не из витрины) и считаем на клиенте:
  //   - горничные: уборки за период (адрес + стоимость) из журнал_уборки;
  //   - мастера: задачи за период из журнал_мастер;
  //   - сотрудники: начислено из журнал_менеджеры_смены (оклад в журналах
  //     не начисляется → у окладных 0);
  //   - выплаты за период из журнал_выплаты.
  // «Долг Ренто» — полный текущий: opening (система_начальные_долги, на
  // DEBT_START) + всё начислено − всё выплачено с DEBT_START. Совпадает с
  // моделью витрины отчёт_сальдо_подрядчики (та же отсечка, её ячейка B3).
  function openОтчётСотрудники(opts) {
    const employee = opts.employee;
    // Отсечка модели долга — миграционная граница. История до неё свёрнута
    // в opening. Держать синхронно с B3 витрины отчёт_сальдо_подрядчики.
    const DEBT_START = '2026-06-12';

    // Кого можно выбрать: три справочника. group — ветка расчёта; payType —
    // тип_получателя в журнал_выплаты; idCol/dateCol — поля журнала начислений.
    const PEOPLE = [];
    Cache.forDropdown('спр_горничные').forEach((r) => PEOPLE.push({
      id: r['id_горничной'], name: r['фио'] || r['id_горничной'],
      group: 'горничная', roleText: 'горничная', payType: 'горничная',
      accrSheet: CONFIG.JOURNAL_УБОРКИ, idCol: 'id_горничной', dateCol: 'дата_уборки' }));
    Cache.forDropdown('спр_мастера').forEach((r) => PEOPLE.push({
      id: r['id_мастера'], name: r['фио'] || r['id_мастера'],
      group: 'мастер', roleText: 'мастер', payType: 'мастер',
      accrSheet: CONFIG.JOURNAL_МАСТЕР, idCol: 'id_мастера', dateCol: 'дата' }));
    // Выплаты ген.дира видит только фаундер (по Google-аккаунту). Прочим
    // сотрудникам с этой ролью строки скрыты — их нет в выпадашке отчёта.
    const isFounder = (Auth.getEmail() || '').trim().toLowerCase() ===
      String(CONFIG.FOUNDER_EMAIL || '').trim().toLowerCase();
    Cache.forDropdown('спр_сотрудники').forEach((r) => {
      if (String(r['роль'] || '').trim() === 'ген.дир' && !isFounder) return;
      PEOPLE.push({
        id: r['id_сотрудника'], name: r['фио'] || r['id_сотрудника'],
        group: 'сотрудник', roleText: r['роль'] || 'сотрудник', payType: 'сотрудник',
        accrSheet: CONFIG.JOURNAL_МЕНЕДЖЕРЫ_СМЕНЫ, idCol: 'id_менеджера', dateCol: 'дата_смены' });
    });
    const byId = {};
    PEOPLE.forEach((p) => { byId[p.id] = p; });

    // Выпадашка сотрудника, сгруппированная по ролям (fillSelect optgroup
    // не умеет — собираем вручную).
    const empSelect = h('select', { class: 'field-input field-select' });
    empSelect.append(h('option', { value: '' }, 'Выберите сотрудника…'));
    [['Горничные', 'горничная'], ['Мастера', 'мастер'],
      ['Сотрудники', 'сотрудник']].forEach(([label, grp]) => {
      const og = h('optgroup', { label });
      PEOPLE.filter((p) => p.group === grp).forEach((p) =>
        og.append(h('option', { value: p.id }, p.name)));
      if (og.children.length) empSelect.append(og);
    });

    const fromEl = h('input', { class: 'field-input', type: 'date' });
    const toEl = h('input', { class: 'field-input', type: 'date' });
    const genBtn = h('button',
      { class: 'btn-primary btn-auto', type: 'submit' }, 'Сформировать');

    const fEmp = field('Сотрудник', empSelect);
    const fFrom = field('Период с', fromEl);
    const fTo = field('Период по', toEl);
    const fieldsRow = h('div', { class: 'field-row-2' }, fFrom, fTo);
    const resultsBox = h('div', { class: 'op-search-results' });
    resultsBox.append(h('p', { class: 'muted' },
      'Выберите сотрудника и период, затем «Сформировать».'));

    function setStatus(text, cls) {
      UI.clear(resultsBox);
      resultsBox.append(h('p', { class: cls || 'muted' }, text));
    }

    // Название объекта по id_объекта_версии (для адресов уборок).
    const objName = {};
    Cache.get('спр_объекты').forEach((o) => {
      objName[o['id_версии']] =
        o['название_короткое'] || o['адрес_полный'] || o['id_версии'];
    });

    const d10 = (v) => String(v || '').slice(0, 10);
    const isActive = (d) =>
      String(d['статус'] || '').trim().toLowerCase() === 'активна';
    const sumOf = (recs, predicate) => recs.reduce(
      (s, r) => (predicate(r.data) ? s + num(r.data['сумма_₽']) : s), 0);

    // --- строители таблиц ---
    function thRow(cells) {
      return h('div', { class: 'today-row today-thead' },
        ...cells.map((c, i) => h('div',
          { class: 'tc ' + (i === cells.length - 1 ? 'tc-sum' : 'tc-desc') }, c)));
    }
    function dataRow(cells) {
      return h('div', { class: 'today-row' },
        ...cells.map((c, i) => h('div',
          { class: 'tc ' + (i === cells.length - 1 ? 'tc-sum' : 'tc-desc') }, c)));
    }
    function totals(label, value) {
      return h('div', { class: 'today-row today-total' },
        h('div', { class: 'tc tc-desc' }, label),
        h('div', { class: 'tc tc-sum' }, value));
    }
    const section = (t) => h('p', { class: 'eyebrow eyebrow-sub' }, t);

    async function generate() {
      const p = byId[empSelect.value];
      if (!p) { setStatus('Выберите сотрудника.', 'error-banner'); return; }
      if (!fromEl.value || !toEl.value) {
        setStatus('Укажите обе даты периода.', 'error-banner'); return;
      }
      if (fromEl.value > toEl.value) {
        setStatus('Дата «с» позже даты «по» — поправьте.', 'error-banner'); return;
      }
      setStatus('Считаем…');
      try {
        const res = await Journal.readMany(
          [p.accrSheet, CONFIG.JOURNAL_ВЫПЛАТЫ, 'система_начальные_долги']);
        render(p, res[p.accrSheet].records,
          res[CONFIG.JOURNAL_ВЫПЛАТЫ].records,
          res['система_начальные_долги'].records);
      } catch (err) {
        console.error('Отчёт по сотрудникам:', err);
        setStatus('Не удалось сформировать отчёт: ' +
          ((err && err.message) || 'ошибка сети') + '.', 'error-banner');
      }
    }

    function render(p, accrRecs, payRecs, openRecs) {
      UI.clear(resultsBox);
      const inPeriod = (v) => {
        const s = d10(v); return s >= fromEl.value && s <= toEl.value;
      };
      const sinceStart = (v) => d10(v) >= DEBT_START;
      const my = (d) => d[p.idCol] === p.id && isActive(d);
      const myPay = (d) => d['тип_получателя'] === p.payType &&
        d['id_получателя'] === p.id && isActive(d);

      resultsBox.append(h('p', { class: 'muted' },
        p.name + ' · ' + p.roleText + ' · период ' +
        fromEl.value + ' — ' + toEl.value));

      // --- начислено за период: построчно по роли ---
      if (p.group === 'горничная') {
        const ub = accrRecs.filter((r) => my(r.data) && inPeriod(r.data['дата_уборки']));
        resultsBox.append(section('Уборки за период'));
        if (ub.length) {
          const t = h('div', { class: 'today-table' });
          t.append(thRow(['ДАТА', 'АДРЕС', 'СТОИМОСТЬ']));
          ub.forEach((r) => t.append(dataRow([
            d10(r.data['дата_уборки']),
            objName[r.data['id_объекта_версии']] || r.data['id_объекта_версии'] || '—',
            money(num(r.data['сумма_₽']))])));
          resultsBox.append(t);
        } else {
          resultsBox.append(h('p', { class: 'muted' }, 'Уборок за период нет.'));
        }
        resultsBox.append(totals('Кол-во уборок за период', String(ub.length)));
        resultsBox.append(totals('К выплате за период',
          money(sumOf(ub, () => true))));
      } else if (p.group === 'мастер') {
        const tasks = accrRecs.filter((r) => my(r.data) && inPeriod(r.data['дата']));
        resultsBox.append(totals('Начислено за период',
          money(sumOf(tasks, () => true))));
        resultsBox.append(section('Выполненные задачи'));
        if (tasks.length) {
          const t = h('div', { class: 'today-table' });
          t.append(thRow(['ДАТА', 'ЗАДАЧА', 'СУММА']));
          tasks.forEach((r) => t.append(dataRow([
            d10(r.data['дата']),
            r.data['описание'] || r.data['тип_записи'] || '—',
            money(num(r.data['сумма_₽']))])));
          resultsBox.append(t);
        } else {
          resultsBox.append(h('p', { class: 'muted' }, 'Задач за период нет.'));
        }
      } else {
        const sm = accrRecs.filter((r) => my(r.data) && inPeriod(r.data['дата_смены']));
        resultsBox.append(totals('Начислено за период',
          money(sumOf(sm, () => true))));
        if (!sm.length) {
          resultsBox.append(h('p', { class: 'muted' },
            'Начислений по сменам нет (оклад в журналах не начисляется).'));
        }
      }

      // --- выплаты за период (все роли) ---
      resultsBox.append(h('div', { class: 'op-divider' }));
      resultsBox.append(section('Оплачено за период'));
      const pays = payRecs.filter((r) => myPay(r.data) && inPeriod(r.data['дата_выплаты']));
      if (pays.length) {
        const t = h('div', { class: 'today-table' });
        t.append(thRow(['ДАТА ОПЛАТЫ', 'СУММА']));
        pays.forEach((r) => t.append(dataRow([
          d10(r.data['дата_выплаты']), money(num(r.data['сумма_₽']))])));
        resultsBox.append(t);
      } else {
        resultsBox.append(h('p', { class: 'muted' }, 'Выплат за период нет.'));
      }
      resultsBox.append(totals('Итого выплачено за период',
        money(sumOf(pays, () => true))));

      // --- долг Ренто (текущий): opening + всё начислено − всё выплачено с DEBT_START ---
      const openRow = openRecs.find((r) => r.data['id'] === p.id);
      const opening = openRow ? num(openRow.data['долг_на_дату_₽']) : 0;
      const accrAll = sumOf(accrRecs, (d) => my(d) && sinceStart(d[p.dateCol]));
      const paidAll = sumOf(payRecs, (d) => myPay(d) && sinceStart(d['дата_выплаты']));
      const debt = opening + accrAll - paidAll;
      resultsBox.append(h('div', { class: 'op-divider' }));
      resultsBox.append(totals(
        debt >= 0 ? 'Долг Ренто (текущий)' : 'Переплата (текущая)',
        money(Math.abs(debt))));
    }

    const form = h('form', { class: 'op-form op-search-form' },
      fEmp,
      fieldsRow,
      h('div', { class: 'op-footer' },
        h('span', { class: 'op-footer-hint' },
          'Строки уборок/задач/выплат — за выбранный период. «Долг Ренто» — ' +
          'полный текущий (стартовый долг + всё с ' + DEBT_START + ').'),
        h('div', { class: 'op-footer-actions' }, genBtn)),
      h('div', { class: 'op-divider' }),
      resultsBox);
    form.addEventListener('submit', (e) => { e.preventDefault(); generate(); });

    return Screens.formScreen({
      employee, title: 'Отчёт по сотруднику',
      subtitle: 'Детально по одному сотруднику за период: уборки/задачи, ' +
        'выплаты и текущий долг.',
      breadcrumb: 'Отчётность',
      content: form,
      onBack: () => opts.onExit(),
      onRefresh: opts.onRefresh, onLogout: opts.onLogout,
      onOpenHelp: opts.onOpenHelp,
    });
  }

  // ============ «Задачи по сервису» (15.06.2026, запрос фаундера) ==========
  // Обратная связь гостей → задачи на исправление. Менеджер заводит задачу,
  // любой сотрудник двигает статус (новая → в работе → выполнено), кто менял
  // — пишется в строку и в _лог_действий. Ответственный опционален.
  //
  // Лист `журнал_задачи_сервис`, id TSK-NNN — своё пространство, вне сквозного
  // OP-счётчика (ADR-009): задача не финансовая операция и не должна утяжелять
  // batchGet транзакции заселения.
  //
  // Telegram (пуш новой задачи + недельный/месячный дайджест) шлёт Apps Script
  // внутри самой таблицы: репозиторий интерфейса публичный, токен бота в код
  // класть нельзя. Клиент только пишет строку; колонку `tg_отправлено` ставит
  // скрипт — чтобы одно и то же уведомление не приходило дважды.

  // Люди для «Ответственного»: три справочника, bare-id (канон ключей).
  function taskPeople() {
    const people = [];
    Cache.forDropdown('спр_горничные').forEach((r) => people.push({
      id: r['id_горничной'], name: r['фио'] || r['id_горничной'], group: 'горничная' }));
    Cache.forDropdown('спр_мастера').forEach((r) => people.push({
      id: r['id_мастера'], name: r['фио'] || r['id_мастера'], group: 'мастер' }));
    Cache.forDropdown('спр_сотрудники').forEach((r) => people.push({
      id: r['id_сотрудника'], name: r['фио'] || r['id_сотрудника'], group: 'сотрудник' }));
    return people;
  }
  // Выпадашка людей с optgroup по ролям (fillSelect optgroup не умеет).
  function fillPeopleSelect(select, people, placeholder) {
    select.innerHTML = '';
    select.append(h('option', { value: '' }, placeholder));
    [['Горничные', 'горничная'], ['Мастера', 'мастер'],
      ['Сотрудники', 'сотрудник']].forEach(([label, grp]) => {
      const og = h('optgroup', { label });
      people.filter((p) => p.group === grp).forEach((p) =>
        og.append(h('option', { value: p.id }, p.name)));
      if (og.children.length) select.append(og);
    });
  }

  // ---------------------- «+ Задача по сервису» ---------------------------
  function openЗадачаСервис(opts) {
    const employee = opts.employee;
    const formType = 'задача_сервис';

    const objects = Cache.forDropdown('спр_объекты');
    const objectSelect = selectInput();
    fillSelect(objectSelect, objects.map((o) => ({
      value: o['id_версии'], text: o['название_короткое'],
    })));
    const descInput = textarea(
      'Что сказал гость: что не так, что нужно исправить');
    const people = taskPeople();
    const respSelect = selectInput();
    fillPeopleSelect(respSelect, people, '— пока не назначен —');

    const fObject = field('Квартира', objectSelect);
    const fDesc = field('Обратная связь гостя / что исправить', descInput);
    const fResp = field('Ответственный', respSelect, { aside: 'необязательно' });

    const draftNote = h('div', { class: 'draft-note', style: 'display:none' });

    function snapshot() {
      return {
        объект: objectSelect.value, описание: descInput.value,
        ответственный: respSelect.value,
      };
    }
    function restore(d) {
      objectSelect.value = d.объект || '';
      descInput.value = d.описание || '';
      respSelect.value = d.ответственный || '';
    }
    function validate() {
      [fObject, fDesc].forEach(clearError);
      let ok = true;
      if (!objectSelect.value) { showError(fObject, 'Выберите квартиру'); ok = false; }
      if (!descInput.value.trim()) {
        showError(fDesc, 'Опишите, что сказал гость / что исправить'); ok = false;
      }
      return ok;
    }
    function collect() {
      const obj = objects.find((o) => o['id_версии'] === objectSelect.value);
      const objName = obj ? obj['название_короткое'] : objectSelect.value;
      return {
        'id_менеджера': employee['id_сотрудника'],
        'id_объекта_версии': objectSelect.value,
        'описание': descInput.value.trim(),
        'источник': 'гость',
        'статус': 'новая',                 // стартовый статус (§задачи)
        'ответственный': respSelect.value,
        'краткое_описание': 'Задача по сервису: ' + objName + ' — ' +
          descInput.value.trim().slice(0, 80),
      };
    }

    const built = composeForm({
      formType, opts, draftNote, queueKey: 'задача_сервис',
      validate, collect,
      fieldNodes: [fObject, fDesc, fResp],
    });
    setupDraft(formType, built.form, snapshot, restore, draftNote);

    return Screens.formScreen({
      employee, title: '+ Задача по сервису',
      subtitle: 'Обратная связь гостя → задача на исправление. Попадёт в ' +
        'список задач и уйдёт уведомлением основателю.',
      breadcrumb: 'Сервис',
      content: built.form,
      onBack: () => opts.onExit(),
      onRefresh: opts.onRefresh, onLogout: opts.onLogout,
      onOpenHelp: opts.onOpenHelp,
    });
  }

  // ------------------- «Задачи по сервису» (канбан) -----------------------
  // Доска из трёх колонок по статусу: новая → в работе → выполнено.
  // Карточку двигают кнопками (работают и на телефоне) либо перетаскиванием
  // мышью (desktop, HTML5 drag&drop — прогрессивное улучшение; на мобильных
  // DnD не работает, поэтому кнопки — основной путь, а не запасной).
  // Любое движение уходит в очередь ('задача_обновление' → in-place патч
  // смежных колонок G..K), переживает обрыв сети.
  function openЗадачиСервис(opts) {
    const employee = opts.employee;
    // Подрядчик (мастер/горничная) видит ТОЛЬКО свои задачи и не может
    // переназначить ответственного — иначе перекинул бы задачу с себя.
    // Роль синтезируется в Cache.activeEmployees по флагу справочника.
    const role = String(employee['роль'] || '').trim().toLowerCase();
    const restricted = role === 'мастер' || role === 'горничная' ||
      role === 'подрядчик';
    const myId = employee['id_сотрудника'];
    const people = taskPeople();
    const peopleById = {};
    people.forEach((p) => { peopleById[p.id] = p; });
    const objByVersion = {};
    Cache.get('спр_объекты').forEach((o) => {
      objByVersion[o['id_версии']] = o['название_короткое'] || o['id_версии'];
    });

    const COLUMNS = [
      { status: 'новая', title: 'Новые', cls: 'kb-col-new' },
      { status: 'в работе', title: 'В работе', cls: 'kb-col-work' },
      { status: 'выполнено', title: 'Выполнено', cls: 'kb-col-done' },
    ];
    // Колонка «выполнено» растёт бесконечно — показываем свежие, остальное
    // за ссылкой (доска не должна превращаться в архив).
    const DONE_LIMIT = 12;

    let tasks = [];              // все задачи листа (локальное состояние доски)
    let showAllDone = false;
    const boardBox = h('div', { class: 'kb-board' });
    const reloadBtn = h('button',
      { class: 'btn-primary btn-auto', type: 'button' }, 'Обновить доску');

    function setNote(text, cls) {
      UI.clear(boardBox);
      boardBox.append(h('p', { class: cls || 'muted' }, text));
    }

    // ISO-timestamp → дд.мм.гггг. Пустое/битое — прочерк, не «Invalid Date».
    function shortDate(v) {
      const s = String(v || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '—';
      const [y, m, d] = s.split('-');
      return d + '.' + m + '.' + y;
    }
    const statusOf = (d) => String(d['статус'] || 'новая').trim();

    // Отправить изменение задачи (статус / ответственный / комментарий).
    function pushUpdate(data, patch) {
      Object.assign(data, patch);
      Queue.add('задача_обновление', {
        'id_операции': data['id_операции'],
        'статус': statusOf(data),
        'ответственный': data['ответственный'] || '',
        'комментарий': data['комментарий'] || '',
        'id_менеджера': employee['id_сотрудника'],
        'краткое_описание': 'Задача ' + data['id_операции'] + ' → ' + statusOf(data),
      });
      // Дату закрытия рисуем сразу — сервер проставит ту же (очередь ретраит).
      data['дата_обновления'] = new Date().toISOString();
      render();
    }

    function moveBtn(label, data, toStatus) {
      const btn = h('button', { class: 'kb-move-btn', type: 'button' }, label);
      btn.addEventListener('click', () => pushUpdate(data, { 'статус': toStatus }));
      return btn;
    }

    function taskCard(data) {
      const id = data['id_операции'];
      const status = statusOf(data);
      const respName = data['ответственный']
        ? ((peopleById[data['ответственный']] || {}).name || data['ответственный'])
        : 'не назначен';

      // Детали (ответственный + комментарий) — под катом: в узкой колонке
      // канбана постоянные селекты съедают всю карточку.
      const respSelect = selectInput();
      fillPeopleSelect(respSelect, people, '— не назначен —');
      respSelect.value = data['ответственный'] || '';
      const noteInput = textInput('Что сделали / детали');
      noteInput.value = data['комментарий'] || '';
      const saveBtn = h('button',
        { class: 'kb-move-btn kb-save', type: 'button' }, 'Сохранить');
      const details = h('div', { class: 'kb-details', style: 'display:none' });
      if (!restricted) details.append(field('Ответственный', respSelect));
      details.append(field('Комментарий', noteInput), saveBtn);
      saveBtn.addEventListener('click', () => pushUpdate(data, restricted
        // Подрядчик ответственного не трогает — шлём текущее значение,
        // иначе патч затёр бы его пустотой.
        ? { 'комментарий': noteInput.value.trim() }
        : { 'ответственный': respSelect.value,
          'комментарий': noteInput.value.trim() }));

      const toggle = h('button', { class: 'kb-toggle', type: 'button' },
        (restricted ? '💬 комментарий' : '👤 ' + respName) +
        (data['комментарий'] ? ' · есть' : ''));
      toggle.addEventListener('click', () => {
        const open = details.style.display !== 'none';
        details.style.display = open ? 'none' : '';
        card.classList.toggle('kb-card-open', !open);
      });

      // Кнопки движения — по текущей колонке (соседние статусы).
      const moves = h('div', { class: 'kb-moves' });
      if (status === 'новая') {
        moves.append(moveBtn('В работу →', data, 'в работе'));
      } else if (status === 'в работе') {
        moves.append(moveBtn('← Новая', data, 'новая'),
          moveBtn('Выполнено →', data, 'выполнено'));
      } else {
        moves.append(moveBtn('← Вернуть в работу', data, 'в работе'));
      }

      const card = h('div', { class: 'kb-card', draggable: 'true' },
        h('div', { class: 'kb-card-top' },
          h('span', { class: 'task-date' }, shortDate(data['дата_внесения'])),
          h('span', { class: 'kb-obj' },
            objByVersion[data['id_объекта_версии']] ||
            data['id_объекта_версии'] || '—')),
        h('p', { class: 'kb-desc' }, data['описание'] || ''),
        toggle, details, moves,
        h('div', { class: 'kb-foot muted' }, id +
          (status === 'выполнено' && data['дата_обновления']
            ? ' · закрыто ' + shortDate(data['дата_обновления']) : '')));

      // Drag&drop (desktop). id задачи — единственное, что кладём в dataTransfer.
      card.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', id);
        e.dataTransfer.effectAllowed = 'move';
        card.classList.add('kb-dragging');
      });
      card.addEventListener('dragend', () => card.classList.remove('kb-dragging'));
      return card;
    }

    function render() {
      UI.clear(boardBox);
      COLUMNS.forEach((col) => {
        let list = tasks.filter((d) => statusOf(d) === col.status)
          // Свежие сверху.
          .sort((a, b) => String(b['дата_внесения'] || '')
            .localeCompare(String(a['дата_внесения'] || '')));
        const total = list.length;
        let hidden = 0;
        if (col.status === 'выполнено' && !showAllDone && total > DONE_LIMIT) {
          hidden = total - DONE_LIMIT;
          list = list.slice(0, DONE_LIMIT);
        }

        const body = h('div', { class: 'kb-col-body' });
        if (!total) {
          body.append(h('p', { class: 'kb-empty muted' }, 'пусто'));
        } else {
          list.forEach((d) => body.append(taskCard(d)));
        }
        if (hidden) {
          const more = h('button', { class: 'link-btn kb-more', type: 'button' },
            'показать ещё ' + hidden);
          more.addEventListener('click', () => { showAllDone = true; render(); });
          body.append(more);
        }

        const column = h('div', { class: 'kb-col ' + col.cls },
          h('div', { class: 'kb-col-head' },
            h('span', { class: 'kb-col-title' }, col.title),
            h('span', { class: 'kb-col-count' }, String(total))),
          body);

        // Приём перетаскиваемой карточки: колонка = целевой статус.
        column.addEventListener('dragover', (e) => {
          e.preventDefault();                     // без этого drop не сработает
          e.dataTransfer.dropEffect = 'move';
          column.classList.add('kb-col-over');
        });
        column.addEventListener('dragleave', () =>
          column.classList.remove('kb-col-over'));
        column.addEventListener('drop', (e) => {
          e.preventDefault();
          column.classList.remove('kb-col-over');
          const id = e.dataTransfer.getData('text/plain');
          const data = tasks.find((t) => t['id_операции'] === id);
          if (!data || statusOf(data) === col.status) return;
          pushUpdate(data, { 'статус': col.status });
        });
        boardBox.append(column);
      });
    }

    async function load() {
      setNote('Загружаем доску…');
      let res;
      try {
        res = await Journal.read(CONFIG.TASKS_SHEET);
      } catch (err) {
        console.error('Задачи по сервису:', err);
        setNote('Не удалось прочитать лист задач: ' +
          ((err && err.message) || 'ошибка сети') + '.', 'error-banner');
        return;
      }
      tasks = res.records.map((r) => r.data)
        .filter((d) => String(d['id_операции'] || '').trim())
        // Подрядчик — только задачи, где ОН ответственный. Его id в
        // `ответственный` — тот же bare-id, под которым он вошёл (MST-001).
        .filter((d) => !restricted ||
          String(d['ответственный'] || '').trim() === myId);
      render();
    }

    reloadBtn.addEventListener('click', load);

    const form = h('form', { class: 'op-form' },
      h('div', { class: 'op-footer' },
        h('span', { class: 'op-footer-hint' },
          'Двигайте карточки кнопками или мышью между колонками. ' +
          'Изменения уходят сразу и переживают обрыв сети.'),
        h('div', { class: 'op-footer-actions' }, reloadBtn)),
      h('div', { class: 'op-divider' }),
      boardBox);
    form.addEventListener('submit', (e) => { e.preventDefault(); load(); });
    load();

    return Screens.formScreen({
      employee, title: restricted ? 'Мои задачи' : 'Задачи по сервису',
      subtitle: restricted
        ? 'Ваши задачи. Двигайте карточку по мере работы: ' +
          'новая → в работе → выполнено.'
        : 'Обратная связь гостей на доске: новая → в работе → выполнено.',
      breadcrumb: 'Сервис',
      content: form,
      onBack: () => opts.onExit(),
      onRefresh: opts.onRefresh, onLogout: opts.onLogout,
      onOpenHelp: opts.onOpenHelp,
    });
  }

  return {
    openУборка, openМастер, openХозРасход, openПрочее, openBatch, openВыплата,
    openЗаселение, openОтчётСобственнику, openОтчётСотрудники,
    openПоискОпераций, openКорректировка,
    openЗадачаСервис, openЗадачиСервис,
    openПомощь,
    openНовыйСобственник, openНоваяКвартира, openНовыйСотрудник, openНоваяГорничная,
    openНовыйРеквизитСобственника,
    nextRefId,        // экспорт для sender'ов в app.js
  };
})();
