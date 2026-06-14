---
name: extension-release
description: Use when doing a formal release of the first-class Firefox extension, signing the extension, running the Sign Extension GitHub Actions workflow, or preparing an installable XPI; do not use for temporary debug-extension iteration.
---

# Formal Extension Release

Use this skill when the user asks to release, sign, rebuild for install, publish, or update the first-class Firefox extension.

Do not use this skill for quick debug-extension iteration through `about:debugging`, temporary extension loading, or local-only source edits that do not need a signed XPI.

## Release Policy

- Formal releases must use the first-class extension path, not the debug-extension path.
- AMO signing happens in GitHub Actions because the AMO API credentials live in repository secrets.
- Never ask the user to paste AMO secrets locally if they already say the secrets are stored in GitHub Actions.
- AMO rejects reused extension versions, so bump `extension/manifest.json` before signing if the current version was already submitted.
- Commit and push only when the user explicitly approves publishing release changes.
- After editing this skill or any OpenCode config-time file, tell the user to quit and restart OpenCode for the skill change to take effect.

## Repository Files

- Extension source: `extension/`
- Manifest version: `extension/manifest.json`
- Local package script: `scripts/package-extension.sh`
- Local signing wrapper: `scripts/sign-extension.sh`
- GitHub signing workflow: `.github/workflows/sign-extension.yml`
- Local artifacts: `dist/`
- Downloaded signed artifacts: prefer `dist/signed/`

## Required Checks

Before committing a release change, run:

```bash
node --check extension/src/background.js
python3 -m json.tool extension/manifest.json >/dev/null
```

If only non-background JavaScript changed, still run the closest available syntax or manifest validation. If no suitable automated check exists, state that clearly.

## Versioning

1. Read `extension/manifest.json`.
2. If signing through AMO and the current version has already been submitted, bump the patch version.
3. Keep the version change in the same release commit if it belongs to the release fix, or in a separate concise commit if it is only to satisfy AMO uniqueness.

Use normal semantic patch increments for small fixes, for example `0.1.1` to `0.1.2`.

## Local Package

Build an unsigned local package with:

```bash
./scripts/package-extension.sh
```

This writes `dist/browser-opt-<version>.xpi`. Treat this as an unsigned package unless it came back from the GitHub signing workflow or AMO.

## Formal Signing Flow

1. Inspect git state:

```bash
git status --short
git diff -- extension .github/workflows scripts
git log --oneline -10
```

2. Validate the extension:

```bash
node --check extension/src/background.js
python3 -m json.tool extension/manifest.json >/dev/null
```

3. Commit only the intended files after user approval:

```bash
git add <intended-files>
git commit -m "Concise release message"
```

4. Push the release commit:

```bash
git push origin master
```

5. Trigger GitHub Actions signing:

```bash
gh workflow run "Sign Extension" --ref master
```

6. Watch the run:

```bash
gh run watch <run-id> --exit-status
```

7. If the run succeeds, download artifacts to a separate signed directory:

```bash
mkdir -p dist/signed
gh run download <run-id> --name browser-opt-extension --dir dist/signed
```

8. Report the run URL and signed artifact paths.

## Common Failure

If signing fails with:

```text
Version <version> already exists.
```

Then:

1. Bump `extension/manifest.json` to a new patch version.
2. Validate JSON and JavaScript.
3. Commit and push the version bump.
4. Rerun `Sign Extension`.

## Debug Iteration Boundary

For debug iteration only:

- Do not run the formal signing workflow.
- Do not bump the manifest version solely for debug testing.
- Use Firefox debug reload paths such as `about:debugging#/runtime/this-firefox` if the user is explicitly testing a temporary extension.

For first-class installed extension release:

- Use signed artifacts from GitHub Actions.
- Bump version as needed for AMO.
- Install/update from the signed `.xpi`, not from a temporary debug load.
