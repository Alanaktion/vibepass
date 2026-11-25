# ADR 0001: Use Bitwarden's SDK for crypto, and license Vibepass as GPL-3.0

- Status: accepted
- Date: 2026-11-24
- Deciders: Alan

## Context

Vibepass needs Bitwarden-compatible crypto: PBKDF2 and Argon2id key derivation, the master
password hash, user key unwrapping, EncString encrypt/decrypt, per-item keys, and (later) RSA
organization keys and newer key types. A bug here can corrupt vaults or leak data, so the spec
lists it as the top risk. The goal is a 1Password-like UX on the Bitwarden core, so reusing
proven code is preferred wherever it does not constrain the UX.

## What we checked

**Packages.** Bitwarden publishes two builds of its internal client SDK on npm:

| Package                              | License                                              |
| ------------------------------------ | ---------------------------------------------------- |
| `@bitwarden/sdk-internal`            | GPL-3.0                                              |
| `@bitwarden/commercial-sdk-internal` | Bitwarden Software Development Kit License Agreement |

The README of both says the package is "only for internal use" and unsupported. Versions are
`0.2.0-main.<build>`, published from the main branch, with no stability promise.

**MV3 fit.** The package is a wasm-bindgen build. Its default entry imports the `.wasm` file as
an ES module, which neither Vite's library build nor service workers support, and service
workers forbid dynamic `import()` and top-level await. Importing the wasm-bindgen glue
(`bitwarden_wasm_internal_bg.js`) directly and calling `WebAssembly.instantiate` ourselves works:

- The glue has a single import namespace and needs no start function or `init_sdk` call for the
  stateless `PureCrypto` API.
- It runs under our existing CSP (`script-src 'self' 'wasm-unsafe-eval'`).
- Measured: about 27 ms to instantiate in Node, and login plus first sync in about 0.8 s in a real
  Chromium MV3 service worker against a local Vaultwarden (600,000 PBKDF2 iterations).
- Size: the `.wasm` is 8.7 MB (`dist/` is about 8.7 MB per browser), the bundled glue about
  240 KB minified. Fine for the Chrome Web Store and Firefox Add-ons; AMO review will want the
  SDK's source reference, which is public.

**API.** `PureCrypto` covers everything Phase 0 to 2 need: `derive_kdf_material` (PBKDF2 and
Argon2id), `decrypt_user_key_with_master_password`, `unwrap_symmetric_key` and
`wrap_symmetric_key`, `symmetric_decrypt_string` and `symmetric_encrypt_string`,
`unwrap_decapsulation_key` and `decapsulate_key_unsigned` for organization keys. Its own doc
comment calls it a stopgap for JS clients, so it may change.

## Decision

1. Use `@bitwarden/sdk-internal` (GPL-3.0), pinned to an exact version.
2. License Vibepass as GPL-3.0, which the SDK's license requires for a distributed combined work.
3. Use only the stateless `PureCrypto` API, behind `src/crypto/`. The SDK's state, sync, and
   client layers are not used, so the popup, search, autofill, and messaging stay ours.
4. Two small pieces stay on Web Crypto because `PureCrypto` doesn't expose them: the master
   password hash (one PBKDF2 round) and the HKDF stretch of the master key used on login (so the
   KDF runs once per login, not twice). Both are checked against the official client in tests.

## Consequences

- The riskiest code is Bitwarden's own, and the official clients run it daily.
- Tests check our wrapper against vaults written by the official web vault
  (`tests/fixtures/official-*.json`): the login hash, the user key, per-item keys, and fields.
  An SDK upgrade that changes behavior fails CI.
- SDK upgrades are manual and deliberate: bump the pinned version, run the tests and the live
  check against local servers, and read the `PureCrypto` changes.
- Anyone can fork Vibepass; selling it is still possible, with source.
- Fallback, if the package disappears or changes license: the wrapper in `src/crypto/` is small,
  so we can replace it with Web Crypto plus an Argon2 WASM build and keep the same tests.
