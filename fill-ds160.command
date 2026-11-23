#!/bin/zsh
# Opens fill-ds160. This file is in the zip. It does not download anything.
set -euo pipefail
SOURCE="$0"
while [[ -L "$SOURCE" ]]; do
  DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
done
REPO="$(cd "$(dirname "$SOURCE")" && pwd)"

if [[ ! -d "$REPO/node_modules/playwright" ]]; then
  /usr/bin/osascript -e 'display dialog "fill-ds160 is not downloaded yet. Double-click Download fill-ds160.command in this folder, wait until it finishes, then open fill-ds160.command again." buttons {"OK"} default button 1 with title "fill-ds160"' >/dev/null
  exit 1
fi

exec "$REPO/scripts/Fill DS-160.command"
