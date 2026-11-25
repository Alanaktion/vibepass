# AGENTS.md

Guide for coding agents (and people) working in this repo. Read this first, then
[docs/PLAN.md](docs/PLAN.md) for where the project is and what comes next.

## What Vibepass is

A fast, keyboard-first browser extension (Chrome and Firefox, Manifest V3) for **self-hosted
Bitwarden and Vaultwarden** servers. Users keep their existing server and vault; Vibepass gives
them a 1Password-style experience on top: quick find, inline autofill, and a calm item view.
Nothing to migrate.

The guiding decision (Alan, 2026-11-24): **a 1Password-like UX on a Bitwarden core.** Reuse
proven Bitwarden code wherever it does not limit the UX. In practice that means Bitwarden's
official SDK does the crypto, and everything the user touches (popup, search, autofill, inline
menu, message protocol) is ours.

## Status and long-term goals

The phased plan, milestones, and exit criteria live in [docs/PLAN.md](docs/PLAN.md). Keep its
status notes current when you finish a milestone.

| Phase            | Goal                                     | State (2026-11-25)                                            |
| ---------------- | ---------------------------------------- | ------------------------------------------------------------- |
| 0. Spike         | Log in, sync, decrypt a real vault       | Done on Vaultwarden; self-hosted Bitwarden still to verify    |
| 1. MVP           | Read-only daily driver                   | Built; Alan's 2-week daily-use trial is the exit gate         |
| 2. Write support | Save, update, edit, generate, organize   | **Next.** Gated on encrypt round-trips (see below)            |
| 3. Beta          | Quality, breadth, security for others    | Milestones 1-2 in basic form (inline menu, multi-step logins) |
| 4. v1            | Chrome Web Store and Firefox Add-ons     | Not started                                                   |
| Later            | Passkeys, cards/identities, Safari, etc. | Driven by beta feedback                                       |

Known gaps carried forward: a live check against self-hosted Bitwarden, Firefox live testing of
the Phase 1 features and inline menu, running the live check in CI, the notifications hub (sync
polls instead), WebAuthn and Duo two-step login, equivalent domains, and the autofill page corpus.

Rules that hold in every phase:

- **Read-only until proven.** No code path writes to a vault until encrypt/decrypt round-trips
  match the official clients. Phase 2 writes ship behind a setting until that gate is green, and
  must preserve cipher fields Vibepass doesn't understand, so editing never drops data.
- **Both servers, always.** Server-facing features are tested against Bitwarden and Vaultwarden.
- **Secrets stay in the worker** (see Security rules).
- **Budgets are tests.** Search under 100 ms on 5,000 items; unlock to filled form under 3 s.

## Architecture

