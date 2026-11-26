// Firefox's WebDriver BiDi installs the unsigned add-on temporarily in a disposable profile.
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const { firefox } = createRequire(import.meta.url)('playwright');
const [serverUrl, email] = process.argv.slice(2);
const masterPassword = process.env.VIBEPASS_TEST_PASSWORD;
if (!serverUrl || new URL(serverUrl).hostname !== '127.0.0.1' || !email || !masterPassword) {
  throw new Error('Use a seeded loopback server, test email, and VIBEPASS_TEST_PASSWORD');
}

// Only the temporary extension reads the fixture. The loopback receiver accepts a pass/fail
// signal with a random path. It never serves credentials or receives vault data.
const token = randomUUID();
let finish;
const result = new Promise((resolve) => {
  finish = resolve;
});
const receiver = createServer((req, res) => {
  const ok = req.method === 'POST' && req.url === '/' + token;
  res.writeHead(ok ? 204 : 404).end();
  if (ok) finish(req.headers['x-result'] === 'passed');
});
const scratch = await mkdtemp(join(tmpdir(), 'vibepass-firefox-'));
let context;
try {
  await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  const endpoint = 'http://127.0.0.1:' + receiver.address().port + '/' + token;
  const extension = join(scratch, 'extension');
  const profile = join(scratch, 'profile');
  await mkdir(profile);
  await cp(new URL('../../dist/firefox/', import.meta.url), extension, { recursive: true });
  const manifestPath = join(extension, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.host_permissions = ['http://127.0.0.1/*'];
  manifest.background.scripts.push('open-test-popup.js');
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(
    join(extension, 'open-test-popup.js'),
    "browser.tabs.create({url: browser.runtime.getURL('popup/index.html')});",
  );
  const popupPath = join(extension, 'popup/index.html');
  await writeFile(
    popupPath,
    (await readFile(popupPath, 'utf8')).replace(
      '</body>',
      '<script type="module" src="../check.js"></script></body>',
    ),
  );

  // Run in the real popup origin so Firefox exercises runtime messages, WASM, session storage
  // and IndexedDB with the same extension principal as a normal login.
  async function exercise(fixture, endpoint) {
    const send = async (type, payload) => {
      const reply = await browser.runtime.sendMessage({ source: 'vibepass', type, payload });
      if (!reply.ok) throw Error('Worker operation failed');
      return reply.data;
    };
    let passed = false;
    try {
      const status = await send('vault:login', fixture);
      if (status.itemCount !== 5 || status.state !== 'unlocked') throw Error('Unexpected vault');
      await send('vault:lock');
      if ((await send('vault:status')).state !== 'locked') throw Error('Lock failed');
      await send('vault:unlock', { masterPassword: fixture.masterPassword });
      const hits = await send('vault:search', { query: 'Local Test Site' });
      if (!hits.some((hit) => hit.name === 'Local Test Site')) throw Error('Missing search hit');
      await send('vault:logout');
      passed = true;
    } finally {
      await fetch(endpoint, {
        method: 'POST',
        headers: { 'x-result': passed ? 'passed' : 'failed' },
      });
    }
  }
  await writeFile(
    join(extension, 'check.js'),
    '(' +
      exercise.toString() +
      ')(' +
      JSON.stringify({ serverUrl, email, masterPassword }) +
      ',' +
      JSON.stringify(endpoint) +
      ');',
    { mode: 0o600 },
  );
  context = await firefox.launchPersistentContext(profile, {
    headless: true,
    args: ['--remote-debugging-port', '0'],
  });
  const { ws_port } = JSON.parse(await readFile(join(profile, 'WebDriverBiDiServer.json'), 'utf8'));
  const socket = new WebSocket('ws://127.0.0.1:' + ws_port + '/session');
  try {
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = reject;
    });
    let id = 0;
    async function command(method, params) {
      const callId = ++id;
      const response = new Promise((resolve, reject) => {
        socket.onmessage = ({ data }) => {
          const reply = JSON.parse(data);
          if (reply.id !== callId) return;
          if (reply.type === 'error') reject(Error(method + ' failed: ' + reply.error));
          else resolve(reply.result);
        };
        socket.onclose = () => reject(Error('Firefox closed the connection'));
      });
      socket.send(JSON.stringify({ id: callId, method, params }));
      return response;
    }
    const run = async () => {
      await command('session.new', { capabilities: {} });
      await command('webExtension.install', { extensionData: { type: 'path', path: extension } });
      if (!(await result)) throw Error('Firefox vault check failed');
    };
    await Promise.race([
      run(),
      delay(45_000, undefined, { ref: false }).then(() => {
        throw Error('Firefox check timed out');
      }),
    ]);
    console.log('PASS Firefox login, five-item sync, lock, unlock, and search');
  } finally {
    socket.close();
  }
} finally {
  await context?.close();
  receiver.close();
  await rm(scratch, { recursive: true, force: true });
}
