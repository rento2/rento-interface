/*
 * auth.js — авторизация Google через Google Identity Services (GIS).
 *
 * Используется token-модель GIS для браузерного клиента: client secret
 * не нужен, GIS сам ведёт PKCE-флоу и возвращает access_token в callback.
 * Refresh-токена в браузерной модели нет, но access_token (~1 час) можно
 * продлевать ТИХО через requestAccessToken({ prompt: '' }) — если сессия
 * Google в браузере жива и доступ уже выдан, GIS вернёт новый токен без
 * единого клика. На этом держится «сессия на сутки»: app.js продлевает
 * токен в фоне (см. scheduleTokenRefresh), пользователь не логинится
 * повторно каждый час.
 *
 * access_token складывается в localStorage, чтобы перезагрузка страницы
 * в пределах срока жизни токена не требовала повторного входа в Google.
 *
 * callback общий для интерактивного входа и тихого продления; режим
 * передаётся третьим аргументом onToken(token|null, errorResp, mode),
 * mode ∈ {'interactive','silent'} — app.js по нему решает, перерисовывать
 * экран (вход) или только обновить токен (фоновое продление).
 */
window.Auth = (() => {
  const CONFIG = window.RENTO_CONFIG;
  const TOKEN_KEY = 'rento_google_token';
  const EMAIL_KEY = 'rento_google_email';

  // Получить email Google-аккаунта по access_token (userinfo.email scope)
  // и положить в localStorage. Fire-and-forget: вход не ждёт ответа, а к
  // моменту захода в отчёт почта обычно уже известна. Ошибку гасим —
  // без почты фаундер-функции просто останутся скрытыми.
  function fetchEmail(accessToken) {
    fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: 'Bearer ' + accessToken },
    }).then((r) => (r.ok ? r.json() : null)).then((info) => {
      if (info && info.email) localStorage.setItem(EMAIL_KEY, info.email);
    }).catch(() => { /* почта не критична */ });
  }

  // Email текущего пользователя из localStorage либо ''.
  function getEmail() {
    return localStorage.getItem(EMAIL_KEY) || '';
  }

  let tokenClient = null;
  let onTokenCallback = null;
  let lastMode = 'interactive';     // режим последнего запроса токена

  // Инициализация token-клиента GIS.
  // onToken(token|null, errorResp, mode).
  function initTokenClient(onToken) {
    onTokenCallback = onToken;
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CONFIG.OAUTH_CLIENT_ID,
      scope: CONFIG.OAUTH_SCOPE,
      callback: (resp) => {
        if (resp.error) {
          onTokenCallback(null, resp, lastMode);
          return;
        }
        // GIS позволяет пользователю снять галочку у запрошенного
        // scope на экране согласия. Без доступа к Таблицам токен
        // бесполезен (Sheets API вернёт 403) — ловим это сразу.
        // Проверяем только КРИТИЧНЫЙ scope (Таблицы). Email —
        // вспомогательный: его пользователь может не выдать, вход всё
        // равно валиден (фаундер-функции просто скроются).
        if (!google.accounts.oauth2.hasGrantedAllScopes(
          resp, CONFIG.OAUTH_REQUIRED_SCOPE)) {
          onTokenCallback(null, { error: 'scope_not_granted' }, lastMode);
          return;
        }
        // expires_in в секундах; минус минута запаса.
        const token = {
          access_token: resp.access_token,
          expires_at: Date.now() + (Number(resp.expires_in) - 60) * 1000,
        };
        localStorage.setItem(TOKEN_KEY, JSON.stringify(token));
        fetchEmail(resp.access_token);   // узнаём Google-аккаунт (фоном)
        onTokenCallback(token, null, lastMode);
      },
    });
  }

  // Запросить токен интерактивно. select_account — всегда показывать
  // выбор аккаунта (общий компьютер: менеджеры по очереди, REVIEW-1.2
  // замечание #3). consent — экран согласия, чтобы можно было выдать
  // доступ к Таблицам, если GIS иначе молча вернул бы прежний токен без
  // нужного scope.
  function requestToken() {
    lastMode = 'interactive';
    tokenClient.requestAccessToken({ prompt: 'select_account consent' });
  }

  // Тихо продлить токен (prompt: '') — без выбора аккаунта и согласия.
  // Сработает, если сессия Google в браузере жива и доступ уже выдан;
  // иначе callback придёт с ошибкой (mode='silent') и app.js мягко
  // отложит до ближайшего 401. На общем компьютере продлевает тот же
  // аккаунт, что вошёл, — смена аккаунта по-прежнему через requestToken.
  function requestTokenSilent() {
    lastMode = 'silent';
    tokenClient.requestAccessToken({ prompt: '' });
  }

  // Действующий токен из localStorage либо null.
  function storedToken() {
    try {
      const token = JSON.parse(localStorage.getItem(TOKEN_KEY));
      if (token && token.access_token && token.expires_at > Date.now()) {
        return token;
      }
    } catch (_) {
      /* битый JSON — считаем, что токена нет */
    }
    return null;
  }

  function clearToken() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(EMAIL_KEY);
  }

  return {
    initTokenClient,
    requestToken,
    requestTokenSilent,
    storedToken,
    clearToken,
    getEmail,
  };
})();
