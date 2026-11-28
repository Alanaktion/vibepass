import { ApiClient } from '../src/api';
import type { CipherResponse, SyncResponse } from '../src/api/types';
import { VaultService, type ServiceDeps } from '../src/background/service';
import type { SearchIndex } from '../src/search';
import type { Account } from '../src/storage/account';
import { DEFAULT_GENERATOR, type StoredGeneratorOptions } from '../src/storage/generator';
import type { UnlockedSession } from '../src/storage/session';
import type { PinEnvelope, PinRecord } from '../src/storage/pin';
import type { BiometricRecord } from '../src/storage/biometric';
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
  /** Write requests (method, path, and JSON body), in order. */
  writes: { method: string; path: string; body: Record<string, unknown> | null }[];
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
    writes: [],
    fetch: (url, init) => {
      const path = new URL(url).pathname;
      server.calls.push(path);
      if (server.offline) return Promise.reject(new TypeError('Failed to fetch'));
      const route = server.routes.get(path);
      if (route) return Promise.resolve(route());
      const method = init?.method ?? 'GET';
      if (method !== 'GET' && path.startsWith('/api/')) {
        return Promise.resolve(writeRoute(server, method, path, init?.body));
      }
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

let serial = 0;

/** Vaultwarden-like handling of cipher and folder writes against the served sync response. */
function writeRoute(server: FakeServer, method: string, path: string, raw: unknown): Response {
  const body = typeof raw === 'string' && raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  server.writes.push({ method, path, body });
  server.revision++;
  const now = new Date(Date.parse('2026-11-25T12:00:00Z') + ++serial * 1000).toISOString();
  const sync = structuredClone(server.sync);
  server.sync = sync;
  const parts = path.split('/').filter(Boolean); // ['api', 'ciphers', id, action]
  const find = (id: string | undefined) => sync.ciphers.find((c) => c.id === id);

  if (parts[1] === 'folders') {
    const id = parts[2];
    if (method === 'POST') {
      const folder = {
        id: `folder-${String(serial)}`,
        name: body?.name as string,
        revisionDate: now,
      };
      sync.folders.push(folder);
      return json(200, folder);
    }
    const folder = sync.folders.find((f) => f.id === id);
    if (!folder) return json(404, { message: 'Folder not found' });
    if (method === 'DELETE') {
      sync.folders = sync.folders.filter((f) => f.id !== id);
      for (const c of sync.ciphers) if (c.folderId === id) c.folderId = null;
      return new Response(null, { status: 200 });
    }
    folder.name = body?.name as string;
    folder.revisionDate = now;
    return json(200, folder);
  }

  if (parts[1] !== 'ciphers') return json(404, { message: 'Not found' });
  if (method === 'POST' && parts.length === 2) {
    const created = {
      ...body,
      id: `cipher-${String(serial)}`,
      revisionDate: now,
      creationDate: now,
      deletedDate: null,
      edit: true,
      viewPassword: true,
      collectionIds: [],
      attachments: null,
      object: 'cipherDetails',
    } as unknown as CipherResponse;
    Reflect.deleteProperty(created, 'lastKnownRevisionDate');
    Reflect.deleteProperty(created, 'encryptedFor');
    sync.ciphers.push(created);
    return json(200, created);
  }
  const cipher = find(parts[2]);
  if (!cipher) return json(404, { message: "Cipher doesn't exist" });
  const action = parts[3];
  if (method === 'DELETE') {
    sync.ciphers = sync.ciphers.filter((c) => c !== cipher);
    return new Response(null, { status: 200 });
  }
  if (action === 'delete') {
    cipher.deletedDate = now;
    cipher.revisionDate = now;
    return new Response(null, { status: 200 });
  }
  if (action === 'restore') {
    cipher.deletedDate = null;
    cipher.revisionDate = now;
    return json(200, cipher);
  }
  if (action === 'partial') {
    cipher.folderId = (body?.folderId as string | null) ?? null;
    cipher.favorite = Boolean(body?.favorite);
    return json(200, cipher);
  }
  // Full update.
  if (body?.lastKnownRevisionDate !== cipher.revisionDate) {
    return json(400, {
      message: 'The client copy of this cipher is out of date. Resync the client and try again.',
      errorModel: {
        message: 'The client copy of this cipher is out of date. Resync the client and try again.',
        object: 'error',
      },
    });
  }
  const updated = {
    ...cipher,
    ...body,
    id: cipher.id,
    revisionDate: now,
    attachments: cipher.attachments ?? null,
  } as unknown as CipherResponse & Record<string, unknown>;
  for (const key of ['lastKnownRevisionDate', 'encryptedFor', 'attachments2']) {
    Reflect.deleteProperty(updated, key);
  }
  sync.ciphers = sync.ciphers.map((c) => (c === cipher ? updated : c));
  return json(200, updated);
}

export function memoryDeps(server?: FakeServer): ServiceDeps & {
  stored: {
    account: Account | null;
    session: UnlockedSession | null;
    cache: Map<string, SyncResponse>;
    remembered: Map<string, string>;
    writes: boolean;
    generatorOptions: StoredGeneratorOptions;
    history: string[];
    pin: PinRecord | null;
    pinSession: PinEnvelope | null;
    biometric: BiometricRecord | null;
  };
} {
  const stored = {
    account: null as Account | null,
    session: null as UnlockedSession | null,
    cache: new Map<string, SyncResponse>(),
    remembered: new Map<string, string>(),
    writes: true,
    generatorOptions: DEFAULT_GENERATOR,
    history: [] as string[],
    pin: null as PinRecord | null,
    pinSession: null as PinEnvelope | null,
    biometric: null as BiometricRecord | null,
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
    writesEnabled: () => Promise.resolve(stored.writes),
    generator: {
      loadOptions: () => Promise.resolve(stored.generatorOptions),
      saveOptions: (options) => {
        stored.generatorOptions = options;
        return Promise.resolve();
      },
      loadHistory: () => Promise.resolve([...stored.history]),
      saveHistory: (entries) => {
        stored.history = [...entries];
        return Promise.resolve();
      },
      clearHistory: () => {
        stored.history = [];
        return Promise.resolve();
      },
    },
    pin: {
      load: () => Promise.resolve(stored.pin ? structuredClone(stored.pin) : null),
      save: (record) => {
        stored.pin = structuredClone(record);
        return Promise.resolve();
      },
      clear: () => {
        stored.pin = null;
        stored.pinSession = null;
        return Promise.resolve();
      },
      loadSession: () => Promise.resolve(stored.pinSession),
      saveSession: (envelope) => {
        stored.pinSession = envelope;
        return Promise.resolve();
      },
    },
    biometric: {
      load: () => Promise.resolve(stored.biometric ? structuredClone(stored.biometric) : null),
      save: (record) => {
        stored.biometric = structuredClone(record);
        return Promise.resolve();
      },
      clear: () => {
        stored.biometric = null;
        return Promise.resolve();
      },
    },
    now: () => (now += 1000),
  };
}

export function createTestService(vault: VaultState, search: SearchIndex, server?: FakeServer) {
  const deps = memoryDeps(server);
  return { service: new VaultService(vault, search, deps), deps };
}
