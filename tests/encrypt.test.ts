/**
 * The Phase 2 write gate: items Vibepass encrypts must read back the same in the official
 * clients, and items the official clients write must read back the same in Vibepass, for every
 * field type, without losing fields Vibepass doesn't edit.
 *
 * "The official clients" here is Bitwarden's own cipher code: the SDK's CiphersClient, which the
 * web vault, browser extension, and mobile apps use to encrypt and decrypt items. It runs from
 * the same pinned package, initialized with the fixture account's keys.
 */
import * as glue from '@bitwarden/sdk-internal/bitwarden_wasm_internal_bg.js';
import type {
  Cipher,
  CipherView,
  Fido2CredentialFullView,
  PasswordManagerClient,
} from '@bitwarden/sdk-internal';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CipherResponse } from '../src/api/types';
import {
  KdfType,
  decryptUserKeyWithPassword,
  sdk,
  toBase64,
  type SymmetricKey,
} from '../src/crypto';
import { decryptCipher } from '../src/vault/decrypt';
import {
  PASSWORD_HISTORY_LIMIT,
  UnsupportedCipherError,
  encryptDraft,
  newDraft,
  toDraft,
  type CipherRequest,
} from '../src/vault/encrypt';
import { createPasskey, signAssertion, type NewPasskeyInput } from '../src/vault/passkey';
import { CipherType, FieldType, UriMatch, type ItemDraft } from '../src/vault/types';
import { officialVaults, type OfficialVaultFixture } from './fixtures';

/** The SDK's enums are separate TypeScript enums with the same numbers. */
const asSdk = (value: number): never => value as never;

const NOW = new Date('2026-11-25T12:00:00Z');
const NEW_ID = '0b7f4f2e-5d0a-4c55-9d43-6f1f1c2b9a01';

async function userKeyOf(fixture: OfficialVaultFixture): Promise<SymmetricKey> {
  const unlock = fixture.sync.userDecryption!.masterPasswordUnlock!;
  const kdf =
    unlock.kdf.kdfType === KdfType.Argon2id
      ? {
          type: KdfType.Argon2id as const,
          iterations: unlock.kdf.iterations,
          memoryMiB: unlock.kdf.memory!,
          parallelism: unlock.kdf.parallelism!,
        }
      : { type: KdfType.PBKDF2_SHA256 as const, iterations: unlock.kdf.iterations };
  return decryptUserKeyWithPassword(
    unlock.masterKeyEncryptedUserKey,
    fixture.password,
    unlock.salt,
    kdf,
  );
}

/** Bitwarden's own client, unlocked with the fixture account's user key. */
async function officialClient(
  fixture: OfficialVaultFixture,
  userKey: SymmetricKey,
): Promise<PasswordManagerClient> {
  await sdk();
  const client = new glue.PasswordManagerClient(
    { get_access_token: () => Promise.resolve(undefined) },
    null,
    new glue.ManagedSettingsClient(),
  );
  const unlock = fixture.sync.userDecryption!.masterPasswordUnlock!;
  await client.crypto().initialize_user_crypto({
    userId: fixture.sync.profile.id as never,
    kdfParams:
      unlock.kdf.kdfType === KdfType.Argon2id
        ? {
            argon2id: {
              iterations: unlock.kdf.iterations,
              memory: unlock.kdf.memory!,
              parallelism: unlock.kdf.parallelism!,
            },
          }
        : { pBKDF2: { iterations: unlock.kdf.iterations } },
    email: fixture.email,
    accountCryptographicState: { V1: { private_key: fixture.sync.profile.privateKey as never } },
    method: { decryptedKey: { decrypted_user_key: toBase64(userKey) } },
  });
  return client;
}

/** What a server stores and returns for a create or update request. */
function asStored(request: CipherRequest, id: string): CipherResponse {
  const stored = {
    ...request,
    id,
    revisionDate: NOW.toISOString(),
    creationDate: NOW.toISOString(),
    deletedDate: null,
    edit: true,
    viewPassword: true,
    organizationUseTotp: true,
    collectionIds: [],
    attachments: null,
  } as Record<string, unknown>;
  for (const key of ['lastKnownRevisionDate', 'encryptedFor', 'attachments2']) {
    Reflect.deleteProperty(stored, key);
  }
  return stored as unknown as CipherResponse;
}

