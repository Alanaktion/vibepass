# Third-party notices

Vibepass bundles the following software in its built extension.

## Bitwarden SDK (`@bitwarden/sdk-internal`)

- License: GPL-3.0 (see `LICENSE`)
- Source: https://github.com/bitwarden/sdk-internal
- Use: key derivation and encryption (`src/crypto/`), shipped as `sdk/bitwarden_wasm_internal_bg.wasm`
  plus its JavaScript glue in `background.js`.

Bitwarden is a trademark of Bitwarden Inc. Vibepass is not affiliated with or endorsed by
Bitwarden Inc.

## Bitwarden clients and Map the Web (field detection)

- License: GPL-3.0 (see `LICENSE`)
- Sources: https://github.com/bitwarden/clients (`apps/browser/src/autofill`) and
  https://github.com/bitwarden/map-the-web
- Use: `src/content/fields.ts` adapts Bitwarden's autofill field keywords and qualification
  rules; `src/data/forms-map.json` is the login-related part of Map the Web's forms map,
  bundled in the content script.

## Apple password-manager-resources

- License: MIT. Copyright 2020 - 2026 Apple Inc. Permission is hereby granted, free of charge,
  to any person obtaining a copy of this software and associated documentation files (the
  "Software"), to deal in the Software without restriction, including without limitation the
  rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
  the Software, and to permit persons to whom the Software is furnished to do so, subject to
  the following conditions: The above copyright notice and this permission notice shall be
  included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS
  IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
  WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO
  EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
  CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
- Source: https://github.com/apple/password-manager-resources
- Use: `src/data/apple-password-rules.json` and `src/data/apple-shared-credentials.json`,
  bundled in the background worker.

## Preact, webextension-polyfill

- Licenses: MIT, MPL-2.0
- Bundled in the popup, background, and content scripts.

## MiniSearch, tldts

- Licenses: MIT, MIT
- Bundled in the background worker: MiniSearch for quick find, tldts (with the Public Suffix
  List, MPL-2.0 data) for registrable-domain matching.

## Lucide (`lucide-preact`)

- Licenses: ISC and MIT for icons derived from Feather (see `LICENSE-LUCIDE` in the extension build).
- Source: https://github.com/lucide-icons/lucide
- Bundled in the popup for action icons.
