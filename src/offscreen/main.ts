/**
 * Chrome offscreen document. MV3 service workers have no DOM, so the worker asks this page to
 * write the clipboard (to clear a copied secret, or copy a TOTP after a fill).
 */
import browser, { type Runtime } from '../shared/browser';
import { writeClipboardText } from '../shared/clipboard';
import { isOffscreenRequest } from '../shared/messages';

browser.runtime.onMessage.addListener((message: unknown, sender: Runtime.MessageSender) => {
  if (!isOffscreenRequest(message) || sender.id !== browser.runtime.id) return undefined;
  return writeClipboardText(message.text).then(
    () => ({ ok: true }),
    (error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : 'failed' }),
  );
});
