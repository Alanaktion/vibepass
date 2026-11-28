import { verifyPasskeyUser } from './passkey-verification';
/**
 * Background service worker (Chrome) / background script (Firefox).
 *
 * Owns auth, sync, and the decrypted vault in memory. The popup and content scripts talk to it
 * only through the typed messages in src/shared/messages.ts.
 */
import { ApiClient } from '../api';
import browser from '../shared/browser';
import { writeClipboardText } from '../shared/clipboard';
import { log } from '../shared/log';
import type { OffscreenRequest, StatusEvent } from '../shared/messages';
import { createSearchIndex } from '../search';
import {
  clearAccount,
  deviceId,
  loadAccount,
  rememberedTwoFactor,
  saveAccount,
} from '../storage/account';
import { generatorStore } from '../storage/generator';
import { sessionStore } from '../storage/session';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type Settings } from '../storage/settings';
import { vaultCache } from '../storage/vault-cache';
import { VaultState } from '../vault/state';
import { createAutofill } from './autofill';
import { createPasskeys } from './passkeys';
import { AUTO_LOCK_ALARM, createAutoLock } from './autolock';
import { CLIPBOARD_ALARM, createClipboard } from './clipboard';
import { createHandlers } from './handlers';
import { listenForPopups } from './reprompt';
import { createRouter } from './router';
import { VaultService } from './service';

const SYNC_ALARM = 'vibepass:sync';
const SYNC_PERIOD_MINUTES = 5;
const FILL_COMMAND = 'fill-login';

// Settings are read often (every clipboard copy and idle event), so keep a copy in memory.
let settingsCache: Promise<Settings> = loadSettings().catch(() => DEFAULT_SETTINGS);
const settings = () => settingsCache;

const vault = new VaultState();
const search = createSearchIndex();
const service = new VaultService(vault, search, {
  createApi: (serverUrl) => new ApiClient({ baseUrl: serverUrl }),
  account: { load: loadAccount, save: saveAccount, clear: clearAccount, deviceId },
  session: sessionStore,
  cache: vaultCache,
  remembered: rememberedTwoFactor,
  device: __BROWSER__ === 'firefox' ? { type: 3, name: 'firefox' } : { type: 2, name: 'chrome' },
  writesEnabled: async () => (await settings()).allowEdits,
  generator: generatorStore,
  now: () => Date.now(),
  onStatus: (status) => {
    // A login waiting for the save banner must not outlive the unlocked vault.
    if (status.state !== 'unlocked') autofill.clearPending();
    const event: StatusEvent = { source: 'vibepass', type: 'event:status', payload: status };
    // No popup open is the normal case, so a missing receiver is not an error.
    browser.runtime.sendMessage(event).catch(() => undefined);
  },
});

/** Chrome workers have no DOM: write the clipboard through an offscreen document. */
async function writeClipboard(text: string): Promise<void> {
  if (__BROWSER__ === 'firefox') return writeClipboardText(text);
  const offscreen = (globalThis as { chrome?: { offscreen?: ChromeOffscreen } }).chrome?.offscreen;
  if (!offscreen) throw new Error('Clipboard is not available');
  if (!(await offscreen.hasDocument())) {
    await offscreen
      .createDocument({
        url: 'offscreen/index.html',
        reasons: ['CLIPBOARD'],
        justification: 'Clear copied passwords from the clipboard after a timeout',
      })
      .catch((error: unknown) => {
        // Two copies racing to create it is fine; anything else is not.
        if (!(error instanceof Error && /single offscreen/i.test(error.message))) throw error;
      });
  }
  const request: OffscreenRequest = { source: 'vibepass', type: 'offscreen:write-clipboard', text };
  const reply: unknown = await browser.runtime.sendMessage(request);
  if (!reply || typeof reply !== 'object' || !('ok' in reply) || reply.ok !== true) {
    throw new Error('Could not write the clipboard');
  }
}

interface ChromeOffscreen {
  hasDocument(): Promise<boolean>;
  createDocument(options: { url: string; reasons: string[]; justification: string }): Promise<void>;
}

const clipboard = createClipboard({
  write: writeClipboard,
  clearAfterSeconds: async () => (await settings()).clipboardClearSeconds,
  now: () => Date.now(),
  alarms: {
    create: (name, info) => browser.alarms.create(name, info),
    clear: (name) => browser.alarms.clear(name),
  },
  store: {
    get: (key) => browser.storage.session.get(key),
    set: (items) => browser.storage.session.set(items),
    remove: (key) => browser.storage.session.remove(key),
  },
});

const autofill = createAutofill({
  vault,
  search,
  service,
  settings,
  copy: (text) => clipboard.copy(text),
  tabs: {
    send: (tabId, message) => browser.tabs.sendMessage(tabId, message, { frameId: 0 }),
    inject: async (tabId) => {
      await browser.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    },
  },
});

const passkeys = createPasskeys({
  vault,
  search,
  service,
  settings,
  verify: (origin) => verifyPasskeyUser(origin, (password) => service.verifyPassword(password)),
});

const autoLock = createAutoLock({
  idle: browser.idle,
  settings,
  lock: () => service.lock(),
  alarms: {
    create: (name, info) => void browser.alarms.create(name, info),
    clear: (name) => browser.alarms.clear(name),
  },
});

const route = createRouter(
  createHandlers({
    vault,
    search,
    service,
    autofill,
    passkeys,
    clipboard,
    settings: { load: settings, save: saveSettings },
    openPopup: () => browser.action.openPopup(),
  }),
  browser.runtime.id,
  browser.runtime.getURL(''),
);

// Listeners must be registered synchronously at the top level so an MV3 worker that is woken
// by an event can receive it.
browser.runtime.onMessage.addListener(route);
listenForPopups(
  browser.runtime.onConnect,
  service.grants,
  browser.runtime.id,
  browser.runtime.getURL(''),
);
autoLock.listen();

browser.runtime.onInstalled.addListener(({ reason }) => {
  log.debug('installed', { reason });
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && 'settings' in changes) {
    settingsCache = loadSettings().catch(() => DEFAULT_SETTINGS);
    void autoLock.apply();
  }
});

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTO_LOCK_ALARM) void service.lock();
  if (alarm.name === CLIPBOARD_ALARM) void clipboard.clearIfDue();
  if (alarm.name === SYNC_ALARM) void service.backgroundSync();
});

browser.commands.onCommand.addListener((command, tab) => {
  if (command !== FILL_COMMAND) return;
  void (async () => {
    const tabId =
      tab?.id ?? (await browser.tabs.query({ active: true, currentWindow: true }))[0]?.id;
    let filled = false;
    if (tabId !== undefined) {
      try {
        filled = await autofill.fillBest(tabId);
      } catch {
        log.warn('fill shortcut failed');
      }
    }
    // Locked, no match, or the item needs the master password: show the popup instead.
    if (!filled) await browser.action.openPopup().catch(() => undefined);
  })();
});

// Startup work that doesn't need to block listeners.
void autoLock.apply().catch(() => undefined);
void clipboard.clearIfDue().catch(() => undefined);
void browser.alarms.get(SYNC_ALARM).then((existing) => {
  // Re-creating an alarm restarts its period, and the worker starts often, so only create once.
  if (!existing) void browser.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_PERIOD_MINUTES });
});
