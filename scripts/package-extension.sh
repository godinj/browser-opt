#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd -P)"
extension_dir="$repo_root/extension"
dist_dir="$repo_root/dist"

if [[ ! -f "$extension_dir/manifest.json" ]]; then
  echo "extension manifest not found: $extension_dir/manifest.json" >&2
  exit 1
fi

version="$(EXTENSION_DIR="$extension_dir" python3 -c 'import json, os, pathlib; print(json.loads((pathlib.Path(os.environ["EXTENSION_DIR"]) / "manifest.json").read_text())["version"])' 2>/dev/null || true)"
if [[ -z "$version" ]]; then
  echo "failed to read extension version from extension/manifest.json" >&2
  exit 1
fi

mkdir -p "$dist_dir"
artifact="$dist_dir/browser-opt-$version.xpi"
rm -f "$artifact"

(
  cd "$extension_dir"
  zip -r "$artifact" . -x "*.DS_Store"
)

echo "packaged extension: $artifact"
