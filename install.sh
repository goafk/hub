#!/bin/sh
# afk installer — one line:
#   curl -fsSL https://goafk.dev/install.sh | sh
#
# Installs into ~/.afk (its own Node.js if yours is missing or too old), adds the `afk`
# command to ~/.local/bin, then runs `afk setup`: syncs Zed's agents, starts the hub, and
# shows a QR code to pair your phone. Nothing outside your home folder is touched.
#
# Environment overrides:
#   AFK_TARBALL   source tarball URL (default: the release below)
#   AFK_SOURCE    install from a local checkout instead (for development)
#   AFK_NO_SETUP  set to 1 to install without running setup
#   AFK_SETUP_ARGS extra flags for setup, e.g. "--no-lan"
set -eu

TARBALL_DEFAULT="https://github.com/goafk/hub/archive/refs/heads/main.tar.gz"
NODE_MIN="22.18.0"

say() { printf '%s\n' "$*"; }
step() { printf '\033[1m==>\033[0m %s\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "afk runs on macOS (it syncs the Zed app on your Mac)."

HOME_DIR="${AFK_HOME:-${ACP_SYNC_HOME:-$HOME/.afk}}"
SRC="$HOME_DIR/src"
BIN_DIR="$HOME/.local/bin"
mkdir -p "$HOME_DIR"

# --- Node.js ----------------------------------------------------------------------------------
node_ok() {
  "$1" -e "const [a,b]=process.versions.node.split('.').map(Number);const [x,y]='$NODE_MIN'.split('.').map(Number);process.exit(a>x||(a===x&&b>=y)?0:1)" 2>/dev/null
}
NODE=""
if [ -x "$HOME_DIR/runtime/node/bin/node" ] && node_ok "$HOME_DIR/runtime/node/bin/node"; then
  NODE="$HOME_DIR/runtime/node/bin/node"
elif command -v node >/dev/null 2>&1 && node_ok "$(command -v node)"; then
  NODE="$(command -v node)"
else
  case "$(uname -m)" in
    arm64) ARCH=arm64 ;;
    x86_64) ARCH=x64 ;;
    *) die "unsupported CPU $(uname -m)" ;;
  esac
  step "Downloading Node.js 22 (private copy in $HOME_DIR/runtime)"
  BASE="https://nodejs.org/dist/latest-v22.x"
  SUMS="$(curl -fsSL "$BASE/SHASUMS256.txt")" || die "could not reach nodejs.org"
  FILE="$(printf '%s\n' "$SUMS" | awk '{print $2}' | grep -E "^node-v22\.[0-9.]+-darwin-$ARCH\.tar\.gz$" | head -1)"
  [ -n "$FILE" ] || die "no Node.js 22 build for darwin-$ARCH"
  WANT="$(printf '%s\n' "$SUMS" | awk -v f="$FILE" '$2==f {print $1}')"
  TMP="$(mktemp -d)"
  curl -fsSL "$BASE/$FILE" -o "$TMP/$FILE" || die "Node.js download failed"
  GOT="$(shasum -a 256 "$TMP/$FILE" | awk '{print $1}')"
  [ "$GOT" = "$WANT" ] || die "Node.js checksum mismatch"
  rm -rf "$HOME_DIR/runtime/node" && mkdir -p "$HOME_DIR/runtime/node"
  tar -xzf "$TMP/$FILE" -C "$HOME_DIR/runtime/node" --strip-components=1
  rm -rf "$TMP"
  NODE="$HOME_DIR/runtime/node/bin/node"
fi
say "    Node.js $("$NODE" --version) ($NODE)"

# --- afk itself --------------------------------------------------------------------------
step "Installing afk into $SRC"
NEW="$HOME_DIR/src.new"
rm -rf "$NEW" && mkdir -p "$NEW"
SOURCE_DIR="${AFK_SOURCE:-${ACP_SYNC_SOURCE:-}}"
if [ -n "$SOURCE_DIR" ]; then
  [ -f "$SOURCE_DIR/src/cli.ts" ] || die "AFK_SOURCE=$SOURCE_DIR is not an afk checkout"
  (cd "$SOURCE_DIR" && tar -cf - --exclude ./node_modules --exclude ./.git --exclude ./test .) | tar -xf - -C "$NEW"
else
  URL="${AFK_TARBALL:-${ACP_SYNC_TARBALL:-$TARBALL_DEFAULT}}"
  TGZ="$(mktemp)"
  if ! curl -fsSL "$URL" -o "$TGZ" 2>/dev/null; then
    # Private repository: fetch it with your own GitHub access instead (SSH key, or `gh auth login`).
    CLONE="$(mktemp -d)"
    if [ -z "${AFK_TARBALL:-${ACP_SYNC_TARBALL:-}}" ] && command -v git >/dev/null 2>&1 \
      && GIT_SSH_COMMAND="ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new" git clone -q --depth 1 git@github.com:goafk/hub.git "$CLONE/hub-main" 2>/dev/null; then
      # Use the clone directly (no re-packing, which makes macOS tar complain about file metadata).
      rm -rf "$CLONE/hub-main/.git" "$CLONE/hub-main/test"
      cp -R "$CLONE/hub-main/." "$NEW/"
      FROM_CLONE=1
      say "    (downloaded with your GitHub SSH key)"
    elif [ -z "${AFK_TARBALL:-${ACP_SYNC_TARBALL:-}}" ] && command -v gh >/dev/null 2>&1 && gh api repos/goafk/hub/tarball/main > "$TGZ" 2>/dev/null; then
      say "    (downloaded with your GitHub login)"
    else
      rm -rf "$CLONE"
      die "could not download $URL — the repository is private: add your SSH key to GitHub (or run 'gh auth login'), then try again"
    fi
    rm -rf "$CLONE"
  fi
  if [ -z "${FROM_CLONE:-}" ]; then
    tar -xzf "$TGZ" -C "$NEW" --strip-components=1 --exclude '*/test' || die "the download is not a valid archive: $URL"
  fi
  rm -f "$TGZ"
fi
[ -f "$NEW/src/cli.ts" ] || die "the download does not look like afk"
rm -rf "$SRC" && mv "$NEW" "$SRC"

# --- the `afk` command -------------------------------------------------------------------
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/afk" <<EOF
#!/bin/sh
exec "$NODE" --no-warnings "$SRC/src/cli.ts" "\$@"
EOF
chmod +x "$BIN_DIR/afk"
say "    command: $BIN_DIR/afk"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say "    Add it to your PATH:  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc" ;;
esac

# --- setup ------------------------------------------------------------------------------------
if [ "${AFK_NO_SETUP:-${ACP_SYNC_NO_SETUP:-}}" = "1" ]; then
  say ""
  say "Installed. Run: afk setup"
  exit 0
fi
step "Running setup"
# shellcheck disable=SC2086
exec "$NODE" --no-warnings "$SRC/src/cli.ts" setup ${AFK_SETUP_ARGS:-${ACP_SYNC_SETUP_ARGS:-}}
