import { ApiClient } from '../src/api';
import type { SyncResponse } from '../src/api/types';
import { VaultService, type ServiceDeps } from '../src/background/service';
import type { SearchIndex } from '../src/search';
import type { Account } from '../src/storage/account';
import type { UnlockedSession } from '../src/storage/session';
import type { VaultState } from '../src/vault/state';
import type { OfficialVaultFixture } from './fixtures';

export interface FakeServer {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  calls: string[];
  /** Set to make the next requests fail as if offline. */
  offline: boolean;
  refreshCount: number;
  /** Vault revision the server reports; bump it to simulate a change in another client. */
  revision: number;
  /** Require two-step login (code 123456, or the remember token it hands out). */
  twoFactor: boolean;
  /** Require Bitwarden's new-device verification (code 654321). */
  newDevice: boolean;
  /** Sync response to serve (defaults to the fixture's). */
  sync: SyncResponse;
  /** Extra routes: path -> response. */
  routes: Map<string, () => Response>;
  forms: URLSearchParams[];
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** A tiny stand-in for a Vaultwarden server that serves one official-client fixture. */
export function fakeServer(fixture: OfficialVaultFixture): FakeServer {
  const unlock = fixture.sync.userDecryption!.masterPasswordUnlock!;
  const server: FakeServer = {
    calls: [],
    offline: false,
    refreshCount: 0,
    revision: 1_700_000_000_000,
    twoFactor: false,
    newDevice: false,
    sync: fixture.sync,
    routes: new Map(),
    forms: [],
    fetch: (url, init) => {
      const path = new URL(url).pathname;
      server.calls.push(path);
      if (server.offline) return Promise.reject(new TypeError('Failed to fetch'));
      const route = server.routes.get(path);
      if (route) return Promise.resolve(route());
      if (path === '/api/accounts/revision-date')
        return Promise.resolve(json(200, server.revision));
      if (path === '/identity/accounts/prelogin') {
        return Promise.resolve(
          json(200, {
            kdf: unlock.kdf.kdfType,
            kdfIterations: unlock.kdf.iterations,
            kdfMemory: unlock.kdf.memory,
            kdfParallelism: unlock.kdf.parallelism,
            salt: null,
          }),
        );
      }
      if (path === '/identity/connect/token') {
        const form = new URLSearchParams(init?.body as string);
        server.forms.push(form);
        if (form.get('grant_type') === 'refresh_token') {
          server.refreshCount++;
          return Promise.resolve(
            json(200, {
              access_token: 'access-2',
              refresh_token: 'refresh-2',
              expires_in: 3600,
              token_type: 'Bearer',
            }),
          );
        }
        if (form.get('password') !== fixture.masterPasswordHash) {
          return Promise.resolve(
            json(400, {
              error: 'invalid_grant',
              error_description: 'invalid_username_or_password',
              ErrorModel: {
                Message: 'Username or password is incorrect. Try again',
                Object: 'error',
              },
            }),
          );
        }
        let rememberToken: string | null = null;
        if (server.twoFactor) {
          const token = form.get('twoFactorToken');
          const provider = form.get('twoFactorProvider');
          const ok =
            (provider === '0' && token === '123456') ||
            (provider === '1' && token === '123456') ||
            (provider === '5' && token === 'remember-1');
          if (!ok) {
            return Promise.resolve(
              json(400, {
                error: 'invalid_grant',
                error_description: 'Two factor required.',
                TwoFactorProviders: [0, 1],
                TwoFactorProviders2: { '0': null, '1': { Email: 'a***@example.com' } },
              }),
            );
          }
          if (form.get('twoFactorRemember') === '1') rememberToken = 'remember-1';
        } else if (server.newDevice && form.get('newDeviceOtp') !== '654321') {
          return Promise.resolve(
            json(400, {
              error: 'invalid_grant',
              error_description: 'new device verification required',
              ErrorModel: { Message: 'new device verification required', Object: 'error' },
            }),
          );
        }
        return Promise.resolve(
          json(200, {
            ...(rememberToken ? { TwoFactorToken: rememberToken } : {}),
            access_token: 'access-1',
            refresh_token: 'refresh-1',
            expires_in: 3600,
            token_type: 'Bearer',
            Key: fixture.sync.profile.key,
            PrivateKey: fixture.sync.profile.privateKey,
            Kdf: unlock.kdf.kdfType,
            KdfIterations: unlock.kdf.iterations,
          }),
        );
      }
      if (path === '/api/sync') return Promise.resolve(json(200, server.sync));
      return Promise.resolve(json(404, { message: 'Not found' }));
    },
  };
  return server;
}

export function memoryDeps(server?: FakeServer): ServiceDeps & {
  stored: {
    account: Account | null;
    session: UnlockedSession | null;
    cache: Map<string, SyncResponse>;
    remembered: Map<string, string>;
  };
} {
  const stored = {
    account: null as Account | null,
    session: null as UnlockedSession | null,
    cache: new Map<string, SyncResponse>(),
    remembered: new Map<string, string>(),
  };
  let now = Date.parse('2026-11-25T00:00:00Z');
  return {
    stored,
    createApi: (serverUrl) =>
      new ApiClient(
        { baseUrl: serverUrl },
        server?.fetch ?? (() => Promise.reject(new TypeError('offline'))),
      ),
    account: {
      load: () => Promise.resolve(stored.account),
      save: (a) => {
        stored.account = structuredClone(a);
        return Promise.resolve();
      },
      clear: () => {
        stored.account = null;
        return Promise.resolve();
      },
      deviceId: () => Promise.resolve('00000000-0000-4000-8000-000000000000'),
    },
    session: {
      save: (s) => {
        stored.session = { ...s, userKey: new Uint8Array(s.userKey) };
        return Promise.resolve();
      },
      load: () =>
        Promise.resolve(
          stored.session
            ? { ...stored.session, userKey: new Uint8Array(stored.session.userKey) }
            : null,
        ),
      clear: () => {
        stored.session = null;
        return Promise.resolve();
      },
    },
    cache: {
      read: (id) => Promise.resolve(stored.cache.get(id) ?? null),
      write: (id, sync) => {
        stored.cache.set(id, sync);
        return Promise.resolve();
      },
      clear: (id) => {
        stored.cache.delete(id);
        return Promise.resolve();
      },
    },
    remembered: {
      get: (serverUrl, email) =>
        Promise.resolve(stored.remembered.get(`${serverUrl}|${email}`) ?? null),
      set: (serverUrl, email, token) => {
        if (token) stored.remembered.set(`${serverUrl}|${email}`, token);
        else stored.remembered.delete(`${serverUrl}|${email}`);
        return Promise.resolve();
      },
    },
    device: { type: 2, name: 'chrome' },
    now: () => (now += 1000),
  };
}

export function createTestService(vault: VaultState, search: SearchIndex, server?: FakeServer) {
  const deps = memoryDeps(server);
  return { service: new VaultService(vault, search, deps), deps };
}
