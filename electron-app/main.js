'use strict';

/**
 * Electron Main — ядро MVP.
 *
 * Обязанности:
 *  - одноразовая OAuth-авторизация Яндекс ID в отдельном BrowserWindow;
 *  - хранение токена в ~/.config/yandex-music-downloader/auth.json (0600);
 *  - запуск Python sidecar `python -m ymd.ipc` и трансляция JSONL → renderer;
 *  - отмена загрузки (SIGTERM, при необходимости SIGKILL через ~2 c);
 *  - выбор папки сохранения.
 *
 * Контракт с Python — JSONL в stdout, весь лог — в stderr.
 */

const { app, BrowserWindow, ipcMain, dialog, session } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// ---------------------------------------------------------------------------
// Константы окружения
// ---------------------------------------------------------------------------

// Wayland/ozone: подсказка платформы должна быть выставлена до app.whenReady()
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
}

const OAUTH_URL =
  'https://oauth.yandex.ru/authorize?response_type=token' +
  '&client_id=23cabbbdc6cd418abb4b39c32c41195d';

/** Токен приходит в хэш-фрагменте URL после логина (см. specs/auth-spec.md §2). */
const TOKEN_URL_RE = /^https:\/\/music\.yandex\.(?:ru|com|by|kz|ua)\/?(?:[?#].*)?$/i;
const TOKEN_PARAM_RE = /[#?&]access_token=([^&]+)/;
const EXPIRES_PARAM_RE = /[#?&]expires_in=(\d+)/;

const AUTH_TIMEOUT_MS = 5 * 60 * 1000; // 5 минут на прохождение OAuth
const CANCEL_TIMEOUT_MS = 1900; // ответ download:cancel должен уложиться в 2 c

const CONFIG_DIR = path.join(os.homedir(), '.config', 'yandex-music-downloader');
const AUTH_FILE = path.join(CONFIG_DIR, 'auth.json');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const isPackaged = app.isPackaged;
const PY_SOURCE_DIR = isPackaged
  ? process.resourcesPath
  : path.join(PROJECT_ROOT, 'programms-source-code', 'yandex-music-downloader-3.5.5');
const PYTHON_BIN = (isPackaged && fs.existsSync(path.join(process.resourcesPath, 'venv', 'bin', 'python')))
  ? path.join(process.resourcesPath, 'venv', 'bin', 'python')
  : '/opt/yandex-music-downloader/venv/bin/python';
const PY_MODULE = 'ymd.ipc';

const AUTH_PARTITION = 'ymd-auth'; // отдельная НЕперсистентная сессия для OAuth
const ALLOWED_QUALITY = new Set(['0', '1', '2']);
const ALLOWED_LYRICS = new Set(['none', 'text', 'lrc']);
const DEFAULT_PATH_PATTERN = '{artist}/{album}/{title}';

// ---------------------------------------------------------------------------
// Состояние модуля
// ---------------------------------------------------------------------------

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {BrowserWindow | null} */
let authWindow = null;
/** @type {import('node:child_process').ChildProcess | null} */
let downloadChild = null;
/** Токен текущей загрузки (для маскирования в stderr/событиях). */
let currentDownloadToken = null;

// ---------------------------------------------------------------------------
// Хранилище токена
// ---------------------------------------------------------------------------

/** Читает auth.json; при любой проблеме возвращает null. */
function readAuth() {
  try {
    const raw = fs.readFileSync(AUTH_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data.access_token !== 'string' || data.access_token.length === 0) {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

/** Атомарно сохраняет токен с правами 0600 (каталог — 0700). */
function writeAuth(payload) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(CONFIG_DIR, 0o700);
  } catch {
    /* права каталога могли быть заданы администратором — не критично */
  }
  const tmp = `${AUTH_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, AUTH_FILE);
}

/** Удаляет сохранённый токен. */
function clearAuth() {
  try {
    fs.unlinkSync(AUTH_FILE);
  } catch (err) {
    if (err && err.code !== 'ENOENT') throw err;
  }
}

/** Текущий статус авторизации для renderer. */
function authStatus() {
  const data = readAuth();
  if (!data) return { authenticated: false };
  return {
    authenticated: true,
    account: typeof data.account === 'string' ? data.account : null,
  };
}

// ---------------------------------------------------------------------------
// OAuth: извлечение токена из URL
// ---------------------------------------------------------------------------

/**
 * Достаёт access_token из URL редиректа.
 * @param {string} url
 * @returns {{token: string, expiresIn: number | null} | null}
 */
function extractToken(url) {
  if (typeof url !== 'string' || url.length === 0) return null;
  if (!TOKEN_URL_RE.test(url)) return null;
  const match = TOKEN_PARAM_RE.exec(url);
  if (!match) return null;
  let token;
  try {
    token = decodeURIComponent(match[1]);
  } catch {
    token = match[1];
  }
  if (!token) return null;
  const exp = EXPIRES_PARAM_RE.exec(url);
  return { token, expiresIn: exp ? Number.parseInt(exp[1], 10) : null };
}

/** Сохраняет токен и оповещает основное окно. */
function persistToken(tokenInfo) {
  const payload = {
    access_token: tokenInfo.token,
    account: null, // email в implicit flow не приходит; UI покажет «Авторизован»
    saved_at: new Date().toISOString(),
    expires_in: tokenInfo.expiresIn,
  };
  writeAuth(payload);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('download:event', { type: 'auth_ok', account: payload.account });
  }
  return payload;
}

/**
 * Открывает модальное окно Яндекс ID и ждёт токен.
 * @returns {Promise<{ok: boolean, account?: string | null, error?: string}>}
 */
function runOAuthLogin(parentWindow) {
  return new Promise((resolve) => {
    let settled = false;
    let timeoutId = null;

    const win = new BrowserWindow({
      parent: parentWindow || undefined,
      modal: Boolean(parentWindow),
      width: 520,
      height: 720,
      title: 'Вход в Яндекс ID',
      autoHideMenuBar: true,
      webPreferences: {
        partition: AUTH_PARTITION,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        // без preload: произвольный внешний сайт не должен видеть API приложения
      },
    });
    authWindow = win;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      if (!win.isDestroyed()) win.destroy();
      if (authWindow === win) authWindow = null;
      resolve(result);
    };

    const tryUrl = (url) => {
      const found = extractToken(url);
      if (!found) return false;
      try {
        const saved = persistToken(found);
        finish({ ok: true, account: saved.account });
      } catch (err) {
        finish({ ok: false, error: `Не удалось сохранить токен: ${String(err.message || err)}` });
      }
      return true;
    };

    // Хэш-фрагмент не уходит на сервер, поэтому слушаем все варианты навигации.
    win.webContents.on('will-redirect', (_event, url) => tryUrl(url));
    win.webContents.on('will-navigate', (_event, url) => tryUrl(url));
    win.webContents.on('did-navigate', (_event, url) => tryUrl(url));
    win.webContents.on('did-navigate-in-page', (_event, url) => tryUrl(url));
    win.webContents.on('did-finish-load', () => {
      if (settled) return;
      win.webContents
        .executeJavaScript('window.location.href', true)
        .then((href) => {
          tryUrl(href);
        })
        .catch(() => {
          /* страница могла быть уничтожена — не критично */
        });
    });

    win.on('closed', () => {
      if (authWindow === win) authWindow = null;
      finish({ ok: false, error: 'Окно авторизации закрыто пользователем' });
    });

    timeoutId = setTimeout(() => {
      finish({ ok: false, error: 'Истекло время ожидания авторизации' });
    }, AUTH_TIMEOUT_MS);

    win.loadURL(OAUTH_URL).catch((err) => {
      finish({ ok: false, error: `Не удалось открыть страницу OAuth: ${String(err.message || err)}` });
    });
  });
}

// ---------------------------------------------------------------------------
// Python sidecar
// ---------------------------------------------------------------------------

/** Отправляет событие в renderer (токен маскируется). */
function emit(event) {
  if (event && typeof event === 'object' && typeof event.message === 'string') {
    event = { ...event, message: maskTokenText(event.message) };
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('download:event', event);
  }
}

/** Проверка шаблона пути на выход за пределы каталога загрузки. */
function isSafePathPattern(pattern) {
  if (typeof pattern !== 'string' || pattern.trim().length === 0) return false;
  if (pattern.includes('..')) return false;
  if (pattern.startsWith('/') || pattern.startsWith('\\')) return false;
  if (/^[a-zA-Z]:[\\/]/.test(pattern)) return false;
  const parts = pattern.split(/[\\/]+/);
  for (const part of parts) {
    if (part === '..' || part === '.') return false;
  }
  return true;
}

/** Маскирует токен в произвольном тексте. */
function maskTokenText(text) {
  const token = currentDownloadToken || (readAuth() && readAuth().access_token);
  if (typeof text !== 'string' || !token) return text;
  return text.split(token).join('[REDACTED]');
}

/** Приводит входные параметры renderer к безопасному виду. */
function normalizeParams(params) {
  const src = params && typeof params === 'object' ? params : {};
  const quality = String(src.quality ?? '2');
  const lyricsFormat = String(src.lyricsFormat ?? 'none');
  const pathPattern =
    typeof src.pathPattern === 'string' && src.pathPattern.trim().length > 0
      ? src.pathPattern
      : DEFAULT_PATH_PATTERN;

  return {
    url: typeof src.url === 'string' ? src.url.trim() : '',
    dir: typeof src.dir === 'string' ? src.dir.trim() : '',
    quality: ALLOWED_QUALITY.has(quality) ? quality : '2',
    lyricsFormat: ALLOWED_LYRICS.has(lyricsFormat) ? lyricsFormat : 'none',
    pathPattern,
    embedCover: Boolean(src.embedCover),
    skipExisting: Boolean(src.skipExisting),
  };
}

/** Собирает аргументы CLI для ymd.ipc (без токена — он передаётся через env). */
function buildPythonArgs(p) {
  const args = [
    '-m',
    PY_MODULE,
    '--url',
    p.url,
    '--dir',
    p.dir,
    '--quality',
    p.quality,
  ];
  if (p.embedCover) args.push('--embed-cover');
  args.push('--lyrics-format', p.lyricsFormat);
  if (p.skipExisting) args.push('--skip-existing');
  args.push('--path-pattern', p.pathPattern);
  return args;
}

/** Запускает загрузку. */
function startDownload(params) {
  if (downloadChild) {
    return { ok: false, error: 'Загрузка уже выполняется' };
  }

  const p = normalizeParams(params);

  if (!isSafePathPattern(p.pathPattern)) {
    emit({ type: 'error', code: 'INVALID_PATH_PATTERN', message: 'Шаблон пути содержит выход за пределы папки (..)' });
    return { ok: false, error: 'Недопустимый шаблон пути' };
  }

  if (!p.url) return { ok: false, error: 'Не указан URL' };
  if (!p.dir) return { ok: false, error: 'Не указана папка сохранения' };

  const auth = readAuth();
  if (!auth) {
    emit({ type: 'error', code: 'UNAUTHORIZED', message: 'Требуется авторизация Яндекс ID' });
    return { ok: false, error: 'Требуется авторизация' };
  }
  currentDownloadToken = auth.access_token;

  try {
    fs.mkdirSync(p.dir, { recursive: true });
  } catch (err) {
    return { ok: false, error: `Не удалось создать папку: ${String(err.message || err)}` };
  }

  const args = buildPythonArgs(p);

  // Чистое окружение дочернего процесса: только необходимое, без секретов хоста.
  const cleanEnv = {};
  for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TMP', 'TEMP', 'XDG_RUNTIME_DIR', 'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY']) {
    if (process.env[key]) cleanEnv[key] = process.env[key];
  }
  cleanEnv.PYTHONPATH = PY_SOURCE_DIR;
  cleanEnv.PYTHONUNBUFFERED = '1';
  cleanEnv.PYTHONIOENCODING = 'utf-8';
  cleanEnv.YMD_TOKEN = auth.access_token;

  let child;
  try {
    child = spawn(PYTHON_BIN, args, {
      cwd: PROJECT_ROOT,
      env: cleanEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    emit({ type: 'error', code: 'SPAWN_FAILED', message: String(err.message || err) });
    return { ok: false, error: 'Не удалось запустить Python sidecar' };
  }

  downloadChild = child;
  let stdoutBuffer = '';
  let finishedSeen = false;

  const handleLine = (line) => {
    const text = line.trim();
    if (!text) return;
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      emit({ type: 'error', code: 'BAD_JSONL', message: maskTokenText(text.slice(0, 500)) });
      return;
    }
    if (!data || typeof data !== 'object') return;
    if (data.type === 'finished') finishedSeen = true;
    if (data.type === 'error' && typeof data.code !== 'string') {
      data.code = 'UNKNOWN';
    }
    emit(data);
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    let idx = stdoutBuffer.indexOf('\n');
    while (idx !== -1) {
      handleLine(stdoutBuffer.slice(0, idx));
      stdoutBuffer = stdoutBuffer.slice(idx + 1);
      idx = stdoutBuffer.indexOf('\n');
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    // Диагностика Python — только в консоль Main, токен маскируется.
    process.stderr.write(`[ymd.ipc] ${maskTokenText(chunk)}`);
  });

  child.on('error', (err) => {
    emit({ type: 'error', code: 'SPAWN_FAILED', message: String(err.message || err) });
  });

  child.on('close', (code, signal) => {
    if (stdoutBuffer.trim()) handleLine(stdoutBuffer);
    stdoutBuffer = '';
    if (downloadChild === child) downloadChild = null;
    currentDownloadToken = null;
    if (!finishedSeen) {
      emit({
        type: 'finished',
        downloaded: 0,
        skipped: 0,
        errors: 1,
        cancelled: signal !== null,
        exitCode: code,
      });
    }
  });

  return { ok: true };
}

/** Останавливает дочерний процесс: SIGTERM, затем SIGKILL, ответ ≤ 2 c. */
function cancelDownload() {
  const child = downloadChild;
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    downloadChild = null;
    return Promise.resolve({ ok: true });
  }

  return new Promise((resolve) => {
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* процесс мог завершиться сам */
      }
      finish({ ok: true });
    }, CANCEL_TIMEOUT_MS);

    child.once('close', () => finish({ ok: true }));

    try {
      child.kill('SIGTERM');
    } catch (err) {
      finish({ ok: false, error: String(err.message || err) });
    }
  });
}

// ---------------------------------------------------------------------------
// Окна
// ---------------------------------------------------------------------------

/** Создаёт главное окно. */
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 720,
    minWidth: 820,
    minHeight: 560,
    title: 'Ya Music Downloader',
    show: false,
    backgroundColor: '#141414',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  mainWindow.once('ready-to-show', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  const indexHtml = path.join(__dirname, 'index.html');
  if (fs.existsSync(indexHtml)) {
    mainWindow.loadFile(indexHtml);
  } else {
    // UI-слой ещё не готов — не падаем, показываем заглушку.
    mainWindow.loadURL(
      'data:text/html;charset=utf-8,' +
        encodeURIComponent(
          '<body style="font-family:sans-serif;background:#141414;color:#eee;padding:2em">' +
            '<h1>Ya Music Downloader</h1>' +
            '<p>Интерфейс (index.html) не найден. Ядро Electron запущено.</p>' +
            '</body>',
        ),
    );
  }
}

// ---------------------------------------------------------------------------
// IPC-обработчики
// ---------------------------------------------------------------------------

function registerIpcHandlers() {
  ipcMain.handle('auth:status', () => authStatus());

  ipcMain.handle('auth:login', async (event) => {
    if (readAuth()) {
      const status = authStatus();
      return { ok: true, account: status.account ?? null };
    }
    const parent = BrowserWindow.fromWebContents(event.sender) || mainWindow;
    const result = await runOAuthLogin(parent);
    return result;
  });

  ipcMain.handle('auth:logout', async () => {
    try {
      clearAuth();
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
    // Очищаем cookies OAuth-сессии, чтобы следующий вход был «чистым».
    try {
      await session.fromPartition(AUTH_PARTITION).clearStorageData();
    } catch {
      /* сессия могла ещё не создаваться */
    }
    return { ok: true };
  });

  ipcMain.handle('download:start', (_event, params) => startDownload(params));

  ipcMain.handle('download:cancel', () => cancelDownload());

  ipcMain.handle('dialog:selectFolder', async (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender) || mainWindow;
    const options = {
      title: 'Папка для сохранения музыки',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Выбрать',
    };
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });
}

// ---------------------------------------------------------------------------
// Жизненный цикл приложения
// ---------------------------------------------------------------------------

// Один экземпляр приложения — иначе два процесса могут писать один auth.json.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    registerIpcHandlers();
    createMainWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    const child = downloadChild;
    downloadChild = null;
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGTERM');
      } catch {
        /* игнорируем: приложение завершается */
      }
    }
  });
}
