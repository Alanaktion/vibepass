/**
 * Biometric unlock runs WebAuthn in an extension window, not the toolbar popup: the popup closes
 * as soon as the browser's passkey sheet takes focus. The worker opens the window, tells it what
 * to do over a port only that window can open, and gets back the passkey's PRF output.
 */
import browser, { type Runtime } from '../shared/browser';

/** What the window should do: make a new platform passkey, or use the saved one. */
export type BiometricRequest =
  { mode: 'enroll'; salt: string } | { mode: 'unlock'; salt: string; credentialId: string };

/** The window's answer. `prf` is the 32-byte PRF output, base64; it lives only in this message. */
export interface BiometricResult {
  credentialId: string;
  prf: string;
}

export const BIOMETRIC_PARAM = 'biometric';
const TIMEOUT_MS = 120_000;

function isResult(value: unknown): value is BiometricResult {
  const v = value as Partial<BiometricResult> | null;
  return typeof v?.credentialId === 'string' && typeof v.prf === 'string';
}

/**
 * Open the biometric window and hand each answer to `finish` until one succeeds. A failure
 * (wrong passkey, or the worker can't use the answer) is shown in the window, which can retry.
 */
export async function askBiometric(
  request: BiometricRequest,
  finish: (result: BiometricResult) => Promise<void>,
): Promise<void> {
  const id = crypto.randomUUID();
  const url = `${browser.runtime.getURL('popup/index.html')}?${BIOMETRIC_PARAM}=${id}`;
  let windowId: number | undefined;
  let finished = false;
  let listener: ((port: Runtime.Port) => void) | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const cancel = () => {
        reject(new Error('Biometric unlock was cancelled'));
      };
      timeout = setTimeout(cancel, TIMEOUT_MS);
      listener = (port) => {
        if (port.name !== id || port.sender?.url !== url || port.sender.id !== browser.runtime.id)
          return;
        port.onDisconnect.addListener(cancel);
        port.postMessage({ request });
        port.onMessage.addListener((message: unknown) => {
          if (!isResult(message)) return;
          finish(message).then(resolve, (error: unknown) => {
            if (!finished) {
              port.postMessage({
                error: error instanceof Error ? error.message : 'That didn’t work. Try again.',
              });
            }
          });
        });
      };
      browser.runtime.onConnect.addListener(listener);
      void browser.windows.create({ type: 'popup', url, width: 420, height: 360 }).then((win) => {
        windowId = win.id;
        if (finished && windowId !== undefined)
          void browser.windows.remove(windowId).catch(() => undefined);
      }, cancel);
    });
  } finally {
    finished = true;
    clearTimeout(timeout);
    if (listener) browser.runtime.onConnect.removeListener(listener);
    if (windowId !== undefined) await browser.windows.remove(windowId).catch(() => undefined);
  }
}