const officialDecrypt = (client: PasswordManagerClient, cipher: CipherResponse) =>
  client
    .vault()
    .ciphers()
    .decrypt(cipher as unknown as Cipher);

function passkeyInput(): NewPasskeyInput {
  return {
    rpId: 'passkeys.example.com',
    rpName: 'Example',
    userHandle: 'dXNlci1oYW5kbGU',
    userName: 'alice@example.com',
    userDisplayName: 'Alice',
    discoverable: true,
    challenge: 'Y2hhbGxlbmdl',
    origin: 'https://passkeys.example.com',
    credProps: false,
    now: NOW,
  };
}

function fullLoginDraft(): ItemDraft {
  return {
    ...newDraft(CipherType.Login),
    name: 'Round trip ✓',
    notes: 'Notes with ünïcødé and\nnew lines',
    favorite: true,
    reprompt: true,
    login: {
      username: 'round@example.com',
      password: 'p@ss w0rd “quoted”',
      totp: 'otpauth://totp/Example:round?secret=JBSWY3DPEHPK3PXP&issuer=Example',
      uris: [
        { uri: 'https://round.example.com/login', match: null },
        { uri: 'https://other.example.org', match: UriMatch.Host },
      ],
    },
    fields: [
      { name: 'PIN', value: '1234', type: FieldType.Hidden, linkedId: null },
      { name: 'Account', value: 'A-42', type: FieldType.Text, linkedId: null },
      { name: 'Admin', value: 'true', type: FieldType.Boolean, linkedId: null },
      { name: 'Linked', value: '', type: FieldType.Linked, linkedId: 101 },
    ],
  };
}

