#!/bin/sh
# macOS: double-click to start. Linux: run ./start.command
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Download the LTS version from https://nodejs.org, install it, then run this again."
  exit 1
fi
(sleep 1; open http://localhost:4321 2>/dev/null || xdg-open http://localhost:4321 2>/dev/null) &
exec node server.js
