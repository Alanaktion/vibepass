# ADR 0005: PIN unlock now, biometric unlock later

Date: 2026-11-28. Status: accepted. PIN built; biometrics built for Chrome and Edge.

## Context

Alan asked for PIN unlock, with the PIN optionally answering items that have master password
re-prompt, and asked whether biometric unlock can work in every browser. Bitwarden's browser
extension does biometrics by talking to its desktop app over native messaging, which never
worked for him on Firefox on macOS.

## Decision: PIN

- **Same construction as Bitwarden.** The PIN goes through the account's own KDF, salted with
  the email, and the stretched key wraps the user key. That is exactly what the SDK's
  `PureCrypto.encrypt_user_key_with_master_password` does, so we call it with the PIN and add no
  crypto of our own (`src/crypto/keys.ts`). `tests/pin.test.ts` checks the result opens with
  the master-key derivation used at login. Bitwarden's newer `PasswordProtectedKeyEnvelope` is
  only reachable through the SDK's stateful clients, which ADR 0001 rules out.
- **The PIN is kept encrypted with the user key** (Bitwarden's `userKeyEncryptedPin`), so after a
  master password unlock the worker can wrap the user key with the PIN again without asking.
- **Memory only by default.** The PIN-wrapped key lives in `storage.session` and is gone after a
  browser restart, matching Bitwarden's default "lock with master password on restart". The
  user can keep it in `storage.local` instead; then a 4-digit PIN is only as strong as the KDF
  against someone who copies the profile. The settings copy and README say so.
- **Five tries.** Each attempt is counted and saved before the KDF runs, so parallel guesses
  and restarts don't reset it. After five wrong PINs the PIN-wrapped key is deleted; the next
  master password unlock (or master password re-prompt) restores it. Bitwarden logs out
  instead; deleting the key gives the same protection without losing the session's setup.
- **Re-prompt.** Off by default. When on, the worker compares the PIN with the decrypted stored
  PIN (constant time, no KDF needed while unlocked) and grants the popup session as a master
  password would. Wrong PINs share the five-try count; once used up, re-prompt asks for the
  master password again. This is weaker than Bitwarden, which never accepts a PIN for
  re-prompt: re-prompt guards against someone at an unlocked computer, and a PIN is easier to
  watch someone type. It is Alan's call to offer it, so it is opt-in.

## Biometrics: findings (2026-11-28)

The route that avoids a desktop app is WebAuthn with the PRF extension: register a passkey on
the platform authenticator (Touch ID, Windows Hello, or the browser's own passkey store) from
an extension page, and use the PRF output to wrap the user key, the same way the PIN does.

- **Chrome and Edge:** extension pages can call WebAuthn with their own `chrome-extension://`
  origin. PRF works with iCloud Keychain on macOS 15+ (Chrome 132+), with Google Password
  Manager passkeys, and with Windows Hello on Windows 11 24H2/25H2 after the February 2026
  update (Chrome/Edge 147+ for PRF at creation). Likely to work; needs a real-device check.
- **Firefox:** PRF itself is supported (macOS from Firefox 139, Windows Hello from 148), but an
  extension page can only use a web domain it has host permission for as the RP ID (Firefox
  150+). Using its own `moz-extension://` origin is
  [bug 1693562](https://bugzilla.mozilla.org/show_bug.cgi?id=1693562), still open with a patch
  in review as of November 2026. Borrowing a web domain would tie the credential to a domain
  someone else could serve, so we shouldn't.
- **Linux:** no platform authenticator; only security keys with PRF.
- The popup closes when the browser's passkey sheet opens, so setup and unlock would run in an
  extension tab or window, as passkey verification already does.

## Decision: biometrics (Alan agreed 2026-11-28)

Built for Chrome and Edge; hidden on Firefox until bug 1693562 ships.

- Setup and unlock run in an extension window (`src/popup/BiometricWindow.tsx`), opened by the
  worker (`src/background/biometric.ts`), which talks to it over a port only that window URL can
  open. The window makes a platform passkey with no RP id, so the browser binds it to the
  extension's own origin (`chrome-extension://<id>`), which no website can use. User
  verification is required.
- The PRF output (with a random salt saved beside it) becomes a wrapping key the way Bitwarden's
  passkey login does (`createSymmetricKeyFromPrf`: HKDF-Expand "enc" and "mac"), and wraps the
  user key with the SDK. The wrapped key and a check value (to notice a rotated account key)
  live in `storage.local`: without the device's secure hardware and a fingerprint or face, the
  PRF output can't be had, so this survives restarts.
- The popup offers it only where `isUserVerifyingPlatformAuthenticatorAvailable()` is true and
  `getClientCapabilities()` doesn't rule out PRF. If create() doesn't return a PRF output, the
  window asks once more with get().
- Not yet: biometrics answering re-prompt; checking on a real Mac and Windows machine (the live
  check uses Chrome's virtual authenticator, which can't copy a passkey's PRF secret, so a full
  unlock with the right output is covered by unit tests).
