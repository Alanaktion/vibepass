# Browser review materials

## Store description

Vibepass is a keyboard-first password manager for self-hosted Bitwarden and Vaultwarden.
Find a login, fill a form, copy a one-time code, or use a saved passkey. Enable editing to
generate passwords, save new logins, organize folders, and restore items from trash.

The screenshots show the Firefox popup using the disposable compatibility vault.
[Quick find](store/quick-find.png) · [Login item](store/item.png)

## Permission justifications

| Access                                   | User action or background work                                                                                                                                                                        |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| storage                                  | Remember settings, account information, and encrypted credentials. Session storage restores the unlocked worker after suspension.                                                                     |
| alarms                                   | Check the server revision, enforce idle lock, and clear copied secrets after the popup closes.                                                                                                        |
| idle                                     | Detect inactivity and system lock to lock the vault.                                                                                                                                                  |
| activeTab                                | Find the page the user selected for quick find or fill.                                                                                                                                               |
| scripting                                | Inject the form detector on a fill gesture in a tab that predates extension installation.                                                                                                             |
| clipboardWrite                           | Copy a selected field or one-time code and clear the clipboard on the configured timer.                                                                                                               |
| offscreen (Chrome)                       | Give the service worker a document for clipboard writes. Firefox uses its background document.                                                                                                        |
| optional server origin                   | Request the chosen server’s origin during login for authentication, sync, and attachment retrieval.                                                                                                   |
| optional privacy                         | Change the built-in password manager preference when the user enables that setting.                                                                                                                   |
| HTTP and HTTPS top-frame content scripts | Show suggestions when login fields receive focus, offer to save on submit when enabled, and handle passkey requests that start before a toolbar click. The passkey bridge starts before page scripts. |
| wasm-unsafe-eval in the extension CSP    | Load the bundled Bitwarden crypto SDK. The build includes the WASM file and its license.                                                                                                              |

## Threat model

| Boundary                  | What to verify                                                                                                                                                                                                                                           |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web page to worker        | Treat the page and its scripts as untrusted. The router restricts extension-only messages. Inline choices require trusted input, and the worker uses the browser-supplied sender tab, frame, and URL.                                                    |
| Credential to destination | Login URI mode, port, transport downgrade, re-prompt, and navigation checks apply at fill time. Domain equivalence is explicit account configuration. WebAuthn separately checks the relying party ID. A site receiving a filled credential can read it. |
| Locked profile            | Keep secret values out of persistent plaintext storage and diagnostic logs. Encrypt generated-password history, remembered two-step tokens, refresh tokens, and cached domain groups. Verify lock, logout, and offline unlock.                           |
| Vault server and network  | Users select a trusted server. Require HTTPS for remote servers. Enforce origin checks for attachment downloads. A compromised server can change matching metadata or withhold updates.                                                                  |
| Updates and packaging     | Install exact dependencies from the lockfile. Inspect dependency changes, audit the tree, run official-client crypto vectors, and compare unsigned package hashes from two builds.                                                                       |

The extension relies on the browser and operating system to isolate its memory. A compromised
browser, a malicious update, and software reading the system clipboard are outside that boundary.
A third-party assessment and testing with assistive technology remain release gates.

## Compatibility and packaging

| Target                | Recorded coverage                                                                                                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vaultwarden 1.37.5    | Seeded Chromium login, unlock, fill, inline menu, editing, and passkey checks. The compatibility workflow runs the pinned version and adds latest on its weekly run.                |
| Self-hosted Bitwarden | Official-client crypto fixtures and SDK round trips. A live server run is still required before claiming server-version support.                                                    |
| Firefox               | Firefox 153 temporary add-on against Vaultwarden 1.37.5. Login, five-item sync, lock, unlock, and search passed. Full live parity for writes, passkeys, and inline UI remains open. |

Treat a server version as verified for a feature only after the corresponding live check passes.
Use the compatibility workflow run for the relevant commit to check current results.

Run `npm ci`, `npm run check`, `npm run build`, and `python3 scripts/package.py` with Python 3.
The ZIPs under `dist/` have the manifest at the archive root. The **Unsigned review packages**
workflow compares two builds and retains the packages and SHA-256 checksums on a version tag
or manual run. Store submission and signing follow maintainer review.
