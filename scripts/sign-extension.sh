#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd -P)"
extension_dir="$repo_root/extension"
dist_dir="$repo_root/dist"

if [[ ! -f "$extension_dir/manifest.json" ]]; then
  echo "extension manifest not found: $extension_dir/manifest.json" >&2
  exit 1
fi

if [[ -z "${AMO_JWT_ISSUER:-}" ]]; then
  echo "AMO_JWT_ISSUER is required" >&2
  echo "create credentials at: https://addons.mozilla.org/developers/addon/api/key/" >&2
  exit 1
fi

if [[ -z "${AMO_JWT_SECRET:-}" ]]; then
  echo "AMO_JWT_SECRET is required" >&2
  echo "create credentials at: https://addons.mozilla.org/developers/addon/api/key/" >&2
  exit 1
fi

mkdir -p "$dist_dir"

npx --yes web-ext sign \
  --source-dir "$extension_dir" \
  --artifacts-dir "$dist_dir" \
  --channel unlisted \
  --api-key "$AMO_JWT_ISSUER" \
  --api-secret "$AMO_JWT_SECRET"
