#!/usr/bin/env bash
set -euo pipefail

if [[ $# -gt 1 ]]; then
  echo "usage: $0 [path-to-bt]" >&2
  exit 1
fi

BT_PATH="${1:-$(pwd)/target/release/bt}"
if [[ ! -x "$BT_PATH" ]]; then
  echo "bt executable not found or not executable: $BT_PATH" >&2
  echo "run: cargo build --release" >&2
  exit 1
fi

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
sed "s#__BT_PATH__#$BT_PATH#g" "$(dirname "$0")/browser_opt.json.in" > "$HOST_DIR/browser_opt.json"
echo "installed native messaging host manifest: $HOST_DIR/browser_opt.json"
