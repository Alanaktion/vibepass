import { KdfType, type KdfConfig } from '../crypto/types';
import type {
  PasswordTokenRequest,
  PreloginResponse,
  ServerConfig,
  SyncResponse,
  TokenResponse,
} from './types';

/** A request the server rejected, with the most useful message we could find in the body. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** The account has two-step login turned on. The prompt for it arrives in Phase 1. */
export class TwoFactorRequiredError extends ApiError {
  constructor(readonly providers: number[]) {
    super(
      'This account uses two-step login. Vibepass will support it soon; for now, use an account without it.',
      400,
    );
    this.name = 'TwoFactorRequiredError';
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Client for a self-hosted Bitwarden or Vaultwarden server. It only speaks HTTP: it never sees
 * the master password or any key, just the derived login hash and tokens.
 */
export class ApiClient {
  readonly baseUrl: string;
  private accessToken: string | null = null;
  private readonly fetch: FetchLike;

  constructor(config: ServerConfig, fetchImpl: FetchLike = (input, init) => fetch(input, init)) {
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    this.fetch = fetchImpl;
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

  /** KDF settings for an account. Unknown emails get server defaults, by design. */
  async prelogin(email: string): Promise<{ kdf: KdfConfig; salt: string | null }> {
    const body = await this.json<PreloginResponse>(`${this.identityUrl}/accounts/prelogin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    return {
      kdf: kdfFromWire(body.kdf, body.kdfIterations, body.kdfMemory, body.kdfParallelism),
      salt: body.salt ?? null,
    };
  }

  async login({ email, masterPasswordHash, device }: PasswordTokenRequest): Promise<TokenResponse> {
    const form = new URLSearchParams({
      grant_type: 'password',
      username: email,
      password: masterPasswordHash,
      scope: 'api offline_access',
      client_id: 'browser',
      deviceType: String(device.type),
      deviceIdentifier: device.identifier,
      deviceName: device.name,
    });
    const token = await this.json<TokenResponse>(`${this.identityUrl}/connect/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
        'Device-Type': String(device.type),
      },
      body: form.toString(),
    });
    this.accessToken = token.access_token;
    return token;
  }

  async refresh(refreshToken: string): Promise<TokenResponse> {
    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: 'browser',
      refresh_token: refreshToken,
    });
    const token = await this.json<TokenResponse>(`${this.identityUrl}/connect/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
      body: form.toString(),
    });
    this.accessToken = token.access_token;
    return token;
  }

  async sync(): Promise<SyncResponse> {
    return await this.json<SyncResponse>(`${this.apiUrl}/sync?excludeDomains=true`, {
      headers: this.authHeaders(),
    });
  }

  private authHeaders(): Record<string, string> {
    if (!this.accessToken) throw new ApiError('Not logged in', 401);
    return { Authorization: `Bearer ${this.accessToken}` };
  }

  private async json<T>(url: string, init: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await this.fetch(url, {
        ...init,
        headers: { Accept: 'application/json', ...(init.headers as Record<string, string>) },
        credentials: 'omit',
        cache: 'no-store',
      });
    } catch {
      throw new ApiError(`Could not reach ${this.baseUrl}`, 0);
    }
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // Non-JSON error pages (proxies, 404s) fall through to the status-based message.
    }
    if (!response.ok) throw errorFrom(response.status, body);
    if (body === null)
      throw new ApiError('The server sent an empty or unreadable response', response.status);
    return body as T;
  }
}

export function kdfFromWire(
  type: KdfType,
  iterations: number,
  memory?: number | null,
  parallelism?: number | null,
): KdfConfig {
  if (type === KdfType.Argon2id) {
    if (!memory || !parallelism) throw new Error('Server sent incomplete Argon2id settings');
    return { type: KdfType.Argon2id, iterations, memoryMiB: memory, parallelism };
  }
  // Servers send plain numbers, so an unknown type can still arrive at runtime.
  if ((type as number) !== 0) throw new Error(`Unsupported key derivation type ${String(type)}`);
  return { type: KdfType.PBKDF2_SHA256, iterations };
}

function errorFrom(status: number, body: unknown): ApiError {
  const data = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  if (Array.isArray(data.TwoFactorProviders)) {
    return new TwoFactorRequiredError((data.TwoFactorProviders as unknown[]).map(Number));
  }
  const model = (data.ErrorModel ?? data.errorModel) as
    { Message?: unknown; message?: unknown } | undefined;
  const candidates = [
    model?.Message,
    model?.message,
    data.message,
    data.Message,
    data.error_description,
  ];
  const message = candidates.find((c): c is string => typeof c === 'string' && c !== '');
  if (
    data.error_description === 'invalid_username_or_password' ||
    (data.error === 'invalid_grant' && !message)
  ) {
    return new ApiError('Email or master password is incorrect', status);
  }
  if (status === 401) return new ApiError('Your session expired. Log in again.', status);
  return new ApiError(message ?? `Server error (${String(status)})`, status);
}

/** Trim whitespace and trailing slashes, and require http(s). */
export function normalizeBaseUrl(input: string): string {
  const url = new URL(input.trim());
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Server URL must use http or https');
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}
