// Dev-only Playwright script, excluded from typecheck and lint (Playwright is not a dependency).
/**
 * Live check for passkeys: drives the built Chrome extension (dist/chrome) against a local
 * Vaultwarden with real keyboard input on a local WebAuthn test site, which checks every
 * response the way a real website does (signature, origin, challenge, flags). New passkeys are
 * read back with Bitwarden's own cipher code from a separate login. It writes to the vault, so
 * only run it against a throwaway server.
 *
 *   node scripts/dev/passkey-check.mjs <serverUrl> <email>
 *
 * The test site listens on localhost:8091 (WebAuthn needs https or localhost).
 */
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';
import * as glue from '@bitwarden/sdk-internal/bitwarden_wasm_internal_bg.js';

const require = createRequire(import.meta.url);
/** @type {typeof import('playwright')} */
const { chromium } = require('playwright');

const password = process.env.VIBEPASS_TEST_PASSWORD;
const [serverUrl, email] = process.argv.slice(2);
if (!serverUrl || !email || !password) {
  console.error('Set VIBEPASS_TEST_PASSWORD and run: passkey-check.mjs <serverUrl> <email>');
  process.exit(2);
}
const base = serverUrl.replace(/\/+$/, '');
const root = fileURLToPath(new URL('../..', import.meta.url));
const results = /** @type {[string, boolean][]} */ ([]);
const check = (/** @type {string} */ name, /** @type {boolean} */ ok) => {
  results.push([name, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
};

// ---- Bitwarden's own client code, logged in separately, to read back what Vibepass wrote ----

const { instance } = await WebAssembly.instantiate(
  await readFile(require.resolve('@bitwarden/sdk-internal/bitwarden_wasm_internal_bg.wasm')),
  { './bitwarden_wasm_internal_bg.js': /** @type {any} */ (glue) },
);
glue.__wbg_set_wasm(instance.exports);
const pc = glue.PureCrypto;
const enc = new TextEncoder();

/** @param {string} path @param {RequestInit} [init] */
async function call(path, init = {}) {
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`${path}: ${String(res.status)}`);
  return text ? JSON.parse(text) : null;
}

async function officialLogin() {
  const prelogin = await call('/identity/accounts/prelogin', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const salt = email.trim().toLowerCase();
  const kdf =
    prelogin.kdf === 1
      ? {
          argon2id: {
            iterations: prelogin.kdfIterations,
            memory: prelogin.kdfMemory,
            parallelism: prelogin.kdfParallelism,
          },
        }
      : { pBKDF2: { iterations: prelogin.kdfIterations } };
  const masterKey = pc.derive_kdf_material(enc.encode(password), enc.encode(salt), kdf);
  const hashKey = await webcrypto.subtle.importKey('raw', masterKey, 'PBKDF2', false, [
    'deriveBits',
  ]);
  const hash = Buffer.from(
    await webcrypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(password), iterations: 1 },
      hashKey,
      256,
    ),
  ).toString('base64');
  const token = await call('/identity/connect/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      username: email,
      password: hash,
      scope: 'api offline_access',
      client_id: 'web',
      deviceType: '9',
      deviceIdentifier: webcrypto.randomUUID(),
      deviceName: 'passkey-check',
    }).toString(),
  });
  const userKey = pc.decrypt_user_key_with_master_password(token.Key, password, salt, kdf);
  const auth = { authorization: `Bearer ${token.access_token}` };
  const sync = await call('/api/sync?excludeDomains=true', { headers: auth });
  const client = new glue.PasswordManagerClient(
    { get_access_token: () => Promise.resolve(undefined) },
    null,
    new glue.ManagedSettingsClient(),
  );
  await client.crypto().initialize_user_crypto({
    userId: sync.profile.id,
    kdfParams: kdf,
    email,
    accountCryptographicState: { V1: { private_key: sync.profile.privateKey } },
    method: { decryptedKey: { decrypted_user_key: Buffer.from(userKey).toString('base64') } },
  });
  return { auth, client };
}

const official = await officialLogin();

/** Logins with passkeys, decrypted by the official client code. */
async function officialPasskeys() {
  const sync = await call('/api/sync?excludeDomains=true', { headers: official.auth });
  const out = [];
  for (const c of sync.ciphers) {
    if (!c.login?.fido2Credentials?.length || c.deletedDate) continue;
    out.push(await official.client.vault().ciphers().decrypt(c));
  }
  return out;
}

// ---- The test site: a minimal relying party that verifies like a real one ----

