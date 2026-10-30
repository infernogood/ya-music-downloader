'use strict';

/**
 * Renderer: единственный слой, который знает про DOM.
 * Связь с Main — только через мост `window.ymd` из preload.js (contextIsolation).
 */

const api = window.ymd || window.ymdApi || null;

/** Максимальное число строк лога (защита от бесконечного роста DOM). */
const MAX_LOG_ROWS = 500;

/** Человекочитаемые подписи статусов трека. */
const TRACK_STATUS_LABEL = {
  downloading: 'загрузка',
  done: 'готово',
  skipped: 'пропущено',
  error: 'ошибка',
};

const els = {
  auth: document.getElementById('auth'),
  btnLogin: document.getElementById('btn-login'),
  authBadge: document.getElementById('auth-badge'),
  authAccount: document.getElementById('auth-account'),
  btnLogout: document.getElementById('btn-logout'),

  inputUrl: document.getElementById('input-url'),
  selectQuality: document.getElementById('select-quality'),
  selectLyrics: document.getElementById('select-lyrics'),
  inputDir: document.getElementById('input-dir'),
  btnBrowse: document.getElementById('btn-browse'),
  checkCover: document.getElementById('check-cover'),
  checkSkip: document.getElementById('check-skip'),
  btnStart: document.getElementById('btn-start'),
  btnCancel: document.getElementById('btn-cancel'),

  queueTitle: document.getElementById('queue-title'),
  queueCount: document.getElementById('queue-count'),
  progressBar: document.getElementById('progress-bar'),
  progressFill: document.getElementById('progress-fill'),
  currentTrack: document.getElementById('current-track'),
  statDone: document.getElementById('stat-done'),
  statSkipped: document.getElementById('stat-skipped'),
  statErrors: document.getElementById('stat-errors'),
  log: document.getElementById('log'),
};

/** Состояние UI. */
const state = {
  authenticated: false,
  running: false,
  total: 0,
  current: 0,
  done: 0,
  skipped: 0,
  errors: 0,
  logEmpty: true,
};

let unsubscribeEvents = null;

/* ---------------- утилиты ---------------- */

/**
 * Возвращает время в формате ЧЧ:ММ:СС.
 * @returns {string}
 */
function nowTime() {
  return new Date().toLocaleTimeString('ru-RU', { hour12: false });
}

/**
 * Переключает доступность элементов управления.
 * @param {boolean} running
 */
function setRunning(running) {
  state.running = Boolean(running);
  els.btnStart.disabled = state.running;
  els.btnCancel.disabled = !state.running;
  els.inputUrl.disabled = state.running;
  els.selectQuality.disabled = state.running;
  els.selectLyrics.disabled = state.running;
  els.btnBrowse.disabled = state.running;
  els.checkCover.disabled = state.running;
  els.checkSkip.disabled = state.running;
}

/**
 * Добавляет строку в лог.
 * @param {'info'|'ok'|'warn'|'err'} kind
 * @param {string} text
 */
function appendLog(kind, text) {
  if (state.logEmpty) {
    els.log.textContent = '';
    state.logEmpty = false;
  }

  const row = document.createElement('div');
  row.className = `log__row log__row--${kind}`;

  const time = document.createElement('span');
  time.className = 'log__time';
  time.textContent = nowTime();

  const message = document.createElement('span');
  message.className = 'log__text';
  message.textContent = text;

  row.append(time, message);
  els.log.append(row);

  while (els.log.childElementCount > MAX_LOG_ROWS) {
    els.log.removeChild(els.log.firstElementChild);
  }

  els.log.scrollTop = els.log.scrollHeight;
}

/**
 * Сбрасывает прогресс, счётчики и лог перед новой загрузкой.
 */
function resetProgress() {
  state.total = 0;
  state.current = 0;
  state.done = 0;
  state.skipped = 0;
  state.errors = 0;

  els.queueTitle.textContent = 'Подготовка очереди…';
  els.queueCount.textContent = '0 из 0';
  els.currentTrack.textContent = '—';
  els.statDone.textContent = '0';
  els.statSkipped.textContent = '0';
  els.statErrors.textContent = '0';

  els.progressFill.style.width = '0%';
  els.progressBar.setAttribute('aria-valuenow', '0');

  els.log.textContent = '';
  state.logEmpty = true;
}

/**
 * Обновляет прогресс-бар и подписи.
 * @param {number} current
 * @param {number} total
 */
