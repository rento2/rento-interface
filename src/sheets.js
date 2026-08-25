/*
 * sheets.js — тонкая обёртка над Google Sheets API v4 (gapi.client).
 *
 * Отвечает только за транспорт: инициализацию клиента, установку токена
 * и batchGet. Никакой бизнес-логики — она в cache.js / app.js.
 */
window.Sheets = (() => {
  const CONFIG = window.RENTO_CONFIG;
  let initialized = false;

  // Загрузка gapi.client и подключение discovery-документа Sheets API.
  function init() {
    return new Promise((resolve, reject) => {
      gapi.load('client', async () => {
        try {
          await gapi.client.init({
            discoveryDocs: [CONFIG.SHEETS_DISCOVERY_DOC],
          });
          initialized = true;
          resolve();
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  // Установить access_token, полученный от GIS (auth.js).
  function setToken(accessToken) {
    gapi.client.setToken({ access_token: accessToken });
  }

  // Единый batch-запрос к нескольким листам.
  // ranges — массив имён листов (имя листа = весь лист как range).
  // Кириллические имена кодируются библиотекой автоматически.
  // spreadsheetId — опционально: по умолчанию боевой файл; файл сервиса
  // (ADR-031) передаёт CONFIG.SERVICE_SPREADSHEET_ID.
  async function batchGet(ranges, spreadsheetId) {
    const response = await gapi.client.sheets.spreadsheets.values.batchGet({
      spreadsheetId: spreadsheetId || CONFIG.SHEETS_ID,
      ranges,
    });
    return response.result.valueRanges || [];
  }

  // Прочитать значения одного диапазона (имя листа = весь лист).
  // spreadsheetId — опционально (файл сервиса, ADR-031).
  async function getValues(range, spreadsheetId) {
    const response = await gapi.client.sheets.spreadsheets.values.get({
      spreadsheetId: spreadsheetId || CONFIG.SHEETS_ID,
      range,
    });
    return response.result.values || [];
  }

  // Дописать строку в конец листа (append-only журналы, §1.2).
  // USER_ENTERED — числа и даты парсятся как в ручном вводе.
  async function appendRow(sheetName, rowValues, spreadsheetId) {
    await gapi.client.sheets.spreadsheets.values.append({
      spreadsheetId: spreadsheetId || CONFIG.SHEETS_ID,
      range: sheetName,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      resource: { values: [rowValues] },
    });
  }

  // Перезаписать конкретный диапазон A1 (для отката — смена статуса
  // в существующей строке журнала, §15).
  async function updateRange(rangeA1, rowValues, spreadsheetId) {
    await gapi.client.sheets.spreadsheets.values.update({
      spreadsheetId: spreadsheetId || CONFIG.SHEETS_ID,
      range: rangeA1,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [rowValues] },
    });
  }

  // Записать несколько диапазонов одним запросом (values.batchUpdate).
  // data — [{ range: 'лист!A2:B2', values: [[...]] }, ...].
  async function batchUpdateValues(data, spreadsheetId) {
    await gapi.client.sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: spreadsheetId || CONFIG.SHEETS_ID,
      resource: { valueInputOption: 'USER_ENTERED', data },
    });
  }

  return {
    init,
    setToken,
    batchGet,
    getValues,
    appendRow,
    updateRange,
    batchUpdateValues,
    isReady: () => initialized,
  };
})();
