/**
 * Passkeys: the authenticator's output must verify the way a website verifies it (signature over
 * authenticatorData and the clientDataJSON hash, with the public key from registration), and the
 * worker must only offer and sign passkeys for the page's own site.
 */
import { describe, expect, it } from 'vitest';
import { createPasskeys } from '../src/background/passkeys';
import { createSearchIndex } from '../src/search';
import { DEFAULT_SETTINGS, type Settings } from '../src/storage/settings';
import { decryptCipher } from '../src/vault/decrypt';
import {
  createPasskey,
  credentialIdForPage,
  isValidRpId,
  p1363ToDer,
  parseCredentialId,
  signAssertion,
} from '../src/vault/passkey';
import { VaultState } from '../src/vault/state';
import { CipherType } from '../src/vault/types';
import { fromBase64Url, toBase64Url, type PasskeyCreateRequest } from '../src/shared/webauthn';
import { officialVaults } from './fixtures';
import { createTestService, fakeServer } from './helpers';

const fixture = officialVaults.pbkdf2;
const PAGE = 'https://www.passkeys.vibepass-test.dev/login';
const NOW = new Date('2026-11-25T12:00:00Z');

const sha256 = async (bytes: Uint8Array<ArrayBuffer>) =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));

/** DER ECDSA signature back to r||s, as Web Crypto verifies it. */
function derToP1363(der: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(64);
  let offset = 2;
  for (let i = 0; i < 2; i++) {
    const length = der[offset + 1]!;
    let value = der.slice(offset + 2, offset + 2 + length);
    while (value.length > 32 && value[0] === 0) value = value.slice(1);
    out.set(value, 32 * (i + 1) - value.length);
    offset += 2 + length;
  }
  return out;
}

/** What a website does with a sign-in response. */
async function verifyAssertion(
  spki: string,
  assertion: { authenticatorData: string; clientDataJSON: string; signature: string },
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'spki',
    fromBase64Url(spki),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  const authData = fromBase64Url(assertion.authenticatorData);
  const hash = await sha256(fromBase64Url(assertion.clientDataJSON));
  const signed = new Uint8Array(authData.length + hash.length);
  signed.set(authData);
  signed.set(hash, authData.length);
  return crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    derToP1363(fromBase64Url(assertion.signature)),
    signed,
  );
}

const input = {
  rpId: 'passkeys.vibepass-test.dev',
  rpName: 'Example',
  userHandle: 'dXNlci1oYW5kbGU',
  userName: 'alice@example.com',
  userDisplayName: 'Alice',
  discoverable: true,
  challenge: 'cmVnaXN0ZXI',
  origin: 'https://www.passkeys.vibepass-test.dev',
  credProps: true,
  now: NOW,
};

