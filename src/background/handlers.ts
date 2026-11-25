import { log } from '../shared/log';
import type { SearchIndex } from '../search';
import type { Settings } from '../storage/settings';
import type { VaultState } from '../vault/state';
import type { Handlers } from './router';
import type { VaultService } from './service';
import type { createAutofill } from './autofill';

export interface BackgroundContext {
  vault: VaultState;
  search: SearchIndex;
  service: VaultService;
  autofill?: ReturnType<typeof createAutofill>;
  clipboard?: { scheduleClear(): Promise<void> };
  settings?: {
    load(): Promise<Settings>;
    save(patch: Partial<Settings>): Promise<Settings>;
  };
  now?: () => number;
}

/** Opening the popup checks for vault changes, at most this often. */
const POPUP_SYNC_INTERVAL_MS = 60_000;

/** Message handlers. They stay thin: VaultService owns the order of operations. */
export function createHandlers(ctx: BackgroundContext): Handlers {
  const { vault, search, service } = ctx;
  const now = ctx.now ?? (() => Date.now());
  let lastPopupSync = 0;
  const need = <T>(value: T | undefined, what: string): T => {
    if (value === undefined) throw new Error(`${what} is not available`);
    return value;
  };

  return {
    'vault:status': async () => {
      const status = await service.status();
      if (status.state === 'unlocked' && now() - lastPopupSync > POPUP_SYNC_INTERVAL_MS) {
        lastPopupSync = now();
        void service.backgroundSync();
      }
      return status;
    },
    'vault:login': (request) => service.login(request),
    'vault:send-login-email': (request) => service.sendLoginEmail(request).then(() => undefined),
    'vault:resend-device-code': (request) =>
      service.resendDeviceCode(request).then(() => undefined),
    'vault:unlock': ({ masterPassword }) => service.unlock(masterPassword),
    'vault:lock': () => service.lock(),
    'vault:logout': () => service.logout(),
    'vault:sync': () => service.sync(),

    'vault:search': async ({ query, url }) => {
      await service.status();
      if (!vault.isUnlocked) return [];
      return search.search(query, url === undefined ? {} : { url });
    },
    'vault:item': ({ id }) => service.item(id),
    'vault:reveal': ({ id, fieldId, masterPassword }) =>
      service.reveal(id, fieldId, masterPassword),
    'vault:totp': ({ id, masterPassword }) => service.totp(id, masterPassword),
    'vault:attachment': ({ id, attachmentId, masterPassword }) =>
      service.attachment(id, attachmentId, masterPassword),

    'autofill:fill': (request) => need(ctx.autofill, 'Autofill').fill(request),
    'autofill:page-ready': ({ loginForms }, sender) => {
      log.debug('page ready', { tabId: sender.tab?.id ?? -1, loginForms });
      return undefined;
    },

    'clipboard:copied': () =>
      need(ctx.clipboard, 'Clipboard')
        .scheduleClear()
        .then(() => undefined),
    'settings:get': () => need(ctx.settings, 'Settings').load(),
    'settings:set': (patch) => need(ctx.settings, 'Settings').save(patch),
  };
}
