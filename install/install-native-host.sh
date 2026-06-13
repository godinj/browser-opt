#!/usr/bin/env bash
set -euo pipefail

if [[ $# -gt 1 ]]; then
  echo "usage: $0 [path-to-browser-opt]" >&2
  exit 1
fi

BROWSER_OPT_INPUT="${1:-$(pwd)/target/release/browser-opt}"
BROWSER_OPT_DIR="$(cd "$(dirname "$BROWSER_OPT_INPUT")" && pwd -P)"
BROWSER_OPT_PATH="$BROWSER_OPT_DIR/$(basename "$BROWSER_OPT_INPUT")"
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

install_brew_cask() {
  local cask_name="$1"
  local app_path="$2"

  if [[ -e "$app_path" ]]; then
    echo "$cask_name already installed: $app_path"
    return
  fi

  if ! command -v brew >/dev/null 2>&1; then
    echo "could not install $cask_name: install Homebrew and rerun this script" >&2
    exit 1
  fi

  if ! brew tap | grep -qx "homebrew/cask"; then
    brew tap homebrew/cask
  fi

  echo "$cask_name not found; installing $cask_name"
  brew install --cask "$cask_name"
}

install_nerd_font() {
  local font_name="JetBrainsMono"
  local font_url="https://github.com/ryanoasis/nerd-fonts/releases/latest/download/${font_name}.zip"
  local font_dir

  case "$(uname -s)" in
    Darwin)
      font_dir="$HOME/Library/Fonts"
      ;;
    Linux)
      font_dir="$HOME/.local/share/fonts"
      ;;
    *)
      echo "unsupported OS: $(uname -s)" >&2
      exit 1
      ;;
  esac

  if compgen -G "$font_dir/JetBrainsMonoNerdFont*.ttf" >/dev/null; then
    echo "JetBrainsMono Nerd Font already installed in $font_dir"
    return
  fi

  echo "JetBrainsMono Nerd Font not found; installing to $font_dir"
  mkdir -p "$font_dir"

  local temp_dir
  temp_dir="$(mktemp -d)"
  trap 'rm -rf "$temp_dir"' RETURN

  curl -fsSL "$font_url" -o "$temp_dir/${font_name}.zip"
  unzip -q "$temp_dir/${font_name}.zip" -d "$temp_dir/$font_name"
  install -m 0644 "$temp_dir"/"$font_name"/*.ttf "$font_dir"/

  if command -v fc-cache >/dev/null 2>&1; then
    fc-cache -f "$font_dir" >/dev/null
  fi
}

install_firefox_alt_tab_remap() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    return
  fi

  install_command jq
  install_brew_cask karabiner-elements "/Applications/Karabiner-Elements.app"

  local karabiner_cli="/Library/Application Support/org.pqrs/Karabiner-Elements/bin/karabiner_cli"
  if [[ ! -x "$karabiner_cli" ]]; then
    echo "karabiner_cli not found after install: $karabiner_cli" >&2
    exit 1
  fi

  local config_dir="$HOME/.config/karabiner"
  local assets_dir="$config_dir/assets/complex_modifications"
  local config_path="$config_dir/karabiner.json"
  local rule_path="$assets_dir/browser-opt-firefox-alt-tab.json"
  mkdir -p "$assets_dir"

  cat > "$rule_path" <<'EOF'
{
  "title": "Browser Opt Firefox shortcuts",
  "rules": [
    {
      "description": "Firefox: use Option-Tab for native next/previous tab switching",
      "manipulators": [
        {
          "type": "basic",
          "from": {
            "key_code": "tab",
            "modifiers": {
              "mandatory": ["option", "shift"]
            }
          },
          "to": [
            {
              "key_code": "tab",
              "modifiers": ["control", "shift"]
            }
          ],
          "conditions": [
            {
              "type": "frontmost_application_if",
              "bundle_identifiers": ["^org\\.mozilla\\.firefox$"]
            }
          ]
        },
        {
          "type": "basic",
          "from": {
            "key_code": "tab",
            "modifiers": {
              "mandatory": ["option"]
            }
          },
          "to": [
            {
              "key_code": "tab",
              "modifiers": ["control"]
            }
          ],
          "conditions": [
            {
              "type": "frontmost_application_if",
              "bundle_identifiers": ["^org\\.mozilla\\.firefox$"]
            }
          ]
        }
      ]
    }
  ]
}
EOF

  if [[ ! -f "$config_path" ]]; then
    cat > "$config_path" <<'EOF'
{
  "global": {
    "ask_for_confirmation_before_quitting": true,
    "check_for_updates_on_startup": true,
    "show_in_menu_bar": true,
    "show_profile_name_in_menu_bar": false,
    "unsafe_ui": false
  },
  "profiles": [
    {
      "complex_modifications": {
        "parameters": {
          "basic.simultaneous_threshold_milliseconds": 50,
          "basic.to_delayed_action_delay_milliseconds": 500,
          "basic.to_if_alone_timeout_milliseconds": 1000,
          "basic.to_if_held_down_threshold_milliseconds": 500,
          "mouse_motion_to_scroll.speed": 100
        },
        "rules": []
      },
      "devices": [],
      "fn_function_keys": [],
      "name": "Default profile",
      "parameters": {
        "delay_milliseconds_before_open_device": 1000
      },
      "selected": true,
      "simple_modifications": [],
      "virtual_hid_keyboard": {
        "country_code": 0,
        "indicate_sticky_modifier_keys_state": true,
        "mouse_key_xy_scale": 100
      }
    }
  ]
}
EOF
  fi

  local temp_config
  temp_config="$(mktemp)"
  jq --slurpfile browser_opt_rule "$rule_path" '
    .profiles |= if length == 0 then [{"name":"Default profile","selected":true,"complex_modifications":{"rules":[]}}] else . end |
    (.profiles | map(.selected == true) | index(true)) as $selected_index |
    ($selected_index // 0) as $profile_index |
    .profiles[$profile_index].complex_modifications.rules = (
      ((.profiles[$profile_index].complex_modifications.rules // [])
        | map(select(.description != "Firefox: use Option-Tab for native next/previous tab switching")))
      + [$browser_opt_rule[0].rules[0]]
    )
  ' "$config_path" > "$temp_config"
  mv "$temp_config" "$config_path"

  "$karabiner_cli" --select-profile "$("$karabiner_cli" --show-current-profile-name 2>/dev/null || printf 'Default profile')" >/dev/null 2>&1 || true
  open -gja "Karabiner-Elements" || true

  echo "installed Karabiner complex modification: $rule_path"
  echo "enabled Firefox Option-Tab remap in Karabiner profile: $("$karabiner_cli" --show-current-profile-name 2>/dev/null || printf 'Default profile')"
  echo "if macOS prompts for Karabiner permissions, approve them in Privacy & Security"
}

install_login_startup() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    return
  fi

  local launch_agents_dir="$HOME/Library/LaunchAgents"
  local plist_path="$launch_agents_dir/local.godin.browser-opt.plist"

  mkdir -p "$launch_agents_dir"
  cat > "$plist_path" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>local.godin.browser-opt</string>
  <key>ProgramArguments</key>
  <array>
    <string>$BROWSER_OPT_PATH</string>
    <string>doctor</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/browser-opt-startup.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/browser-opt-startup.err</string>
</dict>
</plist>
EOF

  if launchctl print "gui/$(id -u)/local.godin.browser-opt" >/dev/null 2>&1; then
    launchctl bootout "gui/$(id -u)" "$plist_path" >/dev/null 2>&1 || true
  fi
  launchctl bootstrap "gui/$(id -u)" "$plist_path"
  launchctl kickstart -k "gui/$(id -u)/local.godin.browser-opt"

  echo "installed login startup agent: $plist_path"
}

install_command curl
install_command unzip
install_command ttyd
install_command tmux
install_nerd_font
install_firefox_alt_tab_remap
install_login_startup

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
"$BROWSER_OPT_PATH" install-native-host "$BROWSER_OPT_PATH"
