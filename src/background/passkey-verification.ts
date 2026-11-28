import browser, { type Runtime } from '../shared/browser';

/** Collect the password in an extension window. Only that window's port can answer this request. */
export async function verifyPasskeyUser(
  origin: string,
  verify: (password: string) => Promise<void>,
): Promise<void> {
  const id = crypto.randomUUID();
  const url = browser.runtime.getURL('popup/index.html') + '?verify=' + id;
  let windowId: number | undefined;
  let finished = false;
  let listener: ((port: Runtime.Port) => void) | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const cancel = () => {
        reject(new Error('Passkey verification cancelled'));
      };
      timeout = setTimeout(cancel, 90000);
      listener = (port) => {
        if (port.name !== id || port.sender?.url !== url || port.sender.id !== browser.runtime.id)
          return;
        port.onDisconnect.addListener(cancel);
        port.postMessage({ origin });
        port.onMessage.addListener((password: unknown) => {
          if (typeof password !== 'string') return;
          void verify(password).then(resolve, () => {
            if (!finished) port.postMessage({ error: 'Verification failed. Try again.' });
          });
        });
      };
      browser.runtime.onConnect.addListener(listener);
      void browser.windows.create({ type: 'popup', url, width: 420, height: 320 }).then((win) => {
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
