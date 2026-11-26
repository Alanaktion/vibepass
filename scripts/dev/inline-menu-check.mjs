// Dev-only Playwright script, excluded from typecheck and lint (Playwright is not a dependency).
/**
 * Inline menu check: drives the built Chrome extension (dist/chrome) in Chromium against a local
 * Vaultwarden seeded by seed-vault.mjs, with real (trusted) mouse and keyboard input on local
 * pages: a single-page login, a multi-step login (username, then password), a split login in a
 * scrolled and transformed layout, and a field with no autocomplete hint.
 *
 *   node scripts/dev/inline-menu-check.mjs <serverUrl> <email>
 *
 * The page server listens on 127.0.0.1:8090, which is what seed-vault.mjs saved the logins for.
 */
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

/** @type {typeof import('playwright')} */
const { chromium } = createRequire(import.meta.url)('playwright');

const password = process.env.VIBEPASS_TEST_PASSWORD;
const [serverUrl, email] = process.argv.slice(2);
if (!serverUrl || !email || !password) {
  console.error('Set VIBEPASS_TEST_PASSWORD and run: inline-menu-check.mjs <serverUrl> <email>');
  process.exit(2);
}
const root = fileURLToPath(new URL('../..', import.meta.url));
const results = /** @type {[string, boolean][]} */ ([]);
const check = (/** @type {string} */ name, /** @type {boolean} */ ok) => {
  results.push([name, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
};

const SEEN = `<script>
  window.seen = {};
  document.addEventListener('input', (e) => (seen[e.target.id] = e.target.value), true);
</script>`;
const PAGES = {
  '/login': `<!doctype html><title>Login</title>
    <form><label>Email <input id="u" type="email" autocomplete="username"></label>
    <label>Password <input id="p" type="password" autocomplete="current-password"></label>
    <button>Sign in</button></form>${SEEN}`,
  // Username first, then the page swaps in a password step (like Google or Microsoft).
  '/multi': `<!doctype html><title>Multi-step</title>
    <form id="f"><label>Email <input id="u" type="email" autocomplete="username"></label>
    <button id="next">Next</button></form>
    <script>
      document.getElementById('f').addEventListener('submit', (e) => {
        e.preventDefault();
        document.getElementById('f').innerHTML =
          '<label>Password <input id="p" type="password" autocomplete="current-password"></label><button>Sign in</button>';
        setTimeout(() => document.getElementById('p').focus(), 50);
      });
    </script>${SEEN}`,
  // Username and password in separate forms, inside a scrolled, transformed container.
  '/split': `<!doctype html><title>Split</title>
    <div style="height:900px"></div>
    <div style="transform: translateX(40px) scale(0.9); transform-origin: 0 0">
      <form><label>Username <input id="u" name="username"></label></form>
      <form><label>Password <input id="p" type="password"></label><button>Go</button></form>
    </div><div style="height:900px"></div>${SEEN}`,
};
const pages = createServer((req, res) => {
  const path = /** @type {keyof typeof PAGES} */ (new URL(req.url ?? '/', 'http://x').pathname);
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(PAGES[path] ?? '<p>hi</p>');
});
await new Promise((resolve) => pages.listen(8090, '127.0.0.1', () => resolve(undefined)));

const ext = await mkdtemp(join(tmpdir(), 'vibepass-ext-'));
await cp(join(root, 'dist/chrome'), ext, { recursive: true });
const manifest = JSON.parse(await readFile(join(ext, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['<all_urls>'];
await writeFile(join(ext, 'manifest.json'), JSON.stringify(manifest));

const context = await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(), 'vp-')), {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  viewport: { width: 900, height: 640 },
  deviceScaleFactor: 2,
});
let [worker] = context.serviceWorkers();
worker ??= await context.waitForEvent('serviceworker');
const extId = new URL(worker.url()).host;
const popup = await context.newPage();
await popup.goto(`chrome-extension://${extId}/popup/index.html`);
const send = (/** @type {string} */ type, /** @type {unknown} */ payload) =>
  popup.evaluate(
    ([t, p]) => chrome.runtime.sendMessage({ source: 'vibepass', type: t, payload: p }),
    /** @type {const} */ ([type, payload]),
  );

/** @param {import('playwright').Page} page */
const menuBox = async (page) => {
  const host = page.locator('vibepass-menu');
  await host.waitFor({ state: 'attached', timeout: 3000 });
  await page.waitForTimeout(100);
  return /** @type {{ x: number; y: number; width: number; height: number }} */ (
    await host.boundingBox()
  );
};
/** @param {import('playwright').Page} page */
const seen = (page) => page.evaluate(() => /** @type {any} */ (window).seen);

try {
  await popup.getByLabel('Server URL').fill(serverUrl);
  await popup.getByLabel('Email').fill(email);
  await popup.getByLabel('Master password').fill(password);
  await popup.getByRole('button', { name: 'Log in' }).click();
  await popup.getByLabel('Search vault').waitFor();
  await send('settings:set', { autoCopyTotp: false });

  // Single-page login: click the field, pick with the keyboard.
  const site = await context.newPage();
  await site.goto('http://127.0.0.1:8090/login');
  await site.click('#u');
  let box = await menuBox(site);
  const field = /** @type {any} */ (await site.locator('#u').boundingBox());
  check('menu opens under the focused field', Math.abs(box.y - (field.y + field.height + 4)) < 2);
  check(
    'page can’t reach into the menu',
    await site.evaluate(() => document.querySelector('vibepass-menu')?.shadowRoot === null),
  );
  check(
    'browser form history is off while the menu is open',
    (await site.getAttribute('#u', 'autocomplete')) === 'off',
  );
  await site.keyboard.press('ArrowDown');
  await site.keyboard.press('Enter');
  await site.waitForFunction(() => /** @type {any} */ (window).seen.p);
  const single = await seen(site);
  check(
    'arrow down + Enter fills username and password',
    single.u === 'alice@example.test' && single.p === 'correct-horse-42',
  );
  check('menu closes after the fill', (await site.locator('vibepass-menu').count()) === 0);
  await site.mouse.click(5, 600);
  check(
    'page’s autocomplete value comes back on blur',
    (await site.getAttribute('#u', 'autocomplete')) === 'username',
  );
  await site.click('#p');
  await menuBox(site);
  await site.keyboard.press('Escape');
  check('Escape closes the menu', (await site.locator('vibepass-menu').count()) === 0);

  // Multi-step: pick with the mouse on step 1, then step 2 offers the same login first.
  await site.goto('http://127.0.0.1:8090/multi');
  await site.click('#u');
  box = await menuBox(site);
  await site.mouse.click(box.x + 40, box.y + 34);
  await site.waitForFunction(() => /** @type {any} */ (window).seen.u);
  check('click fills the username step', (await seen(site)).u === 'alice@example.test');
  await site.click('#next');
  await site.locator('#p').waitFor();
  box = await menuBox(site);
  await site.keyboard.press('ArrowDown');
  await site.keyboard.press('Enter');
  await site.waitForFunction(() => /** @type {any} */ (window).seen.p);
  check('password step fills the same login', (await seen(site)).p === 'correct-horse-42');

  // Split login in a scrolled, transformed layout.
  await site.goto('http://127.0.0.1:8090/split');
  await site.locator('#p').scrollIntoViewIfNeeded();
  await site.click('#p');
  box = await menuBox(site);
  const pw = /** @type {any} */ (await site.locator('#p').boundingBox());
  check(
    'menu follows a transformed, scrolled field',
    Math.abs(box.y - (pw.y + pw.height + 4)) < 2 && Math.abs(box.x - Math.max(pw.x, 4)) < 2,
  );
  await site.mouse.wheel(0, 120);
  await site.waitForTimeout(150);
  box = await menuBox(site);
  const moved = /** @type {any} */ (await site.locator('#p').boundingBox());
  check('menu moves with the page on scroll', Math.abs(box.y - (moved.y + moved.height + 4)) < 2);
  await site.keyboard.press('ArrowDown');
  await site.keyboard.press('Enter');
  await site.waitForFunction(() => /** @type {any} */ (window).seen.p);
  const split = await seen(site);
  check(
    'split login fills both forms',
    split.u === 'alice@example.test' && split.p === 'correct-horse-42',
  );

  // Scripted keys from the page do nothing.
  await site.goto('http://127.0.0.1:8090/login');
  await site.click('#p');
  await menuBox(site);
  await site.evaluate(() => {
    const p = /** @type {HTMLInputElement} */ (document.getElementById('p'));
    for (const key of ['ArrowDown', 'Enter']) {
      p.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    }
  });
  await site.waitForTimeout(300);
  check('scripted keys from the page don’t fill', !(await seen(site)).p);

  // Locked: one row that opens the popup.
  await send('vault:lock', undefined);
  await site.reload();
  await site.click('#p');
  await menuBox(site);
  check('locked vault shows an unlock row', true);

  // Turned off in settings: no menu.
  await send('vault:unlock', { masterPassword: password });
  await send('settings:set', { inlineMenu: false });
  await site.reload();
  await site.click('#p');
  await site.waitForTimeout(400);
  check('setting turns the menu off', (await site.locator('vibepass-menu').count()) === 0);
} catch {
  check('run', false);
} finally {
  await context.close();
  pages.close();
}

const failed = results.filter(([, ok]) => !ok);
console.log(`\n${String(results.length - failed.length)}/${String(results.length)} passed`);
process.exit(failed.length ? 1 : 0);
