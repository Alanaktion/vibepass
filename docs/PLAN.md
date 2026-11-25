# Vibepass build plan

How we get from the current scaffold to a public v1, phase by phase. This follows the roadmap in
the project spec (Spike, MVP, Write support, Beta, v1, Later) and adds the concrete milestones and
exit criteria for each phase, based on what is already in the repo.

Last updated: 2026-11-25.

## Where we are

The scaffold (commit `c08dcb8`) gives us:

- Vite builds for Chrome and Firefox from one manifest generator (`scripts/manifest.mjs`), with
  minimal permissions, runtime-requested host access, and a CSP ready for Argon2 WASM.
- A background worker with a typed message router (`src/shared/messages.ts`,
  `src/background/router.ts`) that always answers with an `{ ok, data | error }` envelope.
- A Preact popup shell with setup, lock, and quick find screens.
- A content script that only counts password fields.
- Typed stubs for the API client, crypto (KDF, keys, EncString), session key store, IndexedDB
  vault cache, and a substring search placeholder.
- CI running typecheck, lint, format check, tests, and both builds.

Nothing talks to a real server yet, and no crypto is implemented.

## Guiding rules for every phase

- **Read-only until proven.** No code path writes to a vault until encrypt/decrypt round-trips
  match the official clients on recorded test vectors (Phase 2 gate).
- **Both servers, always.** Every server-facing feature is tested against current self-hosted
  Bitwarden and Vaultwarden before the phase exits.
- **Secrets stay in the worker.** Popup and content scripts get decrypted values only on demand,
  for the one item the user acted on. No plaintext in `storage.local`, IndexedDB, or logs.
- **Budgets are tests.** Search under 100 ms and unlock-to-fill under 3 s are measured in CI or a
  repeatable benchmark, not eyeballed.

## Phase overview

| Phase            | Goal                                            | Exit criteria (short)                                             |
| ---------------- | ----------------------------------------------- | ----------------------------------------------------------------- |
| 0. Spike         | Unlock and read a real vault                    | Real vault unlocks and is searchable on Bitwarden and Vaultwarden |
| 1. MVP           | A read-only daily driver                        | Alan uses it daily for 2 weeks without falling back               |
| 2. Write support | Full login lifecycle                            | Save, update, edit, generate, and organize without another client |
| 3. Beta          | Quality, breadth, and security for other people | 20+ beta users, no critical security findings                     |
| 4. v1            | Ship it                                         | Listed on the Chrome Web Store and Firefox Add-ons                |
| Later            | Features driven by beta feedback                | Prioritized backlog                                               |

Two workstreams run across all phases and start early because they take the longest to pay off:
the **autofill page corpus** and the **server compatibility suite** (see the end of this doc).

---

## Phase 0: Spike

**Goal:** prove we can authenticate, sync, and decrypt a real vault from self-hosted Bitwarden and
Vaultwarden, and show it in a read-only popup.

> **Status (2026-11-25): done on Vaultwarden; self-hosted Bitwarden still to verify.**
>
> - SDK checked and adopted, repo licensed GPL-3.0 ([ADR 0001](adr/0001-crypto-sdk.md)).
> - Crypto, API client, login, offline unlock, session restore, encrypted cache, and a read-only
>   popup are in. Tests decrypt vaults written by the official web vault (PBKDF2 and Argon2id).
> - Live check: the built extension in a real Chromium MV3 service worker logged in to a local
>   Vaultwarden 1.37.5, synced, searched, locked, rejected a wrong password, unlocked, survived a
>   forced worker restart, and logged out. Login plus sync took about 0.8 s; unlock 0.3 to 0.8 s.
> - Not yet verified: self-hosted Bitwarden (its image could not be pulled in the build
>   environment), Firefox in a live browser, and two-step login (shows a clear error for now).
>   These carry into Phase 1, along with running the local-server check in CI.

### Decisions to make first

**Decided (2026-11-24): reuse Bitwarden's SDK for crypto.** The goal is a 1Password-like
experience on the Bitwarden core, so reusing proven code is preferred wherever it does not limit
the UX. The SDK sits behind `src/crypto/` (and, where it helps, parts of `src/api/`) as an
implementation detail; the UI, search, autofill engine, and message protocol stay ours.

1. **Confirm the SDK can be used.** Before writing code against it, check which Bitwarden SDK
   package fits (the internal client SDK vs. the public one), its license terms for a
   third-party client, and whether it builds for the browser as WASM. If the license or
   packaging rules it out, fall back to reimplementing crypto against test vectors. Record the
   outcome in `docs/adr/0001-crypto-sdk.md`.
