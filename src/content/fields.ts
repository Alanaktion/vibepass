/**
 * Field keyword heuristics adapted from Bitwarden's browser extension (bitwarden/clients,
 * GPL-3.0): the keyword lists in `apps/browser/src/autofill/services/autofill-constants.ts`, the
 * tokenizer and non-login tie-breaks in `utils/qualification.ts`, and the field checks in
 * `services/inline-menu-field-qualification.service.ts`. Bitwarden has refined these against
 * real sites for years, so detect.ts leans on them instead of growing its own per-site fixes.
 *
 * Bitwarden reads a snapshot of each field; this reads the live element, and keeps only the
 * login, sign-up, and one-time code parts.
 */

import { fieldAutocomplete } from './autocomplete';

// --- Keyword lists (AutoFillConstants) ---------------------------------------------------

const EMAIL_NAMES = ['email', 'email address', 'e-mail', 'e-mail address', 'email adresse'];

/** Words that name a username field outright. "login" alone is weaker: see usernameKeyword. */
const USERNAME_NAMES = [
  'username',
  'user name',
  'userid',
  'user id',
  'customer id',
  'login id',
  'benutzername',
  'benutzer name',
  'benutzerid',
  'benutzer id',
  ...EMAIL_NAMES,
];

const TOTP_NAMES = [
  '2facode',
  'approvals_code',
  'mfacode',
  'onetimecode',
  'onetimepassword',
  'otc-code',
  'otp-code',
  'otpcode',
  'second-factor',
  'security_code',
  'security code',
  'totp',
  'totpcode',
  'twofa',
  'twofactor',
  'twofactorcode',
  'verificationcode',
  'verification code',
  'otc-confirmation',
];

const RECOVERY_CODE_NAMES = ['backup', 'recovery'];
const SEARCH_NAMES = new Set(['search', 'query', 'find', 'go']);
const NEW_EMAIL_NAMES = ['new-email', 'newemail', 'new email', 'neue e-mail'];

/** Field words that mean sign up or a new password, not signing in. */
const ACCOUNT_CREATION_NAMES = [
  'register',
  'registration',
  'create password',
  'create a password',
  'create an account',
  'create account password',
  'create user password',
  'confirm password',
  'confirm account password',
  'confirm user password',
  'new user',
  'new email',
  'new e-mail',
  'new password',
  'new-password',
  'neuer benutzer',
  'neues passwort',
  'neue e-mail',
  'pwdcheck',
];

/** Strong enough on its own to say a form isn't for signing in. */
const STRONG_NON_LOGIN = ['newsletter'];
const NON_LOGIN = [...STRONG_NON_LOGIN, 'mailing list', 'subscribe', 'subscription', 'unsubscribe'];
const LOGIN_HEADINGS = ['sign in', 'signin', 'log in', 'login', 'log on', 'logon'];

const IGNORE_NAMES = ['captcha', 'findanything', 'forgot'];
const PASSWORD_TOKENS = ['password', 'passwd'];
const PASSWORD_EXCLUDE = ['hint', ...IGNORE_NAMES, ...TOTP_NAMES];
const EXCLUDED_TYPES = new Set(['hidden', 'file', 'button', 'image', 'reset', 'search']);

// --- Tokenizing (utils/qualification.ts) -------------------------------------------------

/** The full lowercased value, its words, and its words with spaces removed ("user id" → "userid"). */
function tokenize(value: string, into: Set<string>): void {
  let text = value.toLowerCase();
  into.add(text);
  text = text.replace(/-/g, '');
  for (const word of text.split(/[^\p{L}\d]+/u)) if (word) into.add(word);
  for (const word of text.replace(/\s/g, '').split(/[^\p{L}\d]+/u)) if (word) into.add(word);
}

function textOf(doc: Document, ids: string | null): string {
  if (!ids) return '';
  return ids
    .split(/\s+/)
    .map((id) => (id ? (doc.getElementById(id)?.textContent ?? '') : ''))
    .join(' ');
}

/** Everything a field says about itself: attributes, labels, and ARIA text. */
function fieldTexts(input: HTMLInputElement): string[] {
  const doc = input.ownerDocument;
  const labels = input.labels ? Array.from(input.labels, (l) => l.textContent) : [];
  return [
    input.id,
    input.name,
    input.className,
    input.type,
    input.title,
    input.placeholder,
    fieldAutocomplete(input),
    ...Object.values(input.dataset).filter((v): v is string => typeof v === 'string'),
    ...labels,
    input.getAttribute('aria-label') ?? '',
    textOf(doc, input.getAttribute('aria-labelledby')),
    textOf(doc, input.getAttribute('aria-describedby')),
  ].filter((v) => v !== '');
}

function keywordString(texts: readonly string[]): string {
  const tokens = new Set<string>();
  for (const text of texts) tokenize(text, tokens);
  return Array.from(tokens).join(',');
}

/** True when any keyword appears within the field's tokens (Bitwarden's `appearsWithin`). */
export function fieldHasKeyword(input: HTMLInputElement, keywords: readonly string[]): boolean {
  const haystack = keywordString(fieldTexts(input));
  return keywords.some((k) => haystack.includes(k.replace(/-/g, '')));
}

function formHasKeyword(form: HTMLFormElement, keywords: readonly string[]): boolean {
  const haystack = keywordString(
    [
      form.id,
      form.getAttribute('name') ?? '',
      form.getAttribute('action') ?? '',
      form.className,
    ].filter((v) => v !== ''),
  );
  return keywords.some((k) => haystack.includes(k.replace(/-/g, '')));
}

