import { NotImplementedError } from '../shared/errors';
import { log } from '../shared/log';
import type { SearchIndex } from '../search';
import type { VaultState } from '../vault/state';
import type { Handlers } from './router';

export interface BackgroundContext {
  vault: VaultState;
  search: SearchIndex;
}

/**
 * Message handlers. Unlock and sync are stubs until the API client and crypto land (Phase 0).
 */
export function createHandlers({ vault, search }: BackgroundContext): Handlers {
  return {
    'vault:status': () => vault.status(),

    'vault:unlock': () => {
      // Phase 0: prelogin -> deriveMasterKey -> token login -> decryptUserKey -> sync -> index.
      throw new NotImplementedError('vault:unlock');
    },

    'vault:lock': () => {
      vault.lock();
      search.clear();
      return vault.status();
    },

    'vault:sync': () => {
      throw new NotImplementedError('vault:sync');
    },

    'vault:search': ({ query, url }) => {
      if (!vault.isUnlocked) return [];
      return search.search(query, url === undefined ? {} : { url });
    },

    'autofill:page-ready': ({ loginForms }, sender) => {
      log.debug('page ready', { tabId: sender.tab?.id ?? -1, loginForms });
      return undefined;
    },
  };
}
