# Vibepass

A fast, keyboard-first browser extension for **self-hosted Bitwarden and Vaultwarden** servers.
It uses your existing server and vault, with a 1Password-style experience: quick find, inline
autofill, and a calm item view. Nothing to migrate.

> **Status: Phase 1 (read-only daily driver).** Quick find, item details, TOTP codes, autofill
> for standard login forms, auto-lock, clipboard clearing, background sync, two-step login, and
> read-only organization items. It never writes to the vault; saving and editing come in
> Phase 2.

## Using it

- **Open:** Ctrl+Shift+Space (⌘⇧Space on macOS), or click the toolbar icon. Items saved for the
  current site are listed first.
- **In the list:** type to search (fuzzy, across names, usernames, websites, and notes). Up and
  Down move, Enter fills the selected login into the page, Shift+Enter or Right opens it.
  Ctrl+C copies the username, Ctrl+Shift+C the password, Ctrl+Alt+C the one-time password
  (⌘ on macOS).
- **Fill without the popup:** Ctrl+Shift+L (⌘⇧L) fills the best match for the page. If the
  vault is locked or nothing matches, the popup opens instead.
- Vibepass only fills on your gesture, only into the page's top frame, and only for items saved
  for that site. It asks before filling anything else, or an https login into an http page.
- Copied secrets are cleared from the clipboard after 30 seconds, and the vault locks after 15
  minutes idle or when your computer locks. Both are in Settings (gear icon).
- To stop the browser's own password manager from offering to save or fill passwords, turn on
  "Turn off the browser's built-in password manager" in Settings. Vibepass asks for the
  `privacy` permission only then. Browsers have no API for an extension to register as the
  password provider, so this is the closest equivalent (the official Bitwarden extension does
  the same).

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
    autofill.ts   Fill on gesture: page check, URI match, then send to the tab's top frame
    autolock.ts   Idle and system-lock auto-lock
    clipboard.ts  Clears copied secrets after the timeout (offscreen document in Chrome)
  popup/        Preact UI: setup (with two-step login), unlock, quick find, item view, settings
  offscreen/    Chrome-only offscreen document that writes the clipboard for the worker
  content/      Content script: login field detection and filling
  api/          Bitwarden server API client: prelogin, token login and refresh, sync
  crypto/       Thin wrapper over Bitwarden's SDK (WASM): KDF, user key, EncString
  storage/      Settings (storage.local), session key (storage.session), vault cache (IndexedDB)
  search/       MiniSearch quick find, current site first
  vault/        Vault state, decryption, URI matching (public suffix list), TOTP
  shared/       Message protocol, messaging helper, browser API wrapper, logger
scripts/
  build.mjs     Runs one Vite build per entry, then writes manifest.json
  manifest.mjs  Generates the per-browser manifest
  dev/          Local Vaultwarden helpers: register an account, seed a vault, live check
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

For a full live check of the built extension (needs Playwright, which isn't a project
dependency), seed a known vault and run the checks. Plain http on 127.0.0.1 is fine for this:

```sh
node scripts/dev/register-account.mjs http://127.0.0.1:8000 live@example.test 'live test password'
node scripts/dev/seed-vault.mjs http://127.0.0.1:8000 live@example.test 'live test password' \
  http://127.0.0.1:8090/login            # add --two-factor on a second account to test 2FA
npm run build:chrome
node scripts/dev/live-check.mjs http://127.0.0.1:8000 live@example.test 'live test password'
```

Vaultwarden rate-limits logins (10 a minute by default), so wait a minute between repeated runs.

The web vault needs HTTPS, so create a self-signed `ssl/cert.pem` and `ssl/key.pem` for
`localhost` first, and run Node with `NODE_EXTRA_CA_CERTS=ssl/cert.pem`.

## Roadmap

See [docs/PLAN.md](docs/PLAN.md) for the phased build plan. Phases 0 and 1 are done, with a
basic inline menu and multi-step logins pulled forward from Phase 3; next is **Phase 2 (write
support)**: save, update, edit, generate, and organize. Contributors and coding agents: start
with [AGENTS.md](AGENTS.md).

## License

GPL-3.0. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
