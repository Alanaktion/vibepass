import { log } from '../shared/log';
import type { SearchIndex } from '../search';
import type { VaultState } from '../vault/state';
import type { Handlers } from './router';
import type { VaultService } from './service';

export interface BackgroundContext {
  vault: VaultState;
  search: SearchIndex;
  service: VaultService;
}

/** Message handlers. They stay thin: VaultService owns the order of operations. */
export function createHandlers({ vault, search, service }: BackgroundContext): Handlers {
  return {
    'vault:status': () => service.status(),
    'vault:login': ({ serverUrl, email, masterPassword }) =>
      service.login(serverUrl, email, masterPassword),
    'vault:unlock': ({ masterPassword }) => service.unlock(masterPassword),
    'vault:lock': () => service.lock(),
    'vault:logout': () => service.logout(),
    'vault:sync': () => service.sync(),

    'vault:search': async ({ query, url }) => {
      await service.status();
      if (!vault.isUnlocked) return [];
      return search.search(query, url === undefined ? {} : { url });
    },

    'autofill:page-ready': ({ loginForms }, sender) => {
      log.debug('page ready', { tabId: sender.tab?.id ?? -1, loginForms });
      return undefined;
    },
  };
}
