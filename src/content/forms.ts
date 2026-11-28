/**
 * Payment card and address (identity) form detection and filling.
 *
 * Field classification follows Bitwarden's browser extension (bitwarden/clients, GPL-3.0): the
 * keyword lists in `apps/browser/src/autofill/services/autofill-constants.ts`
 * (CreditCardAutoFillConstants, IdentityAutoFillConstants) and the matching, expiry formatting,
 * and drop-down handling in `services/autofill.service.ts` (generateCardFillScript,
 * generateIdentityFillScript, isFieldMatch, generateCombinedExpiryValue). The page's own
 * `autocomplete` tokens, and Map the Web's address and payment-card maps, win over keywords.
 *
 * Differences from Bitwarden: the bare words "name" and "number" only mean the cardholder and
 * card number next to other card fields, a fill stays inside the form the user is in, and one
 * section (shipping or billing) is filled at a time.
 */

import type { CardFill, IdentityFill } from '../shared/messages';
import { fieldAutocomplete, type FormField } from './autocomplete';
import { allFields, fillInput, isUsable } from './detect';
import { isSearchField } from './fields';

export type CardKey =
  'cardholderName' | 'number' | 'exp' | 'expMonth' | 'expYear' | 'code' | 'brand';

export type IdentityKey =
  | 'title'
  | 'fullName'
  | 'firstName'
  | 'middleName'
  | 'lastName'
  | 'email'
  | 'phone'
  | 'company'
  | 'address'
  | 'address1'
  | 'address2'
  | 'address3'
  | 'city'
  | 'state'
  | 'postalCode'
  | 'country'
  | 'username';

export type FieldRole = { form: 'card'; key: CardKey } | { form: 'identity'; key: IdentityKey };

// --- Autocomplete tokens (HTML autofill detail tokens) ------------------------------------

const CARD_TOKENS: Partial<Record<string, CardKey>> = {
  'cc-name': 'cardholderName',
  'cc-number': 'number',
  'cc-exp': 'exp',
  'cc-exp-month': 'expMonth',
  'cc-exp-year': 'expYear',
  'cc-csc': 'code',
  'cc-type': 'brand',
};

const IDENTITY_TOKENS: Partial<Record<string, IdentityKey>> = {
  'honorific-prefix': 'title',
  name: 'fullName',
  'given-name': 'firstName',
  'additional-name': 'middleName',
  'family-name': 'lastName',
  email: 'email',
  tel: 'phone',
  'tel-national': 'phone',
  organization: 'company',
  'street-address': 'address',
  'address-line1': 'address1',
  'address-line2': 'address2',
  'address-line3': 'address3',
  'address-level2': 'city',
  'address-level1': 'state',
  'postal-code': 'postalCode',
  country: 'country',
  'country-name': 'country',
};

/** The field name token of an autocomplete value ("shipping address-line1" → "address-line1"). */
function autocompleteToken(field: FormField): string | null {
  const tokens = fieldAutocomplete(field).trim().split(/\s+/);
  for (let i = tokens.length - 1; i >= 0; i--) {
    const token = tokens[i];
    if (token && (CARD_TOKENS[token] ?? IDENTITY_TOKENS[token])) return token;
  }
  return null;
}

/** "shipping" or "billing" (or a named section) from the autocomplete value, if the page says. */
export function sectionOf(field: FormField): string | null {
  const tokens = fieldAutocomplete(field).trim().split(/\s+/);
  return (
    tokens.find((t) => t === 'shipping' || t === 'billing' || t.startsWith('section-')) ?? null
  );
}

// --- Keyword lists (CreditCardAutoFillConstants, IdentityAutoFillConstants) ---------------

