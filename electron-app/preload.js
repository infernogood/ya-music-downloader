'use strict';

/**
 * Preload — единственный мост между renderer и Main.
 * Renderer не получает доступ к Node/Electron API напрямую (contextIsolation: true).
 *
 * Каналы Main:
 *   auth:status          invoke   → {authenticated: boolean, account?: string|null}
 *   auth:login           invoke   → {ok: boolean, account?: string|null, error?: string}
 *   auth:logout          invoke   → {ok: boolean, error?: string}
 *   download:start       invoke   → {ok: boolean, error?: string}
 *   download:cancel      invoke   → {ok: boolean, error?: string}
 *   dialog:selectFolder  invoke   → string | null
 *   download:event       on       ← JSONL-событие из Python sidecar
 */

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Подписка на события Main.
 * @param {(event: object) => void} handler
 * @returns {() => void} отписка
 */
function subscribeDownloadEvent(handler) {
  if (typeof handler !== 'function') return () => {};
  const listener = (_event, payload) => {
    handler(payload);
  };
  ipcRenderer.on('download:event', listener);
  return () => {
    ipcRenderer.removeListener('download:event', listener);
  };
}

const api = {
  // --- авторизация ---
  authStatus: () => ipcRenderer.invoke('auth:status'),
  authLogin: () => ipcRenderer.invoke('auth:login'),
  authLogout: () => ipcRenderer.invoke('auth:logout'),

  // --- загрузка ---
  /**
   * @param {{url: string, dir: string, quality?: 0|1|2|string,
   *          embedCover?: boolean, lyricsFormat?: 'none'|'text'|'lrc',
   *          skipExisting?: boolean, pathPattern?: string}} params
   */
  downloadStart: (params) => ipcRenderer.invoke('download:start', params),
  downloadCancel: () => ipcRenderer.invoke('download:cancel'),

  /** Подписка на поток событий; возвращает функцию отписки. */
  onDownloadEvent: subscribeDownloadEvent,

  // --- диалоги ---
  selectFolder: () => ipcRenderer.invoke('dialog:selectFolder'),

  /** Список каналов — для диагностики и отладки в DevTools. */
  channels: Object.freeze({
    authStatus: 'auth:status',
    authLogin: 'auth:login',
    authLogout: 'auth:logout',
    downloadStart: 'download:start',
    downloadCancel: 'download:cancel',
    downloadEvent: 'download:event',
    selectFolder: 'dialog:selectFolder',
  }),
};

contextBridge.exposeInMainWorld('ymd', api);
contextBridge.exposeInMainWorld('ymdApi', api);
