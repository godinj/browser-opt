# Agent Instructions

- Do not create new first-class Firefox extension versions unless the user explicitly asks for a formal release, signing, publishing, or an installable signed XPI.
- Do not bump `extension/manifest.json` for normal debugging, implementation, or local testing.
- Do not trigger the `Sign Extension` GitHub Actions workflow unless the user explicitly asks to sign or release the extension.
- Use the `extension-release` skill only when the user explicitly asks for a formal release, signing, publishing, or a first-class installable XPI.
- For ordinary extension fixes, make the code change and validate it locally without packaging/signing unless asked otherwise.
