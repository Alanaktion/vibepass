/**
 * Content script (top frame only). Detects login fields, reports them to the worker, and fills
 * them when the worker asks, which only happens after a user gesture in the popup or a keyboard
 * shortcut. It never holds secrets except for the moment of a fill.
 */
import browser from '../shared/browser';
import { log } from '../shared/log';
import { isContentRequest, type ContentRequest, type PageInfo } from '../shared/messages';
import { sendMessage } from '../shared/messaging';
import { detectLoginFields, fillInput } from './detect';

export function countLoginForms(root: ParentNode = document): number {
  return root.querySelectorAll('input[type="password"]').length;
}

export function inspectPage(): PageInfo {
  const fields = detectLoginFields();
  return {
    url: location.href,
    fields: {
      username: fields.username !== null,
      password: fields.password !== null,
      totp: fields.totp !== null,
    },
  };
}

export function fillPage(request: Extract<ContentRequest, { type: 'content:fill' }>): {
  filled: string[];
} {
  // The page may have navigated since the worker matched the item: refuse a different origin.
  if (location.origin !== request.origin) throw new Error('The page changed before filling');
  const fields = detectLoginFields();
  const filled: string[] = [];
  if (fields.username && request.username) {
    fillInput(fields.username, request.username);
    filled.push('username');
  }
  if (fields.password && request.password) {
    fillInput(fields.password, request.password);
    filled.push('password');
  }
  if (fields.totp && request.totp && !fields.password) {
    fillInput(fields.totp, request.totp);
    filled.push('totp');
  }
  if (filled.length === 0) throw new Error('No login fields found on this page');
  // Leave focus where the user would continue: the field after the last one we filled.
  return { filled };
}

function handle(message: unknown): Promise<unknown> | undefined {
  if (!isContentRequest(message)) return undefined;
  return Promise.resolve().then(() =>
    message.type === 'content:inspect' ? inspectPage() : fillPage(message),
  );
}

declare global {
  interface Window {
    __vibepassContent?: boolean;
  }
}

function main(): void {
  // Only the top frame; cross-origin iframes are refused by design. The flag stops a second
  // copy when the worker injects the script into a tab that already has it.
  if (window.top !== window || window.__vibepassContent) return;
  window.__vibepassContent = true;
  browser.runtime.onMessage.addListener(handle);
  sendMessage('autofill:page-ready', {
    url: location.href,
    loginForms: countLoginForms(),
  }).catch((error: unknown) => {
    log.error('page-ready failed', error);
  });
}

main();