2. **Fit it to MV3.** Confirm the WASM loads under our CSP (`'wasm-unsafe-eval'` only), in the
   Chrome service worker and Firefox background script, and measure bundle size and init time
   against the 3 s unlock-to-fill budget. If the SDK covers Argon2id, no separate Argon2 package
   is needed.
3. **Keep the UX unconstrained.** Use the SDK for key derivation, EncString encrypt/decrypt, and
   key management. Do not adopt its state or sync layers if they would dictate how the popup,
   search, or autofill behave.
4. **License** for the repo, chosen to be compatible with the SDK's terms.

### Milestones

1. **Test harness.** Docker Compose for local Bitwarden (self-hosted) and Vaultwarden, seeded
   with a test account and a known vault. Test vectors exported from the official clients under
   `tests/crypto/vectors/`.
2. **Crypto core** (`src/crypto/`): a thin wrapper over the SDK for PBKDF2-SHA256 and Argon2id
   master key derivation, key stretching, EncString decrypt, user key unwrapping, and
   organization key decrypt. Our own tests still check the wrapper against official-client
   vectors, so an SDK upgrade that changes behavior fails CI.
3. **API client** (`src/api/`): prelogin, token login (password grant), refresh, sync, and a
   clear error for 2FA challenges (full 2FA UI comes in Phase 1).
4. **Unlock flow** in the worker: setup screen saves server URL and email, requests host
   permission, logs in, syncs, decrypts summaries into `VaultState`, and stores the user key in
   `storage.session` so a worker restart does not re-lock.
5. **Encrypted cache:** the raw sync response in IndexedDB, so a locked extension can unlock
   offline with the master password.
6. **Read-only popup:** list and search decrypted names, usernames, and URIs.

### Exit criteria

- A real vault unlocks on both current self-hosted Bitwarden and Vaultwarden, with PBKDF2 and
  Argon2id accounts.
- Crypto tests pass against official-client vectors in CI.
- Item counts and decrypted names match the official web vault for the seeded test vault.
- Lock clears every decrypted value and the session key.

---

## Phase 1: MVP

**Goal:** a read-only extension good enough to replace the official one for daily logins.

### Milestones

1. **Quick find.** Replace the substring placeholder with MiniSearch (fuzzy on name, username,
   URL, notes). Current-site matches first, ranked by registrable-domain match quality. Keyboard
   model: shortcut opens, arrows move, Enter fills, chords copy username, password, and TOTP.
   Benchmark under 100 ms on a 5,000-item vault.
2. **Item detail view.** Large title, favicon, labeled fields with copy and reveal, website links,
   notes, custom fields, and attachment download. Sensitive fields masked by default.
3. **TOTP.** Generate codes with a countdown; copy or fill on request.
4. **Autofill v1** for standard single-page logins: field detection heuristics in the content
   script, fill on user gesture only (popup Enter or keyboard shortcut), matching by registrable
   domain and port, refusing cross-origin iframes. Secrets go to the content script only at fill
   time.
5. **Auto-lock and clipboard.** Lock on idle (`chrome.idle` / alarms), browser close, and system
   lock. Clear the clipboard after the configured timeout.
6. **Sync.** Background sync on unlock and on an interval, with a manual refresh. Live updates
   via the notifications hub where available, falling back to polling. Visible state only on
   error.
7. **Login challenges.** UI for 2FA (authenticator, email, and others the servers support) and
   new-device verification.
8. **Organizations, read-only.** Decrypt and show organization items and collections.

### Exit criteria

- Alan uses Vibepass as the only extension for 2 weeks without falling back.
- Unlock to filled form under 3 seconds on a real login page.
- Autofill works on the top 50 sites in the corpus that use standard login forms.
- Auto-lock and clipboard clearing verified by tests.

---

## Phase 2: Write support

**Goal:** manage the full login lifecycle without opening another client.

### Gate before any write

Encrypt round-trips (encrypt in Vibepass, decrypt in the official clients, and the reverse) pass
for every field type on both servers, using throwaway test vaults. Writes ship behind a setting
until this gate is green in CI.

### Milestones

1. **Encrypt path.** EncString encrypt, cipher serialization that preserves fields we do not
   understand yet (so editing never drops data), and the cipher create/update/delete endpoints.
2. **Save and update banner.** Detect form submit, offer a non-modal "Save" or "Update password"
   banner, let the user pick the item and edit the name before saving.
