/**
 * Autofill v1, worker side. A fill only starts from a user gesture (popup Enter or the fill
 * shortcut). The worker checks which page the tab is on, that the item is saved for it, and only
 * then sends the username and password to that tab's top frame, for that origin only.
 */
import { CodedError } from '../shared/errors';
import type { ContentRequest, FillResult, PageInfo } from '../shared/messages';
import type { SearchIndex } from '../search';
import type { Settings } from '../storage/settings';
import { isInsecureDowngrade, matchItem, MatchQuality, parseUri } from '../vault/match';
import { CipherType } from '../vault/types';
import type { VaultState } from '../vault/state';
import type { VaultService } from './service';

export interface TabsApi {
  /** Message the tab's top frame content script. */
  send(tabId: number, message: ContentRequest): Promise<unknown>;
  /** Inject the content script into a tab opened before the extension was installed. */
  inject(tabId: number): Promise<void>;
}

export interface AutofillDeps {
  vault: VaultState;
  search: SearchIndex;
  service: VaultService;
  tabs: TabsApi;
  settings(): Promise<Settings>;
  copy(text: string): Promise<void>;
}

export interface FillRequest {
  tabId: number;
  id: string;
  force?: boolean | undefined;
  masterPassword?: string | undefined;
}

export function createAutofill(deps: AutofillDeps) {
  async function inspect(tabId: number): Promise<PageInfo> {
    const ask = () => deps.tabs.send(tabId, { source: 'vibepass', type: 'content:inspect' });
    let info: unknown;
    try {
      info = await ask();
    } catch {
      try {
        await deps.tabs.inject(tabId);
        info = await ask();
      } catch {
        throw new Error('Vibepass can’t fill this page. Reload it and try again.');
      }
    }
    if (typeof info !== 'object' || info === null || typeof (info as PageInfo).url !== 'string') {
      throw new Error('Vibepass can’t fill this page. Reload it and try again.');
    }
    return info as PageInfo;
  }

  async function fill(request: FillRequest): Promise<FillResult> {
    const summary = deps.vault.summary(request.id);
    if (!summary) throw new CodedError('Vibepass is locked', 'locked');
    if (summary.type !== CipherType.Login) throw new Error('Only logins can be filled for now');

    const info = await inspect(request.tabId);
    const page = parseUri(info.url);
    if (!page) throw new Error('Vibepass only fills web pages');
    if (!request.force) {
      if (matchItem(summary.uris, page) === MatchQuality.None) {
        throw new CodedError(
          `“${summary.name}” isn’t saved for ${page.url.hostname}`,
          'fill-mismatch',
          { host: page.url.hostname },
        );
      }
      if (isInsecureDowngrade(summary.uris, page)) {
        throw new CodedError(
          `${page.url.hostname} isn’t using a secure connection, but this login is saved for https`,
          'fill-mismatch',
          { host: page.url.hostname },
        );
      }
    }

    const { item, totp } = await deps.service.fillData(request.id, request.masterPassword);
    const result = (await deps.tabs.send(request.tabId, {
      source: 'vibepass',
      type: 'content:fill',
      origin: page.url.origin,
      username: item.login?.username ?? null,
      password: item.login?.password ?? null,
      totp: totp?.code ?? null,
    })) as { filled?: unknown } | undefined;
    const filled = Array.isArray(result?.filled) ? (result.filled as string[]) : [];

    let copiedTotp = false;
    if (totp && !filled.includes('totp') && (await deps.settings()).autoCopyTotp) {
      await deps.copy(totp.code);
      copiedTotp = true;
    }
    return { filled, copiedTotp };
  }

  /**
   * The fill shortcut: fill the best match for the tab. Returns false when the user needs the
   * popup instead (locked, no match, several equally good matches, or a re-prompt item).
   */
  async function fillBest(tabId: number): Promise<boolean> {
    if (!deps.vault.isUnlocked) return false;
    const info = await inspect(tabId);
    const matches = deps.search.matchesFor(info.url).filter((m) => m.type === CipherType.Login);
    const best = matches[0];
    if (!best || best.reprompt) return false;
    await fill({ tabId, id: best.id });
    return true;
  }

  return { fill, fillBest, inspect };
}
