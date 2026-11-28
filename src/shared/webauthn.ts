/**
 * The passkey protocol between the page script (which stands in for navigator.credentials in the
 * page), the passkey content script (which asks the user), and the worker (which holds the keys
 * and signs). Binary values travel as base64url strings, so every hop is plain JSON.
 *
 * No imports: the page script is bundled on its own and must stay tiny.
 */

/** navigator.credentials.get({ publicKey }) as the worker needs it. */
export interface PasskeyGetRequest {
  /** null means "the page's own host", as WebAuthn defines it. */
  rpId: string | null;
  challenge: string;
  /** Credential ids the site will accept; empty means "any passkey for this site". */
  allowCredentials: string[];
  userVerification: string | null;
}

/** navigator.credentials.create({ publicKey }) as the worker needs it. */
export interface PasskeyCreateRequest {
  userVerification?: string | null;
  rp: { id: string | null; name: string };
  user: { id: string; name: string; displayName: string };
  challenge: string;
  /** COSE algorithm ids the site accepts, in its order of preference. */
  algorithms: number[];
  /** Credentials the site already has for this account; making another one is refused. */
  excludeCredentials: string[];
  /** The site wants a discoverable credential (one it can find without knowing the id). */
  residentKey: boolean;
  /** The site asked for the credProps extension (whether the credential is discoverable). */
  credProps: boolean;
}

/** A sign-in assertion, ready to wrap as a PublicKeyCredential. */
export interface AssertionJson {
  id: string;
  authenticatorData: string;
  clientDataJSON: string;
  signature: string;
  userHandle: string | null;
}

/** A new credential, ready to wrap as a PublicKeyCredential. */
export interface AttestationJson {
  id: string;
  authenticatorData: string;
  clientDataJSON: string;
  attestationObject: string;
  /** SubjectPublicKeyInfo (DER), for AuthenticatorAttestationResponse.getPublicKey(). */
  publicKey: string;
  publicKeyAlgorithm: number;
  /** Present when the site asked for credProps. */
  credProps?: { rk: boolean };
}

/** What the content script answers the page script with. */
export type PageResult =
  /** Let the browser handle it (no matching passkey, the user chose another device, or off). */
  | { kind: 'fallback' }
  | { kind: 'error'; name: string; message: string }
  | { kind: 'get'; credential: AssertionJson }
  | { kind: 'create'; credential: AttestationJson }
  /** Whether Vibepass can answer passkey requests on this page (setting on, page allowed). */
  | { kind: 'available'; available: boolean };

export const PAGE_CHANNEL = 'vibepass-webauthn';

export type PageRequestMessage =
  | {
      channel: typeof PAGE_CHANNEL;
      dir: 'request';
      id: string;
      kind: 'get';
      request: PasskeyGetRequest;
    }
  | {
      channel: typeof PAGE_CHANNEL;
      dir: 'request';
      id: string;
      kind: 'create';
      request: PasskeyCreateRequest;
    }
  | { channel: typeof PAGE_CHANNEL; dir: 'request'; id: string; kind: 'abort' }
  /** isUserVerifyingPlatformAuthenticatorAvailable(): answered at once, never prompts. */
  | { channel: typeof PAGE_CHANNEL; dir: 'request'; id: string; kind: 'available' };

export type PageResponseMessage =
  /** Sent at once, so the page script knows Vibepass is listening (else it asks the browser). */
  | { channel: typeof PAGE_CHANNEL; dir: 'ack'; id: string }
  | { channel: typeof PAGE_CHANNEL; dir: 'response'; id: string; result: PageResult };

/** How long the page script waits for the ack before handing the request to the browser. */
export const ACK_TIMEOUT_MS = 1000;

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
