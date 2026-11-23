#!/bin/zsh
# Downloads packages and Chromium. Does not open the app.
set -euo pipefail
SOURCE="$0"
while [[ -L "$SOURCE" ]]; do
  DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
done
REPO="$(cd "$(dirname "$SOURCE")" && pwd)"

trap 'echo; echo "Download failed. Press Return to close."; read -r _; exit 1' ERR

export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  # shellcheck disable=SC1091
  source "$HOME/.nvm/nvm.sh"
fi

NODE="$(command -v node || true)"
if [[ -z "$NODE" || ! -x "$NODE" ]]; then
  echo "Node.js was not found. Install Node 20 from https://nodejs.org"
  echo "Then double-click Download fill-ds160.command again."
  echo "Press Return to close."
  read -r _
  exit 1
fi

cd "$REPO"
if [[ ! -d node_modules ]]; then
  echo "Installing Node packages…"
  npm install
fi
echo "Downloading Chromium…"
npx playwright install chromium

trap - ERR
echo
echo "Download is ready."
echo "Open the app by double-clicking fill-ds160.command in this folder."
echo "Press Return to close."
read -r _
