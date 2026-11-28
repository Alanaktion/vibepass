import browser from '../shared/browser';
import { CipherType } from '../vault/types';
import { isCodedError } from '../shared/errors';
import { sendMessage } from '../shared/messaging';

/** Copy from the popup (it has the user gesture), then let the worker schedule the clear. */
export async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
  await sendMessage('clipboard:copied').catch(() => {
    throw new Error('Copied, but automatic clipboard clearing could not be scheduled');
  });
}

export function errorMessage(error: unknown, fallback = 'Something went wrong'): string {
  return error instanceof Error ? error.message : fallback;
}

export function isMac(): boolean {
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

/** Cmd on macOS, Ctrl elsewhere. */
export function hasMod(event: KeyboardEvent): boolean {
  return isMac() ? event.metaKey : event.ctrlKey;
}

export const modLabel = () => (isMac() ? '⌘' : 'Ctrl+');

/**
 * Whether the popup fills this item into the tab's page: logins on any web page (the worker
 * checks the site), cards and identities when the page has a form for them.
 */
export function canFillItem(
  type: CipherType,
  tab: ActiveTab | null,
  forms: { card: boolean; identity: boolean } | null,
): boolean {
  if (!tab?.url) return false;
  if (type === CipherType.Login) return true;
  if (type === CipherType.Card) return forms?.card === true;
  if (type === CipherType.Identity) return forms?.identity === true;
  return false;
}

export interface ActiveTab {
  id: number;
  url: string | undefined;
}

/** The tab the popup was opened over. activeTab grants its URL for this gesture. */
export async function activeTab(): Promise<ActiveTab | null> {
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) return null;
    return { id: tab.id, url: tab.url?.startsWith('http') ? tab.url : undefined };
  } catch {
    return null;
  }
}

/** What the user typed into the re-prompt dialog: the master password, or the PIN. */
export type RepromptAnswer = { masterPassword: string } | { pin: string };

/**
 * Asks for the master password (or the PIN, when the user allowed it) when an item has
 * re-prompt on. Components pass an `ask` function (it shows the dialog, with the last error)
 * and wrap their secret actions with `withReprompt`.
 */
export type AskPassword = (error?: string) => Promise<RepromptAnswer | null>;

/** Wrong answers ask again; anything else is a real failure. */
const RETRY = /incorrect master password|incorrect pin|too many incorrect pins/i;

export async function withReprompt<T>(
  ask: AskPassword,
  action: (answer?: RepromptAnswer) => Promise<T>,
): Promise<T | null> {
  try {
    return await action();
  } catch (error) {
    if (!isCodedError(error, 'reprompt-required')) throw error;
  }
  let lastError: string | undefined;
  for (;;) {
    const answer = await ask(lastError);
    if (answer === null) return null;
    try {
      return await action(answer);
    } catch (error) {
      if (!(error instanceof Error && RETRY.test(error.message))) throw error;
      lastError = error.message;
    }
  }
}

export function downloadBase64(fileName: string, base64: string): void {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes]));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 60_000);
}

export function iconUrl(serverUrl: string | null, host: string | null): string | null {
  if (!serverUrl || !host) return null;
  return `${serverUrl}/icons/${encodeURIComponent(host)}/icon.png`;
}
