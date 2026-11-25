import { KdfType, type KdfConfig } from '../crypto/types';
import type { ErrorCode } from '../shared/errors';
import {
  TwoFactorProvider,
  type AttachmentResponse,
  type PasswordTokenRequest,
  type PreloginResponse,
  type ServerConfig,
  type SyncResponse,
  type TokenResponse,
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

/** What the login screen needs to ask for a two-step login code. No secrets. */
export interface TwoFactorDetails {
  /** Providers the account has turned on, in the server's order. */
  providers: TwoFactorProvider[];
  /** Masked address the server will email a code to, for the email provider. */
  emailHint: string | null;
}

/** The account has two-step login turned on; ask for a code and send the token request again. */
export class TwoFactorRequiredError extends ApiError {
  readonly code: ErrorCode = 'two-factor-required';
  readonly details: TwoFactorDetails;

  constructor(providers: TwoFactorProvider[], emailHint: string | null = null) {
    super('Enter your two-step login code', 400);
    this.name = 'TwoFactorRequiredError';
    this.details = { providers, emailHint };
  }

  get providers(): TwoFactorProvider[] {
    return this.details.providers;
  }
}

/** Bitwarden asks new devices (without two-step login) for a code it emails to the account. */
export class NewDeviceVerificationError extends ApiError {
  readonly code: ErrorCode = 'new-device-verification';

  constructor() {
    super('Enter the verification code Bitwarden emailed you', 400);
    this.name = 'NewDeviceVerificationError';
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

  async login({
    email,
    masterPasswordHash,
    device,
    challenge,
  }: PasswordTokenRequest): Promise<TokenResponse> {
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
    if (challenge?.twoFactor) {
      form.set('twoFactorToken', challenge.twoFactor.token.replace(/\s+/g, ''));
      form.set('twoFactorProvider', String(challenge.twoFactor.provider));
      form.set('twoFactorRemember', challenge.twoFactor.remember ? '1' : '0');
    }
    if (challenge?.newDeviceOtp) form.set('newDeviceOtp', challenge.newDeviceOtp.trim());
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

  /** Ask the server to email a two-step login code. Needs the login hash, like the token call. */
  async sendEmailLoginCode(
    email: string,
    masterPasswordHash: string,
    deviceIdentifier: string,
  ): Promise<void> {
    await this.request(`${this.apiUrl}/two-factor/send-email-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, masterPasswordHash, deviceIdentifier }),
    });
  }

  /** Ask Bitwarden to email a new device verification code again. */
  async resendNewDeviceOtp(email: string, masterPasswordHash: string): Promise<void> {
    await this.request(`${this.apiUrl}/accounts/resend-new-device-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, masterPasswordHash }),
    });
  }

  /** When the account's vault last changed, in epoch ms. Cheap, so background sync polls it. */
  async revisionDate(): Promise<number> {
    const body = await this.json<unknown>(`${this.apiUrl}/accounts/revision-date`, {
      headers: this.authHeaders(),
    });
    const value = typeof body === 'number' ? body : Date.parse(String(body));
    if (!Number.isFinite(value)) throw new ApiError('The server sent an unreadable revision', 200);
    return value;
  }

  /** Download metadata for an attachment, including a short-lived URL for the encrypted file. */
  async attachment(cipherId: string, attachmentId: string): Promise<AttachmentResponse> {
    return await this.json<AttachmentResponse>(
      `${this.apiUrl}/ciphers/${encodeURIComponent(cipherId)}/attachment/${encodeURIComponent(attachmentId)}`,
      { headers: this.authHeaders() },
    );
  }

  /** Fetch an encrypted attachment. Only from the server's own origin, without our token. */
  async download(url: string): Promise<Uint8Array> {
    const target = new URL(url, this.baseUrl);
    if (target.origin !== new URL(this.baseUrl).origin) {
      throw new ApiError('Attachments stored outside your server are not supported yet', 0);
    }
    const response = await this.request(target.href, {});
    return new Uint8Array(await response.arrayBuffer());
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

  private async request(url: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetch(url, {
        ...init,
        credentials: 'omit',
        cache: 'no-store',
      });
    } catch {
      throw new ApiError(`Could not reach ${this.baseUrl}`, 0);
    }
    if (!response.ok) {
      const text = await response.text();
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        // Fall through to the status-based message.
      }
      throw errorFrom(response.status, body);
    }
    return response;
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
  if (Array.isArray(data.TwoFactorProviders) || isObject(data.TwoFactorProviders2)) {
    return twoFactorError(data);
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
  if (data.error === 'device_error' || /new device verification required/i.test(message ?? '')) {
    return new NewDeviceVerificationError();
  }
  if (
    data.error_description === 'invalid_username_or_password' ||
    (data.error === 'invalid_grant' && !message)
  ) {
    return new ApiError('Email or master password is incorrect', status);
  }
  if (status === 401) return new ApiError('Your session expired. Log in again.', status);
  return new ApiError(message ?? `Server error (${String(status)})`, status);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Servers send the provider list as an array, a keyed object with parameters, or both. */
function twoFactorError(data: Record<string, unknown>): TwoFactorRequiredError {
  const params = isObject(data.TwoFactorProviders2) ? data.TwoFactorProviders2 : {};
  const ids = Array.isArray(data.TwoFactorProviders)
    ? (data.TwoFactorProviders as unknown[]).map(Number)
    : Object.keys(params).map(Number);
  const providers = [...new Set(ids)].filter(
    (id): id is TwoFactorProvider => Number.isInteger(id) && id in TwoFactorProvider,
  );
  const email = params[String(TwoFactorProvider.Email)];
  const hint = isObject(email) && typeof email.Email === 'string' ? email.Email : null;
  return new TwoFactorRequiredError(providers, hint);
}

/** Trim whitespace and trailing slashes, and require http(s). */
export function normalizeBaseUrl(input: string): string {
  const url = new URL(input.trim());
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Server URL must use http or https');
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}