const CARDHOLDER_NAMES = [
  'accountholdername',
  'cc-name',
  'card-name',
  'cardholder-name',
  'cardholder',
  'name-on-card',
  'nameoncard',
  'nom',
];
const CARDHOLDER_CONTAINS = [
  'accountholdername',
  'cc-name',
  'card-name',
  'cardholder-name',
  'cardholder',
  'name-on-card',
  'nameoncard',
];
const CARD_NUMBER_NAMES = [
  'cc-number',
  'cc-num',
  'card-number',
  'card-num',
  'cc',
  'cc-no',
  'card-no',
  'credit-card',
  'numero-carte',
  'carte',
  'carte-credit',
  'num-carte',
  'cb-num',
  'card-pan',
];
const CARD_NUMBER_CONTAINS = [
  'cc-number',
  'cc-num',
  'card-number',
  'card-num',
  'cc-no',
  'card-no',
  'numero-carte',
  'num-carte',
  'cb-num',
];
const EXPIRY_NAMES = [
  'cc-exp',
  'card-exp',
  'cc-expiration',
  'card-expiration',
  'cc-ex',
  'card-ex',
  'card-expire',
  'card-expiry',
  'validite',
  'expiration',
  'expiry',
  'mm-yy',
  'mm-yyyy',
  'yy-mm',
  'yyyy-mm',
  'expiration-date',
  'payment-card-expiration',
  'payment-cc-date',
];
const EXPIRY_CONTAINS = [
  'mm-yy',
  'mm-yyyy',
  'yy-mm',
  'yyyy-mm',
  'expiration-date',
  'payment-card-expiration',
];
const EXPIRY_MONTH_NAMES = [
  'exp-month',
  'cc-exp-month',
  'cc-month',
  'card-month',
  'cc-mo',
  'card-mo',
  'exp-mo',
  'card-exp-mo',
  'cc-exp-mo',
  'card-expiration-month',
  'expiration-month',
  'cc-mm',
  'cc-m',
  'card-mm',
  'card-m',
  'card-exp-mm',
  'cc-exp-mm',
  'exp-mm',
  'exp-m',
  'expire-month',
  'expire-mo',
  'expiry-month',
  'expiry-mo',
  'card-expire-month',
  'card-expire-mo',
  'card-expiry-month',
  'card-expiry-mo',
  'mois-validite',
  'mois-expiration',
  'm-validite',
  'm-expiration',
  'expiry-date-field-month',
  'expiration-date-month',
  'expiration-date-mm',
  'exp-mon',
  'validity-mo',
  'exp-date-mo',
  'cb-date-mois',
  'date-m',
];
const EXPIRY_YEAR_NAMES = [
  'exp-year',
  'cc-exp-year',
  'cc-year',
  'card-year',
  'cc-yr',
  'card-yr',
  'exp-yr',
  'card-exp-yr',
  'cc-exp-yr',
  'card-expiration-year',
  'expiration-year',
  'cc-yy',
  'cc-y',
  'card-yy',
  'card-y',
  'card-exp-yy',
  'cc-exp-yy',
  'exp-yy',
  'exp-y',
  'cc-yyyy',
  'card-yyyy',
  'card-exp-yyyy',
  'cc-exp-yyyy',
  'expire-year',
  'expire-yr',
  'expiry-year',
  'expiry-yr',
  'card-expire-year',
  'card-expire-yr',
  'card-expiry-year',
  'card-expiry-yr',
  'an-validite',
  'an-expiration',
  'annee-validite',
  'annee-expiration',
  'expiry-date-field-year',
  'expiration-date-year',
  'cb-date-ann',
  'expiration-date-yy',
  'expiration-date-yyyy',
  'validity-year',
  'exp-date-year',
  'date-y',
];
const CVV_NAMES = [
  'cvv',
  'cvc',
  'cvv2',
  'cc-csc',
  'cc-cvv',
  'card-csc',
  'card-cvv',
  'cvd',
  'cid',
  'cvc2',
  'cnv',
  'cvn2',
  'cc-code',
  'card-code',
  'code-securite',
  'security-code',
  'crypto',
  'card-verif',
  'verification-code',
  'csc',
  'ccv',
];
const CARD_BRAND_NAMES = ['cc-type', 'card-type', 'card-brand', 'cc-brand', 'cb-type'];

const TITLE_NAMES = ['honorific-prefix', 'prefix', 'title', 'anrede'];
const FULL_NAME_NAMES = ['name', 'full-name', 'your-name'];
const FULL_NAME_CONTAINS = ['full-name', 'your-name'];
const FIRST_NAME_NAMES = ['f-name', 'first-name', 'given-name', 'first-n', 'vorname'];
const MIDDLE_NAME_NAMES = [
  'm-name',
  'middle-name',
  'additional-name',
  'middle-initial',
  'middle-n',
  'middle-i',
];
const LAST_NAME_NAMES = [
  'l-name',
  'last-name',
  's-name',
  'surname',
  'family-name',
  'family-n',
  'last-n',
  'nachname',
  'familienname',
];
const EMAIL_NAMES = ['e-mail', 'email-address'];
const ADDRESS_NAMES = [
  'address',
  'street-address',
  'addr',
  'street',
  'mailing-addr',
  'billing-addr',
  'mail-addr',
  'bill-addr',
  'strasse',
  'adresse',
];
const ADDRESS1_NAMES = ['address-1', 'address-line-1', 'addr-1', 'street-1'];
const ADDRESS2_NAMES = ['address-2', 'address-line-2', 'addr-2', 'street-2', 'address-ext'];
const ADDRESS3_NAMES = ['address-3', 'address-line-3', 'addr-3', 'street-3'];
const POSTAL_NAMES = [
  'postal',
  'zip',
  'zip2',
  'zip-code',
  'postal-code',
  'post-code',
  'postcode',
  'address-zip',
  'address-postal',
  'address-code',
  'address-postal-code',
  'address-zip-code',
  'plz',
  'postleitzahl',
];
const CITY_NAMES = [
  'city',
  'town',
  'address-level-2',
  'address-city',
  'address-town',
  'ort',
  'stadt',
  'wohnort',
];
const STATE_NAMES = [
  'state',
  'province',
  'provence',
  'address-level-1',
  'address-state',
  'address-province',
  'bundesland',
];
const COUNTRY_NAMES = [
  'country',
  'country-code',
  'country-name',
  'address-country',
  'address-country-name',
  'address-country-code',
  'land',
];
const PHONE_NAMES = [
  'phone',
  'mobile',
  'mobile-phone',
  'tel',
  'telephone',
  'phone-number',
  'telefon',
  'telefonnummer',
  'mobil',
  'handy',
];
const USERNAME_NAMES = ['user-name', 'user-id', 'screen-name'];
const COMPANY_NAMES = ['company', 'company-name', 'organization', 'organization-name', 'firma'];

