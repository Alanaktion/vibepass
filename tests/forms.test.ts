import { beforeEach, describe, expect, it, vi } from 'vitest';
import browser from 'webextension-polyfill';
import { detectLoginFields } from '../src/content/detect';
import {
  combinedExpiry,
  fieldRole,
  fillCard,
  fillIdentity,
  findCardFields,
  findIdentityFields,
  pageForms,
} from '../src/content/forms';
import type { CardFill, IdentityFill, InlineMenuItem } from '../src/shared/messages';

const CARD: CardFill = {
  cardholderName: 'Alice Example',
  brand: 'Visa',
  number: '4111 1111 1111 1111',
  expMonth: '4',
  expYear: '2031',
  code: '123',
};

const IDENTITY: IdentityFill = {
  title: 'Ms',
  firstName: 'Alice',
  middleName: 'B',
  lastName: 'Example',
  email: 'alice@example.com',
  phone: '+1 555 0100',
  company: 'Example Co',
  address1: '1 Main St',
  address2: 'Apt 2',
  address3: null,
  city: 'Springfield',
  state: 'California',
  postalCode: '90210',
  country: 'United States',
  username: 'alice',
};

const CARD_ROW: InlineMenuItem = {
  id: 'card-1',
  name: 'Travel card',
  username: 'Visa •••• 1111',
  reprompt: false,
  recent: false,
  type: 'card',
};
const IDENTITY_ROW: InlineMenuItem = {
  id: 'id-1',
  name: 'Home',
  username: 'Alice Example',
  reprompt: false,
  recent: false,
  type: 'identity',
};
const LOGIN_ROW: InlineMenuItem = {
  id: 'login-1',
  name: 'Shop',
  username: 'alice',
  reprompt: false,
  recent: false,
};

function page(html: string) {
  document.body.innerHTML = html;
}

const byId = (id: string) => document.getElementById(id) as HTMLInputElement;
const value = (id: string) =>
  (document.getElementById(id) as HTMLInputElement | HTMLSelectElement).value;

const MONTHS = `<option value="">Month</option>${Array.from(
  { length: 12 },
  (_, i) =>
    `<option value="${String(i + 1).padStart(2, '0')}">${String(i + 1).padStart(2, '0')}</option>`,
).join('')}`;

describe('card forms', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('fills a checkout form marked with autocomplete tokens, drop-downs included', () => {
    page(`
      <form>
        <input id="name" autocomplete="cc-name">
        <input id="num" autocomplete="cc-number">
        <select id="mm" autocomplete="cc-exp-month">${MONTHS}</select>
        <select id="yy" autocomplete="cc-exp-year">
          <option value="">Year</option><option value="30">30</option><option value="31">31</option>
        </select>
        <input id="cvc" autocomplete="cc-csc">
        <select id="type" autocomplete="cc-type">
          <option value="">Type</option><option value="MC">Mastercard</option><option value="V">Visa</option>
        </select>
      </form>`);
    const filled = fillCard(CARD);
    expect(filled.sort()).toEqual(
      ['brand', 'cardholderName', 'code', 'expMonth', 'expYear', 'number'].sort(),
    );
    expect(value('name')).toBe('Alice Example');
    expect(value('num')).toBe('4111111111111111');
    expect(value('mm')).toBe('04');
    expect(value('yy')).toBe('31');
    expect(value('cvc')).toBe('123');
    expect(value('type')).toBe('V');
  });

  it('reads Bitwarden’s card keywords and follows the expiry format the field asks for', () => {
    page(`
      <form>
        <label for="n">Card number</label><input id="n" name="cardnumber">
        <input id="e" name="exp-date" placeholder="MM / YY">
        <input id="c" name="cvc" placeholder="CVC">
      </form>`);
    fillCard(CARD);
    expect(value('n')).toBe('4111111111111111');
    expect(value('e')).toBe('04/31');
    expect(value('c')).toBe('123');
  });

  it('writes a combined expiry in the field’s format', () => {
    const field = (attrs: string) => {
      page(`<input id="x" ${attrs}>`);
      return byId('x');
    };
    expect(combinedExpiry(field('placeholder="MM/YYYY"'), '4', '2031')).toBe('04/2031');
    expect(combinedExpiry(field('placeholder="YY-MM"'), '11', '31')).toBe('31-11');
    expect(combinedExpiry(field('placeholder="M/YY"'), '4', '2031')).toBe('4/31');
    expect(combinedExpiry(field('name="expiry"'), '4', '2031')).toBe('04/31');
    expect(combinedExpiry(field('name="expiry"'), '', '2031')).toBeNull();
  });

  it('pads months and trims years for separate text boxes', () => {
    page(`
      <input id="num" autocomplete="cc-number">
      <input id="m" name="exp-month" maxlength="2">
      <input id="y" name="exp-year" placeholder="YY">`);
    fillCard(CARD);
    expect(value('m')).toBe('04');
    expect(value('y')).toBe('31');
  });

  it('takes a bare “Name” as the cardholder only beside card fields', () => {
    page(`
      <form id="ship"><input id="ship-name" name="name"><input name="city"></form>
      <form id="pay">
        <div><input id="card-name" name="name"></div>
        <div><input id="card-num" name="number" maxlength="19"><input name="cvv"></div>
      </form>`);
    expect(fieldRole(byId('card-name'))).toEqual({ form: 'card', key: 'cardholderName' });
    expect(fieldRole(byId('card-num'))).toEqual({ form: 'card', key: 'number' });
    expect(fieldRole(byId('ship-name'))).toEqual({ form: 'identity', key: 'fullName' });
  });

  it('is not a card form without a number, expiry, or code', () => {
    page(`<form><input name="cardholder"><input name="email" type="email"></form>`);
    expect(findCardFields().fields).toEqual({});
    expect(pageForms().card).toBe(false);
  });

  it('never takes a card’s security code for a one-time password', () => {
    page(`
      <form>
        <input autocomplete="cc-number">
        <label for="sc">Security code</label><input id="sc" name="securityCode" maxlength="4">
      </form>`);
    expect(detectLoginFields().totp).toBeNull();
    expect(fieldRole(byId('sc'))).toEqual({ form: 'card', key: 'code' });
  });
});

