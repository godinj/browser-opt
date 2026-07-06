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
./target/release/browser-opt install-native-host ./target/release/browser-opt
```

This writes the Firefox native messaging manifest to the per-user Mozilla directory on Linux or macOS. The manifest allows the Firefox extension ID `browser-opt@godin.local` to launch the local `browser-opt native-host` process.

For a full workstation setup, use the helper script:

```bash
./install/install-native-host.sh ./target/release/browser-opt
```

The helper installs `ttyd`, `tmux`, and JetBrainsMono Nerd Font if they are missing, then installs the native host manifest.

The native messaging host runs as a Docker service. Firefox launches a small local proxy wrapper from the native messaging manifest, and that proxy forwards messages to the Docker service on `127.0.0.1:8765`. The installer starts the service immediately and installs a login startup task that runs `docker compose up -d` for `docker-compose.yml`.

To start or stop the Docker service manually after installation:

```bash
~/.local/bin/browser-opt-docker-service up
~/.local/bin/browser-opt-docker-service down
```

By default the service mounts the normal Browser Opt data directory and Firefox profile directory. Override them with `BROWSER_OPT_DATA_DIR` or `BROWSER_OPT_FIREFOX_PROFILES` before running Docker Compose directly.

On macOS, the installer also installs and configures Karabiner-Elements so Firefox receives native tab-switching shortcuts from `Option+Tab` and `Option+Shift+Tab`. If macOS prompts for Karabiner permissions, approve them in `System Settings > Privacy & Security`.

## Package Extension

```bash
./scripts/package-extension.sh
```

This writes an unsigned development build to `dist/browser-opt-<version>.xpi`.

## Sign Extension

Regular Firefox requires signed XPIs for persistent installs. Create AMO API credentials at `https://addons.mozilla.org/developers/addon/api/key/`, then run:

```bash
AMO_JWT_ISSUER=... AMO_JWT_SECRET=... ./scripts/sign-extension.sh
```

This submits the extension for Mozilla unlisted signing and writes the signed XPI to `dist/`. Install that signed XPI from `about:addons` with `Install Add-on From File...`.

## Load Extension For Development

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

The web terminal starts your normal login shell in the project directory:

```bash
$SHELL -l
```

Open `http://127.0.0.1:7681` to attach to the session.

`ttyd` is configured to use JetBrainsMono Nerd Font so terminal icons render correctly, and keeps the browser title fixed as ` browser-opt` instead of using shell title updates.

The Firefox extension can also open or focus the terminal from the action search, or with `Ctrl+Shift+Period` / `Command+Shift+Period` on macOS.

## Data Location

By default the database is stored in the platform data directory for `browser-opt`:

- Linux: `~/.local/share/browser-opt/browser-opt.sqlite`
- macOS: `~/Library/Application Support/browser-opt/browser-opt.sqlite`

## Current Limitations

- Source-page capture is best effort. Normal clicked links are captured by the content script, but redirects, address-bar navigations, bookmarks, and some SPA behavior may not have a source URL.
- Duplicate avoidance relies on the last captured `current_tab` snapshot. If Firefox or the extension is not running, this state may be stale.
- Unsigned extension builds are for development. Persistent Firefox installs require Mozilla signing.
- Private browsing is not specially handled yet.