describe('passkey authenticator', () => {
  it('makes a passkey whose sign-ins verify against its registration', async () => {
    const { passkey, response } = await createPasskey(input);
    expect(passkey.credentialId).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.id).toBe(credentialIdForPage(passkey.credentialId));
    expect(response.credProps).toEqual({ rk: true });
    expect(JSON.parse(new TextDecoder().decode(fromBase64Url(response.clientDataJSON)))).toEqual({
      type: 'webauthn.create',
      challenge: 'cmVnaXN0ZXI',
      origin: 'https://www.passkeys.vibepass-test.dev',
      crossOrigin: false,
    });

    // authenticatorData: rpIdHash, flags (UP, UV, BE, BS, AT), counter 0, then the credential.
    const authData = fromBase64Url(response.authenticatorData);
    expect(authData.slice(0, 32)).toEqual(
      await sha256(new TextEncoder().encode('passkeys.vibepass-test.dev')),
    );
    expect(authData[32]).toBe(0x5d);
    expect(authData.slice(33, 37)).toEqual(new Uint8Array(4));
    expect(authData.slice(53, 55)).toEqual(new Uint8Array([0, 16]));
    expect(toBase64Url(authData.slice(55, 71))).toBe(response.id);
    // The attestation object carries the same authenticatorData, with "none" attestation.
    const attestation = fromBase64Url(response.attestationObject);
    expect(new TextDecoder().decode(attestation.slice(0, 20))).toContain('none');
    expect(toBase64Url(attestation.slice(attestation.length - authData.length))).toBe(
      response.authenticatorData,
    );

    const assertion = await signAssertion(passkey, {
      challenge: 'c2lnbi1pbg',
      origin: 'https://www.passkeys.vibepass-test.dev',
      counter: 0,
    });
    expect(assertion.id).toBe(response.id);
    expect(assertion.userHandle).toBe('dXNlci1oYW5kbGU');
    expect(fromBase64Url(assertion.authenticatorData)[32]).toBe(0x1d);
    expect(await verifyAssertion(response.publicKey, assertion)).toBe(true);
    // A tampered challenge doesn't verify.
    const forged = { ...assertion, clientDataJSON: toBase64Url(new TextEncoder().encode('{}')) };
    expect(await verifyAssertion(response.publicKey, forged)).toBe(false);
  });

  it('reads credential ids in both stored forms', () => {
    const raw = parseCredentialId('0d7fe169-8486-40ff-bab3-cedbae63a4b0');
    expect(raw?.[0]).toBe(0x0d);
    expect(raw?.[15]).toBe(0xb0);
    expect(parseCredentialId('b64.AQID')).toEqual(new Uint8Array([1, 2, 3]));
    expect(parseCredentialId('not an id')).toBeNull();
  });

  it('encodes signatures as DER, padding high-bit integers', () => {
    const sig = new Uint8Array(64);
    sig[0] = 0x80;
    sig[63] = 1;
    const der = p1363ToDer(sig);
    expect(der[0]).toBe(0x30);
    expect(der[3]).toBe(33);
    expect(der[4]).toBe(0);
    expect(derToP1363(der)).toEqual(sig);
  });

  it('only allows the page’s own site as the relying party', () => {
    expect(isValidRpId('example.com', 'https://login.example.com/')).toBe(true);
    expect(isValidRpId('login.example.com', 'https://login.example.com/')).toBe(true);
    expect(isValidRpId('other.com', 'https://login.example.com/')).toBe(false);
    expect(isValidRpId('ample.com', 'https://example.com/')).toBe(false);
    expect(isValidRpId('com', 'https://example.com/')).toBe(false);
    expect(isValidRpId('co.uk', 'https://example.co.uk/')).toBe(false);
    expect(isValidRpId('github.io', 'https://me.github.io/')).toBe(false);
    expect(isValidRpId('example.com', 'http://example.com/')).toBe(false);
    expect(isValidRpId('localhost', 'http://localhost:8080/')).toBe(true);
    expect(isValidRpId('127.0.0.1', 'https://127.0.0.1/')).toBe(false);
  });
});

async function setup(patch: Partial<Settings> = {}) {
  const server = fakeServer(fixture);
  const vault = new VaultState();
  const search = createSearchIndex();
  const { service } = createTestService(vault, search, server);
  await service.login({
    serverUrl: 'https://vault.example.com/',
    email: fixture.email,
    masterPassword: fixture.password,
  });
  const settings: Settings = { ...DEFAULT_SETTINGS, allowEdits: true, ...patch };
  const passkeys = createPasskeys({
    vault,
    search,
    service,
    settings: () => Promise.resolve(settings),
    now: () => NOW.getTime(),
  });
  return { server, vault, service, passkeys, settings };
}

function createRequest(): PasskeyCreateRequest {
  return {
    rp: { id: 'passkeys.vibepass-test.dev', name: 'Example' },
    user: { id: 'dXNlci1oYW5kbGU', name: 'alice@example.com', displayName: 'Alice' },
    challenge: 'cmVnaXN0ZXI',
    algorithms: [-8, -7, -257],
    excludeCredentials: [],
    residentKey: true,
    credProps: false,
  };
}

