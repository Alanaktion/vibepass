import type { SyncResponse } from '../../src/api/types';
import pbkdf2 from './official-pbkdf2.json';
import argon2id from './official-argon2id.json';

export interface OfficialVaultFixture {
  email: string;
  password: string;
  masterPasswordHash: string;
  expected: {
    folders: string[];
    items: {
      name: string;
      type: number;
      username?: string;
      password?: string;
      totp?: string;
      uris?: string[];
      notes?: string;
    }[];
  };
  sync: SyncResponse;
}

/** JSON imports type enums as plain numbers, so the fixtures are cast once here. */
function load(data: unknown): OfficialVaultFixture {
  return data as OfficialVaultFixture;
}

/** Vaults written by the official Bitwarden web vault against a local Vaultwarden. */
export const officialVaults = { pbkdf2: load(pbkdf2), argon2id: load(argon2id) };
