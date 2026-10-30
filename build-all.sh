#!/usr/bin/env bash
# Cross-platform build: Windows portable .exe + Linux .rpm
set -euo pipefail

PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ELECTRON_DIR="${PROJECT_ROOT}/electron-app"
ARTIFACTS_DIR="${PROJECT_ROOT}/artifacts"
STAGING_DIR="${PROJECT_ROOT}/build/rpm-staging"

PYTHON_BIN="${PYTHON_BIN:-/opt/yandex-music-downloader/venv/bin/python}"
PY_SOURCE_DIR="${PROJECT_ROOT}/programms-source-code/yandex-music-downloader-3.5.5"

# --- 1. Проверка утилит ---
for tool in node npm python3; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Ошибка: не найдена утилита $tool" >&2
    exit 1
  fi
done

# nfpm (для сборки RPM без rpmbuild)
if ! command -v nfpm >/dev/null 2>&1; then
  NFPM_CACHE="${HOME}/.cache/nfpm"
  mkdir -p "${NFPM_CACHE}"
  if [[ ! -x "${NFPM_CACHE}/nfpm" ]]; then
    echo "Скачиваю nfpm..." >&2
    curl -sL https://github.com/goreleaser/nfpm/releases/download/v2.44.0/nfpm_2.44.0_Linux_x86_64.tar.gz -o "${NFPM_CACHE}/nfpm.tgz"
    tar -xzf "${NFPM_CACHE}/nfpm.tgz" -C "${NFPM_CACHE}" nfpm
    chmod +x "${NFPM_CACHE}/nfpm"
  fi
  export PATH="${NFPM_CACHE}:${PATH}"
fi

mkdir -p "${ARTIFACTS_DIR}"

# --- 2. Зависимости Electron ---
if [[ ! -d "${ELECTRON_DIR}/node_modules/electron" ]]; then
  npm --prefix "${ELECTRON_DIR}" install --no-audit --no-fund
fi
if [[ ! -x "${ELECTRON_DIR}/node_modules/.bin/electron-builder" ]]; then
  npm --prefix "${ELECTRON_DIR}" install --save-dev electron-builder --no-audit --no-fund
fi

# --- 3. Иконки ---
if [[ -f "${PROJECT_ROOT}/scripts/convert-icons.py" ]]; then
  python3 "${PROJECT_ROOT}/scripts/convert-icons.py"
fi

# --- 4. Сборка Windows (portable .exe) ---
echo "==> Building Windows portable .exe"
npm --prefix "${ELECTRON_DIR}" run build:win

# --- 5. Сборка Linux (unpacked) ---
echo "==> Building Linux unpacked"
npm --prefix "${ELECTRON_DIR}" run build:linux-dir 2>/dev/null || \
  "${ELECTRON_DIR}/node_modules/.bin/electron-builder" --linux dir --x64 --projectDir "${ELECTRON_DIR}"

# --- 6. Подготовка staging для RPM ---
echo "==> Preparing RPM staging"
rm -rf "${STAGING_DIR}"
mkdir -p "${STAGING_DIR}/opt/ymd-electron"
mkdir -p "${STAGING_DIR}/opt/yandex-music-downloader"
mkdir -p "${STAGING_DIR}/usr/share/applications"
mkdir -p "${STAGING_DIR}/usr/share/icons/hicolor"

# копируем распакованное Electron-приложение
cp -a "${ELECTRON_DIR}/dist/linux-unpacked/." "${STAGING_DIR}/opt/ymd-electron/"

# копируем Python venv (sidecar) если доступен
if [[ -d "/opt/yandex-music-downloader/venv" ]]; then
  cp -a /opt/yandex-music-downloader/venv "${STAGING_DIR}/opt/yandex-music-downloader/venv"
fi

# иконки по стандарту Freedesktop
for size in 16 32 48 128 256 512; do
  dir="${STAGING_DIR}/usr/share/icons/hicolor/${size}x${size}/apps"
  mkdir -p "${dir}"
  if [[ -f "${ELECTRON_DIR}/assets/icons/${size}x${size}.png" ]]; then
    cp "${ELECTRON_DIR}/assets/icons/${size}x${size}.png" "${dir}/ymd-electron.png"
  fi
done

# .desktop файл
cat > "${STAGING_DIR}/usr/share/applications/ymd-electron.desktop" <<'EOF'
[Desktop Entry]
Name=Ya Music Downloader
Comment=Ya Music Downloader — Electron UI поверх Python sidecar
Exec=/opt/ymd-electron/ymd-electron
Icon=ymd-electron
Type=Application
Categories=AudioVideo;Audio;
Terminal=false
EOF

# --- 7. Сборка RPM через nfpm ---
echo "==> Building RPM"
cd "${PROJECT_ROOT}"
nfpm package --packager rpm --target "${ELECTRON_DIR}/dist/ymd-electron-0.1.0.x86_64.rpm" --config "${PROJECT_ROOT}/nfpm.yaml"

# --- 8. Перенос артефактов ---
echo "==> Collecting artifacts"
cp -f "${ELECTRON_DIR}/dist/"*.exe "${ARTIFACTS_DIR}/" 2>/dev/null || true
cp -f "${ELECTRON_DIR}/dist/"*.rpm "${ARTIFACTS_DIR}/" 2>/dev/null || true

echo "==> Done. Artifacts:"
ls -lh "${ARTIFACTS_DIR}"/*.exe "${ARTIFACTS_DIR}"/*.rpm 2>/dev/null || true
