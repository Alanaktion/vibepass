/**
 * Autofill v1, worker side. A fill only starts from a user gesture (popup Enter, the fill
 * shortcut, or a trusted click or Enter in the page's inline menu). The worker checks which page
 * the tab is on, that the item is saved for it, and only then sends the username and password to
 * that tab's top frame, for that origin only.
 *
 * Cards and identities have no URLs, so they fill into any page's payment or address form, on
 * the same gestures. A card only goes to a page with a secure connection unless the user
 * confirms in the popup.
 */
import { CodedError } from '../shared/errors';
import type {
  CardFill,
  ContentRequest,
  FillResult,
  InlineMenuItem,
  InlineMenuState,
  PageInfo,
  SaveAnswer,
  SavePrompt,
  SubmittedLogin,
} from '../shared/messages';
import type { SearchIndex } from '../search';
import type { Settings } from '../storage/settings';
import { isInsecureDowngrade, matchItem, MatchQuality, parseUri } from '../vault/match';
import { newDraft } from '../vault/encrypt';
import { CipherType } from '../vault/types';
import type { VaultState } from '../vault/state';
import type { CipherSummary } from '../vault/types';
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
  now?: () => number;
}

/**
 * How long a fill counts as the start of a multi-step login, so the next step (the password page
 * after the username page) offers the same login first.
 */
export const RECENT_FILL_MS = 5 * 60_000;

/** How long after a form submit the page (or the page it led to) still offers to save. */
export const SAVE_PROMPT_MS = 2 * 60_000;

export interface FillRequest {
  tabId: number;
  id: string;
  confirmedOrigin?: string | undefined;
  masterPassword?: string | undefined;
  /** The popup's session, which may already have passed the re-prompt. */
  session?: string | undefined;
}

