# Vibepass

A fast, keyboard-first browser extension for **self-hosted Bitwarden and Vaultwarden** servers.
It uses your existing server and vault, with a 1Password-style experience: quick find, inline
autofill, and a calm item view. Nothing to migrate.

> **Status: Phase 0 (read-only).** Vibepass can log in to a self-hosted server, sync, decrypt,
> and search your vault, read-only. It never writes to the vault. Autofill, item details, and
> two-step login come in Phase 1. Test it with a throwaway account first.

## Requirements

- Node.js 22.18 or newer (`.nvmrc` pins 22)
- Chrome 116+ or Firefox 128+

## Getting started

```sh
npm install
npm run build          # builds dist/chrome and dist/firefox
```

Load the unpacked extension:

- **Chrome:** open `chrome://extensions`, turn on Developer mode, choose **Load unpacked**, and
  select `dist/chrome`.
- **Firefox:** open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and
  select `dist/firefox/manifest.json`.

For development, `npm run dev` (Chrome) or `npm run dev:firefox` rebuilds on change. Reload the
extension from the browser's extensions page to pick up changes.

## Scripts

| Script                  | What it does                                         |
| ----------------------- | ---------------------------------------------------- |
| `npm run build`         | Production build for Chrome and Firefox              |
| `npm run build:chrome`  | Production build for Chrome only                     |
| `npm run build:firefox` | Production build for Firefox only                    |
| `npm run dev`           | Watch build for Chrome (`dev:firefox` for Firefox)   |
| `npm run typecheck`     | TypeScript, no emit                                  |
| `npm run lint`          | ESLint (typescript-eslint strict, type-checked)      |
| `npm run format`        | Prettier                                             |
| `npm test`              | Vitest (happy-dom)                                   |
| `npm run check`         | Typecheck, lint, format check, and tests, as CI runs |

## Architecture

Manifest V3, TypeScript, and Preact, with
[webextension-polyfill](https://github.com/mozilla/webextension-polyfill) for a promise-based
`browser.*` API on both browsers.

```
src/
  background/   Service worker: owns auth, sync, and the decrypted vault in memory
    index.ts      Registers listeners (messages, alarms, commands)
    router.ts     Typed message dispatch; always replies with an { ok, data | error } envelope
    handlers.ts   One handler per message type
  popup/        Preact UI: setup, unlock, and quick find in one surface
  content/      Content script: form detection and (later) the inline autofill menu
  api/          Bitwarden server API client: prelogin, token login and refresh, sync
  crypto/       Thin wrapper over Bitwarden's SDK (WASM): KDF, user key, EncString
  storage/      Settings (storage.local), session key (storage.session), vault cache (IndexedDB)
  search/       In-memory search index (substring placeholder; MiniSearch planned)
  vault/        In-memory vault state and decrypted view models
  shared/       Message protocol, messaging helper, browser API wrapper, logger
scripts/
  build.mjs     Runs one Vite build per entry, then writes manifest.json
  manifest.mjs  Generates the per-browser manifest
tests/          Vitest tests
```

### Message passing

The popup and content scripts never hold the vault. They send typed messages (see
`src/shared/messages.ts`) with `sendMessage()` from `src/shared/messaging.ts`, and the background
worker answers. To add a message, add it to `MessageMap` and `MESSAGE_TYPES`, then add a handler
in `src/background/handlers.ts`; TypeScript will flag a missing handler.

### Build

`scripts/build.mjs` runs three Vite builds into `dist/<browser>/`, because each entry point needs a
different output format: the popup is an HTML page, the background is a single ES module, and the
content script is a classic IIFE (content scripts can't be modules). The manifest differs per
browser only where it must: Chrome uses `background.service_worker`, Firefox uses
`background.scripts` and `browser_specific_settings.gecko`.

### Security notes

- Decrypted data and keys live only in background memory, and the unlocked key in
  `storage.session`. Never in `storage.local` or IndexedDB in plaintext.
- `no-console` is an error in `src/`; use `src/shared/log.ts`, and never log vault data.
- The background router rejects messages from other extensions.
- Host access to the server is requested at runtime via `optional_host_permissions`.
- The extension CSP allows `'wasm-unsafe-eval'` for Bitwarden's SDK (WASM), and nothing else
  beyond `'self'`.
- The refresh token is stored encrypted with the user key, so it is useless while locked.
  Unlock works offline from the encrypted IndexedDB cache; sync then runs in the background.

### Crypto

Crypto comes from Bitwarden's official SDK, `@bitwarden/sdk-internal` (GPL-3.0), pinned to an
exact version. `src/crypto/sdk.ts` loads its `.wasm` (copied to `dist/<browser>/sdk/` by the
build) on first use, because MV3 service workers can't use dynamic imports or top-level await.
Only its stateless `PureCrypto` API is used. See
[docs/adr/0001-crypto-sdk.md](docs/adr/0001-crypto-sdk.md).

Tests check the wrapper against vaults written by the official Bitwarden web vault
(`tests/fixtures/official-*.json`, throwaway accounts on a local Vaultwarden).

### Local test server

```sh
docker run -d --name vw -e SIGNUPS_ALLOWED=true -e I_REALLY_WANT_VOLATILE_STORAGE=true \
  -e DOMAIN=https://localhost:8222 -v "$PWD/ssl:/ssl" \
  -e ROCKET_TLS='{certs="/ssl/cert.pem",key="/ssl/key.pem"}' -p 8222:80 vaultwarden/server
node scripts/dev/register-account.mjs https://localhost:8222 me@example.test 'a long test password' argon2id
```

The web vault needs HTTPS, so create a self-signed `ssl/cert.pem` and `ssl/key.pem` for
`localhost` first, and run Node with `NODE_EXTRA_CA_CERTS=ssl/cert.pem`.

## Roadmap

See [docs/PLAN.md](docs/PLAN.md) for the phased build plan. Phase 0 is done; next is
**Phase 1 (MVP)**: quick find, item view, TOTP, autofill, auto-lock, and two-step login.

## License

GPL-3.0. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