3. **Edit mode** in the item view: explicit edit, validation, conflict handling when the server
   copy changed since sync (revision date check).
4. **Generator.** Password and passphrase options, remembering last-used settings, available
   inline on password fields and in the popup. Generated passwords are kept in history until
   saved, so a failed save never loses one.
5. **Folders.** Create, rename, move items, delete.
6. **Soft delete and restore** using the server's trash.

### Exit criteria

- Create, save from a form, update a password, edit, move to a folder, and delete all work on
  both servers, and the official web vault shows the same result.
- No data loss on fields Vibepass does not edit (verified by round-trip tests).
- Alan completes the full lifecycle for 2 weeks without another client.

---

## Phase 3: Beta

**Goal:** make it good and safe enough for other people.

### Milestones

1. **Inline menu.** A suggestion menu anchored to login fields, rendered in a closed shadow DOM,
   keyboard accessible, positioned correctly in scrolled and transformed layouts.
2. **More form types.** Multi-step logins (username then password), split logins, signup forms
   (with generator), and password-change forms (with update banner).
3. **Per-site overrides** for sites the heuristics get wrong, shipped as data, not code.
4. **Firefox parity.** The build exists today; this milestone covers full feature and test
   parity, including Firefox-specific shadow DOM, idle, and session storage behavior.
5. **Permissions review.** Revisit the always-on content script on all sites against the minimal
   permission goal, and document why each permission is needed for store review.
6. **Security review.** Threat model doc, dependency audit and pinning, reproducible builds, then
   a third-party review. Fix all critical and high findings.
7. **Beta program.** Signed beta builds, a feedback channel, and opt-in crash reports with no
   vault data (still no telemetry by default).

### Exit criteria

- Closed beta with 20+ users across both servers and both browsers.
- Third-party security review complete with no open critical findings.
- Autofill succeeds on 90% or more of the corpus, including multi-step and signup forms.

---

## Phase 4: v1

**Goal:** public release on the Chrome Web Store and Firefox Add-ons.

### Milestones

1. **Onboarding.** First-run flow: server URL, permission request explained in plain words,
   login, and a short tour of the shortcut and inline menu.
2. **Docs.** User guide, supported server versions, privacy policy, and security disclosure
   policy.
3. **Store packaging.** Listings, screenshots, permission justifications, and a release pipeline
   that builds, signs, and uploads from a tagged commit.
4. **Support process.** Issue templates, a compatibility matrix that the compatibility suite
   keeps current, and a policy for supported server versions.

### Exit criteria

- Public listing live on both stores.
- Release builds are reproducible from a tag.
- Supported server versions are documented and tested in CI.

---

## Later

Prioritized from beta feedback. Candidates from the spec:

- Passkeys (FIDO2 credentials), feature-detected by server version.
- Cards and identities, with autofill for payment and address forms.
- Biometric or passkey unlock.
- Attachment upload.
- Edge (likely little work beyond the Chrome build) and Safari (a larger port; decide whether to
  support it at all).
- Breach and weak-password alerts.

---

## Cross-cutting workstreams

### Autofill page corpus

Start in Phase 0, because autofill quality is the main reason to switch. Save real login, signup,
and password-change pages as static fixtures (sanitized, no personal data), with expected field
labels. Run the detector against the corpus in CI and track the pass rate per phase.

### Server compatibility suite

Start in Phase 0 with the Docker test harness. Run the API and crypto round-trip tests against
pinned versions of self-hosted Bitwarden and Vaultwarden, plus the latest release on a schedule,
so API changes show up before users report them.

### Performance budgets

Add a benchmark in Phase 1 for search latency and unlock-to-fill time, and fail CI when either
budget regresses.

## Risks to watch

| Risk                          | Where it bites | Mitigation                                                        |
| ----------------------------- | -------------- | ----------------------------------------------------------------- |
| Crypto bugs                   | Phases 0 and 2 | Test vectors, read-only first, write gate, round-trip tests       |
| Autofill quality              | Phases 1 and 3 | Corpus from Phase 0, per-site overrides, track pass rate          |
| Server API drift              | Every phase    | Compatibility suite, pinned supported versions, feature detection |
| MV3 worker lifetime           | Phases 0 and 1 | Session key in `storage.session`, encrypted IndexedDB cache       |
| Store review of password apps | Phase 4        | Minimal permissions, clear justifications, early test submission  |

## Open questions

- Which SDK package and whether its license allows a third-party client (check first in Phase 0).
- Project license (decide in Phase 0).
- Free or paid.
- Whether to support Safari, and how much to invest in passkeys.