const SITE = `<!doctype html><title>Passkey test site</title>
<style>body{font:15px system-ui;margin:40px}button{margin:4px}</style>
<h1>Passkey test site</h1>
<button id="register">Create a passkey</button>
<button id="again">Create another (excluded)</button>
<button id="signin">Sign in with a passkey</button>
<pre id="out"></pre>
<script>
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/') + '==='.slice((s.length+3)%4)), c => c.charCodeAt(0));
const rand = () => crypto.getRandomValues(new Uint8Array(32));
const userId = new TextEncoder().encode('user-1234');
const store = JSON.parse(sessionStorage.getItem('creds') || '[]');
const done = (value) => { window.result = value; document.getElementById('out').textContent = JSON.stringify(value, null, 1); };
const sha = async (bytes) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
function derToRaw(der) {
  const out = new Uint8Array(64); let o = 2;
  for (let i = 0; i < 2; i++) { const n = der[o+1]; let v = der.slice(o+2, o+2+n); while (v.length > 32 && v[0] === 0) v = v.slice(1); out.set(v, 32*(i+1) - v.length); o += 2 + n; }
  return out;
}
async function register(exclude) {
  window.result = undefined;
  const challenge = rand();
  try {
    const cred = await navigator.credentials.create({ publicKey: {
      rp: { name: 'Passkey Test' },
      user: { id: userId, name: 'pk-user@example.test', displayName: 'PK User' },
      challenge, pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      excludeCredentials: exclude ? store.map((c) => ({ type: 'public-key', id: unb64(c.id) })) : [],
      extensions: { credProps: true },
    }});
    const client = JSON.parse(new TextDecoder().decode(cred.response.clientDataJSON));
    const authData = new Uint8Array(cred.response.getAuthenticatorData());
    const ok = cred instanceof PublicKeyCredential && client.type === 'webauthn.create' &&
      client.challenge === b64(challenge) && client.origin === location.origin &&
      b64(authData.slice(0, 32)) === b64(await sha(new TextEncoder().encode('localhost'))) &&
      (authData[32] & 0x45) === 0x45 && cred.response.getPublicKeyAlgorithm() === -7 &&
      b64(cred.rawId) === cred.id && typeof JSON.stringify(cred.toJSON?.() ?? {}) === 'string';
    store.push({ id: cred.id, key: b64(cred.response.getPublicKey()) });
    sessionStorage.setItem('creds', JSON.stringify(store));
    done({ ok, id: cred.id, attachment: cred.authenticatorAttachment, rk: cred.getClientExtensionResults().credProps?.rk });
  } catch (e) { done({ error: e.name, message: e.message }); }
}
async function signin() {
  window.result = undefined;
  const challenge = rand();
  try {
    const cred = await navigator.credentials.get({ publicKey: { challenge, rpId: 'localhost', userVerification: 'required' } });
    // Like @github/webauthn-json (GitHub's sign-in), which replaces toJSON on the credential.
    (() => { 'use strict'; const own = cred.toJSON; cred.toJSON = () => own.call(cred); })();
    const known = store.find((c) => c.id === cred.id);
    if (!known) return done({ error: 'unknown credential', id: cred.id });
    const key = await crypto.subtle.importKey('spki', unb64(known.key), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const authData = new Uint8Array(cred.response.authenticatorData);
    const clientBytes = new Uint8Array(cred.response.clientDataJSON);
    const signed = new Uint8Array([...authData, ...(await sha(clientBytes))]);
    const verified = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, derToRaw(new Uint8Array(cred.response.signature)), signed);
    const client = JSON.parse(new TextDecoder().decode(clientBytes));
    const ok = verified && client.type === 'webauthn.get' && client.challenge === b64(challenge) &&
      client.origin === location.origin && (authData[32] & 0x05) === 0x05 &&
      new TextDecoder().decode(cred.response.userHandle) === 'user-1234';
    done({ ok, verified, id: cred.id });
  } catch (e) { done({ error: e.name, message: e.message }); }
}
document.getElementById('register').onclick = () => register(false);
document.getElementById('again').onclick = () => register(true);
document.getElementById('signin').onclick = () => signin();
</script>`;
const site = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(SITE);
});
await new Promise((resolve) => site.listen(8091, '127.0.0.1', () => resolve(undefined)));

// ---- The extension ----

