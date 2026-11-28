import { useEffect, useRef, useState } from 'preact/hooks';
import browser, { type Runtime } from '../shared/browser';
import { fromBase64, toBase64 } from '../crypto/kdf';
import type { BiometricRequest } from '../background/biometric';
import { biometricSupport } from './biometric';

const TIMEOUT_MS = 60_000;

function bytes(view: BufferSource): Uint8Array {
  return view instanceof ArrayBuffer
    ? new Uint8Array(view)
    : new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

function random(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(length));
}

/** Ask the saved platform passkey for its PRF output. */
async function evaluate(credentialId: Uint8Array, salt: Uint8Array): Promise<Uint8Array> {
  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge: random(32),
      allowCredentials: [{ type: 'public-key', id: credentialId as Uint8Array<ArrayBuffer> }],
      userVerification: 'required',
      timeout: TIMEOUT_MS,
      extensions: { prf: { eval: { first: salt as Uint8Array<ArrayBuffer> } } },
    },
  })) as PublicKeyCredential | null;
  const first = credential?.getClientExtensionResults().prf?.results?.first;
  if (!first) throw new Error('This device didn’t return a key for Vibepass.');
  return bytes(first);
}

/** Make a platform passkey for Vibepass, then get its PRF output (from create, or one more ask). */
async function enroll(salt: Uint8Array): Promise<{ credentialId: Uint8Array; prf: Uint8Array }> {
  const credential = (await navigator.credentials.create({
    publicKey: {
      // No RP id: the browser uses the extension's own origin, which no website can claim.
      rp: { name: 'Vibepass' },
      user: { id: random(16), name: 'Vibepass unlock', displayName: 'Vibepass unlock' },
      challenge: random(32),
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification: 'required',
        residentKey: 'discouraged',
      },
      timeout: TIMEOUT_MS,
      extensions: { prf: { eval: { first: salt as Uint8Array<ArrayBuffer> } } },
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error('No passkey was made.');
  const credentialId = new Uint8Array(credential.rawId);
  const prf = credential.getClientExtensionResults().prf;
  if (prf?.enabled === false) {
    throw new Error('This device can’t unlock Vibepass this way (no PRF support).');
  }
  const first = prf?.results?.first;
  return { credentialId, prf: first ? bytes(first) : await evaluate(credentialId, salt) };
}

function failure(error: unknown): string {
  if (error instanceof DOMException && error.name === 'NotAllowedError') {
    return 'Cancelled or timed out.';
  }
  return error instanceof Error ? error.message : 'That didn’t work.';
}

/** The extension window where Touch ID or Windows Hello runs (see src/background/biometric.ts). */
export function BiometricWindow({ id }: { id: string }) {
  const [label, setLabel] = useState('biometrics');
  const [request, setRequest] = useState<BiometricRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const portRef = useRef<Runtime.Port | null>(null);

  async function run(req: BiometricRequest) {
    setBusy(true);
    setError('');
    try {
      const salt = fromBase64(req.salt);
      const result =
        req.mode === 'enroll'
          ? await enroll(salt)
          : {
              credentialId: fromBase64(req.credentialId),
              prf: await evaluate(fromBase64(req.credentialId), salt),
            };
      portRef.current?.postMessage({
        credentialId: toBase64(result.credentialId),
        prf: toBase64(result.prf),
      });
      result.prf.fill(0);
    } catch (e) {
      setError(failure(e));
      setBusy(false);
    }
  }

  useEffect(() => {
    void biometricSupport().then((s) => {
      setLabel(s.label);
    });
    const connection = browser.runtime.connect({ name: id });
    connection.onMessage.addListener((value: unknown) => {
      const message = value as { request?: BiometricRequest; error?: string };
      if (message.request) {
        setRequest(message.request);
        void run(message.request);
      }
      if (message.error) {
        setError(message.error);
        setBusy(false);
      }
    });
    connection.onDisconnect.addListener(() => {
      window.close();
    });
    portRef.current = connection;
    return () => {
      connection.disconnect();
    };
  }, [id]);

  const action = request?.mode === 'enroll' ? `Set up ${label}` : `Unlock with ${label}`;
  return (
    <main class="screen stack">
      <h1>{action}</h1>
      <p class="muted">
        {busy ? `Follow your browser’s prompt to use ${label}.` : 'Vibepass needs you to confirm.'}
      </p>
      {error && (
        <p role="alert" class="error">
          {error}
        </p>
      )}
      <div class="row end">
        <button
          type="button"
          onClick={() => {
            window.close();
          }}
        >
          Cancel
        </button>
        <button
          type="button"
          class="primary"
          disabled={busy || !request}
          autoFocus
          onClick={() => {
            if (request) void run(request);
          }}
        >
          Try again
        </button>
      </div>
    </main>
  );
}