// --- Matching (AutofillService.isFieldMatch) ----------------------------------------------

function clean(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/** The words of a value: split at spaces, and at punctuation and camelCase ("billingZip"). */
function words(value: string): Set<string> {
  const out = new Set<string>();
  for (const part of value.split(/\s+/)) if (part) out.add(clean(part));
  for (const part of value.replace(/([a-z])([A-Z])/g, '$1 $2').split(/[^a-zA-Z0-9]+/)) {
    if (part) out.add(part.toLowerCase());
  }
  return out;
}

/**
 * The value equals one of the names, or contains one that is allowed to match inside a longer
 * value (all of them when `contains` is left out). Bitwarden matches every name inside longer
 * values; here names of four letters or fewer ("tel", "land", "cvd") must be a whole word, so
 * "hotel", "island", and "accident" don't count.
 */
function isMatch(value: string, names: readonly string[], contains?: readonly string[]): boolean {
  const cleaned = clean(value);
  if (!cleaned) return false;
  let tokens: Set<string> | null = null;
  return names.some((name) => {
    const option = name.toLowerCase().replace(/-/g, '');
    if (cleaned === option) return true;
    if (contains !== undefined && !contains.includes(name)) return false;
    if (option.length > 4) return cleaned.includes(option);
    tokens ??= words(value);
    return tokens.has(option);
  });
}

function labelText(field: FormField): string {
  const labels = field.labels ? Array.from(field.labels, (l) => l.textContent) : [];
  const doc = field.ownerDocument;
  const labelledBy = (field.getAttribute('aria-labelledby') ?? '')
    .split(/\s+/)
    .map((id) => (id ? (doc.getElementById(id)?.textContent ?? '') : ''));
  return [...labels, ...labelledBy].join(' ');
}

/** What the field says about itself, in Bitwarden's order (CardAttributes, IdentityAttributes). */
function attributes(field: FormField): string[] {
  const placeholder = field instanceof HTMLSelectElement ? '' : field.placeholder;
  return [
    fieldAutocomplete(field),
    field.getAttribute('data-stripe') ?? '',
    field.name,
    field.id,
    field.title,
    labelText(field),
    field.getAttribute('aria-label') ?? '',
    placeholder,
    field.getAttribute('data-recurly') ?? '',
  ].filter((v) => v.trim() !== '');
}

function cardKeyword(values: readonly string[]): CardKey | null {
  for (const value of values) {
    if (isMatch(value, CARDHOLDER_NAMES, CARDHOLDER_CONTAINS)) return 'cardholderName';
    if (isMatch(value, CARD_NUMBER_NAMES, CARD_NUMBER_CONTAINS)) return 'number';
    if (isMatch(value, EXPIRY_NAMES, EXPIRY_CONTAINS)) return 'exp';
    if (isMatch(value, EXPIRY_MONTH_NAMES)) return 'expMonth';
    if (isMatch(value, EXPIRY_YEAR_NAMES)) return 'expYear';
    if (isMatch(value, CVV_NAMES)) return 'code';
    if (isMatch(value, CARD_BRAND_NAMES)) return 'brand';
  }
  return null;
}

/** Bitwarden checks identity keywords over all of a field's attributes, in this order. */
function identityKeyword(values: readonly string[]): IdentityKey | null {
  const has = (names: readonly string[], contains?: readonly string[]) =>
    values.some((v) => isMatch(v, names, contains));
  if (has(TITLE_NAMES)) return 'title';
  if (has(FULL_NAME_NAMES, FULL_NAME_CONTAINS)) return 'fullName';
  if (has(FIRST_NAME_NAMES)) return 'firstName';
  if (has(MIDDLE_NAME_NAMES)) return 'middleName';
  if (has(LAST_NAME_NAMES)) return 'lastName';
  if (has(EMAIL_NAMES)) return 'email';
  if (has(ADDRESS1_NAMES)) return 'address1';
  if (has(ADDRESS2_NAMES)) return 'address2';
  if (has(ADDRESS3_NAMES)) return 'address3';
  if (has(ADDRESS_NAMES)) return 'address';
  if (has(POSTAL_NAMES)) return 'postalCode';
  if (has(CITY_NAMES)) return 'city';
  if (has(STATE_NAMES)) return 'state';
  if (has(COUNTRY_NAMES)) return 'country';
  if (has(PHONE_NAMES)) return 'phone';
  if (has(USERNAME_NAMES)) return 'username';
  if (has(COMPANY_NAMES)) return 'company';
  return null;
}

const SKIP_TYPES = new Set([
  'hidden',
  'password',
  'file',
  'button',
  'submit',
  'image',
  'reset',
  'checkbox',
  'radio',
  'range',
  'color',
  'search',
]);

/** Fields a card or identity never goes into: passwords, buttons, site search, captchas. */
function skipField(field: FormField): boolean {
  if (field instanceof HTMLInputElement) {
    if (SKIP_TYPES.has(field.type)) return true;
    if (isSearchField(field)) return true;
  }
  const ac = fieldAutocomplete(field);
  if (/(current|new)-password|one-time-code/.test(ac)) return true;
  return /captcha/i.test(`${field.name} ${field.id}`);
}

/** A bare "Name" or "Number" next to other card fields is the cardholder or card number. */
const GENERIC_CARD: Partial<Record<string, CardKey>> = {
  name: 'cardholderName',
  number: 'number',
};

/** Card fields that only card forms have: the number, expiry, and security code. */
const STRONG_CARD_KEYS = new Set<CardKey>(['number', 'exp', 'expMonth', 'expYear', 'code']);

/**
 * What makes a card form: a number or expiry. A "verification code" box alone is a sign-in's
 * one-time code as often as a card's security code.
 */
const CARD_FORM_KEYS = new Set<CardKey>(['number', 'exp', 'expMonth', 'expYear']);

/** What a field is for, from its autocomplete token, else from its names and labels. */
export function fieldRole(field: FormField): FieldRole | null {
  const role = keywordRole(field);
  if (role || skipField(field)) return role;
  const values = attributes(field);
  const generic = values.map(clean).find((v) => GENERIC_CARD[v]);
  const key = generic ? GENERIC_CARD[generic] : undefined;
  if (key && nearStrongCardField(field)) return { form: 'card', key };
  // An email or phone box that names nothing else.
  if (field instanceof HTMLInputElement && field.type === 'email') {
    return { form: 'identity', key: 'email' };
  }
  if (field instanceof HTMLInputElement && field.type === 'tel') {
    return { form: 'identity', key: 'phone' };
  }
  return null;
}

/** The role from the field alone: its autocomplete token or its own names, nothing nearby. */
function keywordRole(field: FormField): FieldRole | null {
  if (skipField(field)) return null;
  const token = autocompleteToken(field);
  if (token) {
    const card = CARD_TOKENS[token];
    if (card) return { form: 'card', key: card };
    const identity = IDENTITY_TOKENS[token];
    if (identity) return { form: 'identity', key: identity };
  }
  const values = attributes(field);
  const card = cardKeyword(values);
  if (card) return { form: 'card', key: card };
  const identity = identityKeyword(values);
  return identity ? { form: 'identity', key: identity } : null;
}

/** A card number, expiry, or security code field close by: in the same few wrapping elements. */
function nearStrongCardField(field: FormField): boolean {
  let el: Element | null = field.parentElement;
  for (let depth = 0; el && depth < 5; depth++) {
    for (const other of Array.from(el.querySelectorAll('input, select'))) {
      if (other === field) continue;
      const role = keywordRole(other as FormField);
      if (role?.form === 'card' && STRONG_CARD_KEYS.has(role.key)) return true;
    }
    if (el === field.form) break;
    el = el.parentElement;
  }
  return false;
}

/**
 * A field of a payment card form (one with a card number or expiry). On a page with frames,
 * also a field the page tags as a card field (autocomplete "cc-name") next to card fields
 * that live in a payment provider's frames.
 */
export function isCardFormField(field: FormField): boolean {
  if (fieldRole(field)?.form !== 'card') return false;
  const doc = field.ownerDocument;
  return Object.keys(findCardFields(field, doc, hasFrames(doc)).fields).length > 0;
}

/** Whether part of a card form could be in frames: the page has any. */
export function hasFrames(doc: Document = document): boolean {
  return doc.querySelector('iframe') !== null;
}

// --- Finding the form to fill -------------------------------------------------------------

export interface FoundFields<K extends string> {
  fields: Partial<Record<K, FormField>>;
  /** The form (or document) they came from. */
  scope: HTMLFormElement | Document;
}

function usableFields(scope: HTMLFormElement | Document): FormField[] {
  if (scope instanceof HTMLFormElement) {
    return Array.from(scope.elements).filter(
      (el): el is FormField =>
        (el instanceof HTMLInputElement ||
          el instanceof HTMLSelectElement ||
          el instanceof HTMLTextAreaElement) &&
        isUsable(el),
    );
  }
  return allFields(scope).filter(isUsable);
}

function collect<K extends string>(
  fields: readonly FormField[],
  form: FieldRole['form'],
  section: string | null,
): Partial<Record<K, FormField>> {
  const found: Partial<Record<K, FormField>> = {};
  for (const field of fields) {
    const role = fieldRole(field);
    if (role?.form !== form) continue;
    // One section at a time: shipping fields stay out of a billing fill, and the other way.
    const own = sectionOf(field);
    if (section && own && own !== section) continue;
    const key = role.key as K;
    found[key] ??= field;
  }
  return found;
}

/** The scope to fill: the anchor's form, or the form holding most fields of this kind. */
function scopeFor(
  anchor: FormField | null,
  form: FieldRole['form'],
  root: Document,
): HTMLFormElement | Document {
  if (anchor?.isConnected && fieldRole(anchor)?.form === form) return anchor.form ?? root;
  const counts = new Map<HTMLFormElement | Document, number>();
  for (const field of allFields(root).filter(isUsable)) {
    const role = fieldRole(field);
    if (role?.form !== form) continue;
    if (form === 'card' && !CARD_FORM_KEYS.has(role.key as CardKey)) continue;
    const scope = field.form ?? root;
    counts.set(scope, (counts.get(scope) ?? 0) + 1);
  }
  let best: HTMLFormElement | Document = root;
  let bestCount = 0;
  for (const [scope, count] of counts) {
    if (count > bestCount) {
      best = scope;
      bestCount = count;
    }
  }
  return best;
}

/**
 * The card fields to fill. Only a form with a card number or expiry is a card form, except with
 * `split`: a payment provider's frame that holds one field of a card form laid out across
 * several frames (just the security code, say). There only fields whose autocomplete token
 * names the card field count, and the worker fills them only when another frame in the tab has
 * the number or expiry.
 */
export function findCardFields(
  anchor: FormField | null = null,
  root: Document = document,
  split = false,
): FoundFields<CardKey> {
  const scope = scopeFor(anchor, 'card', root);
  const fields = collect<CardKey>(usableFields(scope), 'card', null);
  const strong = Object.keys(fields).some((k) => CARD_FORM_KEYS.has(k as CardKey));
  if (strong) return { fields, scope };
  if (!split) return { fields: {}, scope };
  const tokened: Partial<Record<CardKey, FormField>> = {};
  for (const [key, field] of Object.entries(fields) as [CardKey, FormField][]) {
    const token = autocompleteToken(field);
    if (token && CARD_TOKENS[token] === key) tokened[key] = field;
  }
  return { fields: tokened, scope };
}

/** Whether these card fields make a card form on their own (a number or expiry). */
export function isCardForm(keys: readonly CardKey[]): boolean {
  return keys.some((k) => CARD_FORM_KEYS.has(k));
}

export function findIdentityFields(
  anchor: FormField | null = null,
  root: Document = document,
): FoundFields<IdentityKey> {
  const scope = scopeFor(anchor, 'identity', root);
  const section = anchor && fieldRole(anchor)?.form === 'identity' ? sectionOf(anchor) : null;
  return { fields: collect<IdentityKey>(usableFields(scope), 'identity', section), scope };
}

/**
 * An address or contact form: at least `min` identity fields, so a lone email or name box (a
 * newsletter, a comment form) doesn't count.
 */
export function isIdentityForm(field: FormField, min = 2): boolean {
  if (fieldRole(field)?.form !== 'identity') return false;
  return Object.keys(findIdentityFields(field, field.ownerDocument).fields).length >= min;
}

/** Card and address fields on the page, for the popup's suggestions. */
export function pageForms(root: Document = document): { card: boolean; identity: boolean } {
  const card = Object.keys(findCardFields(null, root).fields).length > 0;
  const identity = Object.keys(findIdentityFields(null, root).fields).length >= 2;
  return { card, identity };
}

// --- Values -------------------------------------------------------------------------------

/** All an attribute-based format hint can say, lowercased without spaces ("MM / YY" → "mm/yy"). */
function formatHints(field: FormField): string {
  const placeholder = field instanceof HTMLSelectElement ? '' : field.placeholder;
  return [
    placeholder,
    labelText(field),
    field.getAttribute('aria-label') ?? '',
    field.title,
    field.name,
    field.id,
    field.getAttribute('data-stripe') ?? '',
    field.getAttribute('data-recurly') ?? '',
  ]
    .join(' ')
    .replace(/ /g, '')
    .toLowerCase();
}

function maxLength(field: FormField): number {
  return field instanceof HTMLSelectElement ? -1 : field.maxLength;
}

function fourDigitYear(year: string): string {
  const digits = year.trim();
  if (/^\d{2}$/.test(digits)) return `20${digits}`;
  return digits;
}

/** The expiry month for a text box: "01" when the box wants two digits, else as stored. */
function monthText(field: FormField, month: string): string {
  const m = String(Number.parseInt(month, 10));
  if (m === 'NaN') return month;
  return /mm/.test(formatHints(field)) || maxLength(field) === 2 ? m.padStart(2, '0') : m;
}

function yearText(field: FormField, year: string): string {
  const full = fourDigitYear(year);
  const hints = formatHints(field);
  if (/yyyy|jjjj|åååå|rrrr|гггг/.test(hints) || maxLength(field) === 4) return full;
  if (/yy|jj|åå|rr|гг|aa/.test(hints) || maxLength(field) === 2) return full.slice(-2);
  return full;
}

/** Year letters per language, as Bitwarden lists them (CardExpiryDateFormats). */
const MONTH = '(mm|m|мм|м)';
const YEAR = '(yyyy|yy|åååå|åå|jjjj|jj|aa|rrrr|rr|гггг|гг)';
const EXPIRY_FORMAT = new RegExp(`${MONTH}[/\\-.]?${YEAR}|${YEAR}[/\\-.]?${MONTH}`, 'i');

/**
 * One box for the whole expiry date: follow the format the field asks for ("MM/YY",
 * "MM-YYYY", "YYYY/MM"), else MM/YY.
 */
export function combinedExpiry(field: FormField, month: string, year: string): string | null {
  const m = Number.parseInt(month, 10);
  if (!Number.isFinite(m) || m < 1 || m > 12) return null;
  const full = fourDigitYear(year);
  if (!/^\d{4}$/.test(full)) return null;
  const format = EXPIRY_FORMAT.exec(formatHints(field))?.[0] ?? 'mm/yy';
  const delimiter = /[/\-.]/.exec(format)?.[0] ?? '';
  const yearFirst = !/^(m|м)/i.test(format);
  const mm = /mm|мм/i.test(format) ? String(m).padStart(2, '0') : String(m);
  const yy = /yyyy|åååå|jjjj|rrrr|гггг/i.test(format) ? full : full.slice(-2);
  return (yearFirst ? [yy, mm] : [mm, yy]).join(delimiter);
}

function normalize(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Pick a drop-down option whose value or text is one of the candidates. */
function optionFor(
  select: HTMLSelectElement,
  candidates: readonly string[],
): HTMLOptionElement | null {
  const wanted = new Set(candidates.map(normalize).filter(Boolean));
  for (const option of Array.from(select.options)) {
    if (option.disabled) continue;
    if (wanted.has(normalize(option.value)) || wanted.has(normalize(option.text))) return option;
  }
  return null;
}

const MONTH_NAMES = Array.from({ length: 12 }, (_, i) => {
  const date = new Date(Date.UTC(2000, i, 1));
  return [
    date.toLocaleString('en', { month: 'long', timeZone: 'UTC' }),
    date.toLocaleString('en', { month: 'short', timeZone: 'UTC' }),
  ];
});

function monthOption(select: HTMLSelectElement, month: string): HTMLOptionElement | null {
  const m = Number.parseInt(month, 10);
  if (!Number.isFinite(m) || m < 1 || m > 12) return null;
  const names = MONTH_NAMES[m - 1] ?? [];
  const byName = optionFor(select, [String(m), String(m).padStart(2, '0'), ...names]);
  if (byName) return byName;
  // "01 - January", "1 (Jan)": a leading number.
  for (const option of Array.from(select.options)) {
    const lead = /^\s*0?(\d{1,2})\b/.exec(option.text)?.[1];
    if (lead && Number(lead) === m && !option.disabled) return option;
  }
  return null;
}

function yearOption(select: HTMLSelectElement, year: string): HTMLOptionElement | null {
  const full = fourDigitYear(year);
  return optionFor(select, [full, full.slice(-2)]);
}

const BRAND_NAMES: Partial<Record<string, string[]>> = {
  visa: ['visa'],
  mastercard: ['mastercard', 'master card', 'mc'],
  amex: ['amex', 'american express', 'americanexpress'],
  discover: ['discover'],
  'diners club': ['diners club', 'diners', 'dinersclub'],
  jcb: ['jcb'],
  maestro: ['maestro'],
  unionpay: ['unionpay', 'union pay', 'china unionpay'],
  rupay: ['rupay'],
};

function brandCandidates(brand: string): string[] {
  const key = normalize(brand);
  return BRAND_NAMES[key] ?? BRAND_NAMES[key.replace(/ /g, '')] ?? [brand];
}

/** US states and Canadian provinces: the codes forms use, by name. */
const REGIONS: Record<string, string> = {
  alabama: 'AL',
  alaska: 'AK',
  arizona: 'AZ',
  arkansas: 'AR',
  california: 'CA',
  colorado: 'CO',
  connecticut: 'CT',
  delaware: 'DE',
  'district of columbia': 'DC',
  florida: 'FL',
  georgia: 'GA',
  hawaii: 'HI',
  idaho: 'ID',
  illinois: 'IL',
  indiana: 'IN',
  iowa: 'IA',
  kansas: 'KS',
  kentucky: 'KY',
  louisiana: 'LA',
  maine: 'ME',
  maryland: 'MD',
  massachusetts: 'MA',
  michigan: 'MI',
  minnesota: 'MN',
  mississippi: 'MS',
  missouri: 'MO',
  montana: 'MT',
  nebraska: 'NE',
  nevada: 'NV',
  'new hampshire': 'NH',
  'new jersey': 'NJ',
  'new mexico': 'NM',
  'new york': 'NY',
  'north carolina': 'NC',
  'north dakota': 'ND',
  ohio: 'OH',
  oklahoma: 'OK',
  oregon: 'OR',
  pennsylvania: 'PA',
  'rhode island': 'RI',
  'south carolina': 'SC',
  'south dakota': 'SD',
  tennessee: 'TN',
  texas: 'TX',
  utah: 'UT',
  vermont: 'VT',
  virginia: 'VA',
  washington: 'WA',
  'west virginia': 'WV',
  wisconsin: 'WI',
  wyoming: 'WY',
  'puerto rico': 'PR',
  guam: 'GU',
  'american samoa': 'AS',
  'virgin islands': 'VI',
  'northern mariana islands': 'MP',
  alberta: 'AB',
  'british columbia': 'BC',
  manitoba: 'MB',
  'new brunswick': 'NB',
  'newfoundland and labrador': 'NL',
  'nova scotia': 'NS',
  ontario: 'ON',
  'prince edward island': 'PE',
  quebec: 'QC',
  saskatchewan: 'SK',
  'northwest territories': 'NT',
  nunavut: 'NU',
  yukon: 'YT',
};

function regionCandidates(state: string): string[] {
  const key = normalize(state);
  const code = REGIONS[key];
  if (code) return [state, code];
  const names = Object.entries(REGIONS)
    .filter(([, c]) => c.toLowerCase() === key)
    .map(([name]) => name);
  return [state, ...names];
}

let regionNames: Intl.DisplayNames | null | undefined;
let countryCodes: Map<string, string> | null = null;

function displayNames(): Intl.DisplayNames | null {
  if (regionNames === undefined) {
    try {
      regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
    } catch {
      regionNames = null;
    }
  }
  return regionNames;
}

/** "United States" for "US", and "US" for "United States" (and "USA"). */
function countryCandidates(country: string): string[] {
  const names = displayNames();
  const trimmed = country.trim();
  const out = [trimmed];
  if (!names) return out;
  if (/^[a-z]{2}$/i.test(trimmed)) {
    try {
      const name = names.of(trimmed.toUpperCase());
      if (name && name !== trimmed.toUpperCase()) out.push(name);
    } catch {
      // Not a region code.
    }
    return out;
  }
  if (!countryCodes) {
    countryCodes = new Map();
    const A = 'A'.charCodeAt(0);
    for (let i = 0; i < 26; i++) {
      for (let j = 0; j < 26; j++) {
        const code = String.fromCharCode(A + i, A + j);
        try {
          const name = names.of(code);
          if (name && name !== code) countryCodes.set(normalize(name), code);
        } catch {
          // Unknown code.
        }
      }
    }
    countryCodes.set('usa', 'US');
    countryCodes.set('united states of america', 'US');
    countryCodes.set('uk', 'GB');
    countryCodes.set('great britain', 'GB');
  }
  const code = countryCodes.get(normalize(trimmed));
  if (code) out.push(code);
  return out;
}

// --- Filling ------------------------------------------------------------------------------

/**
 * Put a value in a field: text boxes get it as is, drop-downs get the matching option or are
 * left alone. Returns whether the field changed.
 */
function put(field: FormField, value: string | null | undefined, candidates?: string[]): boolean {
  if (value === null || value === undefined || value.trim() === '') return false;
  if (field instanceof HTMLSelectElement) {
    const option = optionFor(field, candidates ?? [value]);
    if (!option) return false;
    fillInput(field, option.value);
    return true;
  }
  fillInput(field, value);
  return true;
}

/** Fill a card into the form around `anchor` (or the page's card form). Returns what was filled. */
export function fillCard(
  card: CardFill,
  anchor: FormField | null = null,
  split = false,
): CardKey[] {
  const { fields } = findCardFields(anchor, document, split);
  const filled: CardKey[] = [];
  const done = (key: CardKey, ok: boolean) => {
    if (ok) filled.push(key);
  };
  if (fields.cardholderName)
    done('cardholderName', put(fields.cardholderName, card.cardholderName));
  if (fields.number && card.number)
    done('number', put(fields.number, card.number.replace(/\s+/g, '')));
  const { expMonth, expYear } = card;
  if (fields.exp && expMonth && expYear) {
    const value =
      fields.exp instanceof HTMLSelectElement
        ? null
        : combinedExpiry(fields.exp, expMonth, expYear);
    done('exp', put(fields.exp, value));
  }
  if (fields.expMonth && expMonth) {
    const field = fields.expMonth;
    if (field instanceof HTMLSelectElement) {
      const option = monthOption(field, expMonth);
      if (option) {
        fillInput(field, option.value);
        filled.push('expMonth');
      }
    } else done('expMonth', put(field, monthText(field, expMonth)));
  }
  if (fields.expYear && expYear) {
    const field = fields.expYear;
    if (field instanceof HTMLSelectElement) {
      const option = yearOption(field, expYear);
      if (option) {
        fillInput(field, option.value);
        filled.push('expYear');
      }
    } else done('expYear', put(field, yearText(field, expYear)));
  }
  if (fields.code) done('code', put(fields.code, card.code));
  if (fields.brand && card.brand) {
    done('brand', put(fields.brand, card.brand, brandCandidates(card.brand)));
  }
  return filled;
}

function joined(...parts: (string | null | undefined)[]): string {
  return parts.filter((p): p is string => typeof p === 'string' && p.trim() !== '').join(' ');
}

/** Fill an identity into the address form around `anchor`. Returns what was filled. */
export function fillIdentity(
  identity: IdentityFill,
  anchor: FormField | null = null,
): IdentityKey[] {
  const { fields } = findIdentityFields(anchor);
  const filled: IdentityKey[] = [];
  const set = (key: IdentityKey, value: string | null | undefined, candidates?: string[]) => {
    const field = fields[key];
    if (field && put(field, value, candidates)) filled.push(key);
  };
  set(
    'title',
    identity.title,
    identity.title ? [identity.title, identity.title.replace(/\.$/, '')] : undefined,
  );
  set('fullName', joined(identity.firstName, identity.middleName, identity.lastName));
  set('firstName', identity.firstName);
  set('middleName', identity.middleName);
  set('lastName', identity.lastName);
  set('email', identity.email);
  set('phone', identity.phone);
  set('company', identity.company);
  if (fields.address) {
    // One box for the street: all the lines, or a text area with one per line.
    const lines = [identity.address1, identity.address2, identity.address3].filter(
      (l): l is string => typeof l === 'string' && l.trim() !== '',
    );
    const separator = fields.address instanceof HTMLTextAreaElement ? '\n' : ', ';
    // With separate line 2 and 3 boxes, the street box only takes line 1.
    const value = fields.address2 ? lines[0] : lines.join(separator);
    set('address', value);
  }
  set('address1', identity.address1);
  set('address2', identity.address2);
  set('address3', identity.address3);
  set('city', identity.city);
  set('state', identity.state, identity.state ? regionCandidates(identity.state) : undefined);
  set('postalCode', identity.postalCode);
  if (fields.country && identity.country) {
    const candidates = countryCandidates(identity.country);
    // A text box gets the name the user saved; a drop-down whichever spelling it lists.
    set('country', identity.country, candidates);
  }
  set('username', identity.username);
  return filled;
}