describe('address forms', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('fills an address form, matching drop-downs by name or code', () => {
    page(`
      <form>
        <select id="title" name="title"><option></option><option>Mr.</option><option>Ms.</option></select>
        <input id="first" autocomplete="given-name">
        <input id="last" autocomplete="family-name">
        <input id="email" type="email" name="email">
        <input id="phone" type="tel" name="phone">
        <input id="street" name="address1">
        <input id="street2" name="address2">
        <input id="city" name="city">
        <select id="state" name="state"><option value="">State</option><option value="CA">California</option><option value="NY">New York</option></select>
        <input id="zip" name="zip">
        <select id="country" name="country"><option value="CA">Canada</option><option value="US">United States</option></select>
        <input id="company" name="company">
      </form>`);
    const filled = fillIdentity(IDENTITY);
    expect(filled).toEqual(
      expect.arrayContaining(['firstName', 'lastName', 'email', 'phone', 'address1', 'city']),
    );
    expect(value('title')).toBe('Ms.');
    expect(value('first')).toBe('Alice');
    expect(value('last')).toBe('Example');
    expect(value('email')).toBe('alice@example.com');
    expect(value('phone')).toBe('+1 555 0100');
    expect(value('street')).toBe('1 Main St');
    expect(value('street2')).toBe('Apt 2');
    expect(value('city')).toBe('Springfield');
    expect(value('state')).toBe('CA');
    expect(value('zip')).toBe('90210');
    expect(value('country')).toBe('US');
    expect(value('company')).toBe('Example Co');
  });

  it('matches a saved code to a drop-down of names', () => {
    page(`
      <input autocomplete="address-line1">
      <select id="s" autocomplete="address-level1"><option value="1">California</option><option value="2">Texas</option></select>
      <select id="c" autocomplete="country"><option value="x">Canada</option><option value="y">United States</option></select>`);
    fillIdentity({ ...IDENTITY, state: 'TX', country: 'US' });
    expect(value('s')).toBe('2');
    expect(value('c')).toBe('y');
  });

  it('puts the whole name and street into single boxes', () => {
    page(`
      <form>
        <input id="name" name="full-name">
        <textarea id="street" name="street-address"></textarea>
        <input id="city" name="city">
      </form>`);
    fillIdentity(IDENTITY);
    expect(value('name')).toBe('Alice B Example');
    expect((document.getElementById('street') as HTMLTextAreaElement).value).toBe(
      '1 Main St\nApt 2',
    );
  });

  it('fills only the section the user is in: shipping or billing', () => {
    page(`
      <form>
        <input id="s1" autocomplete="shipping address-line1"><input id="s2" autocomplete="shipping address-level2">
        <input id="b1" autocomplete="billing address-line1"><input id="b2" autocomplete="billing address-level2">
      </form>`);
    fillIdentity(IDENTITY, byId('b1'));
    expect(value('b1')).toBe('1 Main St');
    expect(value('b2')).toBe('Springfield');
    expect(value('s1')).toBe('');
  });

  it('keeps short words whole, so “hotel” and “island” are not phone or country', () => {
    page(
      `<input id="h" name="hotel"><input id="i" name="island"><input id="p" name="billing_zip">`,
    );
    expect(fieldRole(byId('h'))).toBeNull();
    expect(fieldRole(byId('i'))).toBeNull();
    expect(fieldRole(byId('p'))).toEqual({ form: 'identity', key: 'postalCode' });
  });

  it('leaves password and search boxes alone', () => {
    page(
      `<form><input id="q" type="search" name="city"><input id="pw" type="password" name="address"></form>`,
    );
    expect(fieldRole(byId('q'))).toBeNull();
    expect(fieldRole(byId('pw'))).toBeNull();
    expect(findIdentityFields().fields).toEqual({});
  });
});

