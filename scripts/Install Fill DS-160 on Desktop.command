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
SERVER="$SCRIPT_DIR/fill-ui/server.js"
APP="$HOME/Desktop/fill-ds160.app"
OLD_APP="$HOME/Desktop/Fill DS-160.app"
OLD_COMMAND="$HOME/Desktop/Fill DS-160.command"

export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  # shellcheck disable=SC1091
  source "$HOME/.nvm/nvm.sh"
fi
NODE="$(command -v node || true)"
if [[ -z "$NODE" || ! -x "$NODE" ]]; then
  echo "Node.js was not found. Install Node, then run this installer again."
  exit 1
fi

cd "$REPO"
if [[ ! -d node_modules ]]; then
  echo "Installing Node packages (first time on this Mac)…"
  npm install
fi
echo "Making sure Chromium for fill-ds160 is installed…"
npx playwright install chromium || echo "Playwright install skipped (offline or already present)."

as_quote() {
  python3 -c 'import sys; print("\"" + sys.argv[1].replace("\\", "\\\\").replace("\"", "\\\"") + "\"")' "$1"
}

TMP="$(mktemp /tmp/fill-ds160-app.XXXXXX.applescript)"
cat > "$TMP" <<APPLESCRIPT
set repo to $(as_quote "$REPO")
set nodeBin to $(as_quote "$NODE")
set server to $(as_quote "$SERVER")
set logFile to (POSIX path of (path to library folder from user domain)) & "Logs/ds160-fill-launch.log"

do shell script "mkdir -p " & quoted form of ((POSIX path of (path to library folder from user domain)) & "Logs")
set cmd to "cd " & quoted form of repo & " && " & quoted form of nodeBin & " " & quoted form of server & " --open >> " & quoted form of logFile & " 2>&1 &"
do shell script cmd
APPLESCRIPT

/usr/bin/osacompile -o "$APP" "$TMP"
rm -f "$TMP"
if [[ -e "$OLD_APP" || -L "$OLD_APP" ]]; then
  rm -rf "$OLD_APP"
fi
if [[ -L "$OLD_COMMAND" || -e "$OLD_COMMAND" ]]; then
  rm -f "$OLD_COMMAND"
fi
echo "Shortcut installed: $APP"
echo "Double-click fill-ds160. It opens a small window to load files — no Terminal."
