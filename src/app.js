/*
 * app.js — оркестратор: загрузка библиотек, сессия, навигация по
 * экранам, склейка модулей. Сам по себе не рисует UI (это screens.js
 * и forms.js) и не ходит в Sheets напрямую (это cache/journal).
 *
 * Слои проекта:
 *   данные   — sheets.js, cache.js, journal.js
 *   операции — queue.js
 *   вид      — ui.js, screens.js, forms.js
 *   склейка  — app.js
 */
(() => {
  const CONFIG = window.RENTO_CONFIG;
  const USER_KEY = 'rento_user_id';
  // Сессия команды (после выбора сотрудника) живёт 12 часов и
  // переживает перезагрузку страницы. Google OAuth-токен живёт около
  // часа — это отдельный жизненный цикл: когда он истекает, менеджер
  // ещё раз нажимает «Подключить», и попадает сразу на главный экран,
  // не выбирая себя из списка повторно. ADR-025: общий пароль команды
  // убран, доступ контролируется через Google Share на боевой Sheets.
  const SESSION_KEY = 'rento_session_until';
  const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

  function sessionValid() {
    const until = Number(localStorage.getItem(SESSION_KEY) || 0);
    return until > Date.now();
  }
  function startUserSession() {
    localStorage.setItem(SESSION_KEY, String(Date.now() + SESSION_TTL_MS));
  }
  function endUserSession() {
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem(SESSION_KEY);
  }

  let appReady = false;       // библиотеки Google загружены, Sheets готов
  let indicatorSlot = null;   // место индикатора очереди в шапке
  let todayCtl = null;        // контроллер секции «сегодня» (reload)
  let refreshLabelTimer = null;

  // --- помощники --------------------------------------------------------

  function isFounderRole(role) {
    const r = String(role || '').trim().toLowerCase().replace(/\s/g, '');
    return r === 'ген.дир' || r === 'основатель';
  }

  // Текущий сотрудник из кеша по стабильному id_сотрудника (ADR-005).
  function currentEmployee() {
    const id = localStorage.getItem(USER_KEY);
    return Cache.activeEmployees().find((e) => e['id_сотрудника'] === id) || null;
  }

  function describeSheetsError(err) {
    const code = (err && (err.status ||
      (err.result && err.result.error && err.result.error.code))) || null;
    const message = (err && err.result && err.result.error &&
      err.result.error.message) || (err && err.message) || 'неизвестная ошибка';
    return { code, message };
  }

  // Единый обработчик ошибок Sheets API (REVIEW-1.2, замечание #2).
  // true — ошибка авторизационная, сессия сброшена, экран переключён;
  // вызывающему делать нечего. false — прочая ошибка, разбирай сам.
  // Используется загрузкой справочников, кнопкой «Обновить», авто-
  // таймером кеша и очередью отправки (Queue.setAuthErrorHandler).
  function handleSheetsError(err) {
    const { code, message } = describeSheetsError(err);
    if (code === 401) {
      console.warn('Токен Google недействителен:', err);
      Cache.stopAutoRefresh();
      Auth.clearToken();
      showConnect('Сессия Google истекла — подключитесь заново.');
      return true;
    }
    if (code === 403) {
      console.warn('Google отказал в доступе (403):', err);
      Cache.stopAutoRefresh();
      Auth.clearToken();
      showConnect('Google отказал в доступе к таблице (403). Ответ ' +
        'Google: «' + message + '». Проверьте: у выбранного аккаунта ' +
        'есть доступ к боевому файлу, и при входе вы разрешили доступ ' +
        'к Google Таблицам (галочка на экране согласия).');
      return true;
    }
    return false;
  }

  // --- индикатор очереди ------------------------------------------------

  // Перерисовать индикатор очереди в шапке. Безопасно вызывать всегда —
  // если шапки нет на экране, просто ничего не делает.
  function refreshIndicator() {
    if (!indicatorSlot || !document.body.contains(indicatorSlot)) return;
    UI.clear(indicatorSlot);
    indicatorSlot.append(
      UI.queueIndicator(Queue.getStatus(), Queue.nextRetryInSeconds()));
  }

  // --- навигация по экранам --------------------------------------------

  function showConnect(errorText, reloadMode) {
    indicatorSlot = null;
    todayCtl = null;
    Screens.connect({
      appReady,
      errorText,
      reloadMode,
      onConnect: () => Auth.requestToken(),
    });
  }

  function showLogin(errorText) {
    indicatorSlot = null;
    todayCtl = null;
    Screens.login({
      employees: Cache.activeEmployees(),
      storedUserId: localStorage.getItem(USER_KEY),
      errorText,
      onSubmit: (userId) => {
        if (!userId) return 'Выберите, кто вы.';
        localStorage.setItem(USER_KEY, userId);
        startUserSession();           // 12 часов с момента входа
        showMain();
        return null;
      },
      onSwitchAccount: () => { endUserSession(); Auth.clearToken(); showConnect(); },
    });
  }

  function showMain() {
    const employee = currentEmployee();
    if (!employee) {
      endUserSession();
      showLogin('Не удалось определить пользователя — войдите заново.');
      return;
    }
    const founder = isFounderRole(employee['роль']);

    const slots = Screens.main({
      employee,
      isFounder: founder,
      onOpenForm: showФорма,
      onRefresh: handleRefresh,
      onLogout: () => { endUserSession(); showLogin(); },
      onOpenHelp: () => showФорма('помощь'),
    });

    indicatorSlot = slots.indicatorSlot;
    refreshIndicator();

    todayCtl = Screens.renderTodaySection(slots.todaySlot, {
      employee,
      isFounder: founder,
      onRollback: rollbackOperations,
      handleError: handleSheetsError,
    });
  }

  // formType -> функция открытия формы (forms.js).
  const FORM_OPENERS = {
    'уборка': Forms.openУборка,
    'мастер': Forms.openМастер,
    'хоз_расход': Forms.openХозРасход,
    'прочее': Forms.openПрочее,
    'batch_площадки': Forms.openBatch,
    'выплата': Forms.openВыплата,
    'заселение': Forms.openЗаселение,
    'отчёт_собственнику': Forms.openОтчётСобственнику,
    'поиск_операций': Forms.openПоискОпераций,
    'помощь': Forms.openПомощь,
  };

  // Формы только для основателя, которых нет в реестре операций
  // (Operations.get(...).founderOnly закрывает только записи в журнал).
  const FOUNDER_ONLY_FORMS = new Set(['отчёт_собственнику', 'поиск_операций']);

  // Полноэкранный экран формы операции (ADR-006). Отмена, «← На главную»
  // и успешная отправка возвращают на главный экран через showMain.
  function showФорма(formType) {
    const employee = currentEmployee();
    if (!employee) {
      endUserSession();
      showLogin('Не удалось определить пользователя — войдите заново.');
      return;
    }
    const opener = FORM_OPENERS[formType];
    if (!opener) { showMain(); return; }
    // Защита: формы основателя (Выплата, Batch, Отчёт) менеджеру не
    // открываем, даже если formType пришёл в обход карточек главного.
    // Operations.get(...).founderOnly закрывает только записи в журнал;
    // FOUNDER_ONLY_FORMS — для неоперационных форм (отчёт).
    const op = Operations.get(formType);
    const founderOnly = (op && op.founderOnly) || FOUNDER_ONLY_FORMS.has(formType);
    if (founderOnly && !isFounderRole(employee['роль'])) {
      showMain();
      return;
    }
    todayCtl = null; // секции «сегодня» на экране формы нет
    const callbacks = {
      employee,
      onRefresh: handleRefresh,
      onLogout: () => { endUserSession(); showLogin(); },
      onExit: showMain,
      // Кнопка «?» в шапке доступна с любого экрана формы, кроме
      // самой страницы помощи (иначе кольцо «помощь → помощь»).
      onOpenHelp: formType === 'помощь' ? null : () => showФорма('помощь'),
    };
    // «Поиск операций» открывает экран корректировки изнутри —
    // даём ему ту же сборку колбэков плюс ссылку на форму
    // корректировки. Корректировка не сидит в FORM_OPENERS
    // потому что в главное меню не выводится (§16.2: вход
    // только через «Поиск операций»).
    if (formType === 'поиск_операций') {
      callbacks.onOpenКорректировка = (original) => {
        todayCtl = null;
        const corr = Forms.openКорректировка({
          employee, original,
          onRefresh: handleRefresh,
          onLogout: () => { endUserSession(); showLogin(); },
          onExit: showMain,
        });
        indicatorSlot = corr.indicatorSlot;
        refreshIndicator();
      };
    }
    const slots = opener(callbacks);
    indicatorSlot = slots.indicatorSlot;
    refreshIndicator();
  }

  // --- действия ---------------------------------------------------------

  // Кнопка «Обновить справочники». Таймер восстановления подписи
  // отменяется при повторном клике (REVIEW-1.2, замечание #6).
  async function handleRefresh(btn) {
    const label = btn.querySelector('.refresh-label');
    if (refreshLabelTimer) { clearTimeout(refreshLabelTimer); refreshLabelTimer = null; }
    btn.disabled = true;
    label.textContent = 'Обновляем…';
    try {
      await Cache.refresh();
      label.textContent = 'Справочники обновлены';
    } catch (err) {
      if (handleSheetsError(err)) return;
      console.error('Обновление справочников:', err);
      label.textContent = 'Ошибка обновления';
    } finally {
      btn.disabled = false;
      refreshLabelTimer = setTimeout(() => {
        label.textContent = 'Обновить справочники';
        refreshLabelTimer = null;
      }, 2500);
    }
  }

  // Откат выбранных операций — каждая идёт в очередь отдельной операцией.
  // entries — массив { rec, op }: запись журнала + её тип из Operations.
  // Заселение откатывается каскадно (отдельный отправитель — §15, 4.3).
  function rollbackOperations(entries) {
    const employee = currentEmployee();
    if (!employee) return;
    for (const { rec, op } of entries) {
      const desc = 'Откат: ' + op.label + ' — ' + op.describe(rec.data);
      if (op.key === 'заселение') {
        Queue.add('откат_заселения', {
          'id_операции': rec.data['id_операции'],
          'id_менеджера': employee['id_сотрудника'],
          'краткое_описание': desc,
        });
      } else {
        Queue.add('откат', {
          'journalSheet': op.journal,
          'id_операции': rec.data['id_операции'],
          'id_менеджера': employee['id_сотрудника'],
          'тип_операции': op.key,
          'краткое_описание': desc,
        });
      }
    }
    refreshIndicator();
  }

  // --- отправители очереди (как персистить каждый тип операции) --------

  // Создание операции — общий отправитель для всех форм. Журнал и
  // метаданные операция несёт служебными ключами `_journal` / `_logType`
  // / `_shortDesc` / `_managerId` (см. forms.js). Идемпотентность —
  // на уровне appendOperation (по client_uuid) и logAction.
  async function createSender(formData, clientUuid) {
    const row = { ...formData, 'client_uuid': clientUuid };
    const idOperation = await Journal.appendOperation(formData['_journal'], row);
    await Journal.logAction({
      'timestamp': new Date().toISOString(),
      'id_менеджера': formData['_managerId'],
      'действие': 'создание',
      'id_операции': idOperation,
      'тип_операции': formData['_logType'],
      'краткое_описание': formData['_shortDesc'],
    });
    return { idOperation };
  }

  function registerSenders() {
    // Один отправитель на все формы — ветвлений по типу нет (ADR-006
    // pipeline). Ключ очереди = formType из формы, нужен только для
    // маршрутизации и отладки.
    ['уборка', 'мастер', 'хоз_расход', 'прочее', 'batch_площадки', 'выплата']
      .forEach((key) => Queue.registerSender(key, createSender));

    // Заселение — многожурнальная транзакция (§7.6): строка в
    // журнал_поступления + N связанных строк. Вся механика записи и
    // идемпотентности — в Journal.appendIncasementTx.
    Queue.registerSender('заселение', async (formData, clientUuid) => {
      const { idOperation } = await Journal.appendIncasementTx(
        formData['parent'], formData['lines'], clientUuid);
      await Journal.logAction({
        'timestamp': new Date().toISOString(),
        'id_менеджера': formData['_managerId'],
        'действие': 'создание',
        'id_операции': idOperation,
        'тип_операции': 'заселение',
        'краткое_описание': formData['_shortDesc'],
      });
      return { idOperation };
    });

    // Каскадный откат заселения (§15, TICKET-4.3, ADR-015): родитель в
    // журнал_поступления + все связанные строки в журнал_выплаты,
    // журнал_хоз_расходы И журнал_касса. Идемпотентно: уже отменённые
    // пропускаются.
    Queue.registerSender('откат_заселения', async (formData) => {
      const parentId = formData['id_операции'];
      const patch = {
        'статус': 'отменена',
        'отменена_кем': formData['id_менеджера'],
        'отменена_когда': new Date().toISOString(),
      };
      await Journal.updateOperation(
        CONFIG.JOURNAL_ПОСТУПЛЕНИЯ, parentId, patch);

      let cascaded = 0;
      const childJournals = [
        CONFIG.JOURNAL_ВЫПЛАТЫ,
        CONFIG.JOURNAL_ХОЗ_РАСХОДЫ,
        CONFIG.JOURNAL_КАССА,
      ];
      const both = await Journal.readMany(childJournals);
      for (const j of childJournals) {
        const recs = (both[j] && both[j].records) || [];
        for (const rec of recs) {
          if (rec.data['id_связанной_операции'] !== parentId) continue;
          if (String(rec.data['статус']).trim() === 'отменена') continue;
          await Journal.updateOperation(j, rec.data['id_операции'], patch);
          cascaded += 1;
        }
      }
      await Journal.logAction({
        'timestamp': new Date().toISOString(),
        'id_менеджера': formData['id_менеджера'],
        'действие': 'откат',
        'id_операции': parentId,
        'тип_операции': 'заселение',
        'краткое_описание': 'Откат заселения, связанных записей: ' + cascaded,
      });
      return {};
    });

    // Корректировка задним числом (§16, TICKET-6.1). Пишет новую строку
    // в тот же журнал, что исходная, со ссылкой `id_исходной_операции`.
    // Идемпотентность — на уровне appendOperation (по client_uuid).
    // В лог пишется действие `корректировка` (§20); дедуп logAction по
    // паре (id_операции, действие) — id у корректировки новый, поэтому
    // даже при ретраях дубля не будет.
    //
    // requireActiveRoot (REVIEW-6 #6): между «Создать корректировку» в
    // UI и фактической записью корень мог быть отменён через «Сегодня»
    // (если он сегодняшний). Передаём rootId в appendOperation — он
    // в том же batchGet проверит, что корень есть и активен, и упадёт
    // громко с понятной ошибкой, если уже отменён. Без этой проверки
    // корректировка к отменённой операции прошла бы тихо и попала в
    // витрину как «дельта к неактивной строке» — данные грязные.
    Queue.registerSender('корректировка', async (formData, clientUuid) => {
      const row = { ...formData.row, 'client_uuid': clientUuid };
      const idOperation = await Journal.appendOperation(
        formData.journalSheet, row,
        { requireActiveRoot: formData.row['id_исходной_операции'] });
      await Journal.logAction({
        'timestamp': new Date().toISOString(),
        'id_менеджера': formData.managerId,
        'действие': 'корректировка',
        'id_операции': idOperation,
        'тип_операции': formData.opKey,
        'краткое_описание': formData.shortDesc,
      });
      return { idOperation };
    });

    // Откат — смена статуса существующей строки + лог. Повторное
    // применение безопасно (статус просто снова становится «отменена»).
    Queue.registerSender('откат', async (formData) => {
      await Journal.updateOperation(
        formData['journalSheet'], formData['id_операции'], {
          'статус': 'отменена',
          'отменена_кем': formData['id_менеджера'],
          'отменена_когда': new Date().toISOString(),
        });
      await Journal.logAction({
        'timestamp': new Date().toISOString(),
        'id_менеджера': formData['id_менеджера'],
        'действие': 'откат',
        'id_операции': formData['id_операции'],
        'тип_операции': formData['тип_операции'],
        'краткое_описание': formData['краткое_описание'],
      });
      return {};
    });

    // Лог факта генерации отчёта собственнику (§17.5, TICKET-5.2).
    // Это не запись операции в журнал — только аудит-строка в
    // _лог_действий. Идёт через очередь, чтобы переживала обрывы сети
    // и ретраилась; logAction дедуплицирует по (id_операции, действие),
    // но у нас id_операции пустой — дедуп возьмёт за основу
    // (id_менеджера, действие). Этого мало (два отчёта подряд от
    // одного менеджера схлопнутся). Поэтому пишем здесь
    // appendUnique с тройкой (id_менеджера, действие, краткое_описание)
    // — описание включает ФИО собственника и период, разные отчёты
    // дают разное описание, дедуп пройдёт по факту повторной отправки
    // ровно той же строки (ретрай).
    Queue.registerSender('отчёт_собственнику', async (formData) => {
      await Journal.appendUnique(CONFIG.LOG_SHEET, {
        'timestamp': formData['timestamp'],
        'id_менеджера': formData['id_менеджера'],
        'действие': 'генерация_отчёта',
        'id_операции': '',
        'тип_операции': 'отчёт_собственнику',
        'краткое_описание': formData['краткое_описание'],
      }, ['id_менеджера', 'действие', 'краткое_описание']);
      return {};
    });

    // Предложение новой категории (§14, TICKET-3.6). Пишет заявку в
    // _категории_на_модерации и аудит в _лог_действий. У листа модерации
    // нет client_uuid — дедуп по смыслу записи (idempotent на ретраях).
    Queue.registerSender('предложение_категории', async (formData) => {
      // Имена колонок в `_категории_на_модерации` пишутся через
      // подчёркивание (`timestamp_предложения`, `предложенное_название`,
      // `комментарий_основателя`). Раньше тут стояли варианты с
      // пробелами — buildRow искал по имени, не находил и молча ронял
      // значения: timestamp и название уходили в пустоту, а appendUnique
      // по ключу с пробелом не дедуплицировал, и заявки дублировались
      // на ретраях. Имена выровнены под фактический лист.
      await Journal.appendUnique(CONFIG.MODERATION_SHEET, {
        'timestamp_предложения': formData['timestamp'],
        'id_менеджера': formData['id_менеджера'],
        'предложенное_название': formData['название'],
        'статус': 'на модерации',
        'комментарий_основателя': '',
        'комментарий_предложившего': formData['зачем'], // ADR-008
      }, ['id_менеджера', 'предложенное_название']);
      await Journal.appendUnique(CONFIG.LOG_SHEET, {
        'timestamp': new Date().toISOString(),
        'id_менеджера': formData['id_менеджера'],
        'действие': 'предложение_категории',
        'id_операции': '',
        'тип_операции': 'категория',
        'краткое_описание': 'Предложена категория: ' + formData['название'],
      }, ['id_менеджера', 'действие', 'краткое_описание']);
      return {};
    });
  }

  // --- сессия и загрузка -----------------------------------------------

  async function startSession(token) {
    Sheets.setToken(token.access_token);
    try {
      await Cache.refresh();
      Cache.startAutoRefresh(handleSheetsError);
      Queue.start();
      // Сессия команды живёт 12 часов и переживает F5: если у нас уже
      // есть сохранённый сотрудник и сессия не истекла — сразу главный
      // экран, выбор сотрудника не нужен. Если сессия истекла или
      // сотрудник не резолвится по справочнику — обычный вход
      // (showLogin сам подсветит сохранённого сотрудника). ADR-025:
      // пароля команды нет, доступ контролируется Google Share.
      if (sessionValid() && currentEmployee()) {
        showMain();
      } else {
        if (!sessionValid()) endUserSession();
        showLogin();
      }
    } catch (err) {
      if (handleSheetsError(err)) return;
      console.error('Загрузка справочников:', err);
      showConnect('Не удалось загрузить справочники: ' +
        describeSheetsError(err).message + '. Повторите.');
    }
  }

  function onToken(token, errorResp) {
    if (!token) {
      console.error('OAuth:', errorResp);
      const scopeDenied = errorResp && errorResp.error === 'scope_not_granted';
      showConnect(scopeDenied
        ? 'Доступ к Google Таблицам не выдан. Нажмите «Подключить» ещё ' +
          'раз и оставьте галочку доступа к Таблицам включённой.'
        : 'Google не выдал доступ. Повторите вход.');
      return;
    }
    startSession(token);
  }

  function withTimeout(promise, ms, label) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error(label + ' — превышено время ожидания')), ms)),
    ]);
  }

  function waitForLibraries(timeoutMs) {
    return new Promise((resolve, reject) => {
      let waited = 0;
      (function check() {
        const gapiOk = !!window.gapi;
        const gisOk = !!(window.google && window.google.accounts &&
          window.google.accounts.oauth2);
        if (gapiOk && gisOk) { resolve(); return; }
        waited += 100;
        if (waited >= timeoutMs) {
          const missing = [];
          if (!gapiOk) missing.push('gapi (apis.google.com)');
          if (!gisOk) missing.push('GIS (accounts.google.com)');
          reject(new Error('не загрузились: ' + missing.join(', ')));
          return;
        }
        setTimeout(check, 100);
      })();
    });
  }

  async function boot() {
    showConnect(); // экран виден сразу, не дожидаясь библиотек

    try {
      await waitForLibraries(20000);
      // Sheets discovery-документ у Google периодически отдаётся
      // 5–15 секунд; 20 секунд оставляли холодный старт без запаса.
      // 60 секунд — безопасный потолок: если за это время не пришло,
      // это реально сеть/блокировщик, и стоит показать ту самую
      // ошибку.
      await withTimeout(Sheets.init(), 60000, 'инициализация Sheets API');
    } catch (err) {
      console.error('Подготовка Google API:', err);
      showConnect('Не удалось подготовить Google API: ' + err.message +
        '. Чаще всего это блокировщик рекламы/приватности или сетевой ' +
        'фильтр, режущий apis.google.com и accounts.google.com. ' +
        'Отключите блокировщик для этой страницы (или откройте в другом ' +
        'браузере без расширений) и обновите страницу.', true);
      return;
    }

    Auth.initTokenClient(onToken);
    registerSenders();
    Queue.setAuthErrorHandler(handleSheetsError);
    Queue.onChange(refreshIndicator);
    Queue.onCommitted(() => {
      refreshIndicator();
      if (todayCtl) todayCtl.reload();
    });
    // Индикатор тикает раз в секунду — для обратного отсчёта ретрая (§5.3).
    setInterval(refreshIndicator, 1000);
    appReady = true;

    const token = Auth.storedToken();
    if (token) {
      startSession(token);
    } else {
      showConnect();
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