export function createAutofill(deps: AutofillDeps) {
  const now = deps.now ?? (() => Date.now());
  /** Last item filled per tab. Item ids only, never secrets. */
  const recent = new Map<number, { id: string; at: number }>();

  function recentFor(tabId: number): string | null {
    const entry = recent.get(tabId);
    if (!entry) return null;
    if (now() - entry.at > RECENT_FILL_MS) {
      recent.delete(tabId);
      return null;
    }
    return entry.id;
  }

  /** Logins saved for the page, ranked, with the one just filled in this tab first. */
  function loginsFor(tabId: number, url: string) {
    const page = deps.search.pageFor(url);
    if (!page) return [];
    const matches = deps.search
      .matchesFor(url, true)
      .filter((m) => m.type === CipherType.Login && !isInsecureDowngrade(m.uris, page));
    const last = recentFor(tabId);
    const index = matches.findIndex((m) => m.id === last);
    if (index > 0) matches.unshift(...matches.splice(index, 1));
    return matches.map((m) => ({ hit: m, recent: m.id === last }));
  }

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

  /** A page a card may go to without asking: https, or a local development server. */
  function isSecurePage(url: URL): boolean {
    if (url.protocol === 'https:') return true;
    return (
      url.protocol === 'http:' &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')
    );
  }

  /** Fill a card or identity into the page's payment or address form. */
  async function fillForm(request: FillRequest, summary: CipherSummary): Promise<FillResult> {
    const isCard = summary.type === CipherType.Card;
    const info = await inspect(request.tabId);
    const page = deps.search.pageFor(info.url);
    if (!page) throw new Error('Vibepass only fills web pages');
    if (request.confirmedOrigin !== undefined && request.confirmedOrigin !== page.url.origin) {
      throw new Error('The page changed. Start the fill again.');
    }
    if (isCard && request.confirmedOrigin === undefined && !isSecurePage(page.url)) {
      throw new CodedError(`${page.url.origin} isn’t using a secure connection`, 'fill-mismatch', {
        origin: page.url.origin,
      });
    }
    const { item } = await deps.service.fillData(request.id, {
      masterPassword: request.masterPassword,
      session: request.session,
    });
    const card: CardFill | null =
      isCard && item.card
        ? {
            cardholderName: item.card.cardholderName,
            brand: item.card.brand,
            number: item.card.number,
            expMonth: item.card.expMonth,
            expYear: item.card.expYear,
            code: item.card.code,
          }
        : null;
    const result = (await deps.tabs.send(request.tabId, {
      source: 'vibepass',
      type: 'content:fill-form',
      origin: page.url.origin,
      card,
      identity: isCard ? null : { ...item.identity },
    })) as { filled?: unknown } | undefined;
    const filled = Array.isArray(result?.filled) ? (result.filled as string[]) : [];
    return { filled, copiedTotp: false };
  }

  async function fill(request: FillRequest): Promise<FillResult> {
    const summary = deps.vault.summary(request.id);
    if (!summary) throw new CodedError('Vibepass is locked', 'locked');
    if (summary.type === CipherType.Card || summary.type === CipherType.Identity) {
      return fillForm(request, summary);
    }
    if (summary.type !== CipherType.Login) {
      throw new Error('Only logins, cards, and identities can be filled');
    }

    const info = await inspect(request.tabId);
    const page = deps.search.pageFor(info.url);
    if (!page) throw new Error('Vibepass only fills web pages');
    if (request.confirmedOrigin !== undefined && request.confirmedOrigin !== page.url.origin) {
      throw new Error('The page changed. Start the fill again.');
    }
    if (request.confirmedOrigin === undefined) {
      if (matchItem(summary.uris, page) === MatchQuality.None) {
        throw new CodedError(
          `“${summary.name}” isn’t saved for ${page.url.origin}`,
          'fill-mismatch',
          { origin: page.url.origin },
        );
      }
      if (isInsecureDowngrade(summary.uris, page)) {
        throw new CodedError(
          `${page.url.origin} isn’t using a secure connection, but this login is saved for https`,
          'fill-mismatch',
          { origin: page.url.origin },
        );
      }
    }

    const { item, totp } = await deps.service.fillData(request.id, {
      masterPassword: request.masterPassword,
      session: request.session,
    });
    const result = (await deps.tabs.send(request.tabId, {
      source: 'vibepass',
      type: 'content:fill',
      origin: page.url.origin,
      username: item.login?.username ?? null,
      password: item.login?.password ?? null,
      totp: totp?.code ?? null,
    })) as { filled?: unknown } | undefined;
    const filled = Array.isArray(result?.filled) ? (result.filled as string[]) : [];
    if (filled.length > 0) {
      for (const [tab, entry] of recent) if (now() - entry.at > RECENT_FILL_MS) recent.delete(tab);
      recent.set(request.tabId, { id: request.id, at: now() });
    }

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
    const best = loginsFor(tabId, info.url)[0]?.hit;
    if (!best || best.reprompt) return false;
    await fill({ tabId, id: best.id });
    return true;
  }

  /** What the inline menu should list for a page. The caller checks the vault is current. */
  async function menu(tabId: number, url: string): Promise<InlineMenuState> {
    if (!(await deps.settings()).inlineMenu) return { state: 'off' };
    if (!deps.vault.isUnlocked) return { state: 'locked' };
    const items: InlineMenuItem[] = loginsFor(tabId, url).map(({ hit, recent: isRecent }) => ({
      id: hit.id,
      name: hit.name,
      username: hit.subtitle,
      reprompt: hit.reprompt,
      recent: isRecent,
    }));
    const settings = await deps.settings();
    const row =
      (type: 'card' | 'identity') =>
      (hit: CipherSummary): InlineMenuItem => ({
        id: hit.id,
        name: hit.name,
        username: hit.subtitle,
        reprompt: hit.reprompt,
        recent: false,
        type,
      });
    return {
      state: 'unlocked',
      items,
      canGenerate: true,
      offerToSave: settings.allowEdits && settings.offerToSave,
      ...(settings.inlineMenuCards
        ? {
            cards: deps.search.ofType(CipherType.Card).map(row('card')),
            identities: deps.search.ofType(CipherType.Identity).map(row('identity')),
          }
        : {}),
    };
  }

  /**
   * A pick in the inline menu. Same checks as any fill (the item must be saved for the page),
   * never forced, and never for a re-prompt item: the popup asks for the master password.
   */
  async function fillFromMenu(tabId: number, id: string): Promise<FillResult> {
    if (!(await deps.settings()).inlineMenu) throw new Error('The inline menu is turned off');
    const summary = deps.vault.summary(id);
    if (summary?.reprompt) {
      const what =
        summary.type === CipherType.Card
          ? 'card'
          : summary.type === CipherType.Identity
            ? 'identity'
            : 'login';
      throw new CodedError(`Open Vibepass to fill this ${what}`, 'reprompt-required');
    }
    if (
      (summary?.type === CipherType.Card || summary?.type === CipherType.Identity) &&
      !(await deps.settings()).inlineMenuCards
    ) {
      throw new Error('Cards and identities are turned off in the inline menu');
    }
    return fill({ tabId, id });
  }

  // --- Save and update banner -------------------------------------------------------------

  interface Pending {
    /** Registrable domain of the page that submitted. */
    domain: string;
    origin: string;
    username: string | null;
    /** The password to save. Lives only in worker memory, for SAVE_PROMPT_MS, while unlocked. */
    password: string;
    prompt: SavePrompt;
    at: number;
  }
  const pending = new Map<number, Pending>();
  /** Sites the user said "never" for, until the browser restarts. Domains only. */
  const never = new Set<string>();

  function clearPending(): void {
    pending.clear();
  }

  function pendingFor(tabId: number, url: string): Pending | null {
    const entry = pending.get(tabId);
    const page = parseUri(url);
    if (!entry || !page) return null;
    if (now() - entry.at > SAVE_PROMPT_MS || !deps.vault.isUnlocked) {
      pending.delete(tabId);
      return null;
    }
    return entry.domain === page.domain ? entry : null;
  }

  /**
   * A login form was submitted. Decide whether to offer saving a new login or updating the
   * password of a saved one, and remember the credentials until the user answers.
   */
  async function submitted(
    tabId: number,
    url: string,
    login: SubmittedLogin,
  ): Promise<SavePrompt | null> {
    const settings = await deps.settings();
    if (!settings.offerToSave || !settings.allowEdits || !deps.vault.isUnlocked) return null;
    const page = parseUri(url);
    const secret = login.newPassword ?? login.password;
    if (!page || !secret || never.has(page.domain)) return null;
    if (page.url.protocol !== 'https:' && page.url.protocol !== 'http:') return null;
    const username = login.username?.trim() ?? null;

    const saved = [];
    for (const { hit } of loginsFor(tabId, url)) {
      saved.push({ hit, ...(await deps.service.credentials(hit.id)) });
    }
    // Already saved as is: nothing to ask.
    if (saved.some((s) => s.password === secret && (!username || s.username === username))) {
      return null;
    }
    // A password change names the old password, which identifies the login best; otherwise
    // the username does.
    const byOldPassword =
      login.newPassword && login.password ? saved.filter((s) => s.password === login.password) : [];
    const byUsername = username ? saved.filter((s) => (s.username ?? '') === username) : [];
    const candidates = byOldPassword.length > 0 ? byOldPassword : byUsername;

    const host = page.url.hostname;
    const prompt: SavePrompt =
      candidates.length > 0
        ? {
            kind: 'update',
            host,
            username: username ?? candidates[0]?.username ?? null,
            items: candidates.map((c) => ({
              id: c.hit.id,
              name: c.hit.name,
              username: c.hit.subtitle,
            })),
          }
        : { kind: 'save', host, username, suggestedName: host.replace(/^www\./, '') };
    for (const [tab, entry] of pending) if (now() - entry.at > SAVE_PROMPT_MS) pending.delete(tab);
    pending.set(tabId, {
      domain: page.domain,
      origin: page.url.origin,
      username,
      password: secret,
      prompt,
      at: now(),
    });
    return prompt;
  }

  /** The banner to show on a page that just loaded, if a submit in this tab is waiting. */
  function pendingPrompt(tabId: number, url: string): SavePrompt | null {
    return pendingFor(tabId, url)?.prompt ?? null;
  }

  /** Whether a page should send submitted logins at all. */
  async function offersToSave(): Promise<boolean> {
    const settings = await deps.settings();
    return deps.vault.isUnlocked && settings.allowEdits && settings.offerToSave;
  }

  /** The user answered the banner (a trusted click on the page, checked by the content script). */
  async function answer(
    tabId: number,
    url: string,
    reply: SaveAnswer,
  ): Promise<{ message: string }> {
    const entry = pendingFor(tabId, url);
    if (!entry) throw new Error('Nothing to save here anymore');
    if (reply.action === 'dismiss' || reply.action === 'never') {
      pending.delete(tabId);
      if (reply.action === 'never') never.add(entry.domain);
      return { message: '' };
    }
    if (reply.action === 'update') {
      if (entry.prompt.kind !== 'update' || !entry.prompt.items.some((i) => i.id === reply.id)) {
        throw new Error('That login can’t be updated from this page');
      }
      await deps.service.updatePassword(reply.id, entry.password);
      pending.delete(tabId);
      return { message: 'Password updated' };
    }
    const draft = newDraft(CipherType.Login);
    draft.name = reply.name.trim() || entry.prompt.host;
    draft.login = {
      username: entry.username ?? '',
      password: entry.password,
      totp: '',
      uris: [{ uri: entry.origin, match: null }],
    };
    await deps.service.saveItem({ id: null, draft });
    pending.delete(tabId);
    return { message: 'Saved to Vibepass' };
  }

  return {
    fill,
    fillBest,
    fillFromMenu,
    inspect,
    menu,
    submitted,
    pendingPrompt,
    offersToSave,
    answer,
    clearPending,
  };
}