function updateProgress(current, total) {
  if (Number.isFinite(total) && total > 0) {
    state.total = total;
  }
  if (Number.isFinite(current) && current >= 0) {
    state.current = current;
  }

  const percent =
    state.total > 0 ? Math.min(100, Math.round((state.current / state.total) * 100)) : 0;

  els.progressFill.style.width = `${percent}%`;
  els.progressBar.setAttribute('aria-valuenow', String(percent));
  els.queueCount.textContent = `${state.current} из ${state.total}`;
}

/**
 * Обновляет бейдж авторизации.
 * @param {boolean} authenticated
 * @param {string|null} account
 */
function setAuth(authenticated, account) {
  state.authenticated = Boolean(authenticated);

  els.btnLogin.classList.toggle('hidden', state.authenticated);
  els.authBadge.classList.toggle('hidden', !state.authenticated);

  if (state.authenticated) {
    els.authAccount.textContent = account ? `Авторизован: ${account}` : 'Авторизован';
    els.authAccount.title = account || 'Авторизован';
  } else {
    els.authAccount.textContent = 'Авторизован';
    els.authAccount.removeAttribute('title');
  }

  els.btnStart.disabled = state.running || !state.authenticated;
}

/* ---------------- авторизация ---------------- */

async function refreshAuth() {
  if (!api) return;
  try {
    const result = await api.authStatus();
    setAuth(Boolean(result && result.authenticated), result && result.account);
  } catch (error) {
    setAuth(false, null);
    appendLog('err', `Не удалось получить статус авторизации: ${String(error && error.message ? error.message : error)}`);
  }
}

async function handleLogin() {
  if (!api) return;
  els.btnLogin.disabled = true;
  try {
    const result = await api.authLogin();
    if (result && result.ok) {
      setAuth(true, result.account);
      appendLog('ok', result.account ? `Авторизация выполнена: ${result.account}` : 'Авторизация выполнена');
    } else {
      setAuth(false, null);
      appendLog('err', `Вход не выполнен: ${(result && result.error) || 'неизвестная ошибка'}`);
    }
  } catch (error) {
    setAuth(false, null);
    appendLog('err', `Ошибка входа: ${String(error && error.message ? error.message : error)}`);
  } finally {
    els.btnLogin.disabled = false;
  }
}

async function handleLogout() {
  if (!api) return;
  els.btnLogout.disabled = true;
  try {
    const result = await api.authLogout();
    if (result && result.ok) {
      setAuth(false, null);
      appendLog('info', 'Вы вышли из аккаунта');
    } else {
      appendLog('err', `Не удалось выйти: ${(result && result.error) || 'неизвестная ошибка'}`);
    }
  } catch (error) {
    appendLog('err', `Ошибка выхода: ${String(error && error.message ? error.message : error)}`);
  } finally {
    els.btnLogout.disabled = false;
  }
}

/* ---------------- папка назначения ---------------- */

async function handleSelectFolder() {
  if (!api) return;
  try {
    const folder = await api.selectFolder();
    if (typeof folder === 'string' && folder.length > 0) {
      els.inputDir.value = folder;
      els.inputDir.title = folder;
    }
  } catch (error) {
    appendLog('err', `Не удалось выбрать папку: ${String(error && error.message ? error.message : error)}`);
  }
}

/* ---------------- загрузка ---------------- */

/**
 * Собирает параметры для download:start.
 * @returns {{url: string, dir: string, quality: number, embedCover: boolean,
 *            lyricsFormat: string, skipExisting: boolean}|null}
 */
function collectParams() {
  const url = els.inputUrl.value.trim();
  const dir = els.inputDir.value.trim();

  if (!url) {
    appendLog('err', 'Укажите ссылку на трек, альбом, плейлист или артиста');
    els.inputUrl.focus();
    return null;
  }

  if (!dir) {
    appendLog('err', 'Выберите папку сохранения');
    els.btnBrowse.focus();
    return null;
  }

  return {
    url,
    dir,
    quality: Number(els.selectQuality.value),
    embedCover: els.checkCover.checked,
    lyricsFormat: els.selectLyrics.value,
    skipExisting: els.checkSkip.checked,
  };
}

async function handleStart() {
  if (!api) {
    appendLog('err', 'Мост IPC недоступен: preload.js не загружен');
    return;
  }

  if (!state.authenticated) {
    appendLog('err', 'Сначала войдите через Яндекс ID');
    return;
  }

  const params = collectParams();
  if (!params) return;

  resetProgress();
  setRunning(true);
  appendLog('info', `Старт загрузки: ${params.url}`);

  try {
    const result = await api.downloadStart(params);
    if (!result || !result.ok) {
      setRunning(false);
      appendLog('err', `Не удалось запустить загрузку: ${(result && result.error) || 'неизвестная ошибка'}`);
    }
  } catch (error) {
    setRunning(false);
    appendLog('err', `Ошибка запуска загрузки: ${String(error && error.message ? error.message : error)}`);
  }
}

