// Dev-only Playwright script, excluded from typecheck and lint (Playwright is not a dependency).
/**
 * Card and identity fill check: drives the built Chrome extension (dist/chrome) in Chromium
 * against a local Vaultwarden, with real (trusted) input on local checkout pages. It saves a
 * card, a re-prompt card, and an identity (so it writes: use a throwaway account), then checks
 * the inline menu and popup fills, the insecure-page question, and the re-prompt.
 *
 *   node scripts/dev/form-fill-check.mjs <serverUrl> <email> [screenshotDir]
 *
 * Pages are served on 127.0.0.1:8090, and as http://shop.test:8090 for a page without a secure
 * connection (Chromium maps that name to 127.0.0.1).
 */
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

/** @type {typeof import('playwright')} */
const { chromium } = createRequire(import.meta.url)('playwright');

const password = process.env.VIBEPASS_TEST_PASSWORD;
const [serverUrl, email, shots] = process.argv.slice(2);
if (!serverUrl || !email || !password) {
  console.error('Set VIBEPASS_TEST_PASSWORD and run: form-fill-check.mjs <serverUrl> <email>');
  process.exit(2);
}
const root = fileURLToPath(new URL('../..', import.meta.url));
const results = /** @type {[string, boolean][]} */ ([]);
const check = (/** @type {string} */ name, /** @type {boolean} */ ok) => {
  results.push([name, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
};

const MONTHS = Array.from(
  { length: 12 },
  (_, i) =>
    `<option value="${String(i + 1)}">${String(i + 1).padStart(2, '0')} - ${new Date(2000, i).toLocaleString('en', { month: 'short' })}</option>`,
).join('');
const STYLE = `<style>
  body { font: 14px system-ui, sans-serif; margin: 32px; color: #1c1c1e; }
  form { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 16px; max-width: 560px; }
  h2 { grid-column: 1 / -1; margin: 16px 0 0; font-size: 16px; }
  label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #555; }
  input, select { font: inherit; padding: 7px 9px; border: 1px solid #c7c7cc; border-radius: 6px; }
  .wide { grid-column: 1 / -1; }
</style>`;
const SEEN = `<script>
  window.seen = {};
  const note = (e) => (seen[e.target.id] = e.target.value);
  document.addEventListener('input', note, true);
  document.addEventListener('change', note, true);
</script>`;
const CHECKOUT = `<!doctype html><title>Checkout</title>${STYLE}
  <form onsubmit="return false">
    <h2>Shipping address</h2>
    <label>First name <input id="first" name="firstName" autocomplete="shipping given-name"></label>
    <label>Last name <input id="last" name="lastName" autocomplete="shipping family-name"></label>
    <label class="wide">Address <input id="street" name="address1" autocomplete="shipping address-line1"></label>
    <label>City <input id="city" name="city" autocomplete="shipping address-level2"></label>
    <label>State <select id="state" name="state" autocomplete="shipping address-level1">
      <option value="">Choose…</option><option value="CA">California</option><option value="NY">New York</option>
    </select></label>
    <label>ZIP <input id="zip" name="zip" autocomplete="shipping postal-code"></label>
    <label>Country <select id="country" name="country" autocomplete="shipping country">
      <option value="CA">Canada</option><option value="US">United States</option>
    </select></label>
    <label class="wide">Email <input id="email" type="email" name="email"></label>
    <h2>Payment</h2>
    <label class="wide">Name on card <input id="ccname" name="ccname"></label>
    <label class="wide">Card number <input id="ccnum" name="cardnumber" inputmode="numeric"></label>
    <label>Expiry month <select id="ccmm" name="exp-month"><option value="">MM</option>${MONTHS}</select></label>
    <label>Expiry year <select id="ccyy" name="exp-year"><option value="">YYYY</option>
      <option>2029</option><option>2030</option><option>2031</option></select></label>
    <label>Security code <input id="cvc" name="securityCode" maxlength="4"></label>
  </form>${SEEN}`;
// Stripe-style: one expiry box with its format in the placeholder.
const STRIPE = `<!doctype html><title>Pay</title>${STYLE}
  <form onsubmit="return false">
    <label class="wide">Card number <input id="n" name="cardnumber" placeholder="1234 1234 1234 1234"></label>
    <label>Expiration <input id="e" name="exp-date" placeholder="MM / YY"></label>
    <label>CVC <input id="c" name="cvc" placeholder="CVC"></label>
  </form>${SEEN}`;
const PAGES = { '/checkout': CHECKOUT, '/stripe': STRIPE };
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
if (shots) await mkdir(shots, { recursive: true });

const context = await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(), 'vp-')), {
  channel: 'chromium',
  ignoreDefaultArgs: ['--disable-extensions'],
  headless: true,
  args: [
    `--disable-extensions-except=${ext}`,
    `--load-extension=${ext}`,
    '--host-resolver-rules=MAP shop.test 127.0.0.1',
  ],
  viewport: { width: 760, height: 900 },
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
const tabIdOf = (/** @type {string} */ url) =>
  popup.evaluate(
    async (u) => (await chrome.tabs.query({})).find((t) => t.url?.startsWith(u))?.id,
    url,
  );

/** @param {import('playwright').Page} page */
const menuBox = async (page) => {
  const host = page.locator('vibepass-menu');
  await host.waitFor({ state: 'attached', timeout: 3000 });
  await page.waitForTimeout(150);
  return /** @type {{ x: number; y: number; width: number; height: number }} */ (
    await host.boundingBox()
  );
};
/** The menu's text, read through its closed shadow root from the browser's accessibility tree. */
const menuText = async (/** @type {import('playwright').Page} */ page) => {
  const cdp = await context.newCDPSession(page);
  const { nodes } = /** @type {{ nodes: { name?: { value?: string } }[] }} */ (
    await cdp.send('Accessibility.getFullAXTree')
  );
  await cdp.detach();
  return nodes.map((n) => n.name?.value ?? '').join(' ');
};
/** @param {import('playwright').Page} page */
const seen = (page) => page.evaluate(() => /** @type {any} */ (window).seen);

const blankCard = {
  cardholderName: '',
  brand: '',
  number: '',
  expMonth: '',
  expYear: '',
  code: '',
};
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
const IDENTITY_FIELDS = [
  'title',
  'firstName',
  'middleName',
  'lastName',
  'address1',
  'address2',
  'address3',
  'city',
  'state',
  'postalCode',
  'country',
  'company',
  'email',
  'phone',
  'ssn',
  'username',
  'passportNumber',
  'licenseNumber',
];

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
        ...blankCard,
        cardholderName: 'Alice Example',
        brand: 'Visa',
        number: '4111111111111111',
        expMonth: '4',
        expYear: '2031',
        code: '737',
      },
    }),
  });
  const guarded = await send('vault:save', {
    id: null,
    draft: draft(3, {
      name: 'Company Amex',
      reprompt: true,
      card: {
        ...blankCard,
        brand: 'Amex',
        number: '378282246310005',
        expMonth: '12',
        expYear: '2030',
        code: '1234',
      },
    }),
  });
  const identity = await send('vault:save', {
    id: null,
    draft: draft(4, {
      name: 'Home address',
      identity: {
        ...Object.fromEntries(IDENTITY_FIELDS.map((f) => [f, ''])),
        firstName: 'Alice',
        lastName: 'Example',
        address1: '1 Main St',
        city: 'Springfield',
        state: 'California',
        postalCode: '90210',
        country: 'US',
        email: 'alice@example.test',
      },
    }),
  });
  check('saved a card, a re-prompt card, and an identity', card.ok && guarded.ok && identity.ok);

  const site = await context.newPage();
  await site.goto('http://127.0.0.1:8090/checkout');

  // Inline menu on an address field: identities, then fill with the keyboard.
  await site.click('#first');
  await menuBox(site);
  const identityMenu = await menuText(site);
  check(
    'address field offers identities, not cards',
    /Home address/.test(identityMenu) && !/Visa/.test(identityMenu),
  );
  if (shots) await site.screenshot({ path: join(shots, 'identity-menu.png') });
  await site.keyboard.press('ArrowDown');
  await site.keyboard.press('Enter');
  await site.waitForFunction(() => /** @type {any} */ (window).seen.city);
  let values = await seen(site);
  check(
    'identity fills names, street, city, state and country drop-downs, ZIP',
    values.first === 'Alice' &&
      values.last === 'Example' &&
      values.street === '1 Main St' &&
      values.city === 'Springfield' &&
      values.state === 'CA' &&
      values.zip === '90210' &&
      values.country === 'US',
  );
  check('identity leaves the payment fields alone', !values.ccnum && !values.ccname);

  // Inline menu on the card number: cards, pick with the mouse.
  await site.click('#ccnum');
  await menuBox(site);
  const cardMenu = await menuText(site);
  check(
    'card field offers cards, with the re-prompt one marked',
    /Travel Visa/.test(cardMenu) &&
      /Company Amex/.test(cardMenu) &&
      /asks for master password/.test(cardMenu),
  );
  if (shots) await site.screenshot({ path: join(shots, 'card-menu.png') });
  // Rows sort by name: Company Amex, then Travel Visa.
  await site.keyboard.press('ArrowDown');
  await site.keyboard.press('ArrowDown');
  await site.keyboard.press('Enter');
  await site.waitForFunction(() => /** @type {any} */ (window).seen.cvc);
  values = await seen(site);
  check(
    'card fills name, number, month and year drop-downs, security code',
    values.ccname === 'Alice Example' &&
      values.ccnum === '4111111111111111' &&
      values.ccmm === '4' &&
      values.ccyy === '2031' &&
      values.cvc === '737',
  );
  if (shots) await site.screenshot({ path: join(shots, 'checkout-filled.png') });

  // The security code box is the card's, not a one-time password.
  await site.fill('#cvc', '');
  await site.click('#cvc');
  await menuBox(site);
  check('security code field offers cards too', /Travel Visa/.test(await menuText(site)));
  await site.keyboard.press('Escape');

  // Popup fill: the worker checks the re-prompt; the popup asks for the password once.
  const tabId = await tabIdOf('http://127.0.0.1:8090/checkout');
  const forms = await send('autofill:inspect', { tabId });
  check(
    'popup learns the page has card and address forms',
    forms.ok && forms.data.card && forms.data.identity,
  );
  const refused = await send('autofill:fill', { tabId, id: guarded.data.id });
  check('re-prompt card needs the master password', refused.code === 'reprompt-required');
  const allowed = await send('autofill:fill', {
    tabId,
    id: guarded.data.id,
    masterPassword: password,
  });
  values = await seen(site);
  check(
    're-prompt card fills after the password',
    allowed.ok && values.ccnum === '378282246310005' && values.cvc === '1234',
  );

  // One expiry box: follows the placeholder's format.
  await site.goto('http://127.0.0.1:8090/stripe');
  await site.click('#n');
  await menuBox(site);
  await site.keyboard.press('ArrowDown');
  await site.keyboard.press('ArrowDown');
  await site.keyboard.press('Enter');
  await site.waitForFunction(() => /** @type {any} */ (window).seen.c);
  values = await seen(site);
  check(
    'single expiry box gets MM/YY',
    values.n === '4111111111111111' && values.e === '04/31' && values.c === '737',
  );

  // A page without a secure connection: the menu says why, the popup asks first.
  await site.goto('http://shop.test:8090/stripe');
  await site.click('#n');
  await menuBox(site);
  await site.keyboard.press('ArrowDown');
  await site.keyboard.press('ArrowDown');
  await site.keyboard.press('Enter');
  await site.waitForTimeout(400);
  check(
    'insecure page: menu explains instead of filling',
    /secure connection/.test(await menuText(site)) && !(await seen(site)).n,
  );
  if (shots) await site.screenshot({ path: join(shots, 'insecure-page.png') });
  const insecureTab = await tabIdOf('http://shop.test:8090/stripe');
  const asked = await send('autofill:fill', { tabId: insecureTab, id: card.data.id });
  check('insecure page: popup fill asks first', asked.code === 'fill-mismatch');
  const confirmed = await send('autofill:fill', {
    tabId: insecureTab,
    id: card.data.id,
    confirmedOrigin: 'http://shop.test:8090',
  });
  check(
    'insecure page: fills once confirmed',
    confirmed.ok && (await seen(site)).n === '4111111111111111',
  );

  // The popup's suggestions for the checkout page.
  if (shots) {
    await site.goto('http://127.0.0.1:8090/checkout');
    await site.click('#ccnum');
    await site.keyboard.press('Escape');
    const view = await context.newPage();
    await view.setViewportSize({ width: 360, height: 580 });
    const checkoutTab = await tabIdOf('http://127.0.0.1:8090/checkout');
    // The popup asks for the active tab; point it at the checkout page.
    await view.addInitScript((id) => {
      const query = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = async (q) => {
        const tabs = await query({});
        return tabs.filter((t) => t.id === id);
      };
    }, checkoutTab);
    await view.goto(`chrome-extension://${extId}/popup/index.html`);
    await view.getByText('Suggested for this form').waitFor({ timeout: 5000 });
    await view.waitForTimeout(300);
    await view.screenshot({ path: join(shots, 'popup-suggestions.png') });
    check('popup suggests cards and identities for the form', true);
  }

  // Turned off in settings: no card menu.
  await send('settings:set', { inlineMenuCards: false });
  await site.goto('http://127.0.0.1:8090/checkout');
  await site.click('#ccnum');
  await site.waitForTimeout(500);
  check(
    'setting turns card and identity rows off',
    (await site.locator('vibepass-menu').count()) === 0,
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
