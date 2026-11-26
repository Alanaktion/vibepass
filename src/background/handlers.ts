import { log } from '../shared/log';
import type { SearchIndex } from '../search';
import type { Runtime } from '../shared/browser';
import type { Settings } from '../storage/settings';
import type { VaultState } from '../vault/state';
import type { Handlers } from './router';
import type { VaultService } from './service';
import type { createAutofill } from './autofill';
import type { createPasskeys } from './passkeys';

export interface BackgroundContext {
  vault: VaultState;
  search: SearchIndex;
  service: VaultService;
  autofill?: ReturnType<typeof createAutofill>;
  passkeys?: ReturnType<typeof createPasskeys>;
  clipboard?: { scheduleClear(): Promise<void> };
  settings?: {
    load(): Promise<Settings>;
    save(patch: Partial<Settings>): Promise<Settings>;
  };
  /** Open the toolbar popup, for the inline menu's "unlock" row. */
  openPopup?: () => Promise<void>;
  now?: () => number;
}

/** The tab of a content script in a tab's top frame; the inline menu is refused anywhere else. */
function topFrameTab(sender: Runtime.MessageSender): { tabId: number; url: string } {
  const tabId = sender.tab?.id;
  if (tabId === undefined || sender.frameId !== 0 || sender.url === undefined) {
    throw new Error('Untrusted sender');
  }
  return { tabId, url: sender.url };
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
    'autofill:menu': async (_request, sender) => {
      const { tabId, url } = topFrameTab(sender);
      // Restores an unlocked vault after the worker restarted, like the popup does.
      await service.status();
      return need(ctx.autofill, 'Autofill').menu(tabId, url);
    },
    'autofill:menu-fill': ({ id }, sender) => {
      const { tabId } = topFrameTab(sender);
      return need(ctx.autofill, 'Autofill').fillFromMenu(tabId, id);
    },
    'autofill:open-popup': async (_request, sender) => {
      topFrameTab(sender);
      await need(ctx.openPopup, 'Popup')();
      return undefined;
    },

    'autofill:submitted': (login, sender) => {
      const { tabId, url } = topFrameTab(sender);
      return need(ctx.autofill, 'Autofill').submitted(tabId, url, login);
    },
    'autofill:pending-prompt': async (_request, sender) => {
      const { tabId, url } = topFrameTab(sender);
      await service.status();
      const autofill = need(ctx.autofill, 'Autofill');
      return { prompt: autofill.pendingPrompt(tabId, url), offer: await autofill.offersToSave() };
    },
    'autofill:save-answer': (reply, sender) => {
      const { tabId, url } = topFrameTab(sender);
      return need(ctx.autofill, 'Autofill').answer(tabId, url, reply);
    },
    'autofill:generate': async ({ rules }, sender) => {
      topFrameTab(sender);
      return { password: await service.generatePassword({ rules }) };
    },

    'passkey:get-options': (request, sender) => {
      const { url } = topFrameTab(sender);
      return need(ctx.passkeys, 'Passkeys').getOptions(url, request);
    },
    'passkey:get': ({ request, cipherId, credentialId }, sender) => {
      const { url } = topFrameTab(sender);
      return need(ctx.passkeys, 'Passkeys').get(url, request, cipherId, credentialId);
    },
    'passkey:create-options': (request, sender) => {
      const { url } = topFrameTab(sender);
      return need(ctx.passkeys, 'Passkeys').createOptions(url, request);
    },
    'passkey:create': ({ request, cipherId }, sender) => {
      const { url } = topFrameTab(sender);
      return need(ctx.passkeys, 'Passkeys').create(url, request, cipherId);
    },

    'vault:edit': ({ id, masterPassword }) => service.editable(id, masterPassword),
    'vault:save': async (request) => ({ id: await service.saveItem(request) }),
    'vault:organize': ({ id, ...patch }) => service.organize(id, patch).then(() => undefined),
    'vault:trash-item': ({ id }) => service.trashItem(id).then(() => undefined),
    'vault:restore': ({ id }) => service.restoreItem(id).then(() => undefined),
    'vault:delete-forever': ({ id }) => service.deleteItem(id).then(() => undefined),
    'vault:trash': async () => {
      await service.status();
      return [...service.trash()];
    },
    'vault:folders': async () => {
      await service.status();
      return [...service.folders()];
    },
    'folder:create': ({ name }) => service.createFolder(name),
    'folder:rename': ({ id, name }) => service.renameFolder(id, name).then(() => undefined),
    'folder:delete': ({ id }) => service.deleteFolder(id).then(() => undefined),
    'generator:options': () => service.generatorOptions(),
    'generator:generate': async ({ options }) => ({
      password: await service.generatePassword({ options }),
    }),
    'generator:history': () => service.generatorHistory(),
    'generator:clear-history': () => service.clearGeneratorHistory().then(() => undefined),

    'clipboard:copied': () =>
      need(ctx.clipboard, 'Clipboard')
        .scheduleClear()
        .then(() => undefined),
    'settings:get': () => need(ctx.settings, 'Settings').load(),
    'settings:set': (patch) => need(ctx.settings, 'Settings').save(patch),
  };
}
