// Dev-only Playwright script, excluded from typecheck and lint (Playwright is not a dependency).
/**
 * Live check: drives the built Chrome extension (dist/chrome) in Chromium against a local
 * Vaultwarden seeded by seed-vault.mjs, and a local login page. Dev use only; needs Playwright
 * (not a project dependency).
 *
 *   node scripts/dev/live-check.mjs <serverUrl> <email> [twoFactorEmail]
 *
 * The page server listens on 127.0.0.1:8090, which is what seed-vault.mjs saved the logins for.
 */
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { generateTotp } from '../../src/vault/totp.ts';

// Playwright isn't a project dependency; require() also finds a global install.
/** @type {typeof import('playwright')} */
const { chromium } = createRequire(import.meta.url)('playwright');

const password = process.env.VIBEPASS_TEST_PASSWORD;
const [serverUrl, email, tfaEmail] = process.argv.slice(2);
const tfaSecret =
  tfaEmail && process.env.VIBEPASS_TEST_TOTP_FILE
    ? (await readFile(process.env.VIBEPASS_TEST_TOTP_FILE, 'utf8')).trim()
    : null;
if (tfaEmail && !tfaSecret)
  throw new Error('Set VIBEPASS_TEST_TOTP_FILE for the two-step test account');
if (!serverUrl || !email || !password) {
  console.error(
    'Set VIBEPASS_TEST_PASSWORD and run: live-check.mjs <serverUrl> <email> [2faEmail]',
  );
  process.exit(2);
}
const root = fileURLToPath(new URL('../..', import.meta.url));
const results = /** @type {[string, boolean][]} */ ([]);
const check = (/** @type {string} */ name, /** @type {boolean} */ ok) => {
  results.push([name, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
};

// A login page with a React-style controlled form: it only sees values set through input events.
const LOGIN_PAGE = `<!doctype html><title>Local login</title>
<form id="f"><input type="search" placeholder="Search site">
<label>Email <input id="u" name="email" type="email" autocomplete="username"></label>
<label>Password <input id="p" name="password" type="password" autocomplete="current-password"></label>
<button>Sign in</button></form>
<script>
  window.seen = {};
  for (const el of document.querySelectorAll('#u,#p')) el.addEventListener('input', () => (seen[el.id] = el.value));
</script>`;
const pages = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(req.url?.startsWith('/login') || req.url?.startsWith('/team') ? LOGIN_PAGE : '<p>hi</p>');
});
await new Promise((resolve) => pages.listen(8090, '127.0.0.1', () => resolve(undefined)));

// Test copy of the build with host access granted up front, since a headless browser can't
// click the permission prompt.
const ext = await mkdtemp(join(tmpdir(), 'vibepass-ext-'));
await cp(join(root, 'dist/chrome'), ext, { recursive: true });
const manifest = JSON.parse(await readFile(join(ext, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['<all_urls>'];
await writeFile(join(ext, 'manifest.json'), JSON.stringify(manifest));

const context = await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(), 'vp-')), {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  permissions: ['clipboard-read', 'clipboard-write'],
});
let [worker] = context.serviceWorkers();
worker ??= await context.waitForEvent('serviceworker');
const extId = new URL(worker.url()).host;
const popupUrl = `chrome-extension://${extId}/popup/index.html`;

const site = await context.newPage();
await site.goto('http://127.0.0.1:8090/login');
const popup = await context.newPage();
await popup.goto(popupUrl);

/** Send a typed message from an extension page, like the popup does. */
const send = (/** @type {string} */ type, /** @type {unknown} */ payload) =>
  popup.evaluate(
    ([t, p]) => chrome.runtime.sendMessage({ source: 'vibepass', type: t, payload: p }),
    /** @type {const} */ ([type, payload]),
  );
const tabId = /** @type {number} */ (
  await popup.evaluate(
    async () => (await chrome.tabs.query({ url: 'http://127.0.0.1:8090/*' }))[0]?.id,
  )
);

