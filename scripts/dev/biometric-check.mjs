// Dev-only Playwright script, excluded from typecheck and lint (Playwright is not a dependency).
/**
 * Live check for biometric unlock: drives the built Chrome extension (dist/chrome) against a
 * local Vaultwarden, with Chrome's virtual WebAuthn authenticator (internal transport, user
 * verification, PRF) standing in for Touch ID or Windows Hello. Sets up biometric unlock from the
 * extension's own origin, then checks that unlocking asks the saved passkey and refuses a wrong
 * PRF output or a device without the passkey.
 *
 *   node scripts/dev/biometric-check.mjs <serverUrl> <email>
 */
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
/** @type {typeof import('playwright')} */
const { chromium } = require('playwright');

const password = process.env.VIBEPASS_TEST_PASSWORD;
const [serverUrl, email] = process.argv.slice(2);
if (!serverUrl || !email || !password) {
  console.error('Set VIBEPASS_TEST_PASSWORD and run: biometric-check.mjs <serverUrl> <email>');
  process.exit(2);
}
const root = fileURLToPath(new URL('../..', import.meta.url));
const results = /** @type {[string, boolean][]} */ ([]);
const check = (/** @type {string} */ name, /** @type {boolean} */ ok) => {
  results.push([name, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
};

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
    ([t, p]) =>
      chrome.runtime
        .sendMessage({ source: 'vibepass', type: t, payload: p })
        .then((r) => (r.ok ? r.data : { error: r.error })),
    /** @type {const} */ ([type, payload]),
  );

/**
 * Wait for the biometric window, give it a virtual platform authenticator, and press "Try
 * again" once the authenticator is in place (the window starts before we can attach).
 * @param {{ credentials?: any[], prf?: boolean, retry?: boolean }} options
 */
async function inWindow(options = {}) {
  const page = await context.waitForEvent('page', {
    predicate: (p) => p.url().includes('biometric='),
  });
  const cdp = await context.newCDPSession(page);
  /** @type {any[]} */
  const added = [];
  cdp.on('WebAuthn.credentialAdded', (event) => added.push(event.credential));
  await cdp.send('WebAuthn.enable', { enableUI: false });
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      ctap2Version: 'ctap2_1',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      hasPrf: options.prf ?? true,
      automaticPresenceSimulation: true,
    },
  });
  for (const credential of options.credentials ?? []) {
    await cdp.send('WebAuthn.addCredential', { authenticatorId, credential });
  }
  // The window may have started before the authenticator existed: if that attempt failed, retry.
  const closed = page.waitForEvent('close').then(() => 'closed');
  const ready = page
    .waitForFunction(
      () => {
        const button = document.querySelector('button.primary');
        return button !== null && !button.hasAttribute('disabled');
      },
      null,
      { timeout: 70_000 },
    )
    .then(
      () => 'ready',
      () => 'closed',
    );
  if ((await Promise.race([closed, ready])) === 'ready' && options.retry !== false) {
    await page.getByRole('button', { name: 'Try again' }).click();
  }
  return { page, cdp, authenticatorId, added };
}

try {
  await popup.getByLabel('Server URL', { exact: true }).fill(serverUrl);
  await popup.getByLabel('Email', { exact: true }).fill(email);
  await popup.getByLabel('Master password', { exact: true }).fill(password);
  await popup.getByRole('button', { name: 'Log in' }).click();
  await popup.getByLabel('Search vault', { exact: true }).waitFor();

  // Set up: the window makes a platform passkey and returns its PRF output.
  const enrolling = send('biometric:enroll');
  const first = await inWindow();
  const enrolled = await enrolling;
  const credentials = first.added;
  check('setup turns biometric unlock on', enrolled?.biometric === true);
  check(
    'the passkey belongs to the extension origin',
    credentials[0]?.rpId === `chrome-extension://${extId}`,
  );
  check('status reports biometric unlock', (await send('vault:status')).biometric === true);

  await send('vault:lock');
  // Unlock: a fresh window, with the saved passkey copied into a new virtual authenticator.
  // Virtual authenticators can't copy a credential's PRF secret, so this copy signs but returns
  // no PRF output (or a different one): the window or the worker must refuse it. (The real Touch ID or Windows Hello keeps
  // the secret; tests/biometric.test.ts covers unlocking with the right output.)
  const unlocking = send('biometric:unlock');
  const copy = await inWindow({ credentials, retry: false });
  await copy.page.getByRole('alert').waitFor({ timeout: 70_000 });
  const message = await copy.page.getByRole('alert').textContent();
  check(
    'the saved passkey is asked, and a missing or wrong PRF output is refused',
    /didn’t unlock|didn’t return a key/.test(message ?? ''),
  );
  await copy.page.getByRole('button', { name: 'Cancel' }).click();
  const cancelled = await unlocking;
  check('cancelling reports an error to the popup', typeof cancelled?.error === 'string');
  check('the vault stays locked', (await send('vault:status')).state === 'locked');

  // Another authenticator (no saved passkey) can't unlock; cancelling leaves it locked.
  await send('vault:lock');
  const refused = send('biometric:unlock');
  const other = await inWindow({ retry: false });
  await other.page.getByRole('alert').waitFor({ timeout: 70_000 });
  await other.page.getByRole('button', { name: 'Cancel' }).click();
  const answer = await refused;
  check('a device without the passkey is refused', typeof answer?.error === 'string');
  check('the vault is still locked', (await send('vault:status')).state === 'locked');
} catch (error) {
  console.error(error);
  check('ran to the end', false);
} finally {
  await context.close();
}
const failed = results.filter(([, ok]) => !ok).length;
console.log(`${String(results.length - failed)}/${String(results.length)} passed`);
process.exit(failed ? 1 : 0);
