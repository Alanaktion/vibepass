/**
 * Page script (runs in the page's own JavaScript world, at document start, top frame only).
 * It stands in for navigator.credentials.get and create so passkeys in the vault can answer,
 * and hands everything else to the browser untouched.
 *
 * It holds no secrets and asks the user nothing: it forwards the request to the passkey content
 * script with window.postMessage, and wraps the answer as a PublicKeyCredential. The page can
 * see and forge these messages, which is fine: it is the site making the request, and the
 * worker checks the site's origin itself.
 */
import {
  ACK_TIMEOUT_MS,
  PAGE_CHANNEL,
  fromBase64Url,
  toBase64Url,
  type AssertionJson,
  type AttestationJson,
  type PageRequestMessage,
  type PageResponseMessage,
  type PageResult,
  type PasskeyCreateRequest,
  type PasskeyGetRequest,
} from '../shared/webauthn';

function bytes(source: BufferSource | undefined | null): Uint8Array {
  if (!source) return new Uint8Array(0);
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
}

const b64 = (source: BufferSource | undefined | null) => toBase64Url(bytes(source));

function getRequest(options: PublicKeyCredentialRequestOptions): PasskeyGetRequest {
  return {
    rpId: options.rpId ?? null,
    challenge: b64(options.challenge),
    allowCredentials: (options.allowCredentials ?? []).map((c) => b64(c.id)),
    userVerification: options.userVerification ?? null,
  };
}

function createRequest(options: PublicKeyCredentialCreationOptions): PasskeyCreateRequest {
  const selection = options.authenticatorSelection;
  const residentKey =
    selection?.residentKey === 'required' ||
    selection?.residentKey === 'preferred' ||
    (selection?.residentKey === undefined && selection?.requireResidentKey === true);
  const extensions = options.extensions as { credProps?: boolean } | undefined;
  return {
    rp: { id: options.rp.id ?? null, name: options.rp.name },
    user: {
      id: b64(options.user.id),
      name: options.user.name,
      displayName: options.user.displayName,
    },
    challenge: b64(options.challenge),
    algorithms: options.pubKeyCredParams
      .filter((p) => (p.type as string) === 'public-key')
      .map((p) => p.alg),
    excludeCredentials: (options.excludeCredentials ?? []).map((c) => b64(c.id)),
    residentKey,
    credProps: extensions?.credProps === true,
  };
}

let nextId = 0;

/** Ask the content script; resolves with its answer, or rejects if the page aborts. */
function ask(
  kind: 'get' | 'create',
  request: PasskeyGetRequest | PasskeyCreateRequest,
  signal: AbortSignal | undefined,
): Promise<PageResult> {
  const id = `${String(Date.now())}-${String(++nextId)}`;
  const target = location.origin === 'null' ? '*' : location.origin;
  return new Promise((resolve, reject) => {
    // Without the content script (a tab older than the extension) nobody answers: use the browser.
    const timer = setTimeout(() => {
      done();
      resolve({ kind: 'fallback' });
    }, ACK_TIMEOUT_MS);
    const done = () => {
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      signal?.removeEventListener('abort', onAbort);
    };
    const onMessage = (event: MessageEvent) => {
      // Anything the page posts arrives here too, so check every field.
      const data = event.data as
        | (Partial<Record<keyof PageResponseMessage, unknown>> & {
            result?: PageResult;
          })
        | null;
      if (event.source !== window || data?.channel !== PAGE_CHANNEL || data.id !== id) return;
      if (data.dir === 'ack') {
        clearTimeout(timer);
        return;
      }
      if (data.dir !== 'response' || !data.result) return;
      done();
      resolve(data.result);
    };
    const onAbort = () => {
      done();
      const abort: PageRequestMessage = {
        channel: PAGE_CHANNEL,
        dir: 'request',
        id,
        kind: 'abort',
      };
      window.postMessage(abort, target);
      // WebAuthn rejects with the signal's own reason, whatever the page made it.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      reject(signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
    };
    window.addEventListener('message', onMessage);
    signal?.addEventListener('abort', onAbort);
    const message = {
      channel: PAGE_CHANNEL,
      dir: 'request',
      id,
      kind,
      request,
    } as PageRequestMessage;
    window.postMessage(message, target);
  });
}

