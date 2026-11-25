/**
 * Login form detection for standard single-page logins: a username (or email) field and a
 * password field, plus one-time code fields. Heuristics only, no site-specific rules yet
 * (those come with per-site overrides in Phase 3).
 */

export interface LoginFields {
  username: HTMLInputElement | null;
  password: HTMLInputElement | null;
  totp: HTMLInputElement | null;
}

const TEXT_TYPES = new Set(['text', 'email', 'tel', '']);
const USERNAME_HINT = /user|e-?mail|login|account|ident|member|customer|handle|nick|uid/i;
const NOT_USERNAME_HINT = /search|captcha|coupon|promo|zip|postal|otp|totp|2fa|mfa|code|token/i;
const TOTP_HINT =
  /one.?time|otp|totp|2fa|mfa|two.?factor|verification.?code|auth(entication|enticator)?.?code|security.?code|sms.?code|passcode|token/i;

/** Every input in the document, including open shadow roots and same-origin iframes. */
export function allInputs(root: Document | ShadowRoot = document): HTMLInputElement[] {
  const inputs: HTMLInputElement[] = [];
  const visit = (node: Document | ShadowRoot | Element) => {
    for (const el of Array.from(node.querySelectorAll('*'))) {
      if (el instanceof HTMLInputElement) inputs.push(el);
      if (el.shadowRoot) visit(el.shadowRoot);
      if (el instanceof HTMLIFrameElement) {
        let doc: Document | null;
        try {
          // Same-origin frames only: reading a cross-origin frame throws or returns null.
          doc = el.contentDocument;
        } catch {
          doc = null;
        }
        if (doc && sameOrigin(doc)) visit(doc);
      }
    }
  };
  visit(root);
  return inputs;
}

function sameOrigin(doc: Document): boolean {
  try {
    return doc.location.origin === location.origin;
  } catch {
    return false;
  }
}

function hints(input: HTMLInputElement): string {
  const label = input.labels ? Array.from(input.labels, (l) => l.textContent).join(' ') : '';
  return [
    input.name,
    input.id,
    input.getAttribute('autocomplete') ?? '',
    input.placeholder,
    input.getAttribute('aria-label') ?? '',
    label,
  ].join(' ');
}

/** Visible and editable. Layout checks only apply when the page actually has a layout. */
export function isUsable(input: HTMLInputElement): boolean {
  if (input.disabled || input.readOnly || input.type === 'hidden') return false;
  if (input.hidden || input.closest('[hidden],[aria-hidden="true"]')) return false;
  const view = input.ownerDocument.defaultView;
  const style = view?.getComputedStyle(input);
  if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
  for (let el = input.parentElement; el; el = el.parentElement) {
    const parentStyle = view?.getComputedStyle(el);
    if (parentStyle?.display === 'none') return false;
  }
  const root = input.ownerDocument.documentElement.getBoundingClientRect();
  if (root.width > 0) {
    const rect = input.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
  }
  return true;
}

function autocomplete(input: HTMLInputElement): string {
  return (input.getAttribute('autocomplete') ?? '').toLowerCase();
}

export function isTotpField(input: HTMLInputElement): boolean {
  if (!TEXT_TYPES.has(input.type) && input.type !== 'number') return false;
  if (autocomplete(input).includes('one-time-code')) return true;
  const maxLength = input.maxLength;
  if (maxLength > 0 && (maxLength < 4 || maxLength > 10)) return false;
  return TOTP_HINT.test(hints(input));
}

function isUsernameCandidate(input: HTMLInputElement): boolean {
  if (!TEXT_TYPES.has(input.type)) return false;
  const ac = autocomplete(input);
  if (ac.includes('username') || ac.includes('email')) return true;
  if (isTotpField(input)) return false;
  const text = hints(input);
  return !NOT_USERNAME_HINT.test(text) || USERNAME_HINT.test(text);
}

function usernameScore(input: HTMLInputElement): number {
  const ac = autocomplete(input);
  if (ac.includes('username')) return 4;
  if (ac.includes('email') || input.type === 'email') return 3;
  if (USERNAME_HINT.test(hints(input))) return 2;
  return 1;
}

/**
 * Find the fields to fill. The password field is the first usable one that isn't for a new
 * password; the username is the best candidate before it, in the same form when there is one.
 */
export function detectLoginFields(root: Document = document): LoginFields {
  const inputs = allInputs(root).filter(isUsable);
  const passwords = inputs.filter((i) => i.type === 'password');
  const password =
    passwords.find((p) => autocomplete(p).includes('current-password')) ??
    passwords.find((p) => !autocomplete(p).includes('new-password')) ??
    null;

  let username: HTMLInputElement | null = null;
  const scope = password ? inputs.slice(0, inputs.indexOf(password)) : inputs;
  const candidates = scope.filter(
    (i) => isUsernameCandidate(i) && (!password?.form || i.form === password.form),
  );
  if (password) {
    // Closest preceding candidate wins ties, so a search box at the top doesn't.
    let best = -1;
    for (const candidate of candidates) {
      const score = usernameScore(candidate);
      if (score >= best) {
        best = score;
        username = candidate;
      }
    }
  } else {
    // Username-only step (no password field yet): only fill a field that clearly asks for it.
    username = candidates.find((i) => usernameScore(i) >= 3) ?? null;
  }

  const totp = inputs.find((i) => i !== username && isTotpField(i)) ?? null;
  return { username, password, totp };
}

/**
 * Set a value the way typing would, so frameworks (React, Vue, Angular) see it: the native value
 * setter, then input and change events.
 */
export function fillInput(input: HTMLInputElement, value: string): void {
  input.focus();
  // The prototype's setter bypasses frameworks' own value tracking, so they notice the change.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (setter) setter.call(input, value);
  else input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}
