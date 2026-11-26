/**
 * The popup's re-prompt session. While the popup is open it keeps a port to the worker named
 * with a random id, and sends that id with requests for protected items. After the master
 * password is entered once, the worker accepts the id instead of asking again, until the popup
 * closes (the port disconnects) or the vault locks. See src/background/reprompt.ts.
 */
import browser from '../shared/browser';
import { POPUP_PORT_PREFIX } from '../shared/messages';

/** Chrome stops an idle worker after 30 seconds, which would end the grant early. */
const KEEP_ALIVE_MS = 20_000;
/** Reconnects after the worker restarts; a worker that keeps refusing gets no session. */
const MAX_RECONNECTS = 5;

let current: string | null = null;
let reconnects = 0;

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Open the session. Call once when the popup starts. */
export function startPopupSession(): void {
  const id = randomId();
  let port: ReturnType<typeof browser.runtime.connect>;
  try {
    port = browser.runtime.connect({ name: POPUP_PORT_PREFIX + id });
  } catch {
    return;
  }
  current = id;
  const ping = setInterval(() => {
    try {
      port.postMessage('ping');
    } catch {
      // Disconnected; onDisconnect handles it.
    }
  }, KEEP_ALIVE_MS);
  port.onDisconnect.addListener(() => {
    clearInterval(ping);
    if (current === id) current = null;
    // The worker restarted and forgot the grant: open a new session, and the next protected
    // item asks again.
    if (reconnects++ < MAX_RECONNECTS) setTimeout(startPopupSession, 500);
  });
}

/** The session id to send with re-prompt requests, if one is open. */
export function popupSession(): string | undefined {
  return current ?? undefined;
}
