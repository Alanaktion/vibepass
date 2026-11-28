import { useState } from 'preact/hooks';
import { sendMessage } from '../../shared/messaging';
import { useBiometricSupport } from '../biometric';
import { usePopup } from '../context';
import { errorMessage } from '../lib';

/** Turn Touch ID or Windows Hello unlock on or off, where the browser and device can do it. */
export function BiometricSettings() {
  const ctx = usePopup();
  const support = useBiometricSupport();
  const [busy, setBusy] = useState(false);
  if (!support.available && !ctx.status.biometric) return null;

  async function toggle(on: boolean) {
    setBusy(true);
    try {
      // Turning it on opens a window for the browser's prompt, which usually closes this popup.
      ctx.onStatus(await sendMessage(on ? 'biometric:enroll' : 'biometric:remove'));
      if (on) ctx.toast(`${support.label} unlock is on`);
    } catch (err) {
      ctx.toast(errorMessage(err, 'Could not change biometric unlock'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <label class="check">
        <input
          type="checkbox"
          checked={ctx.status.biometric}
          disabled={busy || (!support.available && !ctx.status.biometric)}
          onChange={(e) => void toggle(e.currentTarget.checked)}
        />
        Unlock with {support.label || 'biometrics'}
      </label>
      <p class="muted small">
        Uses a passkey on this device. Your master password still works, and is needed if you remove
        the passkey.
      </p>
    </>
  );
}
