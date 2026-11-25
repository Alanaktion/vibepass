import { describe, expect, it } from 'vitest';
import { ApiClient, TwoFactorRequiredError, normalizeBaseUrl } from '../src/api';
import { KdfType } from '../src/crypto';

describe('normalizeBaseUrl', () => {
  it('trims whitespace and trailing slashes', () => {
    expect(normalizeBaseUrl(' https://vault.example.com/ ')).toBe('https://vault.example.com');
    expect(normalizeBaseUrl('https://example.com/bitwarden//')).toBe(
      'https://example.com/bitwarden',
    );
  });

  it('rejects non-http schemes', () => {
    expect(() => normalizeBaseUrl('ftp://example.com')).toThrow();
  });
});

function client(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const api = new ApiClient({ baseUrl: 'https://vault.example.com/' }, (url, init) => {
    requests.push({ url, init });
    return Promise.resolve(handler(url, init));
  });
  return { api, requests };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe('ApiClient', () => {
  it('derives identity, api, and notifications URLs', () => {
    const api = new ApiClient({ baseUrl: 'https://vault.example.com/' });
    expect(api.identityUrl).toBe('https://vault.example.com/identity');
    expect(api.apiUrl).toBe('https://vault.example.com/api');
    expect(api.notificationsUrl).toBe('https://vault.example.com/notifications/hub');
  });

  it('reads PBKDF2 and Argon2id prelogin settings', async () => {
    const { api } = client(() =>
      json(200, { kdf: 1, kdfIterations: 3, kdfMemory: 64, kdfParallelism: 4, salt: null }),
    );
    await expect(api.prelogin('me@example.com')).resolves.toEqual({
      kdf: { type: KdfType.Argon2id, iterations: 3, memoryMiB: 64, parallelism: 4 },
      salt: null,
    });
  });

  it('sends a password grant with the hash, never the password', async () => {
    const { api, requests } = client(() =>
      json(200, {
        access_token: 'a',
        refresh_token: 'r',
        expires_in: 3600,
        token_type: 'Bearer',
        Key: '2.k',
      }),
    );
    await api.login({
      email: 'me@example.com',
      masterPasswordHash: 'HASH=',
      device: { identifier: 'dev-1', name: 'chrome', type: 2 },
    });
    const form = new URLSearchParams(requests[0]!.init!.body as string);
    expect(requests[0]!.url).toBe('https://vault.example.com/identity/connect/token');
    expect(Object.fromEntries(form)).toEqual({
      grant_type: 'password',
      username: 'me@example.com',
      password: 'HASH=',
      scope: 'api offline_access',
      client_id: 'browser',
      deviceType: '2',
      deviceIdentifier: 'dev-1',
      deviceName: 'chrome',
    });
    expect(api.isAuthenticated).toBe(true);
  });

  it('turns a two-factor challenge into a clear error', async () => {
    const { api } = client(() =>
      json(400, {
        error: 'invalid_grant',
        error_description: 'Two factor required.',
        TwoFactorProviders: [0],
        TwoFactorProviders2: { '0': null },
      }),
    );
    await expect(
      api.login({
        email: 'a@b.c',
        masterPasswordHash: 'h',
        device: { identifier: 'd', name: 'n', type: 2 },
      }),
    ).rejects.toBeInstanceOf(TwoFactorRequiredError);
  });

  it('sends the bearer token with sync and surfaces server messages', async () => {
    const { api, requests } = client((url) =>
      url.endsWith('/api/sync?excludeDomains=true')
        ? json(500, { message: 'Database is on fire' })
        : json(404, {}),
    );
    await expect(api.sync()).rejects.toThrow('Not logged in');
    api.setAccessToken('tok');
    await expect(api.sync()).rejects.toThrow('Database is on fire');
    expect((requests[0]!.init!.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('reports an unreachable server', async () => {
    const api = new ApiClient({ baseUrl: 'https://vault.example.com' }, () =>
      Promise.reject(new TypeError('Failed to fetch')),
    );
    await expect(api.prelogin('a@b.c')).rejects.toThrow(
      'Could not reach https://vault.example.com',
    );
  });
});
