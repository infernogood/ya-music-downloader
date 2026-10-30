# Security Policy

## Token handling
- The Yandex Music access token is **never** passed via command-line arguments.
  It is delivered to the Python sidecar through the `YMD_TOKEN` environment
  variable of an isolated, cleaned child-process environment.
- `ps aux` during a download therefore never contains the token.
- Tokens are stored in `~/.config/yandex-music-downloader/auth.json` with mode `0600`.
- Any token value is masked (`[REDACTED]`) in `stderr`, tracebacks and `--debug` logs.

## Path traversal protection
- `--path-pattern` is validated in both Electron Main and the Python sidecar.
- Patterns containing `..`, absolute paths or `.` segments are rejected.
- Resolved download paths are checked to stay within the selected download dir.

## Process environment
- The child process receives a minimal allow-list of environment variables.
  Host secrets are not inherited.

## Pre-publish audit
- Run `scripts/pre-publish-audit.sh` before releasing.
- It verifies `.gitignore` coverage and absence of leaked secrets/binaries.

## Reporting
- Please report vulnerabilities privately to the maintainer.
