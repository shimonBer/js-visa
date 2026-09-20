#!/bin/zsh
set -euo pipefail
SOURCE="$0"
while [[ -L "$SOURCE" ]]; do
  DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
done
SCRIPT_DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO"

export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  # shellcheck disable=SC1091
  source "$HOME/.nvm/nvm.sh"
fi

NODE="$(command -v node || true)"
if [[ -z "$NODE" || ! -x "$NODE" ]]; then
  echo "Node.js was not found. Install Node, then try again."
  exit 1
fi

"$NODE" "$SCRIPT_DIR/pack-fill-kit.js"
/usr/bin/osascript -e 'display dialog "fill-ds160-kit.zip is on your Desktop. Copy that zip to the worker Mac." buttons {"OK"} default button 1 with title "fill-ds160"' >/dev/null
