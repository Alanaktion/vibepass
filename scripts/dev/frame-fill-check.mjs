// Dev-only Playwright script, excluded from typecheck and lint (Playwright is not a dependency).
/**
 * Autofill in embedded frames: drives the built Chrome extension (dist/chrome) in Chromium
 * against a local Vaultwarden, on local https checkout pages whose card fields sit in frames
 * from other origins, the way payment providers embed them. It saves a card, an identity and a
 * login (so it writes: use a throwaway account), then checks:
 *
 * - a card split over three provider frames (one field each) plus a top-page name field
 * - a single provider frame with the whole card (Payment Element style)
 * - a frame from an unknown site asks first, and fills once confirmed
 * - transparent and covered frames are never filled
 * - a same-origin frame is filled once, by its own content script
 * - a login embedded from another site fills into its frame only when saved for that site
 *
 *   node scripts/dev/frame-fill-check.mjs <serverUrl> <email>
 *
 * Pages are served over https on 127.0.0.1:8443 with a throwaway self-signed certificate, and
 * Chromium maps shop.test, js.stripe.com, cards.unknown.test, login.test and portal.test to it.
 */
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

/** @type {typeof import('playwright')} */
const { chromium } = createRequire(import.meta.url)('playwright');

const password = process.env.VIBEPASS_TEST_PASSWORD;
const [serverUrl, email] = process.argv.slice(2);
if (!serverUrl || !email || !password) {
  console.error('Set VIBEPASS_TEST_PASSWORD and run: frame-fill-check.mjs <serverUrl> <email>');
  process.exit(2);
}
const root = fileURLToPath(new URL('../..', import.meta.url));
const results = /** @type {[string, boolean][]} */ ([]);
const check = (/** @type {string} */ name, /** @type {boolean} */ ok) => {
  results.push([name, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
};

const PORT = 8443;
const STYLE = `<style>
  body { font: 14px system-ui, sans-serif; margin: 24px; }
  iframe { border: 1px solid #c7c7cc; border-radius: 6px; width: 320px; height: 44px; display: block; margin: 6px 0; }
  .big { height: 180px; }
  input { font: inherit; padding: 7px 9px; }
</style>`;
const SEEN = `<script>
  window.seen = {};
  const note = (e) => (seen[e.target.id] = e.target.value);
  document.addEventListener('input', note, true);
  document.addEventListener('change', note, true);
</script>`;
const at = (/** @type {string} */ host, /** @type {string} */ path) =>
  `https://${host}:${String(PORT)}${path}`;

/** Stripe-like single-field frames: an input with the card autocomplete token. */
const FIELD = {
  number:
    '<input id="f" name="cardnumber" autocomplete="cc-number" placeholder="Card number" inputmode="numeric">',
  exp: '<input id="f" name="exp-date" autocomplete="cc-exp" placeholder="MM / YY">',
  cvc: '<input id="f" name="cvc" autocomplete="cc-csc" placeholder="CVC">',
};
const frameDoc = (/** @type {string} */ body) =>
  `<!doctype html><title>Field</title><style>body{margin:0}input{border:0;width:100%;font:16px system-ui;padding:10px}</style>${body}${SEEN}`;
const WHOLE_CARD = frameDoc(`
  <input id="n" autocomplete="cc-number" placeholder="Card number">
  <input id="e" autocomplete="cc-exp" placeholder="MM / YY">
  <input id="c" autocomplete="cc-csc" placeholder="CVC">`);
const page = (/** @type {string} */ body) =>
  `<!doctype html><title>Checkout</title>${STYLE}${body}${SEEN}`;
const SPLIT = page(`
  <label>Name on card <input id="ccname" autocomplete="cc-name"></label>
  <iframe id="number" src="${at('js.stripe.com', '/field/number')}"></iframe>
  <iframe id="exp" src="${at('js.stripe.com', '/field/exp')}"></iframe>
  <iframe id="cvc" src="${at('js.stripe.com', '/field/cvc')}"></iframe>`);
const PAGES = /** @type {Record<string, string>} */ ({
  '/field/number': frameDoc(FIELD.number),
  '/field/exp': frameDoc(FIELD.exp),
  '/field/cvc': frameDoc(FIELD.cvc),
  '/whole': WHOLE_CARD,
  '/split': SPLIT,
  '/element': page(
    `<p>Pay</p><iframe class="big" src="${at('js.stripe.com', '/whole')}"></iframe>`,
  ),
  '/unknown': page(
    `<p>Pay</p><iframe class="big" src="${at('cards.unknown.test', '/whole')}"></iframe>`,
  ),
  '/transparent': page(
    `<p>Pay</p><iframe class="big" style="opacity:0" src="${at('js.stripe.com', '/whole')}"></iframe>`,
  ),
  '/covered': page(`<p>Pay</p><div style="position:relative">
    <iframe class="big" src="${at('js.stripe.com', '/whole')}"></iframe>
    <div style="position:absolute;inset:0;background:#fff"></div></div>`),
  '/same-origin': page(`<p>Pay</p><iframe class="big" src="/whole"></iframe>`),
  '/portal': page(
    `<p>Sign in</p><iframe class="big" src="${at('login.test', '/login')}"></iframe>`,
  ),
  '/evil-portal': page(
    `<p>Sign in</p><iframe class="big" src="${at('evil.test', '/login')}"></iframe>`,
  ),
  '/login': frameDoc(`<form onsubmit="return false">
    <input id="u" name="username" autocomplete="username" placeholder="Email">
    <input id="p" type="password" name="password" autocomplete="current-password" placeholder="Password">
    <button>Sign in</button></form>`),
});

const certDir = await mkdtemp(join(tmpdir(), 'vp-cert-'));
execFileSync(
  'openssl',
  [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=vibepass-test',
    '-keyout',
    join(certDir, 'key.pem'),
    '-out',
    join(certDir, 'cert.pem'),
  ],
  { stdio: 'ignore' },
);
const pages = createServer(
  {
    key: await readFile(join(certDir, 'key.pem')),
    cert: await readFile(join(certDir, 'cert.pem')),
  },
  (req, res) => {
    const path = new URL(req.url ?? '/', 'https://x').pathname;
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGES[path] ?? '<p>hi</p>');
  },
);
await new Promise((resolve) => pages.listen(PORT, '127.0.0.1', () => resolve(undefined)));

const ext = await mkdtemp(join(tmpdir(), 'vibepass-ext-'));
await cp(join(root, 'dist/chrome'), ext, { recursive: true });
const manifest = JSON.parse(await readFile(join(ext, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['<all_urls>'];
await writeFile(join(ext, 'manifest.json'), JSON.stringify(manifest));

const hosts = [
  'shop.test',
  'js.stripe.com',
  'cards.unknown.test',
  'login.test',
  'evil.test',
  'portal.test',
];
const context = await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(), 'vp-')), {
  channel: 'chromium',
  ignoreDefaultArgs: ['--disable-extensions'],
  headless: true,
  ignoreHTTPSErrors: true,
  args: [
    `--disable-extensions-except=${ext}`,
    `--load-extension=${ext}`,
    `--host-resolver-rules=${hosts.map((h) => `MAP ${h} 127.0.0.1`).join(', ')}`,
    '--ignore-certificate-errors',
    '--no-proxy-server',
  ],
  viewport: { width: 760, height: 700 },
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
const tabIdOf = (/** @type {string} */ url) =>
  popup.evaluate(
    async (u) => (await chrome.tabs.query({})).find((t) => t.url?.startsWith(u))?.id,
    url,
  );
const seenIn = (/** @type {import('playwright').Frame} */ frame) =>
  frame.evaluate(() => /** @type {any} */ (window).seen);
/** The page's frames from one origin, in document order. */
const framesOf = (/** @type {import('playwright').Page} */ p, /** @type {string} */ host) =>
  p.frames().filter((f) => f !== p.mainFrame() && new URL(f.url()).hostname === host);

const draft = (/** @type {number} */ type, /** @type {Record<string, unknown>} */ extra) => ({
  type,
  name: '',
  notes: '',
  favorite: false,
  folderId: null,
  reprompt: false,
  login: null,
  card: null,
  identity: null,
  fields: [],
  ...extra,
});

/** Open a page, let its frames register, and return it with its tab id. */
const open = async (/** @type {import('playwright').Page} */ site, /** @type {string} */ url) => {
  await site.goto(url);
  await site.waitForLoadState('load');
  await site.waitForTimeout(700);
  return /** @type {number} */ (await tabIdOf(url));
};

try {
  await popup.getByLabel('Server URL').fill(serverUrl);
  await popup.getByLabel('Email').fill(email);
  await popup.getByLabel('Master password').fill(password);
  await popup.getByRole('button', { name: 'Log in' }).click();
  await popup.getByLabel('Search vault').waitFor();
  await send('settings:set', { allowEdits: true });

  const card = await send('vault:save', {
    id: null,
    draft: draft(3, {
      name: 'Travel Visa',
      card: {
        cardholderName: 'Alice Example',
        brand: 'Visa',
        number: '4111111111111111',
        expMonth: '4',
        expYear: '2031',
        code: '737',
      },
    }),
  });
  const login = await send('vault:save', {
    id: null,
    draft: draft(1, {
      name: 'Login test',
      login: {
        username: 'alice@login.test',
        password: 'frame-secret',
        totp: '',
        uris: [{ uri: 'https://login.test', match: null }],
      },
    }),
  });
  check('saved a card and a login', card.ok && login.ok);

  const site = await context.newPage();

  // Split fields: a top-page name and three single-field provider frames.
  let tabId = await open(site, at('shop.test', '/split'));
  const forms = await send('autofill:inspect', { tabId });
  check('popup learns a split card form is a card form', forms.ok && forms.data.card);
  let result = await send('autofill:fill', { tabId, id: card.data.id });
  await site.waitForTimeout(300);
  const [numberFrame, expFrame, cvcFrame] = framesOf(site, 'js.stripe.com');
  const split = {
    name: (await seenIn(site.mainFrame())).ccname,
    number: numberFrame ? (await seenIn(numberFrame)).f : undefined,
    exp: expFrame ? (await seenIn(expFrame)).f : undefined,
    cvc: cvcFrame ? (await seenIn(cvcFrame)).f : undefined,
  };
  check(
    `split frames: name, number, expiry, code each land in their own frame (${JSON.stringify(split)})`,
    result.ok &&
      split.name === 'Alice Example' &&
      split.number === '4111111111111111' &&
      split.exp === '04/31' &&
      split.cvc === '737',
  );

  // The inline menu on the top page's name field fills the frames too.
  await open(site, at('shop.test', '/split'));
  await site.click('#ccname');
  await site.locator('vibepass-menu').waitFor({ state: 'attached', timeout: 3000 });
  await site.waitForTimeout(150);
  await site.keyboard.press('ArrowDown');
  await site.keyboard.press('Enter');
  await site.waitForTimeout(500);
  const cvcAfterMenu = framesOf(site, 'js.stripe.com')[2];
  check(
    'inline menu on the top page fills the provider frames',
    cvcAfterMenu !== undefined && (await seenIn(cvcAfterMenu)).f === '737',
  );

  // One provider frame with the whole card.
  tabId = await open(site, at('shop.test', '/element'));
  result = await send('autofill:fill', { tabId, id: card.data.id });
  await site.waitForTimeout(300);
  const whole = framesOf(site, 'js.stripe.com')[0];
  const wholeSeen = whole ? await seenIn(whole) : {};
  check(
    'whole card in one provider frame',
    result.ok && wholeSeen.n === '4111111111111111' && wholeSeen.c === '737',
  );

  // A frame from a site Vibepass doesn't know asks first.
  tabId = await open(site, at('shop.test', '/unknown'));
  const asked = await send('autofill:fill', { tabId, id: card.data.id });
  const unknown = framesOf(site, 'cards.unknown.test')[0];
  check(
    `unknown frame site: asks first (${asked.error ?? ''})`,
    asked.code === 'fill-mismatch' &&
      Array.isArray(asked.details?.frames) &&
      unknown !== undefined &&
      !(await seenIn(unknown)).n,
  );
  result = await send('autofill:fill', {
    tabId,
    id: card.data.id,
    confirmedFrames: asked.details?.frames ?? [],
  });
  await site.waitForTimeout(300);
  check(
    'unknown frame site: fills once confirmed',
    result.ok && unknown !== undefined && (await seenIn(unknown)).n === '4111111111111111',
  );

  // Hidden frames never get the card.
  for (const path of ['/transparent', '/covered']) {
    tabId = await open(site, at('shop.test', path));
    result = await send('autofill:fill', { tabId, id: card.data.id });
    await site.waitForTimeout(300);
    const hidden = framesOf(site, 'js.stripe.com')[0];
    check(
      `${path.slice(1)} frame: refused (${result.error ?? 'filled'})`,
      !result.ok && hidden !== undefined && !(await seenIn(hidden)).n,
    );
  }

  // A same-origin frame is filled from the top page, once.
  tabId = await open(site, at('shop.test', '/same-origin'));
  const inner = site.frames().find((f) => f !== site.mainFrame());
  await inner?.evaluate(() => {
    /** @type {any} */ (window).inputs = 0;
    document.addEventListener('input', () => /** @type {any} */ (window).inputs++, true);
  });
  result = await send('autofill:fill', { tabId, id: card.data.id });
  await site.waitForTimeout(300);
  const innerSeen = inner ? await seenIn(inner) : {};
  const inputs = inner ? await inner.evaluate(() => /** @type {any} */ (window).inputs) : -1;
  check(
    `same-origin frame filled once (${String(inputs)} input events, ${result.error ?? 'ok'}, ${JSON.stringify(innerSeen)})`,
    result.ok && innerSeen.n === '4111111111111111' && inputs > 0 && inputs <= 6,
  );

  // A login embedded from another site fills into its frame when saved for that site.
  tabId = await open(site, at('portal.test', '/portal'));
  result = await send('autofill:fill', { tabId, id: login.data.id });
  await site.waitForTimeout(300);
  const loginFrame = framesOf(site, 'login.test')[0];
  const loginSeen = loginFrame ? await seenIn(loginFrame) : {};
  check(
    'embedded login fills into the frame it is saved for',
    result.ok && loginSeen.u === 'alice@login.test' && loginSeen.p === 'frame-secret',
  );
  tabId = await open(site, at('portal.test', '/evil-portal'));
  result = await send('autofill:fill', { tabId, id: login.data.id });
  const evilFrame = framesOf(site, 'evil.test')[0];
  check(
    'embedded login from another site asks first',
    result.code === 'fill-mismatch' && evilFrame !== undefined && !(await seenIn(evilFrame)).p,
  );
} catch (error) {
  console.error(error);
  check('run', false);
} finally {
  await context.close();
  pages.close();
}

const failed = results.filter(([, ok]) => !ok);
console.log(`\n${String(results.length - failed.length)}/${String(results.length)} passed`);
process.exit(failed.length ? 1 : 0);
