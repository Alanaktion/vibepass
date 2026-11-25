import { describe, expect, it } from 'vitest';
import { ApiClient, normalizeBaseUrl } from '../src/api';

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

describe('ApiClient', () => {
  it('derives identity, api, and notifications URLs', () => {
    const client = new ApiClient({ baseUrl: 'https://vault.example.com/' });
    expect(client.identityUrl).toBe('https://vault.example.com/identity');
    expect(client.apiUrl).toBe('https://vault.example.com/api');
    expect(client.notificationsUrl).toBe('https://vault.example.com/notifications/hub');
  });

  it('has stubbed requests', async () => {
    const client = new ApiClient({ baseUrl: 'https://vault.example.com' });
    await expect(client.sync()).rejects.toThrow('Not implemented yet');
  });
});
