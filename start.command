#!/bin/bash
set -eu
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"
for candidate in "$PROJECT_DIR/.venv/bin/python" python3 python3.13 python3.12 python3.11; do
  if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' >/dev/null 2>&1; then
    exec "$candidate" "$PROJECT_DIR/scripts/start_local.py" "$@"
  fi
done
printf '%s\n' 'Trade needs Python 3.11 or newer.' 'Install Python from https://www.python.org/downloads/macos/ and run this launcher again.' >&2
exit 1
