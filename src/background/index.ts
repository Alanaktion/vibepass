/**
 * Background service worker (Chrome) / background script (Firefox).
 *
 * Owns auth, sync, and the decrypted vault in memory. The popup and content scripts talk to it
 * only through the typed messages in src/shared/messages.ts.
 */
import browser from '../shared/browser';
import { log } from '../shared/log';
import { createSearchIndex } from '../search';
import { VaultState } from '../vault/state';
import { createHandlers } from './handlers';
import { createRouter } from './router';

const AUTO_LOCK_ALARM = 'vibepass:auto-lock';

const vault = new VaultState();
const search = createSearchIndex();
const route = createRouter(createHandlers({ vault, search }), browser.runtime.id);

// Listeners must be registered synchronously at the top level so an MV3 worker that is woken
// by an event can receive it.
browser.runtime.onMessage.addListener(route);

browser.runtime.onInstalled.addListener(({ reason }) => {
  log.debug('installed', { reason });
});

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTO_LOCK_ALARM) {
    vault.lock();
    search.clear();
  }
});

browser.commands.onCommand.addListener((command) => {
  log.debug('command', { command });
});
