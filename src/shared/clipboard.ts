/**
 * Write text to the clipboard from a page without a user gesture: the background page in
 * Firefox, or the offscreen document in Chrome. Both need the clipboardWrite permission.
 * A copy event handler lets us write an empty string, which plain execCommand can't.
 */
export async function writeClipboardText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // Offscreen documents never have focus, so the async API fails there; fall back.
  }
  const onCopy = (event: ClipboardEvent) => {
    event.clipboardData?.setData('text/plain', text);
    event.preventDefault();
  };
  document.addEventListener('copy', onCopy, { once: true });
  try {
    // Deprecated, but still the only way to write the clipboard from a page without focus.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    if (!document.execCommand('copy')) throw new Error('Could not write the clipboard');
  } finally {
    document.removeEventListener('copy', onCopy);
  }
}
