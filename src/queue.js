/*
 * queue.js — очередь отправки операций (TICKET-2.1, §5).
 *
 * Любая запись в Sheets (создание операции, откат) идёт через очередь:
 * операция кладётся в localStorage и отправляется фоновым процессором.
 * Если связь упала — операция не теряется, ретраится по графику.
 *
 * Очередь не знает, КАК писать конкретный тип операции — за это
 * отвечают «отправители» (senders), которые регистрирует app.js.
 * Идемпотентность обеспечивается на уровне отправителя через
 * client_uuid (см. journal.appendOperation).
 */
window.Queue = (() => {
  const CONFIG = window.RENTO_CONFIG;

  const senders = {};               // formType -> async (formData, clientUuid)
  const changeListeners = [];       // вызываются при любом изменении очереди
  const commitListeners = [];       // вызываются при успешной отправке
  let authErrorHandler = null;      // app.js: handleSheetsError
  let timer = null;
  let processing = false;

  // --- хранилище ---
  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(CONFIG.QUEUE_KEY));
      return Array.isArray(raw) ? raw : [];
    } catch (_) {
      return [];
    }
  }

  function save(queue) {
    localStorage.setItem(CONFIG.QUEUE_KEY, JSON.stringify(queue));
    changeListeners.forEach((fn) => fn());
  }

  // --- график ретраев (§5.2) ---
  // attempts — число уже сделанных попыток.
  function retryDelayMs(attempts) {
    if (attempts <= 1) return 3000;
    if (attempts === 2) return 10000;
    if (attempts === 3) return 30000;
    return 120000;
  }

  // Операция готова к отправке прямо сейчас?
  function isEligible(item, now) {
    if (item.status === 'pending') return true;
    if (item.status === 'error') {
      return now - new Date(item.lastAttemptAt).getTime() >=
        retryDelayMs(item.attempts);
    }
    return false; // sending / failed
  }

  // Ошибка авторизации (протухший токен / нет доступа)?
  function isAuthError(err) {
    const code = err && (err.status ||
      (err.result && err.result.error && err.result.error.code));
    return code === 401 || code === 403;
  }

  // --- процессор ---
  // Раз в 2 секунды берёт первую готовую операцию и отправляет.
  // За один тик обрабатывается одна операция (флаг processing
  // защищает от наложения, если отправка дольше 2 секунд).
  async function tick() {
    if (processing) return;
    const queue = load();
    const now = Date.now();
    const item = queue.find((it) => isEligible(it, now));
    if (!item) return;

    const sender = senders[item.formType];
    if (!sender) {
      console.error('Нет отправителя для типа операции:', item.formType);
      return;
    }

    processing = true;
    item.status = 'sending';
    item.attempts += 1;
    item.lastAttemptAt = new Date().toISOString();
    save(queue);

    try {
      const result = await sender(item.formData, item.clientUuid);
      // Успех — убрать из очереди.
      const fresh = load().filter((it) => it.clientUuid !== item.clientUuid);
      save(fresh);
      commitListeners.forEach((fn) => fn(item, result));
    } catch (err) {
      console.error('Отправка операции не удалась:', item.formType, err);
      const fresh = load();
      const target = fresh.find((it) => it.clientUuid === item.clientUuid);
      if (target) {
        target.lastError = (err && err.message) || 'ошибка отправки';
        // 10 попыток исчерпано — операция «провалена» (§5.2).
        target.status = target.attempts >= 10 ? 'failed' : 'error';
        save(fresh);
      }
      if (isAuthError(err) && authErrorHandler) authErrorHandler(err);
    } finally {
      processing = false;
    }
  }

  // --- публичное API ---

  // Зарегистрировать отправителя для типа операции.
  function registerSender(formType, fn) {
    senders[formType] = fn;
  }

  // Поставить операцию в очередь. Возвращает client_uuid (§4.2).
  function add(formType, formData) {
    const clientUuid = crypto.randomUUID();
    const queue = load();
    queue.push({
      clientUuid,
      formType,
      formData,
      createdAt: new Date().toISOString(),
      status: 'pending',
      attempts: 0,
      lastError: null,
      lastAttemptAt: null,
    });
    save(queue);
    setTimeout(tick, 50); // не ждать полного интервала
    return clientUuid;
  }

  // Счётчики для индикатора (§5.3).
  function getStatus() {
    const queue = load();
    const status = { pending: 0, sending: 0, error: 0, failed: 0 };
    for (const it of queue) {
      if (status[it.status] !== undefined) status[it.status] += 1;
    }
    return status;
  }

  // Секунды до следующего ретрая первой операции в статусе error
  // (для текста индикатора). null — если ретраить нечего.
  function nextRetryInSeconds() {
    const queue = load();
    const now = Date.now();
    let soonest = null;
    for (const it of queue) {
      if (it.status !== 'error') continue;
      const at = new Date(it.lastAttemptAt).getTime() + retryDelayMs(it.attempts);
      const sec = Math.max(0, Math.ceil((at - now) / 1000));
      if (soonest === null || sec < soonest) soonest = sec;
    }
    return soonest;
  }

  function onChange(fn) { changeListeners.push(fn); }
  // Возвращает отписку — экраны снимают слушателя при выходе, иначе
  // они копятся по одному на каждое открытие (REVIEW-P, минор 2).
  function onCommitted(fn) {
    commitListeners.push(fn);
    return () => {
      const i = commitListeners.indexOf(fn);
      if (i !== -1) commitListeners.splice(i, 1);
    };
  }
  function setAuthErrorHandler(fn) { authErrorHandler = fn; }

  // Восстановить операции, зависшие в 'sending' (REVIEW-2, критичное #1).
  //
  // tick ставит status='sending' в localStorage ДО await sender. Если
  // страницу перезагрузили посреди отправки — операция остаётся
  // 'sending', а isEligible для 'sending' даёт false: процессор её
  // больше никогда не возьмёт, и внесённая операция теряется молча.
  // На старте (контекст JS уже чистый, processing=false) переводим
  // такие операции обратно в 'pending'. Повторная отправка безопасна:
  // и журнал (appendOperation), и лог (logAction) дедуплицируют —
  // дубля не будет, даже если запись на самом деле доехала.
  function recoverStuck() {
    const queue = load();
    let changed = false;
    for (const it of queue) {
      if (it.status === 'sending') {
        console.warn('Восстановлена зависшая операция:', it.clientUuid);
        it.status = 'pending';
        changed = true;
      }
    }
    if (changed) save(queue);
  }

  // Запустить фоновый процессор (раз в 2 секунды, §5.2).
  function start() {
    if (timer) return;
    recoverStuck();
    timer = setInterval(tick, 2000);
    setTimeout(tick, 50);
  }

  return {
    registerSender,
    add,
    getStatus,
    nextRetryInSeconds,
    onChange,
    onCommitted,
    setAuthErrorHandler,
    start,
  };
})();