// --- Field checks (inline-menu-field-qualification.service.ts) ---------------------------

/** A search box, by its type, name, id, or placeholder words ("siteSearch", "q-query"). */
export function isSearchField(input: HTMLInputElement): boolean {
  for (const value of [input.type, input.name, input.id, input.placeholder]) {
    if (!value) continue;
    const words = value
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z]/);
    if (words.some((w) => SEARCH_NAMES.has(w))) return true;
  }
  return false;
}

/** A field that autofill should leave alone: captcha, "forgot password" lookups, site search. */
export function isIgnoredField(input: HTMLInputElement): boolean {
  if (EXCLUDED_TYPES.has(input.type) || isSearchField(input)) return true;
  return [input.id, input.name, input.placeholder].some((value) => {
    const cleaned = value.toLowerCase().replace(/[\s_-]/g, '');
    return cleaned !== '' && IGNORE_NAMES.some((name) => cleaned.includes(name));
  });
}

/** Backup or recovery codes look like one-time codes but must never get the TOTP. */
export function isRecoveryCodeField(input: HTMLInputElement): boolean {
  return fieldHasKeyword(input, RECOVERY_CODE_NAMES);
}

/** A one-time code field by Bitwarden's keyword list ("otp-code", "verificationCode"). */
export function hasTotpKeyword(input: HTMLInputElement): boolean {
  return !isIgnoredField(input) && fieldHasKeyword(input, TOTP_NAMES);
}

/** A username or email field by Bitwarden's keyword list, including German names. */
export function hasUsernameKeyword(input: HTMLInputElement): boolean {
  return fieldHasKeyword(input, USERNAME_NAMES);
}

/** Says it's for a new account, a new password, or a new email address. */
export function hasAccountCreationKeyword(input: HTMLInputElement): boolean {
  return fieldHasKeyword(input, ACCOUNT_CREATION_NAMES);
}

export function hasNewEmailKeyword(input: HTMLInputElement): boolean {
  return fieldHasKeyword(input, NEW_EMAIL_NAMES);
}

function valueIsLikePassword(value: string): boolean {
  const cleaned = value.toLowerCase().replace(/[\s_-]/g, '');
  if (!PASSWORD_TOKENS.some((t) => cleaned.includes(t))) return false;
  return !PASSWORD_EXCLUDE.some((t) => cleaned.includes(t.replace(/[\s_-]/g, '')));
}

/**
 * A text field that is really a password field: a "show password" toggle flipped its type, or
 * the site never used type=password. Its autocomplete, id, name, placeholder, or label says so.
 */
export function isLikePasswordField(input: HTMLInputElement): boolean {
  if (input.type !== 'text') return false;
  const ac = fieldAutocomplete(input);
  if (ac.includes('current-password') || ac.includes('new-password')) return true;
  if (isIgnoredField(input)) return false;
  const labels = input.labels ? Array.from(input.labels, (l) => l.textContent) : [];
  return [
    input.id,
    input.name,
    input.placeholder,
    input.getAttribute('aria-label') ?? '',
    ...labels,
  ]
    .filter((v) => v !== '')
    .some(valueIsLikePassword);
}

// --- Non-login tie-breaks (utils/qualification.ts) ---------------------------------------

function sameFormFields(input: HTMLInputElement): HTMLInputElement[] {
  const form = input.form;
  if (!form) return [input];
  return Array.from(form.elements).filter(
    (el): el is HTMLInputElement => el instanceof HTMLInputElement,
  );
}

/** A newsletter sign-up: the form, the field, or a field beside it says so. */
export function isNonLoginForm(input: HTMLInputElement): boolean {
  if (input.form && formHasKeyword(input.form, STRONG_NON_LOGIN)) return true;
  return sameFormFields(input).some((field) => fieldHasKeyword(field, STRONG_NON_LOGIN));
}

/** Headings around a field, closest first: the nearest ones inside each ancestor in turn. */
function nearbyHeadings(input: HTMLInputElement): string[] {
  const headings: string[] = [];
  const seen = new Set<Element>();
  let el: Element | null = input.form ?? input.parentElement;
  for (let depth = 0; el && depth < 6 && el !== el.ownerDocument.body; depth++) {
    for (const heading of Array.from(
      el.querySelectorAll('h1, h2, h3, h4, h5, h6, legend, [role="heading"]'),
    )) {
      if (seen.has(heading)) continue;
      seen.add(heading);
      headings.push(heading.textContent);
    }
    el = el.parentElement;
  }
  return headings;
}

/**
 * Tie-break for a lone email or username field with no password beside it: is it a newsletter
 * or mailing-list box rather than the first step of a sign-in? A nearby sign-in heading wins.
 */
export function isAmbiguousFieldNonLogin(input: HTMLInputElement): boolean {
  for (const heading of nearbyHeadings(input)) {
    const words = keywordString([heading]);
    if (LOGIN_HEADINGS.some((k) => words.includes(k))) return false;
    if (NON_LOGIN.some((k) => words.includes(k))) return true;
  }
  if (input.form && formHasKeyword(input.form, NON_LOGIN)) return true;
  return sameFormFields(input).some((field) => fieldHasKeyword(field, NON_LOGIN));
}

/** A nearby heading says "Sign in" or "Log in". */
export function hasLoginHeading(input: HTMLInputElement): boolean {
  for (const heading of nearbyHeadings(input)) {
    const words = keywordString([heading]);
    if (LOGIN_HEADINGS.some((k) => words.includes(k))) return true;
    if (NON_LOGIN.some((k) => words.includes(k))) return false;
  }
  return false;
}
