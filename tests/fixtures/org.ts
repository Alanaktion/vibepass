/**
 * An organization vault built in the test from the official PBKDF2 fixture's own keys: the
 * account's real RSA key pair receives a new organization key, and one shared login plus a
 * collection are encrypted with it, the way the server would deliver them in /sync.
 */
import type { CipherResponse, SyncResponse } from '../../src/api/types';
import { decryptUserKeyWithPassword, sdk, unwrapPrivateKey } from '../../src/crypto';
import { CipherType, FieldType } from '../../src/vault/types';
import { officialVaults } from './index';

export const ORG_ID = '11111111-2222-4333-8444-555555555555';
export const COLLECTION_ID = '99999999-8888-4777-8666-555555555555';
export const ORG_CIPHER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

export async function orgVault(
  options: { viewPassword?: boolean; reprompt?: boolean } = {},
): Promise<{ sync: SyncResponse; userKey: Uint8Array }> {
  const fixture = officialVaults.pbkdf2;
  const unlock = fixture.sync.userDecryption!.masterPasswordUnlock!;
  const userKey = await decryptUserKeyWithPassword(
    unlock.masterKeyEncryptedUserKey,
    fixture.password,
    unlock.salt,
    { type: unlock.kdf.kdfType, iterations: unlock.kdf.iterations } as never,
  );
  const crypto = await sdk();
  const privateKey = await unwrapPrivateKey(fixture.sync.profile.privateKey!, userKey);
  const publicKey = crypto.rsa_extract_public_key(privateKey);
  const orgKey = crypto.make_user_key_aes256_cbc_hmac();
  const enc = (value: string) => crypto.symmetric_encrypt_string(value, orgKey);

  const cipher: CipherResponse = {
    id: ORG_CIPHER_ID,
    organizationId: ORG_ID,
    folderId: null,
    type: CipherType.Login,
    key: null,
    name: enc('Team Wiki'),
    notes: enc('shared runbook'),
    favorite: false,
    revisionDate: '2026-11-25T00:00:00Z',
    deletedDate: null,
    reprompt: options.reprompt ? 1 : 0,
    viewPassword: options.viewPassword ?? true,
    collectionIds: [COLLECTION_ID],
    login: {
      username: enc('team@example.com'),
      password: enc('team-secret'),
      totp: null,
      uris: [{ uri: enc('https://wiki.example.org/login'), match: null }],
    },
    fields: [{ name: enc('PIN'), value: enc('4321'), type: FieldType.Hidden }],
  };

  const sync: SyncResponse = {
    ...structuredClone(fixture.sync),
    collections: [
      { id: COLLECTION_ID, organizationId: ORG_ID, name: enc('Engineering'), readOnly: true },
    ],
  };
  sync.profile.organizations = [
    { id: ORG_ID, name: 'Acme', key: crypto.encapsulate_key_unsigned(orgKey, publicKey) },
  ];
  sync.ciphers = [...sync.ciphers, cipher];
  return { sync, userKey };
}
