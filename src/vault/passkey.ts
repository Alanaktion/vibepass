/**
 * A passkey authenticator in the format Bitwarden stores passkeys in, so passkeys saved by the
 * official clients sign in here and passkeys saved here sign in there.
 *
 * Like the official clients: ES256 (ECDSA P-256) keys only, PKCS#8 private keys stored base64url
 * in `keyValue`, credential ids stored as GUIDs (or "b64." plus base64url for imported ids),
 * "none" attestation, and the backup flags set because the vault syncs. The signing is Web
 * Crypto; Bitwarden's SDK doesn't expose its authenticator to JavaScript.
 */
import { parse } from 'tldts';
import {
  fromBase64Url,
  toBase64Url,
  type AssertionJson,
  type AttestationJson,
} from '../shared/webauthn';

/** COSE algorithm id for ES256, the only one Bitwarden passkeys use. */
export const ES256 = -7;

/** A passkey as stored on a login, decrypted. Lives only in worker memory. */
export interface StoredPasskey {
  credentialId: string;
  keyType: string;
  keyAlgorithm: string;
  keyCurve: string;
  /** PKCS#8 private key, base64url. */
  keyValue: string;
  rpId: string;
  /** base64url */
  userHandle: string | null;
  userName: string | null;
  counter: number;
  rpName: string | null;
  userDisplayName: string | null;
  discoverable: boolean;
  creationDate: string;
}

// Vibepass's AAGUID would identify the authenticator to sites; "none" attestation with a zero
// AAGUID is what the spec asks of authenticators that don't attest, and it keeps us anonymous.
const AAGUID = new Uint8Array(16);

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The raw credential id for a stored one, or null if it is malformed. */
export function parseCredentialId(stored: string): Uint8Array | null {
  try {
    if (stored.startsWith('b64.')) return fromBase64Url(stored.slice(4));
    if (!GUID.test(stored)) return null;
    const hex = stored.replace(/-/g, '');
    const out = new Uint8Array(16);
    for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
  } catch {
    return null;
  }
}

/** The page-facing (base64url) id of a stored credential. */
export function credentialIdForPage(stored: string): string | null {
  const raw = parseCredentialId(stored);
  return raw ? toBase64Url(raw) : null;
}

/**
 * Whether `rpId` may be used on a page at `pageUrl`: the page is https (or localhost), and the
 * RP id is the page's host or a parent domain of it that isn't a public suffix.
 */
export function isValidRpId(rpId: string, pageUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  const rp = rpId.toLowerCase();
  if (host === 'localhost')
    return rp === 'localhost' && (url.protocol === 'http:' || url.protocol === 'https:');
  if (url.protocol !== 'https:') return false;
  if (host !== rp && !host.endsWith(`.${rp}`)) return false;
  const info = parse(rp, { allowPrivateDomains: true });
  if (info.isIp || !info.domain) return false;
  return rp === info.domain || rp.endsWith(`.${info.domain}`);
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;

async function authenticatorData(
  rpId: string,
  counter: number,
  attested: Uint8Array | null,
  verified: boolean,
): Promise<Uint8Array<ArrayBuffer>> {
  const flags = FLAG_UP | (verified ? FLAG_UV : 0) | FLAG_BE | FLAG_BS | (attested ? FLAG_AT : 0);
  const count = new Uint8Array(4);
  new DataView(count.buffer).setUint32(0, counter >>> 0);
  return concat(
    await sha256(new TextEncoder().encode(rpId)),
    new Uint8Array([flags]),
    count,
    attested ?? new Uint8Array(0),
  );
}

/** clientDataJSON, as browsers write it (field order matters to some servers' parsers). */
export function clientDataJson(
  type: 'webauthn.get' | 'webauthn.create',
  challenge: string,
  origin: string,
): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
}

/** Web Crypto signs ECDSA as r||s; WebAuthn wants ASN.1 DER. */
export function p1363ToDer(signature: Uint8Array): Uint8Array<ArrayBuffer> {
  const half = signature.length / 2;
  const integer = (bytes: Uint8Array): Uint8Array => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start++;
    let value = bytes.slice(start);
    if ((value[0] ?? 0) & 0x80) value = concat(new Uint8Array([0]), value);
    return concat(new Uint8Array([0x02, value.length]), value);
  };
  const r = integer(signature.slice(0, half));
  const s = integer(signature.slice(half));
  return concat(new Uint8Array([0x30, r.length + s.length]), r, s);
}

