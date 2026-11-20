#!/usr/bin/env bash
# Pond — start the server and open the app (macOS / Linux)
cd "$(dirname "$0")"
PORT="$(grep -E '^PORT=' .env 2>/dev/null | head -1 | cut -d= -f2 | sed 's/#.*//; s/[[:space:]]//g')"
URL="http://localhost:${PORT:-8787}"
( sleep 1.5
  if command -v open >/dev/null 2>&1; then open "$URL"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1
  fi ) &
echo "[pond] Starting on $URL (Ctrl+C to stop)"
exec node server.js
