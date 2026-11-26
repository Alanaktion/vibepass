/** Draft helpers with no crypto, so the popup can use them without loading the SDK. */
import {
  CipherType,
  type CardDraft,
  type IdentityDraft,
  type IdentityFieldName,
  type ItemDraft,
} from './types';

/** The item types the editor can create. SSH keys are edited elsewhere (not yet). */
export type NewItemType =
  CipherType.Login | CipherType.SecureNote | CipherType.Card | CipherType.Identity;

/** Every identity field, in the order the editor and item view show them. */
export const IDENTITY_FIELDS: readonly IdentityFieldName[] = [
  'title',
  'firstName',
  'middleName',
  'lastName',
  'address1',
  'address2',
  'address3',
  'city',
  'state',
  'postalCode',
  'country',
  'company',
  'email',
  'phone',
  'ssn',
  'username',
  'passportNumber',
  'licenseNumber',
];

export function emptyCard(): CardDraft {
  return { cardholderName: '', brand: '', number: '', expMonth: '', expYear: '', code: '' };
}

export function emptyIdentity(): IdentityDraft {
  return Object.fromEntries(IDENTITY_FIELDS.map((f) => [f, ''])) as IdentityDraft;
}

/** An empty draft for a new item. */
export function newDraft(type: NewItemType): ItemDraft {
  return {
    type,
    name: '',
    notes: '',
    favorite: false,
    folderId: null,
    reprompt: false,
    login: type === CipherType.Login ? { username: '', password: '', totp: '', uris: [] } : null,
    card: type === CipherType.Card ? emptyCard() : null,
    identity: type === CipherType.Identity ? emptyIdentity() : null,
    fields: [],
  };
}

/** The brand names the official clients offer, in their order. */
export const CARD_BRANDS = [
  'Visa',
  'Mastercard',
  'Amex',
  'Discover',
  'Diners Club',
  'JCB',
  'Maestro',
  'UnionPay',
  'RuPay',
  'Other',
] as const;

/** Guess a card's brand from its number, as the official clients do. Null when unsure. */
export function cardBrand(number: string): string | null {
  const digits = number.replace(/\D/g, '');
  if (digits.length < 2) return null;
  if (/^4/.test(digits)) return 'Visa';
  if (/^(5[1-5]|2(22[1-9]|2[3-9]\d|[3-6]\d\d|7[01]\d|720))/.test(digits)) return 'Mastercard';
  if (/^3[47]/.test(digits)) return 'Amex';
  if (/^(6011|65|64[4-9])/.test(digits)) return 'Discover';
  if (/^3(0[0-5]|[689])/.test(digits)) return 'Diners Club';
  if (/^35/.test(digits)) return 'JCB';
  if (/^(5018|5020|5038|6304|6759|676[1-3])/.test(digits)) return 'Maestro';
  if (/^62/.test(digits)) return 'UnionPay';
  if (/^(60|65|81|82|508)/.test(digits)) return 'RuPay';
  return null;
}

/**
 * Tidy a card before saving: digits only in the number, a four-digit year. Returns an error
 * message instead when a value can't be right.
 */
export function normalizeCard(card: CardDraft): CardDraft | string {
  const number = card.number.replace(/[\s-]/g, '');
  if (number && !/^\d{8,19}$/.test(number)) return 'The card number should be 8 to 19 digits';
  let expYear = card.expYear.trim();
  if (/^\d{2}$/.test(expYear)) expYear = `20${expYear}`;
  if (expYear && !/^\d{4}$/.test(expYear)) return 'Enter the expiration year as four digits';
  const code = card.code.trim();
  if (code && !/^\d{3,4}$/.test(code)) return 'The security code should be 3 or 4 digits';
  return {
    ...card,
    cardholderName: card.cardholderName.trim(),
    number,
    expYear,
    code,
  };
}