describe('inline menu on card and address forms', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.mocked(browser.runtime.sendMessage).mockResolvedValue({ ok: true, data: { state: 'off' } });
  });

  const unlocked = {
    state: 'unlocked' as const,
    items: [LOGIN_ROW],
    cards: [CARD_ROW],
    identities: [IDENTITY_ROW],
  };

  it('offers cards on card fields and identities on address fields', async () => {
    const content = await import('../src/content/index');
    page(`
      <form>
        <input id="first" autocomplete="given-name"><input id="street" autocomplete="address-line1">
        <input id="email" type="email" autocomplete="email">
      </form>
      <form><input id="num" autocomplete="cc-number"><input id="cvc" name="cvc"></form>`);
    expect(content.menuRows(unlocked, byId('num'))).toEqual([{ kind: 'item', item: CARD_ROW }]);
    expect(content.menuRows(unlocked, byId('cvc'))).toEqual([{ kind: 'item', item: CARD_ROW }]);
    expect(content.menuRows(unlocked, byId('first'))).toEqual([
      { kind: 'item', item: IDENTITY_ROW },
    ]);
    // An email box in an address form is the address's, not a sign-in.
    expect(content.menuRows(unlocked, byId('email'))).toEqual([
      { kind: 'item', item: IDENTITY_ROW },
    ]);
    expect(content.menuRows({ state: 'locked' }, byId('num'))).toEqual([
      { kind: 'unlock', what: 'card' },
    ]);
    // No cards saved (or turned off): no menu at all.
    expect(content.menuRows({ ...unlocked, cards: [] }, byId('num'))).toEqual([]);
  });

  it('keeps logins on sign-in and sign-up forms', async () => {
    const content = await import('../src/content/index');
    page(`
      <form>
        <input id="first" autocomplete="given-name"><input id="last" autocomplete="family-name">
        <input id="email" type="email" autocomplete="email"><input id="pw" type="password">
      </form>`);
    expect(content.menuRows(unlocked, byId('email'))).toEqual([{ kind: 'item', item: LOGIN_ROW }]);
    // Name boxes of a sign-up form still offer identities.
    expect(content.menuRows(unlocked, byId('first'))).toEqual([
      { kind: 'item', item: IDENTITY_ROW },
    ]);
  });

  it('fills into the form the menu is on, for the page’s own origin only', async () => {
    const content = await import('../src/content/index');
    page(`
      <form><input id="a1" autocomplete="shipping address-line1"><input id="c1" autocomplete="shipping address-level2"></form>
      <form><input id="a2" autocomplete="address-line1"><input id="c2" autocomplete="address-level2"></form>`);
    const menu = content.inlineMenu();
    menu.open(byId('a2'), [{ kind: 'item', item: IDENTITY_ROW }]);
    const request = {
      source: 'vibepass' as const,
      type: 'content:fill-form' as const,
      origin: location.origin,
      card: null,
      identity: IDENTITY,
    };
    expect(content.fillFormPage(request).filled).toEqual(['address1', 'city']);
    expect(value('a2')).toBe('1 Main St');
    expect(value('a1')).toBe('');
    expect(menu.isOpen).toBe(false);
    expect(() => content.fillFormPage({ ...request, origin: 'https://evil.test' })).toThrow(
      'page changed',
    );
    page(`<p>Nothing here</p>`);
    expect(() => content.fillFormPage({ ...request, card: CARD, identity: null })).toThrow(
      'No card fields',
    );
  });

  it('reports card and address forms to the popup', async () => {
    const content = await import('../src/content/index');
    page(`
      <input autocomplete="cc-number"><input autocomplete="cc-csc">
      <input autocomplete="address-line1"><input autocomplete="postal-code">`);
    expect(content.inspectPage().fields).toMatchObject({ card: true, identity: true });
  });
});
