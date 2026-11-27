/**
 * Login form detection: a username (or email) field and a password field, plus one-time code
 * fields. Covers single-page logins, multi-step logins (a username step, then a password step),
 * and split logins (username and password in separate forms).
 */

import {
  fieldAutocomplete as autocomplete,
  restoreBrowserAutocomplete,
  suppressBrowserAutocomplete,
} from './autocomplete';
import {
  hasAccountCreationKeyword,
  hasLoginHeading,
  hasNewEmailKeyword,
  hasTotpKeyword,
  hasUsernameKeyword,
  isAmbiguousFieldNonLogin,
  isIgnoredField,
  isLikePasswordField,
  isNonLoginForm,
  isRecoveryCodeField,
} from './fields';

export { restoreBrowserAutocomplete, suppressBrowserAutocomplete };

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
    autocomplete(input),
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

/** A field's autocomplete value as detection reads it (site map role, else the page's), lowercased. */
export function fieldAutocomplete(input: HTMLInputElement): string {
  return autocomplete(input);
}

/**
 * A password field: type=password, or a text field that is one (a "show password" toggle, a
 * site map entry, or Bitwarden's password keywords). Never a one-time code or captcha box.
 */
export function isPasswordInput(input: HTMLInputElement): boolean {
  const ac = autocomplete(input);
  if (ac.includes('one-time-code')) return false;
  if (input.type === 'password') {
    if (ac.includes('current-password') || ac.includes('new-password')) return true;
    // Some sites use a password box for the one-time code or a captcha.
    return !hasTotpKeyword(input) && !isIgnoredField(input);
  }
  return isLikePasswordField(input);
}

/**
 * A field whose visible name is only "Code" (Microsoft's sign-in, which has no other hint).
 * Matched against each name on its own, so "Promo code" or "Postal code" never count.
 */
const BARE_CODE = /^\s*(enter\s+(the\s+|your\s+)?)?code\s*:?\s*$/i;

function visibleNames(input: HTMLInputElement): string[] {
  const labels = input.labels ? Array.from(input.labels, (l) => l.textContent) : [];
  return [...labels, input.placeholder, input.getAttribute('aria-label') ?? ''];
}

export function isTotpField(input: HTMLInputElement): boolean {
  if (!TEXT_TYPES.has(input.type) && input.type !== 'number') return false;
  if (autocomplete(input).includes('one-time-code')) return true;
  // Backup and recovery codes look the same, but a TOTP would burn the user's attempt.
  if (isRecoveryCodeField(input) || isIgnoredField(input)) return false;
  const maxLength = input.maxLength;
  if (maxLength > 0 && (maxLength < 4 || maxLength > 10)) return false;
  return (
    TOTP_HINT.test(hints(input)) ||
    visibleNames(input).some((n) => BARE_CODE.test(n)) ||
    hasTotpKeyword(input)
  );
}

function isUsernameCandidate(input: HTMLInputElement): boolean {
  if (!TEXT_TYPES.has(input.type) || isPasswordInput(input)) return false;
  const ac = autocomplete(input);
  if (ac.includes('username') || ac.includes('email')) return true;
  // Bitwarden's exclusions: site search, captcha, "forgot password" lookups, a new email
  // address, and newsletter boxes.
  if (isTotpField(input) || isIgnoredField(input) || hasNewEmailKeyword(input)) return false;
  if (isNonLoginForm(input)) return false;
  const text = hints(input);
  return !NOT_USERNAME_HINT.test(text) || USERNAME_HINT.test(text) || hasUsernameKeyword(input);
}

function usernameScore(input: HTMLInputElement): number {
  const ac = autocomplete(input);
  if (ac.includes('username')) return 4;
  if (ac.includes('email') || input.type === 'email') return 3;
  if (USERNAME_HINT.test(hints(input)) || hasUsernameKeyword(input)) return 2;
  return 1;
}

/** Not a new-password field, by autocomplete or by Bitwarden's sign-up words. */
function isCurrentPasswordInput(input: HTMLInputElement): boolean {
  const ac = autocomplete(input);
  if (ac.includes('current-password')) return true;
  return !ac.includes('new-password') && !hasAccountCreationKeyword(input);
}

/**
 * Find the fields to fill. The password field is the first usable one that isn't for a new
 * password; the username is the best candidate before it, in the same form when there is one.
 */
export function detectLoginFields(root: Document = document): LoginFields {
  const inputs = allInputs(root).filter(isUsable);
  const passwords = inputs.filter(isPasswordInput);
  const password =
    passwords.find((p) => autocomplete(p).includes('current-password')) ??
    passwords.find(isCurrentPasswordInput) ??
    null;

  let username: HTMLInputElement | null = null;
  const scope = password ? inputs.slice(0, inputs.indexOf(password)) : inputs;
  const all = scope.filter(isUsernameCandidate);
  if (password) {
    const sameForm = all.filter((i) => !password.form || i.form === password.form);
    // Split login: the username sits in another form (or outside it), so only take a field
    // whose type, autocomplete, name, or label says it's a username or email.
    const candidates = sameForm.length > 0 ? sameForm : all.filter((i) => usernameScore(i) >= 2);
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
    // Username-only step of a multi-step login (no password field yet): only fill a field that
    // clearly asks for it, or the one field whose name or label says "user" or "login".
    // A lone email box can be a newsletter sign-up: Bitwarden's tie-break checks the headings
    // and words around it unless the page marked the field as a username.
    // Only fields that would otherwise win pay for it (it walks the headings around them).
    const loginish = (i: HTMLInputElement) =>
      autocomplete(i).includes('username') || !isAmbiguousFieldNonLogin(i);
    const hinted = all.filter((i) => usernameScore(i) === 2);
    const onlyHinted = hinted.length === 1 ? hinted[0] : undefined;
    username =
      all.find((i) => usernameScore(i) >= 3 && loginish(i)) ??
      (onlyHinted && loginish(onlyHinted) ? onlyHinted : undefined) ??
      soleFieldUnderLoginHeading(all);
  }

  const totp = inputs.find((i) => i !== username && isTotpField(i)) ?? null;
  return { username, password, totp };
}

