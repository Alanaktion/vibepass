import { describe, expect, it } from 'vitest';
import { base32Decode, generateTotp, parseTotp, totpCode } from '../src/vault/totp';

const ascii = (s: string) => new TextEncoder().encode(s);

// RFC 6238 appendix B.
const SEED_SHA1 = ascii('12345678901234567890');
const SEED_SHA256 = ascii('12345678901234567890123456789012');
const SEED_SHA512 = ascii('1234567890123456789012345678901234567890123456789012345678901234');

describe('TOTP', () => {
  it.each([
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1234567890, '89005924', '91819424', '93441116'],
    [20000000000, '65353130', '77737706', '47863826'],
  ])('matches the RFC 6238 vectors at %i', async (time, sha1, sha256, sha512) => {
    const base = { digits: 8, period: 30, steam: false };
    const at = time * 1000;
    expect((await totpCode({ ...base, secret: SEED_SHA1, algorithm: 'SHA-1' }, at)).code).toBe(
      sha1,
    );
    expect((await totpCode({ ...base, secret: SEED_SHA256, algorithm: 'SHA-256' }, at)).code).toBe(
      sha256,
    );
    expect((await totpCode({ ...base, secret: SEED_SHA512, algorithm: 'SHA-512' }, at)).code).toBe(
      sha512,
    );
  });

  it('decodes base32 with spaces, lowercase, and padding', () => {
    expect(base32Decode('GEZD GNBV gy3t qojq====')).toEqual(ascii('1234567890'));
    expect(() => base32Decode('not base32!')).toThrow();
  });

  it('parses otpauth URIs', () => {
    const params = parseTotp(
      'otpauth://totp/Example:alice?secret=GEZDGNBVGY3TQOJQ&algorithm=SHA256&digits=8&period=60',
    );
    expect(params).toMatchObject({ algorithm: 'SHA-256', digits: 8, period: 60, steam: false });
    expect(parseTotp('otpauth://totp/x?secret=GEZDGNBVGY3TQOJQ&digits=99').digits).toBe(6);
  });

  it('counts down to the next code', async () => {
    const code = await generateTotp('JBSWY3DPEHPK3PXP', 1_000_000_000_000);
    expect(code.code).toMatch(/^\d{6}$/);
    expect(code.period).toBe(30);
    expect(code.remaining).toBe(20);
  });

  it('generates Steam codes', async () => {
    const steam = await generateTotp('steam://JBSWY3DPEHPK3PXP', 59_000);
    expect(steam.code).toMatch(/^[23456789BCDFGHJKMNPQRTVWXY]{5}$/);
  });
});
