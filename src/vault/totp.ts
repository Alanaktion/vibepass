/**
 * TOTP codes (RFC 6238) from the seed formats Bitwarden stores: a bare base32 secret, an
 * otpauth:// URI, or a steam:// secret. Runs in the background worker only; the seed never
 * leaves it, just the current code.
 */
export type TotpAlgorithm = 'SHA-1' | 'SHA-256' | 'SHA-512';

export interface TotpParams {
  secret: Uint8Array;
  algorithm: TotpAlgorithm;
  digits: number;
  period: number;
  steam: boolean;
}

export interface TotpCode {
  code: string;
  period: number;
  /** Seconds until this code stops being valid. */
  remaining: number;
}

const STEAM_ALPHABET = '23456789BCDFGHJKMNPQRTVWXY';
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(input: string): Uint8Array {
  const clean = input.toUpperCase().replace(/[\s=-]/g, '');
  if (clean === '' || /[^A-Z2-7]/.test(clean)) throw new Error('Invalid TOTP secret');
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    buffer = (buffer << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

function algorithmFrom(value: string | null): TotpAlgorithm {
  switch (value?.toUpperCase().replace('-', '')) {
    case 'SHA256':
      return 'SHA-256';
    case 'SHA512':
      return 'SHA-512';
    default:
      return 'SHA-1';
  }
}

function intParam(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = value === null ? NaN : Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export function parseTotp(raw: string): TotpParams {
  const value = raw.trim();
  if (/^steam:\/\//i.test(value)) {
    return {
      secret: base32Decode(value.slice('steam://'.length)),
      algorithm: 'SHA-1',
      digits: 5,
      period: 30,
      steam: true,
    };
  }
  if (/^otpauth:\/\//i.test(value)) {
    const url = new URL(value);
    const params = url.searchParams;
    const secret = params.get('secret');
    if (!secret) throw new Error('Invalid TOTP secret');
    const steam = params.get('encoder')?.toLowerCase() === 'steam';
    return {
      secret: base32Decode(secret),
      algorithm: algorithmFrom(params.get('algorithm')),
      digits: steam ? 5 : intParam(params.get('digits'), 6, 1, 10),
      period: intParam(params.get('period'), 30, 1, 3600),
      steam,
    };
  }
  return { secret: base32Decode(value), algorithm: 'SHA-1', digits: 6, period: 30, steam: false };
}

/** HOTP (RFC 4226) for one counter value. */
async function hotp(params: TotpParams, counter: number): Promise<string> {
  const message = new Uint8Array(8);
  let rest = counter;
  for (let i = 7; i >= 0; i--) {
    message[i] = rest & 0xff;
    rest = Math.floor(rest / 256);
  }
  const key = await crypto.subtle.importKey(
    'raw',
    params.secret as Uint8Array<ArrayBuffer>,
    { name: 'HMAC', hash: params.algorithm },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, message));
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const binary =
    (((mac[offset] ?? 0) & 0x7f) << 24) |
    ((mac[offset + 1] ?? 0) << 16) |
    ((mac[offset + 2] ?? 0) << 8) |
    (mac[offset + 3] ?? 0);

  if (params.steam) {
    let code = '';
    let value = binary;
    for (let i = 0; i < params.digits; i++) {
      code += STEAM_ALPHABET[value % STEAM_ALPHABET.length] ?? '';
      value = Math.floor(value / STEAM_ALPHABET.length);
    }
    return code;
  }
  return String(binary % 10 ** params.digits).padStart(params.digits, '0');
}

export async function totpCode(params: TotpParams, nowMs: number): Promise<TotpCode> {
  const seconds = Math.floor(nowMs / 1000);
  const counter = Math.floor(seconds / params.period);
  return {
    code: await hotp(params, counter),
    period: params.period,
    remaining: params.period - (seconds % params.period),
  };
}

/** Convenience: parse the stored seed and compute the current code. */
export async function generateTotp(raw: string, nowMs: number): Promise<TotpCode> {
  return totpCode(parseTotp(raw), nowMs);
}
