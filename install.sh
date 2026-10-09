#!/usr/bin/env bash
# Installs or updates t3-glasses, then runs its guided setup.
#   curl -fsSL https://raw.githubusercontent.com/gerdums/t3-glasses/main/install.sh | bash
set -euo pipefail

REPO="${T3_GLASSES_REPO:-https://github.com/gerdums/t3-glasses.git}"
DIR="${T3_GLASSES_HOME:-$HOME/.t3-glasses}"
NODE_MAJOR=22

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
fail() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

bold "Installing T3 Glasses"

[[ "$(uname -s)" == "Darwin" ]] || fail "This installer supports macOS. On Linux, clone the repo and run: npm ci && npm run build && node packages/bridge/dist/cli.js setup"

if ! command -v brew >/dev/null 2>&1; then
  for candidate in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    [[ -x "$candidate" ]] && eval "$("$candidate" shellenv)" && break
  done
fi
command -v brew >/dev/null 2>&1 || fail "Homebrew is required. Install it from https://brew.sh, then run this again."

node_ok() {
  command -v node >/dev/null 2>&1 && [[ "$(node -p 'process.versions.node.split(".")[0]')" -ge $NODE_MAJOR ]]
}
if ! node_ok; then
  info "Installing Node.js..."
  brew install node >/dev/null
  node_ok || fail "Node.js $NODE_MAJOR or newer is required (found $(node -v 2>/dev/null || echo none))."
fi
info "Node.js $(node -v)"

if ! command -v tailscale >/dev/null 2>&1 && [[ ! -d /Applications/Tailscale.app ]]; then
  info "Installing Tailscale..."
  brew install --cask tailscale >/dev/null
  info "Open Tailscale from Applications and sign in. Setup will wait for it."
fi

if [[ -d "$DIR/.git" ]]; then
  info "Updating $DIR"
  git -C "$DIR" pull --ff-only --quiet
else
  info "Downloading to $DIR"
  git clone --quiet --depth 1 "$REPO" "$DIR"
fi

info "Building (about a minute)..."
(cd "$DIR" && npm ci --no-audit --no-fund --loglevel=error >/dev/null && npm run build --silent >/dev/null)

CLI="$DIR/packages/bridge/dist/cli.js"
chmod +x "$CLI"
BIN="$(brew --prefix)/bin"
ln -sf "$CLI" "$BIN/t3-glasses"
info "Installed the t3-glasses command in $BIN"

# Setup is interactive; read answers from the terminal even when piped from curl.
if { true </dev/tty; } 2>/dev/null; then
  node "$CLI" setup </dev/tty
else
  bold "Done. Run: t3-glasses setup"
fi