/** CBOR head for a major type and length (only the sizes attestation objects need). */
function cborHead(major: number, length: number): Uint8Array {
  if (length < 24) return new Uint8Array([(major << 5) | length]);
  if (length < 0x100) return new Uint8Array([(major << 5) | 24, length]);
  return new Uint8Array([(major << 5) | 25, length >> 8, length & 0xff]);
}

function cborText(text: string): Uint8Array {
  const bytes = new TextEncoder().encode(text);
  return concat(cborHead(3, bytes.length), bytes);
}

/** { fmt: "none", attStmt: {}, authData } in CTAP2 canonical CBOR (keys by length). */
function attestationObject(authData: Uint8Array): Uint8Array<ArrayBuffer> {
  return concat(
    new Uint8Array([0xa3]),
    cborText('fmt'),
    cborText('none'),
    cborText('attStmt'),
    new Uint8Array([0xa0]),
    cborText('authData'),
    cborHead(2, authData.length),
    authData,
  );
}

/** The public key as a COSE_Key: { kty: EC2, alg: ES256, crv: P-256, x, y }. */
function coseKey(x: Uint8Array, y: Uint8Array): Uint8Array {
  return concat(
    new Uint8Array([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
    x,
    new Uint8Array([0x22, 0x58, 0x20]),
    y,
  );
}

function newGuid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface NewPasskeyInput {
  verified?: boolean;
  rpId: string;
  rpName: string;
  /** base64url */
  userHandle: string;
  userName: string;
  userDisplayName: string;
  discoverable: boolean;
  challenge: string;
  origin: string;
  credProps: boolean;
  now: Date;
}

/** Make a new passkey: the credential to store and the response for the page. */
export async function createPasskey(
  input: NewPasskeyInput,
): Promise<{ passkey: StoredPasskey; response: AttestationJson }> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  if (!jwk.x || !jwk.y) throw new Error('Could not make a passkey');

  const credentialId = newGuid();
  const rawId = parseCredentialId(credentialId);
  if (!rawId) throw new Error('Could not make a passkey');
  const attested = concat(
    AAGUID,
    new Uint8Array([rawId.length >> 8, rawId.length & 0xff]),
    rawId,
    coseKey(fromBase64Url(jwk.x), fromBase64Url(jwk.y)),
  );
  const authData = await authenticatorData(input.rpId, 0, attested, input.verified === true);
  const clientData = clientDataJson('webauthn.create', input.challenge, input.origin);

  const passkey: StoredPasskey = {
    credentialId,
    keyType: 'public-key',
    keyAlgorithm: 'ECDSA',
    keyCurve: 'P-256',
    keyValue: toBase64Url(pkcs8),
    rpId: input.rpId,
    userHandle: input.userHandle,
    userName: input.userName,
    counter: 0,
    rpName: input.rpName,
    userDisplayName: input.userDisplayName,
    discoverable: input.discoverable,
    creationDate: input.now.toISOString(),
  };
  const response: AttestationJson = {
    id: toBase64Url(rawId),
    authenticatorData: toBase64Url(authData),
    clientDataJSON: toBase64Url(clientData),
    attestationObject: toBase64Url(attestationObject(authData)),
    publicKey: toBase64Url(spki),
    publicKeyAlgorithm: ES256,
  };
  if (input.credProps) response.credProps = { rk: input.discoverable };
  pkcs8.fill(0);
  return { passkey, response };
}

/** Sign in with a stored passkey. `counter` is the value to report (see the worker). */
export async function signAssertion(
  passkey: StoredPasskey,
  input: { challenge: string; origin: string; counter: number; verified?: boolean },
): Promise<AssertionJson> {
  if (passkey.keyAlgorithm !== 'ECDSA' || passkey.keyCurve !== 'P-256') {
    throw new Error('This passkey uses a key type Vibepass can’t sign with yet');
  }
  const rawId = parseCredentialId(passkey.credentialId);
  if (!rawId) throw new Error('This passkey’s id is damaged');
  const pkcs8 = fromBase64Url(passkey.keyValue);
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pkcs8,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  pkcs8.fill(0);
  const authData = await authenticatorData(
    passkey.rpId,
    input.counter,
    null,
    input.verified === true,
  );
  const clientData = clientDataJson('webauthn.get', input.challenge, input.origin);
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      concat(authData, await sha256(clientData)),
    ),
  );
  return {
    id: toBase64Url(rawId),
    authenticatorData: toBase64Url(authData),
    clientDataJSON: toBase64Url(clientData),
    signature: toBase64Url(p1363ToDer(signature)),
    userHandle: passkey.userHandle,
  };
}
