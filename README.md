# Vibepass

A fast, keyboard-first browser extension for **self-hosted Bitwarden and Vaultwarden** servers.
It uses your existing server and vault, with a 1Password-style experience: quick find, inline
autofill, and a calm item view. Nothing to migrate.

> **Status: Phase 2 (write support), new.** Everything from Phase 1 (quick find, item details,
> TOTP codes, autofill, auto-lock, clipboard clearing, background sync, two-step login,
> organization items), plus creating, editing, and organizing items, a password generator, and
> saving logins from web pages. Editing is **off by default**: turn on "Let Vibepass edit my
> vault" in Settings. Until then Vibepass never writes to your vault.

## Using it

- **Open:** Ctrl+Shift+Space (⌘⇧Space on macOS), or click the toolbar icon. Items saved for the
  current site are listed first.
- **In the list:** type to search (fuzzy, across names, usernames, websites, and notes). Up and
  Down move, Enter fills the selected login into the page, Shift+Enter or Right opens it.
  Ctrl+C copies the username, Ctrl+Shift+C the password, Ctrl+Alt+C the one-time password
  (⌘ on macOS).
- **Inline suggestions:** type in a username field to narrow the menu by login name or username.
  From a password field, press Alt+Down or click “Search these logins” to filter inside the menu.
  Arrow keys move through the results. Enter fills the highlighted login and Escape closes the menu.
  Base-domain matching honors the enabled equivalent-domain groups from your server.
- **In an item:** click a masked value or focus it and press Enter or Space to copy it.
  Use the eye icon to reveal or hide it and the copy icon to copy a field.
- **Fill without the popup:** Ctrl+Shift+L (⌘⇧L) fills the best match for the page. If the
  vault is locked or nothing matches, the popup opens instead.
- Vibepass only fills on your gesture, only into the page's top frame, and only for items saved
  for that site. It asks before filling anything else, or an https login into an http page.
- Copied secrets are cleared from the clipboard after 30 seconds, and the vault locks after 15
  minutes idle or when your computer locks. Both are in Settings (gear icon).
- **Editing** (after turning it on in Settings): the + button starts a new login for the current
  site. In an item, the pencil (or E) edits it and the star favorites it; the folder menu and
  "Move to trash" are under the fields. In the editor, Ctrl+S (⌘S) saves and Escape cancels.
  If the item changed on another device since you opened it, Vibepass asks before saving over
  it. Folders and the trash (restore, or delete for good) are in Settings.
- **Generator:** the key button opens the password and passphrase generator. It remembers your
  options, and every password it makes is kept in an encrypted history, so a password used on a
  site but never saved isn't lost.
- **On web pages:** on a sign-up or change-password field, the inline menu offers "Use a strong
  password" (following the site's `passwordrules` when it has them). After you sign in, sign up,
  or change a password, a small banner offers to save the login or update the saved password.
  You can edit the name before saving, pick which login to update, or say "Never for this site".
- **Passkeys:** when a site asks to sign in with a passkey and your vault has one for it
  (saved by Vibepass or any Bitwarden client), Vibepass shows its own prompt: pick the passkey,
  or choose "Use another device or security key" to get the browser's usual sheet. With editing
  on, sites that make a new passkey get "Save a passkey for this site?", saved as a new login or
  onto a login you already have for the site. If Vibepass is locked it offers to unlock first.
  "Use passkeys saved in Vibepass" in Settings turns this off. Not yet: passkeys in the inline
  menu (sites that only offer them as autofill suggestions), cross-origin iframes, and items
  with master password re-prompt.
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
    service.ts    VaultService: order of operations for login, unlock, sync, and writes
    autofill.ts   Fill on gesture; the save and update banner's decisions
    autolock.ts   Idle and system-lock auto-lock
    clipboard.ts  Clears copied secrets after the timeout (offscreen document in Chrome)
  popup/        Preact UI: setup, unlock, quick find, item view, editor, generator, folders,
                trash, settings
  offscreen/    Chrome-only offscreen document that writes the clipboard for the worker
  content/      Content scripts: field detection, filling, inline menu, save banner, passkeys
  api/          Bitwarden server API client: login, sync, and cipher and folder writes
  crypto/       Thin wrapper over Bitwarden's SDK (WASM): KDF, keys, EncString, generator
  storage/      Settings (storage.local), session key (storage.session), vault cache (IndexedDB)
  search/       MiniSearch quick find, current site first
  vault/        Vault state, decryption, encryption, URI matching, TOTP
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