describe.each(Object.entries(officialVaults))('round trips (%s)', (_name, fixture) => {
  let userKey: SymmetricKey;
  let official: PasswordManagerClient;
  const context = () => ({ ownerKey: userKey, userId: fixture.sync.profile.id, now: NOW });

  beforeAll(async () => {
    userKey = await userKeyOf(fixture);
    official = await officialClient(fixture, userKey);
  });

  it('a new login reads back the same in the official client', async () => {
    const draft = fullLoginDraft();
    const request = await encryptDraft(draft, null, null, context());
    expect(request.key).toMatch(/^2\./);
    expect(request.encryptedFor).toBe(fixture.sync.profile.id);
    const view = await officialDecrypt(official, asStored(request, NEW_ID));

    expect(view.name).toBe(draft.name);
    expect(view.notes).toBe(draft.notes);
    expect(view.favorite).toBe(true);
    expect(view.reprompt).toBe(1);
    expect(view.login?.username).toBe(draft.login!.username);
    expect(view.login?.password).toBe(draft.login!.password);
    expect(view.login?.totp).toBe(draft.login!.totp);
    // The official client drops a website whose checksum doesn't match.
    expect(view.login?.uris?.map((u) => [u.uri, u.match ?? null])).toEqual([
      ['https://round.example.com/login', null],
      ['https://other.example.org', UriMatch.Host],
    ]);
    expect(view.fields?.map((f) => [f.name, f.value ?? null, f.type, f.linkedId ?? null])).toEqual([
      ['PIN', '1234', FieldType.Hidden, null],
      ['Account', 'A-42', FieldType.Text, null],
      ['Admin', 'true', FieldType.Boolean, null],
      ['Linked', null, FieldType.Linked, 101],
    ]);

    // And Vibepass reads its own write the same way.
    const ours = await decryptCipher(asStored(request, NEW_ID), userKey);
    expect(toDraft(ours)).toEqual({ ...draft, folderId: null });
  });

  it('a new secure note reads back in the official client', async () => {
    const draft = { ...newDraft(CipherType.SecureNote), name: 'Note', notes: 'body' };
    const request = await encryptDraft(draft, null, null, context());
    const view = await officialDecrypt(official, asStored(request, NEW_ID));
    expect(view.type).toBe(CipherType.SecureNote);
    expect(view.secureNote).toEqual({ type: 0 });
    expect(view.notes).toBe('body');
  });

  it('an edit keeps every field it does not change, and records the old password', async () => {
    const base = structuredClone(fixture.sync.ciphers.find((c) => c.type === CipherType.Login)!);
    // A field from a newer client, which Vibepass doesn't know about, must survive.
    (base as unknown as Record<string, unknown>).futureField = { keep: 'me' };
    const previous = await decryptCipher(base, userKey);
    const draft = toDraft(previous);
    draft.name = 'Renamed';
    draft.login!.password = 'a brand new password';

    const request = await encryptDraft(draft, base, previous, context());
    expect(request.futureField).toEqual({ keep: 'me' });
    expect(request.key).toBe(base.key);
    expect(request.lastKnownRevisionDate).toBe(base.revisionDate);
    expect(request.id).toBeUndefined();
    for (const key of ['bankAccount', 'driversLicense', 'passport', 'sshKey', 'card']) {
      expect(Object.hasOwn(request, key)).toBe(Object.hasOwn(base, key));
    }

    const view = await officialDecrypt(official, asStored(request, base.id));
    expect(view.name).toBe('Renamed');
    expect(view.login?.password).toBe('a brand new password');
    expect(view.login?.username).toBe(previous.login?.username);
    expect(view.login?.totp).toBe(previous.login?.totp);
    expect(view.notes).toBe(previous.notes);
    expect(view.login?.uris?.map((u) => u.uri)).toEqual(previous.login?.uris.map((u) => u.uri));
    expect(view.passwordHistory?.[0]?.password).toBe(previous.login?.password);
    expect(Date.parse(view.login!.passwordRevisionDate!)).toBe(NOW.getTime());
  });

  it('keeps password history at the official limit', async () => {
    let cipher = structuredClone(fixture.sync.ciphers.find((c) => c.type === CipherType.Login)!);
    for (let i = 0; i < PASSWORD_HISTORY_LIMIT + 2; i++) {
      const previous = await decryptCipher(cipher, userKey);
      const draft = toDraft(previous);
      draft.login!.password = `password ${String(i)}`;
      cipher = asStored(await encryptDraft(draft, cipher, previous, context()), cipher.id);
    }
    const view = await officialDecrypt(official, cipher);
    expect(view.passwordHistory).toHaveLength(PASSWORD_HISTORY_LIMIT);
    expect(view.passwordHistory?.[0]?.password).toBe(`password ${String(PASSWORD_HISTORY_LIMIT)}`);
  });

  it('reads items the official client writes, for every field type', async () => {
    const base = fixture.sync.ciphers.find((c) => c.type === CipherType.Login)!;
    const view: CipherView = await officialDecrypt(official, base);
    view.name = 'Written by the official client';
    view.notes = 'official notes';
    view.login!.password = 'official password';
    view.fields = [
      { name: 'Hidden', value: 'h1dden', type: asSdk(FieldType.Hidden) },
      { name: 'Flag', value: 'false', type: asSdk(FieldType.Boolean) },
      { name: 'Link', type: asSdk(FieldType.Linked), linkedId: asSdk(100) },
    ];
    const { cipher } = await official.vault().ciphers().encrypt(view);
    const ours = await decryptCipher(cipher as unknown as CipherResponse, userKey);
    expect(ours.name).toBe('Written by the official client');
    expect(ours.notes).toBe('official notes');
    expect(ours.login?.password).toBe('official password');
    expect(ours.login?.username).toBe(view.login?.username);
    expect(ours.fields).toEqual([
      { name: 'Hidden', value: 'h1dden', type: FieldType.Hidden, linkedId: null },
      { name: 'Flag', value: 'false', type: FieldType.Boolean, linkedId: null },
      { name: 'Link', value: null, type: FieldType.Linked, linkedId: 100 },
    ]);
  });

  it('editing a card keeps its card details', async () => {
    const base = fixture.sync.ciphers.find((c) => c.type === CipherType.Login)!;
    const view: CipherView = await officialDecrypt(official, base);
    view.type = asSdk(CipherType.Card);
    delete view.login;
    view.card = {
      cardholderName: 'Alice Example',
      brand: 'Visa',
      number: '4111111111111111',
      expMonth: '4',
      expYear: '2030',
      code: '123',
    };
    const { cipher } = await official.vault().ciphers().encrypt(view);
    const card = cipher as unknown as CipherResponse;
    const previous = await decryptCipher(card, userKey);
    const draft = toDraft(previous);
    draft.name = 'Travel card';
    draft.notes = 'edited in Vibepass';
    const request = await encryptDraft(draft, card, previous, context());
    const after = await officialDecrypt(official, asStored(request, card.id));
    expect(after.name).toBe('Travel card');
    expect(after.card).toEqual(view.card);
    expect(after.login).toBeUndefined();
  });

  it('a passkey Vibepass saves reads back the same in the official client', async () => {
    const { passkey } = await createPasskey(passkeyInput());
    const base = structuredClone(fixture.sync.ciphers.find((c) => c.type === CipherType.Login)!);
    const previous = await decryptCipher(base, userKey);
    const request = await encryptDraft(toDraft(previous), base, previous, context(), {
      add: passkey,
    });
    const stored = asStored(request, base.id);
    const view = await officialDecrypt(official, stored);
    expect(view.login?.fido2Credentials).toHaveLength(1);
    const theirs = view.login!.fido2Credentials![0]!;
    expect(theirs).toMatchObject({
      credentialId: passkey.credentialId,
      keyType: 'public-key',
      keyAlgorithm: 'ECDSA',
      keyCurve: 'P-256',
      keyValue: passkey.keyValue,
      rpId: 'passkeys.example.com',
      userHandle: passkey.userHandle,
      userName: 'alice@example.com',
      counter: '0',
      rpName: 'Example',
      userDisplayName: 'Alice',
      discoverable: 'true',
    });
    expect(Date.parse(theirs.creationDate)).toBe(NOW.getTime());
    // Everything else on the login is untouched.
    expect(view.login?.password).toBe(previous.login?.password);

    // A counter update changes only the counter.
    const withPasskey = await decryptCipher(stored, userKey);
    expect(withPasskey.login?.passkeys).toEqual([passkey]);
    const bumped = await encryptDraft(toDraft(withPasskey), stored, withPasskey, context(), {
      counter: { credentialId: passkey.credentialId, value: 7 },
    });
    const after = await officialDecrypt(official, asStored(bumped, base.id));
    expect(after.login?.fido2Credentials?.[0]).toMatchObject({ ...theirs, counter: '7' });

    // An ordinary edit keeps the passkey.
    const edited = toDraft(withPasskey);
    edited.name = 'Renamed with a passkey';
    const plain = await encryptDraft(edited, stored, withPasskey, context());
    const kept = await officialDecrypt(official, asStored(plain, base.id));
    expect(kept.login?.fido2Credentials?.[0]?.keyValue).toBe(passkey.keyValue);
  });

  it('signs with a passkey the official client saved', async () => {
    const { passkey } = await createPasskey(passkeyInput());
    const base = fixture.sync.ciphers.find((c) => c.type === CipherType.Login)!;
    let view: CipherView = await officialDecrypt(official, base);
    view = official
      .vault()
      .ciphers()
      .set_fido2_credentials(view, [
        { ...passkey, counter: '3', discoverable: 'true', creationDate: NOW.toISOString() },
      ] as unknown as Fido2CredentialFullView[]);
    const { cipher } = await official.vault().ciphers().encrypt(view);
    const ours = await decryptCipher(cipher as unknown as CipherResponse, userKey);
    expect(ours.login?.passkeys).toEqual([
      { ...passkey, counter: 3, creationDate: expect.any(String) as string },
    ]);
    expect(Date.parse(ours.login!.passkeys[0]!.creationDate)).toBe(NOW.getTime());
    const assertion = await signAssertion(ours.login!.passkeys[0]!, {
      challenge: 'Y2hhbGxlbmdl',
      origin: 'https://passkeys.example.com',
      counter: 4,
    });
    expect(assertion.userHandle).toBe(passkey.userHandle);
  });

  it('refuses to re-encrypt an item in a format it does not understand', async () => {
    const base = structuredClone(fixture.sync.ciphers[0]!) as unknown as Record<string, unknown>;
    base.data = 'sealed-blob';
    const cipher = base as unknown as CipherResponse;
    await expect(encryptDraft(newDraft(CipherType.Login), cipher, null, context())).rejects.toThrow(
      UnsupportedCipherError,
    );
  });
});
