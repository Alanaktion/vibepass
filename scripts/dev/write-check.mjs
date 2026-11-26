// Dev-only Playwright script, excluded from typecheck and lint (Playwright is not a dependency).
/**
 * Live check for Phase 2 writes: drives the built Chrome extension (dist/chrome) against a local
 * Vaultwarden seeded by seed-vault.mjs, with real mouse and keyboard input, then reads every
 * write back with Bitwarden's own cipher code (the SDK's CiphersClient, which the official
 * clients use) from a separate login, so "the official clients see the same thing" is checked
 * against a real server, not just in unit tests. Dev and test use only; it writes to the vault.
 *
 *   node scripts/dev/write-check.mjs <serverUrl> <email>
 *
 * The page server listens on 127.0.0.1:8090, which is what seed-vault.mjs saved the logins for.
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
  console.error('Set VIBEPASS_TEST_PASSWORD and run: write-check.mjs <serverUrl> <email>');
  process.exit(2);
}
const base = serverUrl.replace(/\/+$/, '');
const root = fileURLToPath(new URL('../..', import.meta.url));
/** Unique per run, so the check can run again on the same vault. */
const stamp = String(Date.now());
const changed = `changed-on-the-site-${stamp}`;
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

/** Log in like an official client and keep a token plus an unlocked SDK client. */
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
      deviceName: 'write-check',
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
  await client.crypto().initialize_org_crypto({
    organizationKeys: new Map(
      (sync.profile.organizations ?? []).map((/** @type {any} */ o) => [o.id, o.key]),
    ),
  });
  return { auth, client, userKey };
}

const official = await officialLogin();

/** The server's current copy, decrypted by the official client code. */
async function officialRead() {
  const sync = await call('/api/sync?excludeDomains=true', { headers: official.auth });
  const views = new Map();
  for (const c of sync.ciphers) views.set(c.id, await official.client.vault().ciphers().decrypt(c));
  const folders = new Map(
    sync.folders.map((/** @type {any} */ f) => [
      f.id,
      pc.symmetric_decrypt_string(f.name, official.userKey),
    ]),
  );
  return { sync, views, folders };
}

// ---- Local pages ----

const PAGE_STYLE =
  '<style>body{font:15px system-ui;margin:40px}input{display:block;margin:6px 0 12px;padding:6px}</style>';
