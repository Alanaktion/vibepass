import { useState } from 'preact/hooks';
import type { PinOptions } from '../../shared/messages';
import { sendMessage } from '../../shared/messaging';
import { usePopup } from '../context';
import { errorMessage } from '../lib';

/** Matches the worker's MIN_PIN_LENGTH; the worker checks again. */
const MIN_LENGTH = 4;

/** Set up, change, or turn off unlocking with a PIN. */
export function PinSettings() {
  const ctx = usePopup();
  const pin = ctx.status.pin;
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [confirm, setConfirm] = useState('');
  const [options, setOptions] = useState<PinOptions>({ afterRestart: false, reprompt: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function startEditing() {
    setOptions({ afterRestart: pin.afterRestart, reprompt: pin.repromptSetting });
    setValue('');
    setConfirm('');
    setError(null);
    setEditing(true);
  }

  async function savePin(e: Event) {
    e.preventDefault();
    if (value !== confirm) {
      setError('The PINs don’t match');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      ctx.onStatus(await sendMessage('pin:set', { pin: value, ...options }));
      setEditing(false);
      ctx.toast(pin.set ? 'PIN changed' : 'PIN unlock is on');
    } catch (err) {
      setError(errorMessage(err, 'Could not set the PIN'));
    } finally {
      setValue('');
      setConfirm('');
      setBusy(false);
    }
  }

  function change(patch: Partial<PinOptions>) {
    sendMessage('pin:options', patch).then(ctx.onStatus, (err: unknown) => {
      ctx.toast(errorMessage(err, 'Could not save'));
    });
  }

  if (editing) {
    return (
      <form class="stack pin-setup" onSubmit={(e) => void savePin(e)}>
        <label>
          {pin.set ? 'New PIN' : 'PIN'}
          <input
            type="password"
            autocomplete="off"
            value={value}
            minLength={MIN_LENGTH}
            onInput={(e) => {
              setValue(e.currentTarget.value);
            }}
            autoFocus
            required
          />
        </label>
        <label>
          Confirm PIN
          <input
            type="password"
            autocomplete="off"
            value={confirm}
            onInput={(e) => {
              setConfirm(e.currentTarget.value);
            }}
            required
          />
        </label>
        <label class="check">
          <input
            type="checkbox"
            checked={!options.afterRestart}
            onChange={(e) => {
              setOptions({ ...options, afterRestart: !e.currentTarget.checked });
            }}
          />
          Ask for my master password after the browser restarts
        </label>
        <label class="check">
          <input
            type="checkbox"
            checked={options.reprompt}
            onChange={(e) => {
              setOptions({ ...options, reprompt: e.currentTarget.checked });
            }}
          />
          Accept my PIN for items that ask for the master password
        </label>
        <p class="muted small">
          Use at least {MIN_LENGTH} characters. After 5 wrong PINs, Vibepass asks for your master
          password.
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
              setEditing(false);
            }}
          >
            Cancel
          </button>
          <button type="submit" class="primary" disabled={busy || value.length < MIN_LENGTH}>
            {busy ? 'Saving…' : pin.set ? 'Change PIN' : 'Turn on PIN unlock'}
          </button>
        </div>
      </form>
    );
  }

  if (!pin.set) {
    return (
      <div class="stack">
        <div class="row">
          <button type="button" class="ghost" onClick={startEditing}>
            Unlock with a PIN…
          </button>
        </div>
      </div>
    );
  }

  return (
    <div class="stack">
      <p class="muted small">
        PIN unlock is on.
        {!pin.unlock && ' It works again after the next unlock with your master password.'}
      </p>
      <label class="check">
        <input
          type="checkbox"
          checked={!pin.afterRestart}
          onChange={(e) => {
            change({ afterRestart: !e.currentTarget.checked });
          }}
        />
        Ask for my master password after the browser restarts
      </label>
      <label class="check">
        <input
          type="checkbox"
          checked={pin.repromptSetting}
          onChange={(e) => {
            change({ reprompt: e.currentTarget.checked });
          }}
        />
        Accept my PIN for items that ask for the master password
      </label>
      <div class="row">
        <button type="button" class="ghost" onClick={startEditing}>
          Change PIN…
        </button>
        <button
          type="button"
          class="ghost"
          onClick={() => {
            sendMessage('pin:remove').then(ctx.onStatus, (err: unknown) => {
              ctx.toast(errorMessage(err, 'Could not turn off the PIN'));
            });
          }}
        >
          Turn off PIN
        </button>
      </div>
    </div>
  );
}
