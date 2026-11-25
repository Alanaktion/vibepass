/**
 * Content script. Scaffold only: counts password fields and tells the background worker.
 *
 * The autofill engine will live here: form detection (login, signup, password change),
 * an inline menu rendered in a closed shadow DOM, and fill-on-user-gesture. It never
 * receives secrets until the user picks an item to fill.
 */
import { sendMessage } from '../shared/messaging';
import { log } from '../shared/log';

export function countLoginForms(root: ParentNode = document): number {
  return root.querySelectorAll('input[type="password"]').length;
}

function main(): void {
  // Only run in the top frame for now; cross-origin iframes are refused by default.
  if (window.top !== window) return;
  sendMessage('autofill:page-ready', {
    url: location.href,
    loginForms: countLoginForms(),
  }).catch((error: unknown) => {
    log.error('page-ready failed', error);
  });
}

main();