`scripts/build.mjs` runs one Vite build per entry point into `dist/<browser>/`, because each needs
a different output format: the popup is an HTML page, the background is a single ES module, and
the content scripts are classic IIFEs (content scripts can't be modules). Passkeys add two content
scripts that run at document start: `passkey.js` (the prompt) and `webauthn-page.js`, which runs
in the page's own world to stand in for `navigator.credentials`. The manifest differs per
browser only where it must: Chrome uses `background.service_worker`, Firefox uses
`background.scripts` and `browser_specific_settings.gecko`.

### Security notes

- Decrypted data and keys live only in background memory, and the unlocked key in
  `storage.session`. Never in `storage.local` or IndexedDB in plaintext.
- `no-console` is an error in `src/`; use `src/shared/log.ts`, and never log vault data.
- The background router rejects messages from other extensions.
- Remote servers require HTTPS. Local development can use HTTP on loopback. API requests reject redirects.
- Autofill confirmation applies to the displayed origin. An address saved without a scheme defaults to HTTPS.
- Opening a re-prompted item requires the master password. Its notes are excluded from search.
- Remembered two-step tokens are encrypted. Logging out forgets the current account's token.
- Website icons are opt-in. Enabling them sends the hostname of each displayed site to your vault server.
- Host access to the server is requested at runtime via `optional_host_permissions`.
- The extension CSP allows `'wasm-unsafe-eval'` for Bitwarden's SDK (WASM), and nothing else
  beyond `'self'`.
- The refresh token is stored encrypted with the user key, so it is useless while locked.
  Unlock works offline from the encrypted IndexedDB cache; sync then runs in the background.

### Crypto

Crypto comes from Bitwarden's official SDK, `@bitwarden/sdk-internal` (GPL-3.0), pinned to an
exact version. `src/crypto/sdk.ts` loads its `.wasm` (copied to `dist/<browser>/sdk/` by the
build) on first use, because MV3 service workers can't use dynamic imports or top-level await.
Only its stateless `PureCrypto` API is used, plus the SDK's password generator. See
[docs/adr/0001-crypto-sdk.md](docs/adr/0001-crypto-sdk.md) and
[docs/adr/0002-write-path.md](docs/adr/0002-write-path.md).

Tests check the wrapper against vaults written by the official Bitwarden web vault
(`tests/fixtures/official-*.json`, throwaway accounts on a local Vaultwarden). Writes are checked
the other way too: `tests/encrypt.test.ts` encrypts items in Vibepass and decrypts them with
Bitwarden's own cipher code (the SDK's `CiphersClient`, which the official clients use), and
reads items that code encrypted, for every field type.

### Local test server

```sh
docker run -d --name vw -e SIGNUPS_ALLOWED=true -e I_REALLY_WANT_VOLATILE_STORAGE=true \
  -e DOMAIN=https://localhost:8222 -v "$PWD/ssl:/ssl" \
  -e ROCKET_TLS='{certs="/ssl/cert.pem",key="/ssl/key.pem"}' -p 8222:80 vaultwarden/server
read -rs -p 'Test account password: ' VIBEPASS_TEST_PASSWORD
export VIBEPASS_TEST_PASSWORD
node scripts/dev/register-account.mjs https://localhost:8222 me@example.test argon2id
```

For a full live check of the built extension (needs Playwright, which isn't a project
dependency), seed a known vault and run the checks. Plain http on 127.0.0.1 is fine for this:

```sh
# Bash: enter the disposable account password without echo or command history.
read -rs -p 'Test account password: ' VIBEPASS_TEST_PASSWORD
export VIBEPASS_TEST_PASSWORD
# For --two-factor, set VIBEPASS_TEST_TOTP_FILE to a new file in a private directory.
node scripts/dev/register-account.mjs http://127.0.0.1:8000 live@example.test
node scripts/dev/seed-vault.mjs http://127.0.0.1:8000 live@example.test \
  http://127.0.0.1:8090/login            # add --two-factor on a second account to test 2FA
npm run build:chrome
node scripts/dev/live-check.mjs http://127.0.0.1:8000 live@example.test
node scripts/dev/inline-menu-check.mjs http://127.0.0.1:8000 live@example.test
node scripts/dev/write-check.mjs http://127.0.0.1:8000 live@example.test
node scripts/dev/passkey-check.mjs http://127.0.0.1:8000 live@example.test
```

`write-check.mjs` writes to the vault (create, edit, conflicts, folders, trash, the save banner)
and reads every write back with Bitwarden's own cipher code from a separate login.
`passkey-check.mjs` makes and uses passkeys on a local test site (localhost:8091) that verifies
them like a real one, and also writes. Run both only against a throwaway test server.

Vaultwarden rate-limits logins (10 a minute by default), so wait a minute between repeated runs.

The web vault needs HTTPS, so create a self-signed `ssl/cert.pem` and `ssl/key.pem` for
`localhost` first, and run Node with `NODE_EXTRA_CA_CERTS=ssl/cert.pem`.

## Roadmap

See [docs/PLAN.md](docs/PLAN.md) for the phased build plan. Phases 0 and 1 are done, with a
basic inline menu and multi-step logins pulled forward from Phase 3. **Phase 2 (write support)**
is built and in its trial: save, update, edit, generate, and organize, behind a setting. Basic
passkey support (sign in, and save with editing on) is pulled forward from "Later". Contributors and coding agents: start
with [AGENTS.md](AGENTS.md).

## Privacy, compatibility, and feedback

See the [privacy policy](docs/PRIVACY.md), [verified server coverage and review materials](docs/REVIEW.md),
and [private security reporting instructions](SECURITY.md). Use the repository’s compatibility
issue template for form or server problems.

## License

GPL-3.0. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
