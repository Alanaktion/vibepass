import { useState } from 'preact/hooks';

export type DialogRequest =
  | { kind: 'password'; resolve: (value: string | null) => void }
  | {
      kind: 'confirm';
      message: string;
      confirmLabel: string;
      resolve: (value: boolean) => void;
    };

/** Modal for re-prompt and "fill anyway?", rendered over the current view. */
export function Dialog({ request, onDone }: { request: DialogRequest; onDone: () => void }) {
  const [password, setPassword] = useState('');

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

  const finish = (value: string | null) => {
    request.resolve(value);
    onDone();
  };
  return (
    <div class="dialog-backdrop">
      <div class="dialog" role="dialog" aria-modal="true" aria-label="Master password required">
        <form
          class="stack"
          onSubmit={(e) => {
            e.preventDefault();
            finish(password);
          }}
        >
          <p>This item asks for your master password.</p>
          <label>
            Master password
            <input
              type="password"
              autocomplete="current-password"
              value={password}
              onInput={(e) => {
                setPassword(e.currentTarget.value);
              }}
              autoFocus
              required
            />
          </label>
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
        width={24}
        height={24}
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
