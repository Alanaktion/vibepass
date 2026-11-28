/**
 * The content script in a frame: a payment provider's card fields (Stripe, Braintree, Adyen),
 * possibly one field per frame, a login form embedded from another site, or a same-origin
 * frame. The top page's script doesn't read into frames, so each frame answers for itself.
 *
 * A frame here only reports what fields it has and fills when the worker asks. The worker
 * decides which frames may receive what: logins only where the frame's own origin matches the
 * login, cards and addresses only on a secure page and in frames from the same site or a known
 * payment provider (others ask first). No inline menu or save banner yet: a card field's frame
 * is often too small to draw one in.
 */
import browser from '../shared/browser';
import { log } from '../shared/log';
import {
  isContentRequest,
  type CardFieldKey,
  type ContentRequest,
  type FrameInfo,
} from '../shared/messages';
import { sendMessage } from '../shared/messaging';
import type { FormField } from './autocomplete';
import { allFields, detectLoginFields, fillInput, isUsable } from './detect';
import { fillCard, fillIdentity, findCardFields, findIdentityFields } from './forms';

function focusedField(): FormField | null {
  let el = document.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  return el instanceof HTMLInputElement ||
    el instanceof HTMLSelectElement ||
    el instanceof HTMLTextAreaElement
    ? el
    : null;
}

/** Big enough to see: a zero-size or one-pixel frame is a trap, not a form. */
function frameHasSize(): boolean {
  return window.innerWidth >= 10 && window.innerHeight >= 10;
}

interface VisibilityEntry extends IntersectionObserverEntry {
  isVisible?: boolean;
}

/**
 * Where the browser can tell (Chrome's IntersectionObserver v2), whether the field is visible
 * on screen: not transparent, not covered by something else, not clipped away. Elsewhere
 * (Firefox) only the frame's size is checked.
 */
export function fieldVisible(field: Element, timeoutMs = 400): Promise<boolean> {
  if (typeof IntersectionObserver === 'undefined') return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: boolean) => {
      if (done) return;
      done = true;
      observer?.disconnect();
      resolve(value);
    };
    let observer: IntersectionObserver | null = null;
    try {
      observer = new IntersectionObserver(
        (entries) => {
          const entry = entries[entries.length - 1] as VisibilityEntry | undefined;
          if (!entry) return;
          // No v2 support: the property is missing, so only size counts.
          finish(entry.isVisible ?? true);
        },
        { trackVisibility: true, delay: 100 } as IntersectionObserverInit,
      );
      observer.observe(field);
    } catch {
      finish(true);
      return;
    }
    // No callback (the frame isn't rendered): treat as hidden.
    setTimeout(() => {
      finish(false);
    }, timeoutMs);
  });
}

/** The fields a fill would use here, to check they can be seen. */
function fillableFields(): FormField[] {
  const login = detectLoginFields();
  const card = Object.values(findCardFields(focusedField(), document, true).fields);
  const identity = Object.values(findIdentityFields(focusedField()).fields);
  return [login.username, login.password, login.totp, ...card, ...identity].filter(
    (f): f is FormField => f !== null,
  );
}

async function visible(): Promise<boolean> {
  if (!frameHasSize()) return false;
  const fields = fillableFields();
  if (fields.length === 0) return false;
  const results = await Promise.all(fields.map((f) => fieldVisible(f)));
  return results.every(Boolean);
}

export async function inspectFrame(): Promise<FrameInfo> {
  const login = detectLoginFields();
  const anchor = focusedField();
  const cardKeys = Object.keys(findCardFields(anchor, document, true).fields) as CardFieldKey[];
  const identityKeys = Object.keys(findIdentityFields(anchor).fields);
  return {
    url: location.href,
    focused: anchor !== null,
    visible: await visible(),
    fields: {
      username: login.username !== null,
      password: login.password !== null,
      totp: login.totp !== null,
      card: cardKeys.length > 0,
      identity: identityKeys.length >= 2,
    },
    cardKeys,
    identityKeys,
  };
}

/** Fill what the worker sent, after checking the frame is still the one it checked. */
export async function fillFrame(
  request: Exclude<ContentRequest, { type: 'content:inspect' }>,
): Promise<{ filled: string[] }> {
  if (location.origin !== request.origin) throw new Error('The page changed before filling');
  // The page could have hidden or covered the frame since the worker looked.
  if (!(await visible())) throw new Error('The form isn’t visible');
  const anchor = focusedField();
  let filled: string[] = [];
  if (request.type === 'content:fill-form') {
    if (request.card) filled = fillCard(request.card, anchor, true);
    else if (request.identity) filled = fillIdentity(request.identity, anchor);
  } else {
    const fields = detectLoginFields();
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
  }
  return { filled };
}

function handle(message: unknown): Promise<unknown> | undefined {
  if (!isContentRequest(message)) return undefined;
  return message.type === 'content:inspect' ? inspectFrame() : fillFrame(message);
}

function hasFields(): boolean {
  return allFields(document).some(isUsable);
}

/**
 * Start in a frame. Tell the worker about the frame once it has form
 * fields (a payment provider builds its fields after load), so frames without forms (ads,
 * videos) never register.
 */
export function startFrame(): void {
  browser.runtime.onMessage.addListener(handle);
  const register = () => {
    sendMessage('autofill:frame-ready').catch(() => {
      log.debug('frame-ready failed');
    });
  };
  if (hasFields()) {
    register();
    return;
  }
  let pending = false;
  const observer = new MutationObserver(() => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      if (!hasFields()) return;
      observer.disconnect();
      register();
    }, 200);
  });
  observer.observe(document, { childList: true, subtree: true, attributes: true });
  // Stop watching a frame that never grows a form.
  setTimeout(() => {
    observer.disconnect();
  }, 60_000);
}
