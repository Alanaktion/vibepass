import { useState } from 'preact/hooks';
import type { RepromptAnswer } from '../lib';

export type DialogRequest =
  | {
      kind: 'password';
      resolve: (value: RepromptAnswer | null) => void;
      /** Why the last answer didn't work. */
      error?: string;
    }
  | {
      kind: 'confirm';
      message: string;
      confirmLabel: string;
      resolve: (value: boolean) => void;
    };

/** Modal for re-prompt and "fill anyway?", rendered over the current view. */
export function Dialog({
  request,
  pinReprompt = false,
  onDone,
}: {
  request: DialogRequest;
  /** The user allowed the PIN for re-prompt items, and it isn't paused by wrong PINs. */
  pinReprompt?: boolean;
  onDone: () => void;
}) {
  const [password, setPassword] = useState('');
  const [preferPin, setPreferPin] = useState(true);

  if (request.kind === 'confirm') {
    const answer = (value: boolean) => {
      request.resolve(value);
      onDone();
    };
    return (
      <div class="dialog-backdrop">
        <div class="dialog" role="alertdialog" aria-modal="true" aria-label="Confirm">
          <p>{request.message}</p>
          <div class="row end">
            <button
              type="button"
              onClick={() => {
                answer(false);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              class="primary"
              autoFocus
              onClick={() => {
                answer(true);
              }}
            >
              {request.confirmLabel}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const usePin = pinReprompt && preferPin;
  const finish = (value: RepromptAnswer | null) => {
    request.resolve(value);
    onDone();
  };
  return (
    <div class="dialog-backdrop">
      <div
        class="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={usePin ? 'PIN required' : 'Master password required'}
      >
        <form
          class="stack"
          onSubmit={(e) => {
            e.preventDefault();
            finish(usePin ? { pin: password } : { masterPassword: password });
          }}
        >
          <p>
            This item asks for your {usePin ? 'PIN' : 'master password'}. You won’t be asked again
            until you close Vibepass or it locks.
          </p>
          <label>
            {usePin ? 'PIN' : 'Master password'}
            <input
              key={usePin ? 'pin' : 'password'}
              type="password"
              autocomplete={usePin ? 'off' : 'current-password'}
              value={password}
              onInput={(e) => {
                setPassword(e.currentTarget.value);
              }}
              autoFocus
              required
            />
          </label>
          {request.error && (
            <p role="alert" class="error">
              {request.error}
            </p>
          )}
          {pinReprompt && (
            <button
              type="button"
              class="link"
              onClick={() => {
                setPreferPin(!preferPin);
                setPassword('');
              }}
            >
              {usePin ? 'Use master password instead' : 'Use PIN instead'}
            </button>
          )}
          <div class="row end">
            <button
              type="button"
              onClick={() => {
                finish(null);
              }}
            >
              Cancel
            </button>
            <button type="submit" class="primary" disabled={password === ''}>
              Continue
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function Toast({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div class="toast" role="status">
      {message}
    </div>
  );
}

/** Website icon from the server's icon service, falling back to the item's first letter. */
export function ItemIcon({ name, src }: { name: string; src: string | null }) {
  const [failed, setFailed] = useState(false);
  if (src && !failed) {
    return (
      <img
        class="icon"
        src={src}
        alt=""
        width={18}
        height={18}
        onError={() => {
          setFailed(true);
        }}
      />
    );
  }
  return (
    <span class="icon letter" aria-hidden="true">
      {(name.trim()[0] ?? '?').toUpperCase()}
    </span>
  );
}