/**
 * Own properties, writable like the browser's own (which live on the prototype): libraries
 * such as @github/webauthn-json assign `credential.toJSON = ...`, which throws in strict code
 * if the property is read-only.
 */
function define(target: object, values: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(target, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
}

/** A PublicKeyCredential the page can't tell from the browser's own (for what sites check). */
function credential(
  id: string,
  response: object,
  responseJson: Record<string, unknown>,
  extensions: Record<string, unknown>,
): PublicKeyCredential {
  const cred = Object.create(PublicKeyCredential.prototype) as PublicKeyCredential;
  define(cred, {
    id,
    rawId: fromBase64Url(id).buffer,
    type: 'public-key',
    authenticatorAttachment: 'platform',
    response,
    getClientExtensionResults: () => extensions,
    toJSON: () => ({
      id,
      rawId: id,
      type: 'public-key',
      authenticatorAttachment: 'platform',
      response: responseJson,
      clientExtensionResults: extensions,
    }),
  });
  return cred;
}

function assertion(json: AssertionJson): PublicKeyCredential {
  const response = Object.create(AuthenticatorAssertionResponse.prototype) as object;
  define(response, {
    clientDataJSON: fromBase64Url(json.clientDataJSON).buffer,
    authenticatorData: fromBase64Url(json.authenticatorData).buffer,
    signature: fromBase64Url(json.signature).buffer,
    userHandle: json.userHandle === null ? null : fromBase64Url(json.userHandle).buffer,
  });
  return credential(
    json.id,
    response,
    {
      clientDataJSON: json.clientDataJSON,
      authenticatorData: json.authenticatorData,
      signature: json.signature,
      userHandle: json.userHandle ?? undefined,
    },
    {},
  );
}

function attestation(json: AttestationJson): PublicKeyCredential {
  const transports = ['hybrid', 'internal'];
  const response = Object.create(AuthenticatorAttestationResponse.prototype) as object;
  define(response, {
    clientDataJSON: fromBase64Url(json.clientDataJSON).buffer,
    attestationObject: fromBase64Url(json.attestationObject).buffer,
    getAuthenticatorData: () => fromBase64Url(json.authenticatorData).buffer,
    getPublicKey: () => fromBase64Url(json.publicKey).buffer,
    getPublicKeyAlgorithm: () => json.publicKeyAlgorithm,
    getTransports: () => [...transports],
  });
  return credential(
    json.id,
    response,
    {
      clientDataJSON: json.clientDataJSON,
      attestationObject: json.attestationObject,
      authenticatorData: json.authenticatorData,
      publicKey: json.publicKey,
      publicKeyAlgorithm: json.publicKeyAlgorithm,
      transports,
    },
    json.credProps ? { credProps: json.credProps } : {},
  );
}

function install(): void {
  const container = navigator.credentials as CredentialsContainer | undefined;
  if (!container || !window.isSecureContext || typeof PublicKeyCredential === 'undefined') return;
  const nativeGet = container.get.bind(container);
  const nativeCreate = container.create.bind(container);

  const get = async (options?: CredentialRequestOptions): Promise<Credential | null> => {
    // Conditional (autofill-style) requests stay with the browser for now.
    if (!options?.publicKey || options.mediation === 'conditional') return nativeGet(options);
    options.signal?.throwIfAborted();
    const result = await ask('get', getRequest(options.publicKey), options.signal ?? undefined);
    if (result.kind === 'get') return assertion(result.credential);
    if (result.kind === 'error') throw new DOMException(result.message, result.name);
    return nativeGet(options);
  };

  const create = async (options?: CredentialCreationOptions): Promise<Credential | null> => {
    if (!options?.publicKey) return nativeCreate(options);
    options.signal?.throwIfAborted();
    const result = await ask(
      'create',
      createRequest(options.publicKey),
      options.signal ?? undefined,
    );
    if (result.kind === 'create') return attestation(result.credential);
    if (result.kind === 'error') throw new DOMException(result.message, result.name);
    return nativeCreate(options);
  };

  Object.defineProperty(container, 'get', { value: get, configurable: true, writable: true });
  Object.defineProperty(container, 'create', { value: create, configurable: true, writable: true });
}

if (window.top === window) install();
