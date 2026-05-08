# Browser Opt

Browser Opt is a local-first Firefox tab archive and browser-search prototype.

It includes:

- `browser-opt`, a Rust CLI and Firefox native messaging host.
- A SQLite datastore with FTS5 search.
- A Firefox extension that captures tab snapshots, navigation events, and best-effort link-click source hints.
- Manual recurring tab sets opened from the CLI.

## Build

```bash
cargo build --release
```

## Install Native Host

```bash
./install/install-native-host.sh ./target/release/browser-opt
```

The installer installs `ttyd` and `tmux` if they are missing, then writes the Firefox native messaging manifest to the per-user Mozilla directory on Linux or macOS.

## Load Extension

1. Open `about:debugging#/runtime/this-firefox` in Firefox.
2. Click `Load Temporary Add-on...`.
3. Select `extension/manifest.json`.

## CLI Examples

```bash
browser-opt doctor
browser-opt search "sqlite firefox"
browser-opt fzf all
browser-opt fzf pages
browser-opt archive today
browser-opt archive list
browser-opt archive show 2026-05-07
browser-opt archive open 2026-05-07
browser-opt recurring create work
browser-opt recurring add work https://github.com
browser-opt recurring open work
```

Use `--db ./dev.sqlite` with any command to work against a development database.

## Web Terminal

When `browser-opt` starts, it also starts a local `ttyd` server in the background if one is not already listening on `127.0.0.1:7681`.

The web terminal runs:

```bash
tmux new-session -A -s browser-opt
```

Open `http://127.0.0.1:7681` to attach to the session.

The Firefox extension can also open or focus the terminal from the action search, or with `Ctrl+Shift+Period` / `Command+Shift+Period` on macOS.

## Data Location

By default the database is stored in the platform data directory for `browser-opt`:

- Linux: `~/.local/share/browser-opt/browser-opt.sqlite`
- macOS: `~/Library/Application Support/browser-opt/browser-opt.sqlite`

## Current Limitations

- Source-page capture is best effort. Normal clicked links are captured by the content script, but redirects, address-bar navigations, bookmarks, and some SPA behavior may not have a source URL.
- Duplicate avoidance relies on the last captured `current_tab` snapshot. If Firefox or the extension is not running, this state may be stale.
- The extension is loaded as a temporary add-on during development.
- Private browsing is not specially handled yet.
