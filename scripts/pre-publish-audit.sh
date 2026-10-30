#!/usr/bin/env bash
# Pre-publish security audit for Ya Music Downloader.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
errors=0

fail() { echo "FAIL: $*"; errors=$((errors + 1)); }
ok() { echo "OK:   $*"; }

# 1. .gitignore must cover sensitive artifacts
for pat in 'auth.json' 'yandex-music-token-1.3' 'artifacts/' 'reference/' 'node_modules/'; do
  if grep -qF "$pat" "$ROOT/.gitignore"; then
    ok ".gitignore contains $pat"
  else
    fail ".gitignore missing $pat"
  fi
done

# 2. No token on command line in Electron main
if grep -n -- '--token' "$ROOT/electron-app/main.js" >/dev/null; then
  fail "electron-app/main.js still references --token"
else
  ok "no --token in spawn args"
fi

# 3. Path traversal guard present in both layers
if grep -q "isSafePathPattern" "$ROOT/electron-app/main.js"; then ok "Electron path guard present"; else fail "Electron path guard missing"; fi
if grep -q "Шаблон пути не может содержать" "$ROOT/programms-source-code/yandex-music-downloader-3.5.5/ymd/ipc.py"; then ok "Python path guard present"; else fail "Python path guard missing"; fi

# 4. Token masking present
if grep -q "REDACTED" "$ROOT/programms-source-code/yandex-music-downloader-3.5.5/ymd/ipc.py"; then ok "Python token masking present"; else fail "Python token masking missing"; fi
if grep -q "maskTokenText" "$ROOT/electron-app/main.js"; then ok "Electron token masking present"; else fail "Electron token masking missing"; fi

# 5. Clean env (no spread of process.env in spawn)
if grep -q "\.\.\.process.env" "$ROOT/electron-app/main.js"; then
  fail "Electron still spreads process.env into child"
else
  ok "Electron uses cleaned child env"
fi

# 6. Scan publishable code for leaked client_secret value
secret='53bc75238f0c4d08a118e51fe9203300'
if grep -RInF --exclude='pre-publish-audit.sh' "$secret" "$ROOT/electron-app" "$ROOT/docs" "$ROOT/scripts" 2>/dev/null; then
  fail "client_secret leaked in publishable code"
else
  ok "no client_secret in publishable code"
fi

# 7. No auth.json or binaries in publishable tree
if find "$ROOT/electron-app" "$ROOT/docs" "$ROOT/scripts" -type f \( -name 'auth.json' -o -name '*.rpm' -o -name '*.zip' \) | grep -q .; then
  fail "forbidden artifact in publishable tree"
else
  ok "no auth.json/binaries in publishable tree"
fi

echo
if [ "$errors" -eq 0 ]; then
  echo "pre-publish-audit: PASS"
  exit 0
else
  echo "pre-publish-audit: FAIL ($errors issue(s))"
  exit 1
fi
