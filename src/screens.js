/*
 * screens.js — экраны интерфейса: connect, login, main.
 * Плюс секция «Мои внесения за сегодня» с откатом (§15, §18).
 *
 * Экраны — функции рендера: получают данные и колбэки, рисуют в #app,
 * не держат сессию и не ходят в сеть напрямую (этим занят app.js).
 * Исключение — секция «сегодня»: она сама дочитывает журнал.
 */
window.Screens = (() => {
  const CONFIG = window.RENTO_CONFIG;
  const h = UI.h;
  const app = document.getElementById('app');

  function todayHuman() {
    return new Intl.DateTimeFormat('ru-RU', {
      day: 'numeric', month: 'long', year: 'numeric', weekday: 'long',
    }).format(new Date());
  }

  function money(value) {
    const n = Number(value);
    return (isNaN(n) ? value : n.toLocaleString('ru-RU')) + ' ₽';
  }

  function roleLabel(role) {
    const r = String(role || '').trim().toLowerCase().replace(/\s/g, '');
    if (r === 'ген.дир') return 'Ген. директор';
    if (r === 'основатель') return 'Основатель';
    return role || '';
  }

  // ========================= ЭКРАН: connect ============================
  // reloadMode=true — фатальная ошибка подготовки: кнопка «Обновить
  // страницу» вместо неактивной «Загрузка…».
  function connect(opts) {
    app.innerHTML = '';
    const errorBox = h('div',
      { class: 'error-banner', style: opts.errorText ? '' : 'display:none' },
      opts.errorText || '');

    let btn;
    if (opts.reloadMode) {
      btn = h('button', { class: 'btn-primary', type: 'button' },
        'Обновить страницу');
      btn.addEventListener('click', () => location.reload());
    } else {
      btn = h('button', { class: 'btn-primary', type: 'button' },
        opts.appReady ? 'Подключить Google-аккаунт' : 'Загрузка…');
      btn.disabled = !opts.appReady;
      btn.addEventListener('click', () => {
        btn.disabled = true;
        btn.textContent = 'Ожидание Google…';
        opts.onConnect();
      });
    }

    app.append(h('div', { class: 'auth-wrap' },
      h('div', { class: 'card auth-card' },
        UI.logo(),
        h('div', { class: 'auth-title' },
          h('h1', { class: 'h1' }, 'Войти в систему'),
          h('p', { class: 'muted' }, 'Внутренний учёт Ренто')),
        errorBox,
        btn)));
  }

  // ========================== ЭКРАН: login =============================
  // ADR-025: модель доступа — OAuth-only. Поле пароля команды убрано;
  // на этом экране остался только выбор сотрудника (нужен, чтобы
  // зафиксировать `id_менеджера` в журналах). Доступ контролируется
  // Google Share на боевой Sheets — кто не Editor, тот не пройдёт.
  // onSubmit(userId) -> строка ошибки либо null при успехе.
  function login(opts) {
    app.innerHTML = '';
    const errorBox = h('div',
      { class: 'error-banner', style: opts.errorText ? '' : 'display:none' },
      opts.errorText || '');

    const userSelect = h('select', { class: 'field-input field-select' },
      h('option', { value: '' }, 'Выберите...'));
    for (const emp of opts.employees) {
      const o = h('option', { value: emp['id_сотрудника'] },
        emp['фио'] + ' — ' + emp['роль']);
      if (emp['id_сотрудника'] === opts.storedUserId) o.selected = true;
      userSelect.append(o);
    }

    const fieldError = h('div', { class: 'field-error', style: 'display:none' });
    const submitBtn = h('button', { class: 'btn-primary', type: 'submit' },
      'Войти →');

    // Пустой справочник сотрудников — тупик: объясняем, не молчим
    // (REVIEW-1.2, замечание #4). Режим исполнителя (файл сервиса,
    // ADR-031) передаёт свой текст через opts.emptyText.
    const empty = opts.employees.length === 0;
    if (empty) {
      submitBtn.disabled = true;
      fieldError.textContent = opts.emptyText ||
        'В справочнике нет активных сотрудников. ' +
        'Заполните спр_сотрудники в Google Sheets и обновите страницу.';
      fieldError.style.display = '';
    }

    const form = h('form', { class: 'auth-form' },
      h('label', { class: 'field' },
        h('span', { class: 'field-label' }, 'Кто вы?'),
        userSelect),
      fieldError,
      submitBtn);

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      fieldError.style.display = 'none';
      const err = opts.onSubmit(userSelect.value);
      if (err) {
        fieldError.textContent = err;
        fieldError.style.display = '';
      }
    });

    const switchLink = h('button', { class: 'link-btn', type: 'button' },
      'сменить аккаунт');
    switchLink.addEventListener('click', opts.onSwitchAccount);

    app.append(h('div', { class: 'auth-wrap' },
      h('div', { class: 'card auth-card' },
        UI.logo(),
        h('div', { class: 'auth-title' },
          h('h1', { class: 'h1' }, 'Войти в систему'),
          h('p', { class: 'muted' }, 'Внутренний учёт Ренто')),
        errorBox,
        form,
        h('div', { class: 'auth-footer' },
          h('span', {}, '✓ Google подключён'), switchLink))));
  }

  // Шапка приложения: логотип + индикатор очереди + «?» + «обновить» +
  // чип пользователя. Общая для главного экрана и экранов форм
  // (ADR-006). Кнопка «?» (TICKET-6.2) доступна со всех экранов; если
  // мы уже на странице помощи, opts.onOpenHelp не передан — кнопка
  // не рендерится. Возвращает { headerEl, indicatorSlot } —
  // indicatorSlot наполняет app.js.
  function appHeader(opts) {
    const indicatorSlot = h('div', { class: 'indicator-slot' });

    let helpBtn = null;
    if (opts.onOpenHelp) {
      helpBtn = h('button',
        { class: 'help-btn', type: 'button', title: 'Помощь' }, '?');
      helpBtn.addEventListener('click', opts.onOpenHelp);
    }

    const refreshBtn = h('button', { class: 'refresh-btn', type: 'button' },
      h('span', { class: 'refresh-icon' }, '↻'),
      h('span', { class: 'refresh-label' }, 'Обновить справочники'));
    refreshBtn.addEventListener('click', () => opts.onRefresh(refreshBtn));

    const logoutBtn = h('button', { class: 'link-btn', type: 'button' }, 'Выйти');
    logoutBtn.addEventListener('click', opts.onLogout);
    const chip = h('div', { class: 'user-chip' },
      h('span', { class: 'user-avatar' }),
      h('span', { class: 'user-name' }, opts.employee['фио']),
      h('span', { class: 'user-sep' }, '·'),
      logoutBtn);

    const headerEl = h('header', { class: 'app-header' },
      UI.logo(),
      h('div', { class: 'header-right' },
        indicatorSlot, helpBtn, refreshBtn, chip));
    return { headerEl, indicatorSlot };
  }

  // =========================== ЭКРАН: main =============================
  // Возвращает { indicatorSlot, todaySlot } — app.js наполняет их
  // живыми данными (индикатор очереди и список «сегодня»).
  function main(opts) {
    app.innerHTML = '';
    const employee = opts.employee;
    const founder = opts.isFounder;
    const restricted = opts.isRestricted;

    // --- шапка ---
    const { headerEl, indicatorSlot } = appHeader({
      employee,
      onRefresh: opts.onRefresh,
      onLogout: opts.onLogout,
      onOpenHelp: opts.onOpenHelp,
    });

    // --- приветствие ---
    const greetRow = h('div', { class: 'greet-row' },
      h('h1', { class: 'h1' }, employee['фио']));
    if (founder) {
      greetRow.append(h('span', { class: 'role-chip' },
        roleLabel(employee['роль'])));
    }
    const greet = h('div', { class: 'greet' }, greetRow,
      h('p', { class: 'muted' }, 'Сегодня — ' + todayHuman()));

    // --- карточки действий ---
    // Карточка кликабельна, если у неё есть formType. «Заселение» —
    // formType пустой: его форма появится в Инкременте 4.
    function card(label, formType, icon) {
      const active = !!formType;
      const node = h('div', {
        class: 'form-card' + (active ? ' form-card-active' : ''),
        role: 'button', 'aria-disabled': active ? 'false' : 'true',
      },
        h('span', { class: 'form-card-icon' }, icon || '+'),
        h('span', { class: 'form-card-label' }, label));
      if (active) node.addEventListener('click', () => opts.onOpenForm(formType));
      return node;
    }

    // Подрядчик (мастер/горничная с доступом) видит ТОЛЬКО доску задач:
    // ни операций, ни отчётов, ни справочников. Ранний выход — блоки ниже
    // просто не собираются (гейт продублирован в app.js showФорма).
    //
    // Исполнитель файла сервиса (ADR-031, isExecutor): его доска читает
    // файл сервиса и появится в С1.2 — до неё карточка неактивна, чтобы
    // вход и роль уже можно было проверить на живом файле.
    if (opts.isRestricted) {
      const grid = h('div', { class: 'cards-grid' });
      // Исполнитель файла сервиса (EXE-*) — новая доска (журнал_задачи
      // файла сервиса, С1.2); подрядчик ADR-028 — старая доска боевого,
      // пока не проведена миграция TICKET-С1.0. Карточки квартир
      // (инструкции уборки, опись) — всем ролям (ADR-035 п.3).
      grid.append(opts.isExecutor
        ? card('Доска задач', 'доска_сервис', '📋')
        : card('Доска задач', 'задачи_сервис', '📋'));
      if (opts.isExecutor) grid.append(card('Паспорт квартиры', 'квартиры', '🏠'));
      const only = h('section', { class: 'section' },
        h('div', { class: 'section-head' },
          h('span', { class: 'eyebrow' }, 'СЕРВИС'),
          h('h2', { class: 'h2' }, 'Мои задачи')),
        grid);
      const mainEl = h('main', { class: 'app-main' }, greet, only);
      app.append(headerEl, mainEl);
      return { indicatorSlot, todaySlot: h('div') };
    }

    const cardsGrid = h('div', { class: 'cards-grid' },
      card('Заселение', 'заселение'),
      card('Уборка', 'уборка'),
      card('Мастер', 'мастер'),
      card('Хоз-расход', 'хоз_расход'),
      card('Прочее', 'прочее'));

    const actions = h('section', { class: 'section' },
      h('div', { class: 'section-head' },
        h('span', { class: 'eyebrow' }, 'ОСНОВНЫЕ ДЕЙСТВИЯ'),
        h('h2', { class: 'h2' }, 'Внести операцию')),
      cardsGrid);

    // Блок «Отчётность» — доступен обоим (TICKET-8.4 / ADR-026):
    // приватности между двумя пользователями нет, оба видят отчёты и
    // могут корректировать задним числом.
    actions.append(h('span', { class: 'eyebrow eyebrow-sub' }, 'ОТЧЁТНОСТЬ'));
    actions.append(h('div', { class: 'cards-grid' },
      card('Отчёт собственнику', 'отчёт_собственнику', '📋'),
      card('Отчёт по сотрудникам', 'отчёт_сотрудники', '👥'),
      card('Поиск операций', 'поиск_операций', '🔍')));

    // Сервис: доска задач сервисного блока (ADR-031, С1.2) — файл
    // сервиса, статусы §5, цены. Ветка service-c1 уходит в прод только
    // после миграции TSK (TICKET-С1.0), поэтому карточка сразу ведёт на
    // новую доску; старая ('задачи_сервис') остаётся в FORM_OPENERS на
    // переходный период.
    actions.append(h('span', { class: 'eyebrow eyebrow-sub' }, 'СЕРВИС'));
    actions.append(h('div', { class: 'cards-grid' },
      card('Доска задач', 'доска_сервис', '📋'),
      card('Паспорт квартиры', 'квартиры', '🏠')));

    // Справочники (TICKET-8.1..8.3 / ADR-026). Доступны всем сотрудникам
    // (доработка 28.05.2026, решение Абдулы) — не только основателю.
    // Отдельный блок, контекстно отделён от «внести операцию».
    actions.append(h('span', { class: 'eyebrow eyebrow-sub' }, 'СПРАВОЧНИКИ'));
    actions.append(h('div', { class: 'cards-grid' },
      card('Собственник', 'новый_собственник', '👤'),
      card('Реквизит собственника', 'новый_реквизит', '💳'),
      card('Квартира', 'новая_квартира', '🏠'),
      card('Сотрудник', 'новый_сотрудник', '💼'),
      card('Горничная', 'новая_горничная', '🧹')));

    if (founder) {
      actions.append(h('span', { class: 'eyebrow eyebrow-sub' },
        'ТОЛЬКО ДЛЯ ОСНОВАТЕЛЯ'));
      actions.append(h('div', { class: 'cards-grid' },
        card('Выплата', 'выплата', '₽'),
        card('Batch площадки', 'batch_площадки', '↓')));
    }

    // --- секция «сегодня» ---
    const todaySlot = h('div', { class: 'section' });

    const mainEl = h('main', { class: 'app-main' }, greet, actions, todaySlot);
    app.append(headerEl, mainEl);
    return { indicatorSlot, todaySlot };
  }

  // ===================== ЭКРАН: форма операции ==========================
  // Полноэкранный экран формы (ADR-006): шапка + хлебные крошки +
  // карточка. Сам по себе не знает про конкретную форму — поля и футер
  // строит forms.js и передаёт готовым узлом в opts.content.
  //
  // opts: { employee, title, subtitle, content, onBack, onRefresh, onLogout }
  // Возвращает { indicatorSlot } — app.js наполняет индикатор очереди.
  function formScreen(opts) {
    app.innerHTML = '';

    const { headerEl, indicatorSlot } = appHeader({
      employee: opts.employee,
      onRefresh: opts.onRefresh,
      onLogout: opts.onLogout,
      onOpenHelp: opts.onOpenHelp,
    });

    // Хлебные крошки: «← На главную · <breadcrumb> › <title>».
    // breadcrumb по умолчанию «Внести операцию» (для форм ввода
    // операций). Для не-операционных экранов вроде «Отчёт собственнику»
    // вызывающий передаёт свой текст.
    const backBtn = h('button', { class: 'crumb-back', type: 'button' },
      h('span', { class: 'crumb-arrow' }, '←'),
      h('span', {}, 'На главную'));
    backBtn.addEventListener('click', opts.onBack);
    const navRow = h('nav', { class: 'nav-row' },
      backBtn,
      h('span', { class: 'crumb-sep' }, '·'),
      h('span', { class: 'crumb-text' }, opts.breadcrumb || 'Внести операцию'),
      h('span', { class: 'crumb-sep' }, '›'),
      h('span', { class: 'crumb-current' }, opts.title));

    const titleBlock = h('div', { class: 'op-card-title' },
      h('h1', { class: 'h1' }, opts.title),
      opts.subtitle ? h('p', { class: 'muted' }, opts.subtitle) : null);

    const card = h('div', { class: 'op-card' }, titleBlock, opts.content);
    const formMain = h('main', { class: 'form-main' }, card);

    app.append(headerEl, navRow, formMain);
    return { indicatorSlot };
  }

  // ============ секция «Мои / Все внесения за сегодня» (§18) ============
  // opts: { employee, isFounder, onRollback(entries), handleError(err) }
  // Собирает записи за сегодня из всех журналов (реестр Operations).
  // entry = { rec, op }: запись журнала + её тип. onRollback получает
  // массив entry для отката.
  function renderTodaySection(slot, opts) {
    let filterMode = 'Мои'; // для основателя переключается на «Все»

    // id_менеджера у выплаты — в колонке id_менеджера_внёс (§4.22).
    function managerOf(data) {
      return data['id_менеджера'] || data['id_менеджера_внёс'] || '';
    }

    async function load() {
      UI.clear(slot);
      slot.append(h('span', { class: 'eyebrow' }, 'СЕГОДНЯ'));

      const types = Operations.listForToday(opts.isFounder);
      // Журналы для верхнеуровневых строк + журналы-дети заселения
      // (журнал_выплаты / журнал_хоз_расходы / журнал_касса нужны
      // всегда: менеджер видит связанные строки под своим заселением,
      // хотя сами эти журналы ему верхним уровнем не показываются —
      // см. ADR-015).
      const sheets = [...new Set([
        ...types.map((t) => t.journal),
        CONFIG.JOURNAL_ВЫПЛАТЫ, CONFIG.JOURNAL_ХОЗ_РАСХОДЫ, CONFIG.JOURNAL_КАССА,
      ])];

      let byJournal;
      try {
        byJournal = await Journal.readMany(sheets);
      } catch (err) {
        if (opts.handleError(err)) return;
        slot.append(h('p', { class: 'muted' },
          'Не удалось загрузить внесения за сегодня.'));
        return;
      }

      // Собрать записи за сегодня из всех журналов, пометив типом.
      let rows = [];
      types.forEach((op) => {
        const journal = byJournal[op.journal];
        if (!journal) return;
        Journal.todayRecords(journal.records).forEach((rec) => {
          if (op.match && !op.match(rec.data)) return;
          rows.push({ rec, op });
        });
      });

      const myId = opts.employee['id_сотрудника'];
      const showAll = opts.isFounder && filterMode === 'Все';
      rows = rows.filter((e) => showAll || managerOf(e.rec.data) === myId);
      // Новые — сверху (по дата_внесения, ISO-строка сортируется лексически).
      rows.sort((a, b) => String(b.rec.data['дата_внесения'])
        .localeCompare(String(a.rec.data['дата_внесения'])));

      // Заголовок секции + фильтр Мои/Все для основателя.
      const head = h('div', { class: 'today-head' },
        h('h2', { class: 'h2' },
          opts.isFounder ? 'Внесения за сегодня' : 'Мои внесения за сегодня'));
      if (opts.isFounder) {
        const seg = h('div', { class: 'segmented' });
        ['Мои', 'Все'].forEach((m) => {
          const b = h('button', {
            class: 'seg-btn' + (m === filterMode ? ' seg-active' : ''),
            type: 'button',
          }, m);
          b.addEventListener('click', () => { filterMode = m; load(); });
          seg.append(b);
        });
        head.append(seg);
      }
      slot.append(head);

      if (!rows.length) {
        slot.append(h('p', { class: 'muted' },
          'Сегодня операций пока нет.'));
        return;
      }

      // Таблица.
      const selected = new Set();
      const rollbackBtn = h('button',
        { class: 'btn-ghost', type: 'button', disabled: 'true' },
        'Откатить выбранные (0)');

      function syncBtn() {
        rollbackBtn.textContent = 'Откатить выбранные (' + selected.size + ')';
        rollbackBtn.disabled = selected.size === 0;
      }

      // Связанные записи заселения (§7.6, ADR-015) — в журнал_выплаты,
      // журнал_хоз_расходы и журнал_касса, по id_связанной_операции = id
      // заселения.
      function findChildren(parentId) {
        const out = [];
        [[CONFIG.JOURNAL_ВЫПЛАТЫ, 'выплата'],
          [CONFIG.JOURNAL_ХОЗ_РАСХОДЫ, 'хоз_расход'],
          [CONFIG.JOURNAL_КАССА, 'касса_заселения']].forEach(([j, key]) => {
          const recs = (byJournal[j] && byJournal[j].records) || [];
          recs.forEach((r) => {
            if (r.data['id_связанной_операции'] === parentId) {
              out.push({ data: r.data, op: Operations.get(key) });
            }
          });
        });
        return out;
      }

      // Свёрнутый блок связанных записей под строкой заселения (4.3).
      function childrenBlock(children) {
        const sub = h('div', { class: 'today-sub', style: 'display:none' });
        children.forEach((c) => {
          const cancelled = String(c.data['статус']).trim() === 'отменена';
          sub.append(h('div',
            { class: 'today-subrow' + (cancelled ? ' row-cancelled' : '') },
            h('span', { class: 'today-sub-type' }, c.op.label),
            h('span', { class: 'today-sub-desc' }, c.op.describe(c.data)),
            h('span', { class: 'today-sub-sum' },
              money(Operations.sumOf(c.op, c.data)))));
        });
        const label = (n) => ' Связанные записи (' + n + ')';
        const toggle = h('button', { class: 'today-toggle', type: 'button' },
          '▸' + label(children.length));
        toggle.addEventListener('click', () => {
          const closed = sub.style.display === 'none';
          sub.style.display = closed ? '' : 'none';
          toggle.textContent = (closed ? '▾' : '▸') + label(children.length);
        });
        return h('div', { class: 'today-children' }, toggle, sub);
      }

      const table = h('div', { class: 'today-table' });
      table.append(h('div', { class: 'today-row today-thead' },
        h('div', { class: 'tc tc-check' }, ''),
        h('div', { class: 'tc tc-id' }, 'ID'),
        h('div', { class: 'tc tc-type' }, 'ТИП'),
        h('div', { class: 'tc tc-desc' }, 'ОПИСАНИЕ'),
        h('div', { class: 'tc tc-sum' }, 'СУММА'),
        h('div', { class: 'tc tc-status' }, 'СТАТУС')));

      for (const entry of rows) {
        const { rec, op } = entry;
        const d = rec.data;
        const cancelled = String(d['статус']).trim() === 'отменена';

        let checkCell;
        if (cancelled) {
          checkCell = h('div', { class: 'tc tc-check' }, '');
        } else {
          const cb = h('input', { type: 'checkbox' });
          cb.addEventListener('change', () => {
            if (cb.checked) selected.add(entry); else selected.delete(entry);
            syncBtn();
          });
          checkCell = h('div', { class: 'tc tc-check' }, cb);
        }

        table.append(h('div',
          { class: 'today-row' + (cancelled ? ' row-cancelled' : '') },
          checkCell,
          h('div', { class: 'tc tc-id' }, d['id_операции'] || '—'),
          h('div', { class: 'tc tc-type' }, op.label),
          h('div', { class: 'tc tc-desc' }, op.describe(d)),
          h('div', { class: 'tc tc-sum' }, money(Operations.sumOf(op, d))),
          h('div', { class: 'tc tc-status' },
            h('span',
              { class: 'status-badge ' + (cancelled ? 'st-cancelled' : 'st-active') },
              cancelled ? 'отменена' : 'активна'))));

        // Под заселением — свёрнутый список связанных записей (4.3).
        if (op.key === 'заселение') {
          const children = findChildren(d['id_операции']);
          if (children.length) table.append(childrenBlock(children));
        }
      }

      rollbackBtn.addEventListener('click', () => {
        if (!selected.size) return;
        if (!confirm('Откатить выбранные операции (' + selected.size + ')? ' +
          'Откат нельзя отменить.')) return;
        opts.onRollback(Array.from(selected));
      });

      slot.append(table, h('div', { class: 'today-actions' }, rollbackBtn));
    }

    load();
    return { reload: load };
  }

  return { connect, login, main, formScreen, renderTodaySection };
})();
