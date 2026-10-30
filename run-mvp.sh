#!/usr/bin/env bash
# Запуск MVP: Electron-интерфейс + Python sidecar (ymd.ipc).
#
# Скрипт выставляет PYTHONPATH на исходники Python-ядра и запускает
# Electron-приложение из electron-app/.
set -euo pipefail

# Каталог проекта — определяется по расположению самого скрипта.
PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ELECTRON_DIR="${PROJECT_ROOT}/electron-app"
PY_SOURCE_DIR="${PROJECT_ROOT}/programms-source-code/yandex-music-downloader-3.5.5"
PYTHON_BIN="${PYTHON_BIN:-/opt/yandex-music-downloader/venv/bin/python}"

# Python sidecar ищет пакет ymd через PYTHONPATH.
export PYTHONPATH="${PY_SOURCE_DIR}${PYTHONPATH:+:${PYTHONPATH}}"
export PYTHONUNBUFFERED=1
export PYTHONIOENCODING=utf-8

if [[ ! -d "${ELECTRON_DIR}" ]]; then
  echo "Ошибка: не найдена папка electron-app (${ELECTRON_DIR})" >&2
  exit 1
fi

if [[ ! -d "${PY_SOURCE_DIR}/ymd" ]]; then
  echo "Ошибка: не найдены исходники Python-ядра (${PY_SOURCE_DIR}/ymd)" >&2
  exit 1
fi

if [[ ! -x "${PYTHON_BIN}" ]]; then
  echo "Предупреждение: не найден интерпретатор ${PYTHON_BIN}" >&2
fi

if [[ ! -d "${ELECTRON_DIR}/node_modules/electron" ]]; then
  echo "Зависимости Electron не установлены. Выполняю npm install..." >&2
  npm --prefix "${ELECTRON_DIR}" install --no-audit --no-fund
fi

cd "${ELECTRON_DIR}"

# Прямой вызов локального бинарника не требует npx и работает офлайн.
if [[ -x "${ELECTRON_DIR}/node_modules/.bin/electron" ]]; then
  exec "${ELECTRON_DIR}/node_modules/.bin/electron" .
fi

exec npm start