describe('passkeys in the worker', () => {
  it('saves a new passkey as a login, then signs in with it', async () => {
    const { passkeys, server, vault } = await setup();
    const options = await passkeys.createOptions(PAGE, {
      rpId: 'passkeys.vibepass-test.dev',
      algorithms: [-7],
      excludeCredentials: [],
      userName: 'alice@example.com',
    });
    expect(options).toEqual({ state: 'ready', rpId: 'passkeys.vibepass-test.dev', logins: [] });

    const created = await passkeys.create(PAGE, createRequest(), null);
    expect(server.writes.at(-1)).toMatchObject({ method: 'POST', path: '/api/ciphers' });
    const saved = vault.items.find((i) => i.name === 'Example');
    expect(saved).toMatchObject({ subtitle: 'alice@example.com', type: CipherType.Login });
    expect(saved?.uris).toEqual([{ uri: 'https://passkeys.vibepass-test.dev', match: null }]);

    // The site now asks to sign in, without knowing who (a discoverable passkey).
    const get = await passkeys.getOptions(PAGE, {
      rpId: 'passkeys.vibepass-test.dev',
      allowCredentials: [],
    });
    expect(get).toEqual({
      state: 'ready',
      rpId: 'passkeys.vibepass-test.dev',
      passkeys: [
        expect.objectContaining({
          cipherId: saved!.id,
          name: 'Example',
          userName: 'alice@example.com',
        }),
      ],
    });
    if (get.state !== 'ready') throw new Error('expected passkeys');
    const choice = get.passkeys[0]!;
    const assertion = await passkeys.get(
      PAGE,
      {
        rpId: 'passkeys.vibepass-test.dev',
        challenge: 'c2lnbg',
        allowCredentials: [created.id],
        userVerification: null,
      },
      choice.cipherId,
      choice.credentialId,
    );
    expect(await verifyAssertion(created.publicKey, assertion)).toBe(true);
    expect(
      JSON.parse(new TextDecoder().decode(fromBase64Url(assertion.clientDataJSON))),
    ).toMatchObject({
      origin: 'https://www.passkeys.vibepass-test.dev',
      challenge: 'c2lnbg',
    });

    // Registering again for the same account is refused.
    expect(
      await passkeys.createOptions(PAGE, {
        rpId: 'passkeys.vibepass-test.dev',
        algorithms: [-7],
        excludeCredentials: [created.id],
        userName: 'alice@example.com',
      }),
    ).toEqual({ state: 'excluded', rpId: 'passkeys.vibepass-test.dev', name: 'Example' });
  });

  it('adds a passkey to an existing login, keeping its password', async () => {
    const { passkeys, vault, service } = await setup();
    const login = vault.items.find((i) => i.type === CipherType.Login && i.uris.length > 0)!;
    const before = await decryptCipher(vault.raw(login.id)!, vault.key!);
    const url = login.uris[0]!.uri;
    const host = new URL(url.includes('://') ? url : `https://${url}`).hostname;
    const page = `https://${host}/`;
    const request = { ...createRequest(), rp: { id: host, name: host } };
    const options = await passkeys.createOptions(page, {
      rpId: host,
      algorithms: [-7],
      excludeCredentials: [],
      userName: 'x',
    });
    expect(options.state === 'ready' && options.logins.map((l) => l.id)).toContain(login.id);
    await passkeys.create(page, request, login.id);
    const after = await service.passkeyLogin(login.id);
    expect(after.login?.password).toBe(before.login?.password);
    expect(after.login?.passkeys).toHaveLength(1);
    expect(after.login?.passkeys[0]?.rpId).toBe(host);
  });

  it('offers nothing to other sites, and hands off when off or locked', async () => {
    const { passkeys, service, settings } = await setup();
    await passkeys.create(PAGE, createRequest(), null);

    const other = await passkeys.getOptions('https://evil.example.net/', {
      rpId: null,
      allowCredentials: [],
    });
    expect(other).toEqual({ state: 'ready', rpId: 'evil.example.net', passkeys: [] });
    // A page can't claim another site's RP id.
    expect(
      await passkeys.getOptions('https://evil.example.net/', {
        rpId: 'passkeys.vibepass-test.dev',
        allowCredentials: [],
      }),
    ).toEqual({ state: 'off' });
    await expect(
      passkeys.get(
        'https://evil.example.net/',
        {
          rpId: 'passkeys.vibepass-test.dev',
          challenge: 'eA',
          allowCredentials: [],
          userVerification: null,
        },
        'x',
        'y',
      ),
    ).rejects.toThrow();
    // Plain http pages get nothing.
    expect(
      await passkeys.getOptions('http://passkeys.vibepass-test.dev/', {
        rpId: null,
        allowCredentials: [],
      }),
    ).toEqual({ state: 'off' });

    // Saving needs editing on, and only ES256 is offered.
    settings.allowEdits = false;
    expect(
      await passkeys.createOptions(PAGE, {
        rpId: null,
        algorithms: [-7],
        excludeCredentials: [],
        userName: '',
      }),
    ).toEqual({ state: 'off' });
    settings.allowEdits = true;
    expect(
      await passkeys.createOptions(PAGE, {
        rpId: null,
        algorithms: [-257],
        excludeCredentials: [],
        userName: '',
      }),
    ).toEqual({ state: 'off' });

    settings.passkeys = false;
    expect(await passkeys.getOptions(PAGE, { rpId: null, allowCredentials: [] })).toEqual({
      state: 'off',
    });
    settings.passkeys = true;

    await service.lock();
    expect(await passkeys.getOptions(PAGE, { rpId: null, allowCredentials: [] })).toEqual({
      state: 'locked',
    });
  });

  it('reports a platform authenticator only where it would answer', async () => {
    const { passkeys, service, settings } = await setup();
    expect(await passkeys.available(PAGE)).toBe(true);
    // Locked still counts: the prompt asks the user to unlock.
    await service.lock();
    expect(await passkeys.available(PAGE)).toBe(true);
    expect(await passkeys.available('http://passkeys.vibepass-test.dev/')).toBe(false);
    expect(await passkeys.available('not a url')).toBe(false);
    settings.passkeys = false;
    expect(await passkeys.available(PAGE)).toBe(false);
  });
});
