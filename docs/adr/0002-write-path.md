# ADR 0002: The write path

- Status: accepted
- Date: 2026-11-25
- Deciders: Alan (asked for Phase 2 with live writes against a backed-up Vaultwarden)

## Context

Phase 2 lets Vibepass change the vault: create and edit items, organize folders, use the
server's trash, generate passwords, and save logins from web pages. A bad write can lose data in
a way a bad read can't, so the plan gates writes on round trips with the official clients and on
never dropping fields Vibepass doesn't understand. Bitwarden keeps adding fields (passkeys,
archive dates, bank accounts, driver's licenses, a sealed "blob" cipher format), and Vibepass
pins one SDK version, so whatever writes must not depend on knowing every field.

## Decision

1. **Our own serializer on `PureCrypto`, starting from the server's copy.** `src/vault/encrypt.ts`
   clones the cipher exactly as the server sent it, drops only fields the server computes (`id`,
   dates, permissions), and re-encrypts only the fields in an `ItemDraft` (name, notes, login,
   custom fields, folder, favorite, re-prompt). Everything else is sent back byte for byte, so a
   card's details, passkeys, attachments, and fields from newer clients survive an edit.
   - Existing items keep their per-item key; new items get one (as the official clients do).
   - Website checksums (`uriChecksum`) are computed like the official clients, which drop a
     website whose checksum doesn't match.
   - A changed password goes to the password history (newest first, 5 kept, as the official
     clients do), with `passwordRevisionDate`.
   - Attachments are sent back as the `attachments` and `attachments2` maps servers expect.
   - Items in the sealed blob format (`data` set, no field-level `name`) are refused, not guessed.
2. **Not the SDK's `CiphersClient.encrypt`.** It would need the SDK's stateful client holding our
   keys (ADR 0001 keeps those layers out), and it serializes only the fields the pinned SDK
   knows, so a newer server field would be dropped on save.
3. **The SDK's `CiphersClient` is the test oracle.** `tests/encrypt.test.ts` unlocks the SDK's
   client with the fixture account's keys and checks both directions: what Vibepass encrypts
   decrypts the same in Bitwarden's code, and what Bitwarden's code encrypts decrypts the same
   in Vibepass, for every field type. `scripts/dev/write-check.mjs` does the same against a real
   server. This is the Phase 2 gate, and it runs in CI with the rest of the tests.
4. **The SDK's generator.** Passwords and passphrases come from the SDK's `GeneratorClient`
   (same character sets and EFF word list as the official clients, plus its `passwordrules`
   parser). It is reached through a `PasswordManagerClient` that is never given keys, a token,
   or vault data, which keeps to the spirit of ADR 0001: no SDK state.
5. **Conflicts use the servers' own check.** Saves send `lastKnownRevisionDate`; both servers
   refuse a stale copy (with about a second of slack). The worker also refuses when a sync
   replaced the copy the editor started from. The popup then asks whether to save over the
   other device's change; "yes" syncs first and saves on top of the newest copy.
6. **State follows the server.** A write changes nothing locally until the server answers; the
   answer is applied to the encrypted cache and decrypted again, so the cache and the view never
   disagree and no full sync is needed.
7. **Behind a setting.** "Let Vibepass edit my vault" is off by default; every write path checks
   it in the worker, not just the UI.
8. **The save banner keeps the password in the worker.** The content script reads a submitted
   form only when the worker says saving is on, sends it once, and gets back a banner with names
   and usernames. The password waits in worker memory for 2 minutes, never on disk, and is
   dropped on lock. Only trusted clicks and keys on the banner save, and the worker checks the
   answer against the site and the logins it offered.
9. **Generator history is encrypted** with the user key in `storage.local` (20 entries), like
   the refresh token, and cleared on logout.

## Consequences

- An edit can't lose data Vibepass doesn't show, including fields that don't exist yet.
- Creating organization items and changing collections aren't supported yet (editing
  organization items the user may edit works, encrypted with the organization key).
- Cards, identities, and SSH keys can be renamed, noted, organized, and given custom fields;
  their own fields are kept but not editable yet.
- New items always get a per-item key. Servers too old to know per-item keys (before 2024)
  are not supported for writes.
- Self-hosted Bitwarden still needs a live run (its image couldn't be pulled in the build
  environment); the unit tests use Bitwarden's own client code, and Vaultwarden passed live.
