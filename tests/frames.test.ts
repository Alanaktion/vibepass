import { afterEach, describe, expect, it, vi } from 'vitest';
import { cardFor, createAutofill, identityFor } from '../src/background/autofill';
import { isPaymentProvider } from '../src/background/payment-frames';
import { fieldVisible, inspectFrame } from '../src/content/frame';
import { fillCard, findCardFields } from '../src/content/forms';
import { createSearchIndex } from '../src/search';
import type { CardFill, ContentRequest, FrameInfo, PageInfo } from '../src/shared/messages';
import { DEFAULT_SETTINGS } from '../src/storage/settings';
import { newDraft } from '../src/vault/draft';
import { VaultState } from '../src/vault/state';
import { CipherType } from '../src/vault/types';
import { officialVaults } from './fixtures';
import { createTestService, fakeServer } from './helpers';

const fixture = officialVaults.pbkdf2;
const loginId = fixture.sync.ciphers.find((c) => c.type === CipherType.Login)!.id;
const loginItem = fixture.expected.items.find((i) => i.type === 1)!;

const CARD: CardFill = {
  cardholderName: 'Alice Example',
  brand: 'Visa',
  number: '4111111111111111',
  expMonth: '4',
  expYear: '2031',
  code: '123',
};

const NO_FIELDS = { username: false, password: false, totp: false, card: false, identity: false };

function frame(url: string, patch: Partial<FrameInfo> = {}): FrameInfo {
  return {
    url,
    focused: false,
    visible: true,
    fields: { ...NO_FIELDS },
    cardKeys: [],
    identityKeys: [],
    ...patch,
  };
}

interface Sent {
  frameId: number;
  message: ContentRequest;
}

/** A tab with a top page and frames by id; frames answer inspect with their info. */
async function setup(top: PageInfo, frames: Record<number, FrameInfo>) {
  const vault = new VaultState();
  const search = createSearchIndex();
  const { service } = createTestService(vault, search, fakeServer(fixture));
  await service.login({
    serverUrl: 'https://vault.example.com',
    email: fixture.email,
    masterPassword: fixture.password,
  });
  const sent: Sent[] = [];
  const send = vi.fn((_tabId: number, message: ContentRequest, frameId: number = 0) => {
    const info = frameId === 0 ? top : frames[frameId];
    if (!info) return Promise.reject(new Error('No frame'));
    if (message.type === 'content:inspect') return Promise.resolve(info);
    sent.push({ frameId, message });
    if (message.type === 'content:fill-form') {
      const keys = frameId === 0 ? ['number'] : (info as FrameInfo).cardKeys;
      return Promise.resolve({ filled: message.card ? keys : ['firstName'] });
    }
    return Promise.resolve({ filled: ['username', 'password'] });
  });
  const autofill = createAutofill({
    vault,
    search,
    service,
    tabs: { send, inject: () => Promise.resolve() },
    copy: () => Promise.resolve(),
    settings: () => Promise.resolve({ ...DEFAULT_SETTINGS, autoCopyTotp: false }),
  });
  for (const id of Object.keys(frames)) autofill.frameReady(7, Number(id));
  const card = newDraft(CipherType.Card);
  card.name = 'Travel card';
  card.card = {
    cardholderName: 'Alice Example',
    brand: 'Visa',
    number: '4111111111111111',
    expMonth: '4',
    expYear: '2031',
    code: '123',
  };
  const cardId = await service.saveItem({ id: null, draft: card });
  const identity = newDraft(CipherType.Identity);
  identity.name = 'Home';
  identity.identity = {
    ...identity.identity!,
    firstName: 'Alice',
    lastName: 'Example',
    city: 'Springfield',
    ssn: '123-45-6789',
  };
  const identityId = await service.saveItem({ id: null, draft: identity });
  return { autofill, sent, send, cardId, identityId };
}

const shop = (fields: Partial<PageInfo['fields']> = {}): PageInfo => ({
  url: 'https://shop.test/checkout',
  fields: { ...NO_FIELDS, ...fields },
});