const ext = await mkdtemp(join(tmpdir(), 'vibepass-ext-'));
await cp(join(root, 'dist/chrome'), ext, { recursive: true });
const manifest = JSON.parse(await readFile(join(ext, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['<all_urls>'];
await writeFile(join(ext, 'manifest.json'), JSON.stringify(manifest));

const context = await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(), 'vp-')), {
  channel: 'chromium',
  ignoreDefaultArgs: ['--disable-extensions'],
  headless: true,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
let [worker] = context.serviceWorkers();
worker ??= await context.waitForEvent('serviceworker');
const extId = new URL(worker.url()).host;
const popup = await context.newPage();
await popup.setViewportSize({ width: 360, height: 600 });
await popup.goto(`chrome-extension://${extId}/popup/index.html`);

/** @returns {Promise<any>} */
const send = (/** @type {string} */ type, /** @type {unknown} */ payload) =>
  popup.evaluate(
    ([t, p]) => chrome.runtime.sendMessage({ source: 'vibepass', type: t, payload: p }),
    /** @type {const} */ ([type, payload]),
  );

try {
  await popup.getByLabel('Server URL', { exact: true }).fill(serverUrl);
  await popup.getByLabel('Email', { exact: true }).fill(email);
  await popup.getByLabel('Master password', { exact: true }).fill(password);
  await popup.getByRole('button', { name: 'Log in' }).click();
  await popup.getByLabel('Search vault', { exact: true }).waitFor();
  await send('settings:set', { allowEdits: true });

  const page = await context.newPage();
  await page.setViewportSize({ width: 900, height: 600 });
  await page.goto('http://localhost:8091/');
  const result = async () => {
    await page.waitForFunction(() => window.result !== undefined, null, { timeout: 15_000 });
    return page.evaluate(() => window.result);
  };
  const prompt = () =>
    page.waitForFunction(() => document.querySelector('vibepass-passkey') !== null, null, {
      timeout: 5000,
    });
  const promptGone = () =>
    page.waitForFunction(() => document.querySelector('vibepass-passkey') === null, null, {
      timeout: 5000,
    });

  // Create: Vibepass asks, the user presses Enter on "Save passkey".
  const before = (await officialPasskeys()).length;
  await page.click('#register');
  await prompt();
  check(
    'the prompt is in a closed shadow root',
    await page.evaluate(() => document.querySelector('vibepass-passkey')?.shadowRoot === null),
  );
  await page.keyboard.press('Enter');
  const verify = async () => {
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const wait = () => {
        const dialog = context.pages().find((p) => p.url().includes('/popup/index.html?verify='));
        if (dialog)
          resolve(
            dialog
              .getByLabel('Master password')
              .fill(password)
              .then(() => dialog.getByRole('button', { name: 'Verify', exact: true }).click()),
          );
        else if (Date.now() > deadline) reject(new Error('Verification window unavailable'));
        else setTimeout(wait, 50);
      };
      wait();
    });
  };
  await verify();
  const created = await result();
  check('new passkey verifies on the site', created.ok === true);
  check('credProps reports a discoverable passkey', created.rk === true);
  const saved = await officialPasskeys();
  const view = saved.find((v) => v.login.fido2Credentials.some((p) => p.rpId === 'localhost'));
  const stored = view?.login.fido2Credentials[0];
  check(
    'the official client reads the new passkey from the server',
    saved.length === before + 1 &&
      view?.name === 'Passkey Test' &&
      view.login.username === 'pk-user@example.test' &&
      stored?.keyAlgorithm === 'ECDSA' &&
      stored.keyCurve === 'P-256' &&
      stored.counter === '0' &&
      stored.discoverable === 'true' &&
      stored.userName === 'pk-user@example.test' &&
      stored.userHandle === Buffer.from('user-1234').toString('base64url'),
  );

  // Sign in: pick the passkey with Enter.
  await page.click('#signin');
  await prompt();
  await page.keyboard.press('Enter');
  await verify();
  const signedIn = await result();
  check('sign-in with the saved passkey verifies', signedIn.ok === true);
  check('the sign-in used the new passkey', signedIn.id === created.id);

  // Escape cancels, like the browser's own sheet.
  await page.click('#signin');
  await prompt();
  await page.keyboard.press('Escape');
  const cancelled = await result();
  check('Escape cancels with NotAllowedError', cancelled.error === 'NotAllowedError');
  await promptGone();

  // Registering the same account again is refused.
  await page.click('#again');
  await prompt();
  await page.keyboard.press('Enter');
  const excluded = await result();
  check('a second passkey for the same account is refused', excluded.error === 'InvalidStateError');

  // "Use another device or security key" hands the request to the browser.
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  await page.click('#register');
  await prompt();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  const native = await result();
  check(
    'another device creates the passkey in the browser instead',
    native.ok === true &&
      native.id !== created.id &&
      (await officialPasskeys()).length === saved.length,
  );

  // With editing off, Vibepass stays out of the way of new passkeys, but still signs in.
  await send('settings:set', { allowEdits: false });
  await page.click('#register');
  const untouched = await result();
  check(
    'with editing off, creating goes straight to the browser',
    untouched.ok === true &&
      (await page.evaluate(() => document.querySelector('vibepass-passkey') === null)),
  );

  // Locked: the prompt offers to unlock, and the browser on request.
  await send('vault:lock');
  await page.click('#signin');
  await prompt();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  const lockedResult = await result();
  check(
    'while locked, "another device" signs in with the browser',
    lockedResult.ok === true && lockedResult.id !== created.id,
  );
} catch {
  check('no unexpected errors', false);
} finally {
  await context.close();
  site.close();
}

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${String(results.length - failed)} of ${String(results.length)} passed`);
process.exit(failed ? 1 : 0);
