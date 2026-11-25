/**
 * Background service worker (Chrome) / background script (Firefox).
 *
 * Owns auth, sync, and the decrypted vault in memory. The popup and content scripts talk to it
 * only through the typed messages in src/shared/messages.ts.
 */
import { ApiClient } from '../api';
import browser from '../shared/browser';
import { log } from '../shared/log';
import { createSearchIndex } from '../search';
import { clearAccount, deviceId, loadAccount, saveAccount } from '../storage/account';
import { sessionStore } from '../storage/session';
import { vaultCache } from '../storage/vault-cache';
import { VaultState } from '../vault/state';
import { createHandlers } from './handlers';
import { createRouter } from './router';
import { VaultService } from './service';

const AUTO_LOCK_ALARM = 'vibepass:auto-lock';

const vault = new VaultState();
const search = createSearchIndex();
const service = new VaultService(vault, search, {
  createApi: (serverUrl) => new ApiClient({ baseUrl: serverUrl }),
  account: { load: loadAccount, save: saveAccount, clear: clearAccount, deviceId },
  session: sessionStore,
  cache: vaultCache,
  device: __BROWSER__ === 'firefox' ? { type: 3, name: 'firefox' } : { type: 2, name: 'chrome' },
  now: () => Date.now(),
});
const route = createRouter(createHandlers({ vault, search, service }), browser.runtime.id);

// Listeners must be registered synchronously at the top level so an MV3 worker that is woken
// by an event can receive it.
browser.runtime.onMessage.addListener(route);

browser.runtime.onInstalled.addListener(({ reason }) => {
  log.debug('installed', { reason });
});

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTO_LOCK_ALARM) void service.lock();
});

browser.commands.onCommand.addListener((command) => {
  log.debug('command', { command });
});