describe('autofill in frames, worker side', () => {
  it('fills a card split over payment provider frames, each with only its own field', async () => {
    const { autofill, sent, cardId } = await setup(shop(), {
      11: frame('https://js.stripe.com/v3/elements-inner-card.html', { cardKeys: ['number'] }),
      12: frame('https://js.stripe.com/v3/elements-inner-expiry.html', { cardKeys: ['exp'] }),
      13: frame('https://js.stripe.com/v3/elements-inner-cvc.html', { cardKeys: ['code'] }),
    });
    const result = await autofill.fill({ tabId: 7, id: cardId });
    expect(result.filled.sort()).toEqual(['code', 'exp', 'number']);
    const byFrame = new Map(sent.map((s) => [s.frameId, s.message]));
    expect(byFrame.has(0)).toBe(false);
    expect(byFrame.get(11)).toMatchObject({
      origin: 'https://js.stripe.com',
      card: { number: CARD.number, code: null, expMonth: null, cardholderName: null },
    });
    expect(byFrame.get(12)).toMatchObject({
      card: { number: null, code: null, expMonth: '4', expYear: '2031' },
    });
    expect(byFrame.get(13)).toMatchObject({ card: { number: null, code: '123' } });
  });

  it('fills the top page and its provider frame together', async () => {
    const { autofill, sent, cardId } = await setup(shop({ card: true }), {
      11: frame('https://checkoutshopper-live.adyen.com/x', { cardKeys: ['number', 'code'] }),
    });
    await autofill.fill({ tabId: 7, id: cardId });
    expect(sent.map((s) => s.frameId).sort()).toEqual([0, 11]);
    // The top page gets the whole card, as without frames.
    expect(sent.find((s) => s.frameId === 0)?.message).toMatchObject({ card: CARD });
  });

  it('fills a frame from the page’s own site without asking', async () => {
    const { autofill, sent, cardId } = await setup(shop(), {
      11: frame('https://pay.shop.test/card', { cardKeys: ['number', 'exp', 'code'] }),
    });
    await autofill.fill({ tabId: 7, id: cardId });
    expect(sent.map((s) => s.frameId)).toEqual([11]);
  });

  it('asks before a card goes to a frame from a site it doesn’t know', async () => {
    const { autofill, sent, cardId } = await setup(shop(), {
      11: frame('https://cards.unknown.test/f', { cardKeys: ['number', 'exp', 'code'] }),
    });
    await expect(autofill.fill({ tabId: 7, id: cardId })).rejects.toMatchObject({
      code: 'fill-mismatch',
      message: expect.stringContaining('cards.unknown.test') as unknown,
      details: { frames: ['https://cards.unknown.test'] },
    });
    expect(sent).toHaveLength(0);
    // Confirming another origin doesn't count.
    await expect(
      autofill.fill({ tabId: 7, id: cardId, confirmedFrames: ['https://other.test'] }),
    ).rejects.toMatchObject({ code: 'fill-mismatch' });
    await autofill.fill({ tabId: 7, id: cardId, confirmedFrames: ['https://cards.unknown.test'] });
    expect(sent.map((s) => s.frameId)).toEqual([11]);
  });

  it('never sends a card to a hidden or insecure frame', async () => {
    const { autofill, sent, cardId } = await setup(shop({ card: true }), {
      11: frame('https://js.stripe.com/a', { cardKeys: ['number'], visible: false }),
      12: frame('http://js.stripe.com/b', { cardKeys: ['code'] }),
    });
    await autofill.fill({ tabId: 7, id: cardId });
    expect(sent.map((s) => s.frameId)).toEqual([0]);
  });

  it('says so when the only card form is hidden', async () => {
    const { autofill, sent, cardId } = await setup(shop(), {
      11: frame('https://js.stripe.com/a', { cardKeys: ['number', 'exp'], visible: false }),
    });
    await expect(autofill.fill({ tabId: 7, id: cardId })).rejects.toThrow('isn’t visible');
    expect(sent).toHaveLength(0);
  });

  it('ignores a lone security code frame when nothing in the tab is a card form', async () => {
    const { autofill, sent, cardId } = await setup(shop(), {
      11: frame('https://js.stripe.com/cvc', { cardKeys: ['code'] }),
    });
    await autofill.fill({ tabId: 7, id: cardId });
    expect(sent.map((s) => s.frameId)).toEqual([0]);
  });

  it('sends a frame only the identity values its fields use', async () => {
    const { autofill, sent, identityId } = await setup(shop(), {
      11: frame('https://js.stripe.com/address', { identityKeys: ['fullName', 'city'] }),
    });
    await autofill.fill({ tabId: 7, id: identityId });
    const identity = (sent[0]?.message as Extract<ContentRequest, { type: 'content:fill-form' }>)
      .identity;
    expect(identity).toMatchObject({
      firstName: 'Alice',
      lastName: 'Example',
      city: 'Springfield',
    });
    expect(Object.keys(identity!).sort()).toEqual([
      'city',
      'firstName',
      'lastName',
      'middleName',
      'title',
    ]);
  });

  it('fills a login into the embedded frame it is saved for', async () => {
    const { autofill, sent } = await setup(
      { url: 'https://portal.test/', fields: { ...NO_FIELDS } },
      {
        11: frame('https://login.example.com/embed', {
          fields: { ...NO_FIELDS, username: true, password: true },
        }),
      },
    );
    await autofill.fill({ tabId: 7, id: loginId });
    expect(sent).toEqual([
      {
        frameId: 11,
        message: expect.objectContaining({
          type: 'content:fill',
          origin: 'https://login.example.com',
          password: loginItem.password,
        }) as unknown,
      },
    ]);
  });

  it('asks before filling a login into a frame it isn’t saved for', async () => {
    const { autofill, sent } = await setup(
      { url: 'https://login.example.com/', fields: { ...NO_FIELDS } },
      {
        11: frame('https://evil.test/embed', {
          focused: true,
          fields: { ...NO_FIELDS, username: true, password: true },
        }),
      },
    );
    // The top page matches, but the form the user is in belongs to another site.
    await expect(autofill.fill({ tabId: 7, id: loginId })).rejects.toMatchObject({
      code: 'fill-mismatch',
      details: { origin: 'https://evil.test' },
    });
    expect(sent).toHaveLength(0);
  });

  it('prefers the frame the user was typing in over the top page', async () => {
    const { autofill, sent } = await setup(
      { url: 'https://login.example.com/', fields: { ...NO_FIELDS, username: true } },
      {
        11: frame('https://login.example.com/frame', {
          focused: true,
          fields: { ...NO_FIELDS, username: true, password: true },
        }),
      },
    );
    await autofill.fill({ tabId: 7, id: loginId });
    expect(sent.map((s) => s.frameId)).toEqual([11]);
  });

  it('forgets frames that went away, and a closed tab’s frames', async () => {
    const { autofill, send, cardId } = await setup(shop({ card: true }), {});
    autofill.frameReady(7, 99);
    await autofill.fill({ tabId: 7, id: cardId });
    await autofill.fill({ tabId: 7, id: cardId });
    const inspects99 = send.mock.calls.filter(
      ([, m, f]) => m.type === 'content:inspect' && f === 99,
    );
    expect(inspects99).toHaveLength(1);
    autofill.frameReady(7, 5);
    autofill.tabClosed(7);
    send.mockClear();
    await autofill.fill({ tabId: 7, id: cardId });
    expect(send.mock.calls.some(([, , f]) => f === 5)).toBe(false);
  });

  it('suggests cards for a page whose card form is in frames', async () => {
    const { autofill } = await setup(shop(), {
      11: frame('https://js.stripe.com/a', { cardKeys: ['number'] }),
    });
    await expect(autofill.inspectTab(7)).resolves.toMatchObject({ card: true });
  });
});

