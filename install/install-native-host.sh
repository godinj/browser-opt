#!/usr/bin/env bash
set -euo pipefail

if [[ $# -gt 1 ]]; then
  echo "usage: $0 [path-to-browser-opt]" >&2
  exit 1
fi

BROWSER_OPT_PATH="${1:-$(pwd)/target/release/browser-opt}"
if [[ ! -x "$BROWSER_OPT_PATH" ]]; then
  echo "browser-opt executable not found or not executable: $BROWSER_OPT_PATH" >&2
  echo "run: cargo build --release" >&2
  exit 1
fi

install_command() {
  local command_name="$1"

  if command -v "$command_name" >/dev/null 2>&1; then
    echo "$command_name already installed: $(command -v "$command_name")"
    return
  fi

  echo "$command_name not found; installing $command_name"
  if command -v brew >/dev/null 2>&1; then
    brew install "$command_name"
  elif command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update
    sudo apt-get install -y "$command_name"
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y "$command_name"
  elif command -v pacman >/dev/null 2>&1; then
    sudo pacman -S --needed "$command_name"
  else
    echo "could not install $command_name: install Homebrew, apt, dnf, or pacman and rerun this script" >&2
    exit 1
  fi
}

install_command ttyd
install_command tmux

case "$(uname -s)" in
  Darwin)
    HOST_DIR="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts"
    ;;
  Linux)
    HOST_DIR="$HOME/.mozilla/native-messaging-hosts"
    ;;
  *)
    echo "unsupported OS: $(uname -s)" >&2
    exit 1
    ;;
esac

mkdir -p "$HOST_DIR"
WRAPPER_PATH="$HOST_DIR/browser_opt_host"
cat > "$WRAPPER_PATH" <<EOF
#!/usr/bin/env bash
exec "$BROWSER_OPT_PATH" native-host
EOF
chmod +x "$WRAPPER_PATH"
sed "s#__BT_PATH__#$WRAPPER_PATH#g" "$(dirname "$0")/browser_opt.json.in" > "$HOST_DIR/browser_opt.json"
echo "installed native messaging host wrapper: $WRAPPER_PATH"
echo "installed native messaging host manifest: $HOST_DIR/browser_opt.json"
