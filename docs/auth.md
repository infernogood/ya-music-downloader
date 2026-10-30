# Auth Spec — Яндекс.Музыка (OAuth implicit flow)

Источники: `programms-source-code/yandex-music-token-1.3/browser-extension/src/background.js`,
`.../web-app/src/Api.js`, `.../android-app/.../MainActivity.kt`,
`programms-source-code/yandex-music-downloader-3.5.5/ymd/core.py`.

## 1. Основной (рекомендуемый) способ — implicit flow через BrowserWindow

- `client_id`: `23cabbbdc6cd418abb4b39c32c41195d`
- OAuth URL:
  ```
  https://oauth.yandex.ru/authorize?response_type=token&client_id=23cabbbdc6cd418abb4b39c32c41195d
  ```
- `response_type`: `token`
- redirect URI: отдельный `redirect_uri` **не передаётся** — используется Callback URI,
  зарегистрированный для приложения: `https://music.yandex.ru/` (допустимы также
  домены `music.yandex.com|by|kz|ua`, см. regex расширения).
- `client_secret` для этой схемы не нужен (не передавать в URL и не хранить).

## 2. Извлечение токена

Токен приходит в **хэш-фрагменте** URL после успешного входа:

```
https://music.yandex.ru/#access_token=<TOKEN>&token_type=bearer&expires_in=<seconds>
```

Регулярное выражение (из расширения, расширено под 4 домена и `expires_in`):

```
^https:\/\/music\.yandex\.(?:ru|com|by|kz|ua)\/#access_token=([^&]*)
```

Алгоритм для Electron Main:

1. Создать `BrowserWindow` (контекст `ymd-auth`, без `nodeIntegration`).
2. `win.loadURL(OAUTH_URL)`.
3. Подписаться на `will-redirect` **и** `did-navigate` / `did-navigate-in-page`
   (хэш-часть не вызывает навигацию верхнего уровня — при необходимости сработает
   `did-navigate-in-page` или инъекция в `preload`).
4. При совпадении regex: сохранить `access_token`, закрыть окно, вернуть
   `{ok: true, account}` в renderer через `auth:login`.
5. Если пользователь закрыл окно без токена — `{ok: false}`.
6. Таймаут (например 5 минут) — закрыть окно, вернуть `{ok: false}`.

Внимание: хэш может быть не виден в `will-redirect` (он не уходит на сервер).
Надёжный путь — `did-navigate-in-page` + `webContents.getURL()` либо
`win.webContents.on('did-finish-load')` с чтением `location.hash` через
`executeJavaScript`.

## 3. Хранение токена

- Файл: `~/.config/yandex-music-downloader/auth.json`
- Минимальная структура:
  ```json
  {"access_token": "...", "account": "user@example.com", "saved_at": "ISO-8601"}
  ```
- Права файла `0600`; каталог создаётся с `0700`.
- `expires_in` из URL (~1 год) можно сохранять для предупреждения об истечении,
  но MVP может его игнорировать: при `401` показывать «Авторизуйтесь заново».

## 4. Проверка токена

- Python: `ymd.core.init_client(token, timeout, max_try_count, retry_delay)` →
  `Client(token).init()`; при невалидном токене библиотека бросает
  `UnauthorizedError`/`NetworkError`. Ошибку транслировать как
  `{"type":"error","code":"UNAUTHORIZED"}`.
- `account` (email) при желании берётся из `Client.account_status()` / профиля;
  если получить не удалось — писать `null`, UI показывает «Авторизован».

## 5. Scope / разрешения

- Явный `scope` в URL не передаётся: используется набор по умолчанию,
  зарегистрированный для `client_id` (полный доступ к Яндекс.Музыке, включая
  скачивание треков и чтение библиотеки). Дополнительные разрешения не нужны.
- `client_secret` из `web-app/src/Api.js` (`[REDACTED_CLIENT_SECRET]`)
  относится к устаревшему password-гранту; **не использовать** и **не хранить**.

## 6. Отклонённые альтернативы

| Способ | Почему не берём |
|:---|:---|
| Password grant `POST https://oauth.yandex.com/token` (`grant_type=password`) | Устаревший; требует `client_secret`; не работает для части аккаунтов; капча. |
| Yandex Auth SDK (Android, `com.yandex.authsdk`) | Требует мобильное приложение и нативные intents, в Electron неприменим. |

## 7. Итог для разработчиков

- Electron (main process): реализовать §1–§3 в `main.js`, каналы `auth:status|login|logout`.
- Python sidecar: принимать токен флагом `--token`, читать `auth.json` как fallback,
  ошибку авторизации отдавать как `{"type":"error","code":"UNAUTHORIZED"}`.
