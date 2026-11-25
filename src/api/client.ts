import { NotImplementedError } from '../shared/errors';
import type {
  CipherResponse,
  PreloginResponse,
  ServerConfig,
  SyncResponse,
  TokenRequest,
  TokenResponse,
} from './types';

/**
 * Client for a self-hosted Bitwarden or Vaultwarden server.
 * Scaffold only: endpoint URLs are wired up, requests are not.
 */
export class ApiClient {
  readonly baseUrl: string;
  private accessToken: string | null = null;

  constructor(config: ServerConfig) {
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
  }

  get identityUrl(): string {
    return `${this.baseUrl}/identity`;
  }

  get apiUrl(): string {
    return `${this.baseUrl}/api`;
  }

  get notificationsUrl(): string {
    return `${this.baseUrl}/notifications/hub`;
  }

  setAccessToken(token: string | null): void {
    this.accessToken = token;
  }

  get isAuthenticated(): boolean {
    return this.accessToken !== null;
  }

  prelogin(_email: string): Promise<PreloginResponse> {
    return Promise.reject(new NotImplementedError('ApiClient.prelogin'));
  }

  login(_request: TokenRequest): Promise<TokenResponse> {
    return Promise.reject(new NotImplementedError('ApiClient.login'));
  }

  refresh(_refreshToken: string): Promise<TokenResponse> {
    return Promise.reject(new NotImplementedError('ApiClient.refresh'));
  }

  sync(): Promise<SyncResponse> {
    return Promise.reject(new NotImplementedError('ApiClient.sync'));
  }

  getCipher(_id: string): Promise<CipherResponse> {
    return Promise.reject(new NotImplementedError('ApiClient.getCipher'));
  }
}

/** Trim whitespace and trailing slashes, and require http(s). */
export function normalizeBaseUrl(input: string): string {
  const url = new URL(input.trim());
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Server URL must use http or https');
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}