try {
  // Log in through the real setup screen.
  await popup.getByLabel('Server URL').fill(serverUrl);
  await popup.getByLabel('Email').fill(email);
  await popup.getByLabel('Master password').fill(password);
  let start = Date.now();
  await popup.getByRole('button', { name: 'Log in' }).click();
  await popup.getByLabel('Search vault').waitFor();
  check('log in and first sync', true);

  const status = /** @type {any} */ (await send('vault:status', undefined)).data;
  check('all items decrypted, including the organization', status.itemCount === 5);

  const hits = /** @type {any} */ (
    await send('vault:search', { query: '', url: 'http://127.0.0.1:8090/login' })
  ).data;
  check('current site first', hits[0]?.name === 'Local Test Site' && hits[0].siteMatch);
  const fuzzy = /** @type {any} */ (await send('vault:search', { query: 'wiki', url: undefined }))
    .data;
  check('fuzzy search finds the shared item', fuzzy[0]?.name === 'Team Wiki');
  const notes = /** @type {any} */ (await send('vault:search', { query: 'fridge' })).data;
  check('search covers notes', notes[0]?.name === 'Wi-Fi');

  const login = hits[0];
  const detail = /** @type {any} */ (await send('vault:item', { id: login.id })).data;
  const fields = detail.sections.flatMap((/** @type {any} */ s) => s.fields);
  check(
    'item view keeps secrets out',
    !JSON.stringify(detail).includes('correct-horse-42') &&
      fields.some((/** @type {any} */ f) => f.label === 'Recovery PIN'),
  );
  const revealed = /** @type {any} */ (
    await send('vault:reveal', { id: login.id, fieldId: 'login.password' })
  ).data;
  check('reveal password', revealed === 'correct-horse-42');
  const totp = /** @type {any} */ (await send('vault:totp', { id: login.id })).data;
  const expected = (await generateTotp('JBSWY3DPEHPK3PXP', Date.now())).code;
  check('TOTP code matches', totp.code === expected);
  const file = /** @type {any} */ (
    await send('vault:attachment', { id: login.id, attachmentId: detail.attachments[0]?.id })
  ).data;
  check(
    'attachment downloads and decrypts',
    Buffer.from(file?.base64 ?? '', 'base64').toString() === 'hello from an attachment\n',
  );

  const shared = fuzzy[0];
  const sharedDetail = /** @type {any} */ (await send('vault:item', { id: shared.id })).data;
  check(
    'organization item shows org and collection',
    sharedDetail.organization === 'Acme' && sharedDetail.collections[0] === 'Engineering',
  );
  const sharedPw = /** @type {any} */ (
    await send('vault:reveal', { id: shared.id, fieldId: 'login.password' })
  ).data;
  check('organization item decrypts', sharedPw === 'team-secret-1');

  const bank = /** @type {any} */ (await send('vault:search', { query: 'bank' })).data[0];
  const denied = /** @type {any} */ (
    await send('vault:reveal', { id: bank.id, fieldId: 'login.password' })
  );
  const allowed = /** @type {any} */ (
    await send('vault:reveal', { id: bank.id, fieldId: 'login.password', masterPassword: password })
  );
  check(
    're-prompt item asks for the master password',
    denied.code === 'reprompt-required' && allowed.data === 'bank-secret-9',
  );

  // Autofill into the real page, then lock and time unlock-to-fill.
  await send('settings:set', { autoCopyTotp: true, clipboardClearSeconds: 10 });
  const fill = /** @type {any} */ (await send('autofill:fill', { tabId, id: login.id }));
  const seen = await site.evaluate(() => /** @type {any} */ (window).seen);
  check(
    'fill sets username and password through input events',
    seen.u === 'alice@example.test' && seen.p === 'correct-horse-42',
  );
  const mismatch = /** @type {any} */ (
    await send('autofill:fill', { tabId, id: bank.id, masterPassword: password })
  );
  check('fill refuses an item saved for another site', mismatch.code === 'fill-mismatch');

  await site.bringToFront();
  const copied = await site.evaluate(() => navigator.clipboard.readText());
  check('TOTP copied after fill', copied === expected || /^\d{6}$/.test(copied));
  await new Promise((r) => setTimeout(r, 11_000));
  const cleared = await site.evaluate(() => navigator.clipboard.readText());
  check('clipboard cleared after the timeout', cleared === '');

  await send('vault:lock', undefined);
  await site.reload();
  start = Date.now();
  const unlocked = /** @type {any} */ (await send('vault:unlock', { masterPassword: password }));
  const again = /** @type {any} */ (await send('autofill:fill', { tabId, id: login.id }));
  const unlockToFill = Date.now() - start;
  check('unlock to filled form under 3 s', unlocked.ok && again.ok && unlockToFill < 3000);

  // Worker restart keeps the vault unlocked (storage.session).
  const before = /** @type {any} */ (await send('vault:status', undefined)).data.state;
  check('stays unlocked', before === 'unlocked');

  // Shortcut path: the fill command picks the best match.
  await send('vault:sync', undefined);
  const synced = /** @type {any} */ (await send('vault:status', undefined)).data;
  check('manual sync', synced.syncError === null && synced.lastSync !== null);

  if (tfaEmail && tfaSecret) {
    await send('vault:logout', undefined);
    const first = /** @type {any} */ (
      await send('vault:login', { serverUrl, email: tfaEmail, masterPassword: password })
    );
    check('two-step login asks for a code', first.code === 'two-factor-required');
    const code = (await generateTotp(tfaSecret, Date.now())).code;
    const second = /** @type {any} */ (
      await send('vault:login', {
        serverUrl,
        email: tfaEmail,
        masterPassword: password,
        challenge: { twoFactor: { provider: 0, token: code, remember: true } },
      })
    );
    check(
      'two-step login with an authenticator code',
      second.ok && second.data.state === 'unlocked',
    );
    await send('vault:logout', undefined);
    const third = /** @type {any} */ (
      await send('vault:login', { serverUrl, email: tfaEmail, masterPassword: password })
    );
    check('logout forgets the remembered browser', third.code === 'two-factor-required');
  }
} catch {
  check('unexpected error', false);
} finally {
  await context.close();
  pages.close();
}
const failed = results.filter(([, ok]) => !ok);
console.log(`\n${String(results.length - failed.length)}/${String(results.length)} checks passed`);
process.exit(failed.length ? 1 : 0);