Manifest V3, TypeScript, Preact, and
[webextension-polyfill](https://github.com/mozilla/webextension-polyfill) for a promise-based
`browser.*` API on both browsers. Licensed **GPL-3.0-only**, because it ships Bitwarden's GPL SDK.

```
src/
  background/  Service worker. Owns auth, sync, and the decrypted vault in memory.
    index.ts     Registers listeners (messages, alarms, commands)
    router.ts    Typed dispatch; always replies { ok, data | error }; rejects other extensions
    handlers.ts  One thin handler per message type
    service.ts   VaultService: owns the order of operations (login, unlock, sync, lock)
    autofill.ts  Fill on gesture: page check, URI match, send to the tab's top frame
    autolock.ts  Idle and system-lock auto-lock
    clipboard.ts Clears copied secrets after the timeout
  popup/       Preact UI: setup (with two-step login), lock, quick find, item view, settings
  content/     Content script: login field detection, filling, inline menu (menu.ts)
  offscreen/   Chrome-only offscreen document that writes the clipboard for the worker
  api/         Bitwarden server API client: prelogin, token login/refresh, sync
  crypto/      Thin wrapper over Bitwarden's SDK (WASM): KDF, user key, EncString
  storage/     Settings (storage.local), session key (storage.session), vault cache (IndexedDB)
  search/      MiniSearch quick find, current site first
  vault/       VaultState, decryption, URI matching (tldts / public suffix list), TOTP
  shared/      Message protocol, messaging helper, browser wrapper, errors, logger
scripts/
  build.mjs    One Vite build per entry point, then writes manifest.json per browser
  manifest.mjs Generates the Chrome and Firefox manifests
  dev/         Local Vaultwarden helpers: register, seed, live-check, inline-menu-check
tests/         Vitest (happy-dom) tests and fixtures
docs/          PLAN.md (phased plan) and adr/ (architecture decisions)
```

### Message passing

The popup and content scripts never hold the vault. They call `sendMessage()`
(`src/shared/messaging.ts`) with a typed message from `src/shared/messages.ts`, and the
background worker answers. To add a message:

1. Add it to `MessageMap` and `MESSAGE_TYPES` in `src/shared/messages.ts`.
2. Add a handler in `src/background/handlers.ts`. TypeScript flags a missing handler.
3. Keep the handler thin; put sequencing and state in `VaultService` (`src/background/service.ts`).

Errors the UI must react to (two-step login, re-prompt, fill mismatch, locked) are
`CodedError`s with an `ErrorCode` from `src/shared/errors.ts`. The router carries `code` and
`details` across the boundary, so `details` must never hold secrets.

### Crypto

Crypto comes from `@bitwarden/sdk-internal` (GPL-3.0), **pinned to an exact version**. Only its
stateless `PureCrypto` API is used, and only from inside `src/crypto/`; the rest of the code
imports `src/crypto` and never the SDK directly. Do not adopt the SDK's state, sync, or client
layers: they would dictate how the UI behaves. Two pieces stay on Web Crypto because `PureCrypto`
doesn't expose them (the master password hash and the HKDF stretch). Rationale and fallback plan
are in [docs/adr/0001-crypto-sdk.md](docs/adr/0001-crypto-sdk.md).

`src/crypto/sdk.ts` loads the `.wasm` on first use (copied to `dist/<browser>/sdk/` by the build),
because MV3 service workers allow neither dynamic `import()` nor top-level await. The CSP allows
`'wasm-unsafe-eval'` for this and nothing else beyond `'self'`.

SDK upgrades are deliberate: bump the pin, run the tests (which decrypt vaults written by the
official web vault, `tests/fixtures/official-*.json`), run the live check, and read the
`PureCrypto` changes.

### Build

`scripts/build.mjs` runs three Vite builds into `dist/<browser>/` because each entry needs a
different format: the popup is an HTML page, the background is one ES module, and the content
script is a classic IIFE. The manifest differs per browser only where it must (Chrome
`background.service_worker`, Firefox `background.scripts` and `browser_specific_settings.gecko`).
`__BROWSER__` is defined at build time for the few browser-specific branches.

## Security rules

These are not style preferences. A change that breaks one is a bug.

- Decrypted data and keys live only in background memory, and the unlocked user key in
  `storage.session`. Never plaintext in `storage.local`, IndexedDB, or logs.
- Popup and content scripts get decrypted values only on demand, for the one item the user acted
  on. The inline menu gets names and usernames, never secrets.
- Autofill happens only on a user gesture, only in the tab's top frame, and only for items saved
  for that site; anything else (mismatch, https item on an http page) asks first. Re-prompt items
  need the master password again.
- `no-console` is an error in `src/`. Use `log` from `src/shared/log.ts` with short static
  messages, and never pass it vault data, keys, or passwords.
- Keep permissions minimal. Host access to the server is requested at runtime via
  `optional_host_permissions`; `privacy` only when the user turns off the browser's password
  manager. Justify any new permission in the commit message.
- The refresh token is stored encrypted with the user key.
- Ask Alan before landing anything risky: changes to crypto, the write path, or permissions.

## How to code here

- **TypeScript, strict.** `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and
  `verbatimModuleSyntax` are on: use `import type` for types, and handle `undefined` from index
  access instead of asserting it away. ESLint is typescript-eslint `strictTypeChecked`;
  non-null assertions are allowed only in tests. Prefix intentionally unused names with `_`.
- **Formatting:** Prettier (single quotes, trailing commas, 100 columns), 2-space indent, LF.
  Run `npm run format` rather than hand-formatting.
- **UI:** Preact function components with hooks (`react-hooks` lint rules apply). Keyboard first:
  every action in the popup and inline menu must work without a mouse.
- **Dependencies:** pin exact versions (no `^` or `~`). Prefer no new runtime dependency; if one is
  bundled, add it to `THIRD_PARTY_NOTICES.md` with its license, and it must be GPL-3.0 compatible.
- **Comments:** explain why, not what. Short doc comments on exported types and functions, as in
  `src/shared/messages.ts`.
- **Write UI copy** in plain, calm words. Error messages say what happened and what to do.
- **Docs move with code.** Update `README.md` for user-visible behavior and `docs/PLAN.md` status
  notes when a milestone lands. Record significant decisions as a new `docs/adr/NNNN-*.md`.

## Tests and checks

Node 22.18 or newer (`.nvmrc`). Install with `npm ci`.

| Command             | What it does                                                      |
| ------------------- | ----------------------------------------------------------------- |
| `npm run check`     | Typecheck, lint, format check, and tests. Run before every commit |
| `npm run build`     | Builds `dist/chrome` and `dist/firefox` (CI runs this too)        |
| `npm test`          | Vitest only; `npx vitest run tests/<file>` for one file           |
| `npm run typecheck` | `tsc --noEmit`                                                    |
| `npm run lint`      | ESLint                                                            |
| `npm run format`    | Prettier, write mode                                              |
| `npm run dev`       | Watch build for Chrome (`dev:firefox` for Firefox)                |

CI (`.github/workflows/ci.yml`) runs `npm run check` and `npm run build` on every push to `main`
and every pull request.

Writing tests:

- Tests live in `tests/*.test.ts(x)`. `tests/setup.ts` replaces `webextension-polyfill` with an
  in-memory fake; `tests/setup-sdk.ts` loads the real SDK `.wasm` from `node_modules`.
- `tests/helpers.ts` has a fake Bitwarden server (two-step login, new-device verification,
  offline mode, revision bumps) and service builders. Use it rather than mocking `fetch` ad hoc.
- Crypto and decrypt tests run against vaults written by the official web vault
  (`tests/fixtures/official-*.json`). Never weaken them to make a change pass.
- KDF tests are slow by design (600k PBKDF2 rounds, Argon2id); the timeout is 20 s.

Live checks against a real server (need Docker and Playwright, which is not a project
dependency; Playwright is preinstalled in Claude cloud sessions). Start a local Vaultwarden, then:

```sh
node scripts/dev/register-account.mjs http://127.0.0.1:8000 live@example.test 'live test password'
node scripts/dev/seed-vault.mjs http://127.0.0.1:8000 live@example.test 'live test password' \
  http://127.0.0.1:8090/login            # --two-factor on a second account tests 2FA
npm run build:chrome
node scripts/dev/live-check.mjs http://127.0.0.1:8000 live@example.test 'live test password'
node scripts/dev/inline-menu-check.mjs http://127.0.0.1:8000 live@example.test 'live test password'
```

See the README for the full Docker command. Vaultwarden rate-limits logins (about 10 a minute),
so wait between repeated runs, and run with `NO_PROXY='*'` behind a proxy. Run the live checks
for changes to login, sync, unlock, autofill, or the inline menu.

## Workflow

- For now Alan wants changes pushed straight to `main` (no pull request), as long as
  `npm run check` and `npm run build` pass. Ask first for risky work (crypto, vault writes,
  permissions).
- Commit messages: a short, plain summary line in the imperative or as a feature name
  ("Rank current-site matches by most specific domain"), with a body for the why when it isn't
  obvious.