const SIGNUP = `<!doctype html><title>Sign up</title>${PAGE_STYLE}
<h1>Create an account</h1>
<form method="post" action="/welcome">
<label>Username <input id="u" name="username"></label>
<label>Password <input id="a" name="password" type="password"></label>
<label>Confirm password <input id="b" name="confirm" type="password"></label>
<button id="go">Create account</button></form>`;
const LOGIN = `<!doctype html><title>Sign in</title>${PAGE_STYLE}
<form method="post" action="/welcome">
<label>Email <input id="u" name="email" type="email" autocomplete="username"></label>
<label>Password <input id="p" name="password" type="password" autocomplete="current-password"></label>
<button id="go">Sign in</button></form>`;
const WELCOME = `<!doctype html><title>Welcome</title>${PAGE_STYLE}<h1>Welcome</h1><p>Signed in.</p>`;
const pages = createServer((req, res) => {
  if (req.method === 'POST') {
    req.resume();
    res.writeHead(303, { location: '/welcome' });
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  const url = req.url ?? '';
  res.end(url.startsWith('/signup') ? SIGNUP : url.startsWith('/login') ? LOGIN : WELCOME);
});
await new Promise((resolve) => pages.listen(8090, '127.0.0.1', () => resolve(undefined)));

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
  permissions: ['clipboard-read', 'clipboard-write'],
});
let [worker] = context.serviceWorkers();
worker ??= await context.waitForEvent('serviceworker');
const extId = new URL(worker.url()).host;
const popupUrl = `chrome-extension://${extId}/popup/index.html`;
const popup = await context.newPage();
await popup.setViewportSize({ width: 360, height: 600 });
await popup.goto(popupUrl);

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

  // Writes are off until the user turns them on.
  const off = await send('folder:create', { name: 'Nope' });
  check('writes refused while editing is off', off.code === 'writes-off');
  await popup.getByRole('button', { name: 'Settings' }).click();
  await popup.getByLabel('Let Vibepass edit my vault (new)', { exact: true }).click();
  await popup.getByRole('button', { name: 'Turn on editing' }).click();
  await popup.waitForFunction(() => true);
  check('editing turned on in settings', (await send('settings:get')).data.allowEdits === true);
  await popup.keyboard.press('Escape');

  // New login through the popup, with a generated password.
  await popup.getByRole('button', { name: 'New login' }).first().click();
  await popup.getByLabel('Name', { exact: true }).fill('Created by Vibepass');
  await popup.getByLabel('Username', { exact: true }).fill('new-user@example.test');
  await popup.getByRole('button', { name: 'Generate a password' }).click();
  await popup.getByLabel('One-time password key', { exact: true }).fill('JBSWY3DPEHPK3PXP');
  // The popup page is its own active tab here, so no website is filled in for us.
  await popup.getByRole('button', { name: 'Add website' }).click();
  await popup.getByLabel('Website 1', { exact: true }).fill('https://created.example.test/login');
  await popup.getByLabel('Notes', { exact: true }).fill('Notes with ünïcødé ✓');
  await popup.getByRole('button', { name: 'Add field' }).click();
  await popup.getByLabel('Field 1 name', { exact: true }).fill('PIN');
  await popup.getByLabel('Field 1 type', { exact: true }).selectOption({ label: 'Hidden' });
  await popup.getByLabel('Field 1 value', { exact: true }).fill('4321');
  await popup.keyboard.press('Control+s');
  await popup.getByRole('button', { name: 'Edit' }).waitFor();
  const created = (await send('vault:search', { query: 'Created by Vibepass' })).data[0];
  const generated = (await send('vault:reveal', { id: created.id, fieldId: 'login.password' }))
    .data;
  let server = await officialRead();
  let view = server.views.get(created.id);
  check(
    'new login reads back in the official client',
    view?.name === 'Created by Vibepass' &&
      view.login?.username === 'new-user@example.test' &&
      view.login?.password === generated &&
      generated.length === 20 &&
      view.login?.totp === 'JBSWY3DPEHPK3PXP' &&
      view.login?.uris?.[0]?.uri === 'https://created.example.test/login' &&
      view.notes === 'Notes with ünïcødé ✓' &&
      view.fields?.[0]?.name === 'PIN' &&
      view.fields?.[0]?.value === '4321' &&
      view.fields?.[0]?.type === 1 &&
      Boolean(server.sync.ciphers.find((/** @type {any} */ c) => c.id === created.id)?.key),
  );

  // Edit the password in the popup: the old one goes to the password history.
  await popup.getByRole('button', { name: 'Edit' }).click();
  await popup.getByLabel('Password', { exact: true }).fill('a new password 1');
  await popup.getByRole('button', { name: 'Save' }).click();
  await popup.getByRole('button', { name: 'Edit' }).waitFor();
  server = await officialRead();
  view = server.views.get(created.id);
  check(
    'edit keeps the old password in history',
    view?.login?.password === 'a new password 1' &&
      view.passwordHistory?.[0]?.password === generated,
  );

  // Editing a seeded login with an attachment, custom field, and TOTP keeps all of them.
  const local = (await send('vault:search', { query: 'Local Test Site' })).data[0];
  const before = server.views.get(local.id);
  const editable = (await send('vault:edit', { id: local.id })).data;
  editable.draft.notes = 'edited by Vibepass';
  const saved = await send('vault:save', {
    id: local.id,
    draft: editable.draft,
    revisionDate: editable.revisionDate,
  });
  server = await officialRead();
  const after = server.views.get(local.id);
  check(
    'edit keeps attachments, custom fields, and TOTP',
    saved.ok &&
      after?.notes === 'edited by Vibepass' &&
      after.attachments?.length === before.attachments?.length &&
      after.attachments?.[0]?.fileName === before.attachments?.[0]?.fileName &&
      JSON.stringify(after.fields) === JSON.stringify(before.fields) &&
      after.login?.totp === before.login?.totp &&
      after.login?.password === before.login?.password,
  );
  const detail = (await send('vault:item', { id: local.id })).data;
  const file = (
    await send('vault:attachment', { id: local.id, attachmentId: detail.attachments[0]?.id })
  ).data;
  check(
    'attachment still decrypts after the edit',
    Buffer.from(file?.base64 ?? '', 'base64').toString() === 'hello from an attachment\n',
  );

  // An organization item, encrypted with the organization key.
  const wiki = (await send('vault:search', { query: 'Team Wiki' })).data[0];
  const wikiEdit = (await send('vault:edit', { id: wiki.id })).data;
  wikiEdit.draft.name = 'Team Wiki (edited)';
  const wikiSaved = await send('vault:save', {
    id: wiki.id,
    draft: wikiEdit.draft,
    revisionDate: wikiEdit.revisionDate,
  });
  server = await officialRead();
  check(
    'organization item edit reads back in the official client',
    wikiSaved.ok &&
      server.views.get(wiki.id)?.name === 'Team Wiki (edited)' &&
      server.views.get(wiki.id)?.login?.password === 'team-secret-1',
  );

  // Another client changes the item; saving the stale copy is a conflict, then overwrite works.
  const stale = (await send('vault:edit', { id: created.id })).data;
  const raw = server.sync.ciphers.find((/** @type {any} */ c) => c.id === created.id);
  // Both servers allow a second of slack between revisions before they call a copy stale.
  await new Promise((r) => setTimeout(r, 2000));
  const other = { ...raw, favorite: !raw.favorite, lastKnownRevisionDate: raw.revisionDate };
  delete other.attachments;
  other.encryptedFor = server.sync.profile.id;
  await call(`/api/ciphers/${created.id}`, {
    method: 'PUT',
    headers: { ...official.auth, 'content-type': 'application/json' },
    body: JSON.stringify(other),
  });
  stale.draft.name = 'Mine wins';
  const conflict = await send('vault:save', {
    id: created.id,
    draft: stale.draft,
    revisionDate: stale.revisionDate,
  });
  const overwrite = await send('vault:save', {
    id: created.id,
    draft: stale.draft,
    revisionDate: stale.revisionDate,
    overwrite: true,
  });
  server = await officialRead();
  check(
    'server conflict is reported, and overwrite saves',
    conflict.code === 'conflict' &&
      overwrite.ok &&
      server.views.get(created.id)?.name === 'Mine wins',
  );

  // Folders and moving items.
  const folder = (await send('folder:create', { name: 'Vibepass folder' })).data;
  await send('vault:organize', { id: created.id, folderId: folder.id, favorite: true });
  await send('folder:rename', { id: folder.id, name: 'Renamed folder' });
  server = await officialRead();
  const movedRaw = server.sync.ciphers.find((/** @type {any} */ c) => c.id === created.id);
  check(
    'folder create, rename, and move',
    server.folders.get(folder.id) === 'Renamed folder' &&
      movedRaw.folderId === folder.id &&
      movedRaw.favorite === true,
  );
  await send('folder:delete', { id: folder.id });
  server = await officialRead();
  check(
    'deleting a folder keeps its items',
    !server.folders.has(folder.id) && server.views.has(created.id),
  );

  // Trash, restore, delete for good.
  await send('vault:trash-item', { id: created.id });
  server = await officialRead();
  const trashed = server.sync.ciphers.find((/** @type {any} */ c) => c.id === created.id);
  const trashList = (await send('vault:trash')).data;
  check(
    'move to trash',
    Boolean(trashed?.deletedDate) && trashList.some((/** @type {any} */ t) => t.id === created.id),
  );
  await send('vault:restore', { id: created.id });
  server = await officialRead();
  check(
    'restore from trash',
    !server.sync.ciphers.find((/** @type {any} */ c) => c.id === created.id)?.deletedDate,
  );
  await send('vault:trash-item', { id: created.id });
  await send('vault:delete-forever', { id: created.id });
  server = await officialRead();
  check('delete for good', !server.views.has(created.id));

  // Sign up on a page: the inline menu suggests a password, the banner saves the login.
  const site = await context.newPage();
  await site.setViewportSize({ width: 900, height: 600 });
  await site.goto('http://127.0.0.1:8090/signup');
  await site.click('#u');
  await site.keyboard.type(`signup-${stamp}`);
  // The username field shows saved logins for the site; Tab moves on, as a user would.
  await site.keyboard.press('Tab');
  await site.waitForTimeout(400);
  await site.keyboard.press('ArrowDown');
  await site.keyboard.press('Enter');
  await site.waitForTimeout(400);
  const [a, b] = await site.evaluate(() => [
    /** @type {HTMLInputElement} */ (document.getElementById('a')).value,
    /** @type {HTMLInputElement} */ (document.getElementById('b')).value,
  ]);
  check('sign-up field gets a generated password, confirm too', a.length >= 12 && a === b);
  const history = (await send('generator:history')).data;
  check('generated password is in the history', history[0]?.password === a);
  await site.click('#go');
  await site.waitForURL('**/welcome');
  await site.locator('vibepass-banner').waitFor({ timeout: 5000 });
  await site.waitForTimeout(300);
  // The banner is in a closed shadow root: reach it with the keyboard, as a user could.
  await site.keyboard.press('Tab');
  await site.keyboard.press('Control+a');
  await site.keyboard.type(`Signup ${stamp}`);
  await site.keyboard.press('Enter');
  await site.waitForTimeout(800);
  const signup = (await send('vault:search', { query: `Signup ${stamp}` })).data.find(
    (/** @type {any} */ h) => h.name === `Signup ${stamp}`,
  );
  const signupPw = signup
    ? (await send('vault:reveal', { id: signup.id, fieldId: 'login.password' })).data
    : null;
  check(
    'save banner saves the new login',
    signup?.subtitle === `signup-${stamp}` && signupPw === a,
  );

  // Sign in with a changed password: the banner offers to update the saved login.
  await site.goto('http://127.0.0.1:8090/login');
  await site.click('#u');
  await site.keyboard.press('Escape');
  await site.keyboard.type('alice@example.test');
  await site.click('#p');
  await site.keyboard.press('Escape');
  await site.keyboard.type(changed);
  await site.keyboard.press('Enter');
  await site.waitForURL('**/welcome');
  await site.locator('vibepass-banner').waitFor({ timeout: 5000 });
  await site.waitForTimeout(300);
  await site.keyboard.press('Tab');
  await site.keyboard.press('Enter');
  await site.waitForTimeout(800);
  server = await officialRead();
  const updated = server.views.get(local.id);
  check(
    'update banner changes the password, old one in history',
    updated?.login?.password === changed &&
      updated.passwordHistory?.[0]?.password === before.login?.password,
  );

  // Already saved: no banner.
  await site.goto('http://127.0.0.1:8090/login');
  await site.click('#u');
  await site.keyboard.press('Escape');
  await site.keyboard.type('alice@example.test');
  await site.click('#p');
  await site.keyboard.press('Escape');
  await site.keyboard.type(changed);
  await site.keyboard.press('Enter');
  await site.waitForURL('**/welcome');
  await site.waitForTimeout(1000);
  check(
    'no banner for a login that is already saved',
    (await site.locator('vibepass-banner').count()) === 0,
  );
} catch {
  check('unexpected error', false);
} finally {
  await context.close();
  pages.close();
}
const failed = results.filter(([, ok]) => !ok);
console.log(`\n${String(results.length - failed.length)}/${String(results.length)} checks passed`);
process.exit(failed.length ? 1 : 0);
