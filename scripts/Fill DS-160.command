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
SERVER="$SCRIPT_DIR/fill-ui/server.js"
CLOSER="$SCRIPT_DIR/close-idle-fill-window.applescript"
LOG_DIR="$HOME/Library/Logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/ds160-fill-launch.log"

if [[ -z "$NODE" || ! -x "$NODE" ]]; then
  /usr/bin/osascript -e 'display dialog "Node.js was not found. Ask IT to install Node, then try again." buttons {"OK"} default button 1 with title "fill-ds160"' >/dev/null
  exit 1
fi

# Finder opens Terminal for .command files. Start the UI outside this window,
# then close the tab once it is idle so workers do not see extra Terminals.
/usr/bin/osascript - "$REPO" "$NODE" "$SERVER" "$LOG" "$CLOSER" <<'APPLESCRIPT'
on run argv
  set repo to item 1 of argv
  set nodeBin to item 2 of argv
  set server to item 3 of argv
  set logFile to item 4 of argv
  set closer to item 5 of argv

  my miniaturizeFillWindow()
  set cmd to "cd " & quoted form of repo & " && " & quoted form of nodeBin & " " & quoted form of server & " --open >> " & quoted form of logFile & " 2>&1 &"
  do shell script cmd
  my closeFillWindowLater(closer)
end run

on miniaturizeFillWindow()
  try
    tell application "Terminal"
      repeat with w in windows
        try
          if name of w contains "Fill DS-160" or name of w contains "fill-ds160" then set miniaturized of w to true
        end try
      end repeat
    end tell
  end try
end miniaturizeFillWindow

on closeFillWindowLater(closer)
  do shell script "(sleep 0.8; /usr/bin/osascript " & quoted form of closer & ") >/dev/null 2>&1 &"
end closeFillWindowLater
APPLESCRIPT

exit 0
