#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="${SCRIPT_DIR}/.venv"
REQUIREMENTS_FILE="${SCRIPT_DIR}/requirements.txt"
LEGACY_SCRIPT="${SCRIPT_DIR}/bootstrap-legacy.sh"
PYTHON_ENTRY="servarr_bootstrap"

if [[ "${1:-}" == "legacy" ]]; then
  shift
  if [[ ! -x "$LEGACY_SCRIPT" ]]; then
    echo "Legacy bootstrap script not found at $LEGACY_SCRIPT" >&2
    exit 1
  fi
  exec "$LEGACY_SCRIPT" "$@"
fi

command -v python3 >/dev/null 2>&1 || {
  echo "python3 is required but was not found in PATH." >&2
  exit 1
}

if [[ ! -f "$REQUIREMENTS_FILE" ]]; then
  echo "Missing requirements file at $REQUIREMENTS_FILE" >&2
  exit 1
fi

if [[ ! -d "$VENV_DIR" ]]; then
  echo "Creating Python virtual environment..."
  python3 -m venv "$VENV_DIR"
fi

PYTHON_BIN="${VENV_DIR}/bin/python"
REQ_HASH_FILE="${VENV_DIR}/.requirements-hash"

calculate_requirements_hash() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$REQUIREMENTS_FILE" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$REQUIREMENTS_FILE" | awk '{print $1}'
  else
    echo ""
  fi
}

install_requirements() {
  local current_hash
  current_hash="$(calculate_requirements_hash)"
  local needs_install=1

  if [[ -n "$current_hash" && -f "$REQ_HASH_FILE" ]]; then
    read -r cached_hash <"$REQ_HASH_FILE"
    if [[ "$cached_hash" == "$current_hash" ]]; then
      needs_install=0
    fi
  fi

  if [[ $needs_install -eq 1 ]]; then
    echo "Installing Python dependencies..."
    "$PYTHON_BIN" -m pip install --upgrade pip >/dev/null
    "$PYTHON_BIN" -m pip install -r "$REQUIREMENTS_FILE"
    if [[ -n "$current_hash" ]]; then
      echo "$current_hash" >"$REQ_HASH_FILE"
    fi
  fi
}

install_requirements

exec "$PYTHON_BIN" -m "$PYTHON_ENTRY" "$@"