async function handleCancel() {
  if (!api) return;
  els.btnCancel.disabled = true;
  try {
    const result = await api.downloadCancel();
    if (result && result.ok) {
      appendLog('warn', 'Запрошена остановка загрузки');
    } else {
      els.btnCancel.disabled = false;
      appendLog('err', `Не удалось остановить: ${(result && result.error) || 'неизвестная ошибка'}`);
    }
  } catch (error) {
    els.btnCancel.disabled = false;
    appendLog('err', `Ошибка остановки: ${String(error && error.message ? error.message : error)}`);
  }
}

/* ---------------- обработка событий sidecar ---------------- */

/**
 * Применяет одно JSONL-событие из Python sidecar к UI.
 * @param {object} event
 */
function handleSidecarEvent(event) {
  if (!event || typeof event !== 'object') return;

  switch (event.type) {
    case 'auth_ok': {
      setAuth(true, event.account);
      appendLog('ok', event.account ? `Аккаунт: ${event.account}` : 'Авторизация подтверждена');
      break;
    }

    case 'queue_info': {
      state.total = Number(event.total) || 0;
      state.current = 0;
      els.queueTitle.textContent = event.title || 'Очередь';
      updateProgress(0, state.total);
      appendLog('info', `В очереди ${state.total} трек(ов): ${event.title || 'без названия'}`);
      break;
    }

    case 'track_progress': {
      const title = event.title || 'Неизвестный трек';
      const status = event.status || 'downloading';
      const total = Number(event.total) || state.total;

      els.currentTrack.textContent = `${title} — ${TRACK_STATUS_LABEL[status] || status}`;
      els.currentTrack.title = title;

      if (status === 'done') {
        state.done += 1;
        els.statDone.textContent = String(state.done);
        updateProgress(Number(event.current) || state.current, total);
        appendLog('ok', `${title}${event.path ? ` → ${event.path}` : ''}`);
      } else if (status === 'skipped') {
        state.skipped += 1;
        els.statSkipped.textContent = String(state.skipped);
        updateProgress(Number(event.current) || state.current, total);
        appendLog('warn', `${title} — уже существует, пропущен`);
      } else if (status === 'error') {
        state.errors += 1;
        els.statErrors.textContent = String(state.errors);
        updateProgress(Number(event.current) || state.current, total);
        appendLog('err', `${title} — ${event.message || 'ошибка загрузки'}`);
      } else {
        updateProgress(Number(event.current) || state.current, total);
      }
      break;
    }

    case 'finished': {
      setRunning(false);
      state.done = Number(event.downloaded) || state.done;
      state.skipped = Number(event.skipped) || state.skipped;
      state.errors = Number(event.errors) || state.errors;
      els.statDone.textContent = String(state.done);
      els.statSkipped.textContent = String(state.skipped);
      els.statErrors.textContent = String(state.errors);
      updateProgress(state.total, state.total);
      els.currentTrack.textContent = 'Загрузка завершена';
      appendLog(
        'info',
        `Завершено: скачано ${state.done}, пропущено ${state.skipped}, ошибок ${state.errors}`,
      );
      break;
    }

    case 'error': {
      const message = event.message || 'неизвестная ошибка';
      appendLog('err', `${event.code ? `[${event.code}] ` : ''}${message}`);
      if (event.code === 'UNAUTHORIZED') {
        setAuth(false, null);
      }
      break;
    }

    default: {
      appendLog('info', `Событие: ${String(event.type)}`);
    }
  }
}

/* ---------------- инициализация ---------------- */

function bindEvents() {
  els.btnLogin.addEventListener('click', handleLogin);
  els.btnLogout.addEventListener('click', handleLogout);
  els.btnBrowse.addEventListener('click', handleSelectFolder);
  els.btnStart.addEventListener('click', handleStart);
  els.btnCancel.addEventListener('click', handleCancel);

  // Enter в поле URL запускает загрузку.
  els.inputUrl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !state.running) {
      event.preventDefault();
      handleStart();
    }
  });
}

function init() {
  bindEvents();
  setRunning(false);

  if (!api) {
    appendLog('err', 'Мост IPC недоступен: preload.js не загружен');
    els.btnStart.disabled = true;
    return;
  }

  unsubscribeEvents = api.onDownloadEvent(handleSidecarEvent);
  appendLog('info', 'Готово к работе. Укажите ссылку и папку сохранения.');
  refreshAuth();
}

window.addEventListener('beforeunload', () => {
  if (typeof unsubscribeEvents === 'function') {
    unsubscribeEvents();
    unsubscribeEvents = null;
  }
});

init();