describe('frame helpers', () => {
  it('trims a card to the fields asked for', () => {
    expect(cardFor(CARD, ['expMonth'])).toEqual({
      cardholderName: null,
      brand: null,
      number: null,
      expMonth: '4',
      expYear: '2031',
      code: null,
    });
  });

  it('never gives an address frame identity numbers', () => {
    expect(
      identityFor({ ssn: '1', passportNumber: '2', city: 'X' }, ['city', 'ssn', 'passportNumber']),
    ).toEqual({ city: 'X' });
  });

  it('knows the common payment providers by registrable domain', () => {
    expect(isPaymentProvider('stripe.com')).toBe(true);
    expect(isPaymentProvider('braintreegateway.com')).toBe(true);
    expect(isPaymentProvider('stripe.com.evil.test')).toBe(false);
  });
});

describe('autofill in frames, frame side', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('finds a lone security code by its autocomplete token, for split card forms', () => {
    document.body.innerHTML = '<input name="cvc" autocomplete="cc-csc" />';
    expect(Object.keys(findCardFields(null, document, false).fields)).toEqual([]);
    expect(Object.keys(findCardFields(null, document, true).fields)).toEqual(['code']);
    // A one-time code box named like a security code isn't a card field on its own.
    document.body.innerHTML = '<input name="security-code" />';
    expect(Object.keys(findCardFields(null, document, true).fields)).toEqual([]);
  });

  it('fills only the values it was given', () => {
    document.body.innerHTML = '<input name="cvc" autocomplete="cc-csc" />';
    expect(fillCard(cardFor(CARD, ['code']), null, true)).toEqual(['code']);
    expect(document.querySelector('input')!.value).toBe('123');
  });

  it('reports its card fields and focus', async () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    document.body.innerHTML =
      '<input name="cardnumber" autocomplete="cc-number" /><input name="exp-date" autocomplete="cc-exp" />';
    document.querySelector('input')!.focus();
    const info = await inspectFrame();
    expect(info).toMatchObject({ focused: true, cardKeys: ['number', 'exp'] });
  });

  it('treats a field the browser says is covered as hidden', async () => {
    class Observer {
      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe(target: Element) {
        this.callback(
          [{ target, isVisible: false } as unknown as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        );
      }
      disconnect() {}
    }
    vi.stubGlobal('IntersectionObserver', Observer);
    expect(await fieldVisible(document.body)).toBe(false);
  });
});
