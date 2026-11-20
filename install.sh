#!/usr/bin/env bash
# Pond installer for macOS / Linux
#   curl -fsSL https://raw.githubusercontent.com/raspy135/pond/main/install.sh | bash
# Re-run any time to update — your .env and data/ are never touched.
# Options (env vars): POND_HOME (default ~/pond)  POND_REPO (raspy135/pond)  POND_BRANCH (main)
#                     POND_NO_START=1 (don't launch)  POND_SOURCE_DIR (install from a local folder)
set -euo pipefail

main() {
  local REPO="${POND_REPO:-raspy135/pond}" BRANCH="${POND_BRANCH:-main}" DIR="${POND_HOME:-$HOME/pond}"
  say()  { printf '\033[1;36m[pond]\033[0m %s\n' "$*"; }
  fail() { printf '\033[1;31m[pond]\033[0m %s\n' "$*" >&2; exit 1; }
  node_ok() { command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 18 ]; }
  py_ok() { command -v python3 >/dev/null 2>&1 && python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' 2>/dev/null; }
  venv_ok() { python3 -m venv --help >/dev/null 2>&1 && python3 -c 'import ensurepip' >/dev/null 2>&1; }

  # 1) Node.js 18+
  if ! node_ok; then
    if [ "$(uname)" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
      say "Installing Node.js with Homebrew…"; brew install node
    else
      say "Installing Node.js LTS with nvm (no sudo needed)…"
      export NVM_DIR="$HOME/.nvm"
      [ -s "$NVM_DIR/nvm.sh" ] || curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
      # shellcheck disable=SC1091
      . "$NVM_DIR/nvm.sh"; nvm install --lts >/dev/null; nvm use --lts >/dev/null
    fi
    node_ok || fail "Node.js 18+ is required — install it from https://nodejs.org and run this again."
  fi
  say "Using Node $(node -v)"

  # 1b) Python 3.9+ with venv (required: data, spreadsheets, PDFs, scripts)
  if ! py_ok || { [ "$(uname)" != "Darwin" ] && ! venv_ok; }; then
    if [ "$(uname)" = "Darwin" ]; then
      command -v brew >/dev/null 2>&1 && { say "Installing Python with Homebrew…"; brew install python; }
    elif command -v apt-get >/dev/null 2>&1; then
      say "Installing Python (asks for your password)…"; sudo apt-get update -qq && sudo apt-get install -y python3 python3-venv python3-pip
    elif command -v dnf >/dev/null 2>&1; then
      say "Installing Python (asks for your password)…"; sudo dnf install -y python3 python3-pip
    elif command -v pacman >/dev/null 2>&1; then
      say "Installing Python (asks for your password)…"; sudo pacman -S --needed --noconfirm python python-pip
    fi
    py_ok || fail "Python 3.9+ is required — install it (https://www.python.org/downloads/) and run this again."
  fi
  say "Using $(python3 --version)"

  # 2) Download or update Pond (keeps .env and data/)
  if [ -n "${POND_SOURCE_DIR:-}" ]; then
    say "Copying from $POND_SOURCE_DIR…"; mkdir -p "$DIR"
    (cd "$POND_SOURCE_DIR" && tar --exclude=./data --exclude=./.env --exclude=./.git --exclude=./node_modules --exclude=./.venv --exclude='./.backup*' -cf - .) | (cd "$DIR" && tar -xf -)
  elif command -v git >/dev/null 2>&1 && [ -d "$DIR/.git" ]; then
    say "Updating $DIR…"; git -C "$DIR" pull --ff-only
  elif command -v git >/dev/null 2>&1 && [ ! -e "$DIR" ]; then
    say "Downloading Pond to $DIR…"; git clone --depth 1 -b "$BRANCH" "https://github.com/$REPO.git" "$DIR"
  else
    say "Downloading Pond to $DIR…"; mkdir -p "$DIR"
    curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH" | tar -xz --strip-components=1 -C "$DIR"
  fi
  cd "$DIR"

  # 3) Configure (interactive when a terminal is available, even under `curl | bash`)
  if [ -z "${POND_NONINTERACTIVE:-}" ] && { exec 3</dev/tty; } 2>/dev/null; then
    exec 3<&-
    node scripts/setup.mjs < /dev/tty
  else
    node scripts/setup.mjs --yes
  fi

  # 4) Start
  local PORT; PORT="$(grep -E '^PORT=' .env 2>/dev/null | head -1 | cut -d= -f2 | sed 's/#.*//; s/[[:space:]]//g')"; PORT="${PORT:-8787}"
  if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
    say "Pond is already running on port $PORT — restart it to load this version."
  elif [ -n "${POND_NO_START:-}" ]; then
    say "Installed. Start it with: $DIR/start.sh"
  else
    say "Installed in $DIR — next time just run: $DIR/start.sh"
    exec bash ./start.sh
  fi
}

main "$@"