/**
 * The first step of a multi-step sign-in that names nothing ("Phone, email, or Skype"): the one
 * text field in its form, under a "Sign in" heading. Bitwarden treats a form's single text field
 * as a username step; requiring the heading keeps contact and search forms out.
 */
function soleFieldUnderLoginHeading(candidates: HTMLInputElement[]): HTMLInputElement | null {
  if (candidates.length !== 1) return null;
  const [only] = candidates;
  if (!only?.form) return null;
  const siblings = Array.from(only.form.elements).filter(
    (el) => el instanceof HTMLInputElement && TEXT_TYPES.has(el.type) && isUsable(el),
  );
  return siblings.length === 1 && hasLoginHeading(only) ? only : null;
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

/**
 * A password field for a new password: sign up, or the new and confirm fields of a password
 * change. The page's autocomplete says so, or the field sits with another password field in a
 * form that has no current-password field.
 */
export function isNewPasswordField(input: HTMLInputElement): boolean {
  if (!isPasswordInput(input)) return false;
  const ac = autocomplete(input);
  if (ac.includes('new-password')) return true;
  if (ac.includes('current-password')) return false;
  // "New password", "Confirm password", "Create a password" (Bitwarden's sign-up words).
  if (hasAccountCreationKeyword(input)) return true;
  const passwords = passwordFieldsNear(input);
  if (passwords.length < 2) return false;
  if (passwords.some((p) => autocomplete(p).includes('current-password'))) return false;
  // Two fields: sign up (password and confirm). Three: current, new, confirm.
  return passwords.length === 2 || passwords.indexOf(input) > 0;
}

/** Usable password fields in the input's form, or in its document when it has no form. */
function passwordFieldsNear(input: HTMLInputElement): HTMLInputElement[] {
  const scope: ParentNode = input.form ?? input.ownerDocument;
  return Array.from(scope.querySelectorAll('input')).filter(
    (p) => isUsable(p) && (p === input || isPasswordInput(p)),
  );
}

/** The password fields that should get the same new password as `input` (it and its confirm). */
export function newPasswordFields(input: HTMLInputElement): HTMLInputElement[] {
  const passwords = passwordFieldsNear(input);
  const others = passwords.filter((p) => p !== input && isNewPasswordField(p));
  return [input, ...others.filter((p) => p.value === '' || p.value === input.value)];
}

export interface SubmittedFields {
  username: string | null;
  password: string | null;
  newPassword: string | null;
}

/**
 * Read what a login, sign-up, or password-change form is submitting, at the moment of submit.
 * Returns null when there's no password in it.
 */
export function readSubmitted(scope: HTMLFormElement | Document): SubmittedFields | null {
  const inputs = (scope instanceof HTMLFormElement ? Array.from(scope.elements) : allInputs(scope))
    .filter((el): el is HTMLInputElement => el instanceof HTMLInputElement)
    .filter(isUsable);
  const passwords = inputs.filter((i) => isPasswordInput(i) && i.value !== '');
  if (passwords.length === 0) return null;

  const byAc = (hint: string) => passwords.find((p) => autocomplete(p).includes(hint)) ?? null;
  let current = byAc('current-password');
  let fresh = byAc('new-password');
  if (!current && !fresh) {
    const [first, second, third] = passwords;
    if (passwords.length === 1) current = first ?? null;
    else if (passwords.length === 2 && first && second) {
      // Same value twice: sign up with a confirm field. Different: old and new password.
      if (first.value === second.value) fresh = first;
      else [current, fresh] = [first, second];
    } else if (first && second && third) {
      [current, fresh] = [first, second.value === third.value ? second : third];
    }
  } else if (!fresh && passwords.length >= 2) {
    fresh = passwords.find((p) => p !== current) ?? null;
  }

  const firstPassword = passwords[0];
  const before = firstPassword ? inputs.slice(0, inputs.indexOf(firstPassword)) : inputs;
  let username: HTMLInputElement | null = null;
  let best = 0;
  for (const candidate of before.filter((i) => isUsernameCandidate(i) && i.value.trim())) {
    const score = usernameScore(candidate);
    if (score >= best) {
      best = score;
      username = candidate;
    }
  }
  return {
    username: username?.value.trim() ?? null,
    password: current?.value ?? null,
    newPassword: fresh && fresh !== current ? fresh.value : null,
  };
}
