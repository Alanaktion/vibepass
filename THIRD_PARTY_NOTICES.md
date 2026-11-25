# Third-party notices

Vibepass bundles the following software in its built extension.

## Bitwarden SDK (`@bitwarden/sdk-internal`)

- License: GPL-3.0 (see `LICENSE`)
- Source: https://github.com/bitwarden/sdk-internal
- Use: key derivation and encryption (`src/crypto/`), shipped as `sdk/bitwarden_wasm_internal_bg.wasm`
  plus its JavaScript glue in `background.js`.

Bitwarden is a trademark of Bitwarden Inc. Vibepass is not affiliated with or endorsed by
Bitwarden Inc.

## Preact, webextension-polyfill

- Licenses: MIT, MPL-2.0
- Bundled in the popup, background, and content scripts.
