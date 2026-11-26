import { ArrowLeft, Eye, EyeOff, Plus, RefreshCw, X } from 'lucide-preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { isCodedError } from '../../shared/errors';
import { sendMessage } from '../../shared/messaging';
import { newDraft } from '../../vault/draft';
import { parseTotp } from '../../vault/totp';
import { toWebUrl } from '../../vault/uri';
import {
  CipherType,
  FieldType,
  type DraftField,
  type FolderSummary,
  type ItemDraft,
} from '../../vault/types';
import { pw } from '../actions';
import { usePopup } from '../context';
import { errorMessage, hasMod, modLabel, withReprompt } from '../lib';
import { IconButton } from './IconButton';

interface Props {
  /** null creates a new item. */
  id: string | null;
  type: CipherType.Login | CipherType.SecureNote;
  onSaved: (id: string) => void;
  onCancel: () => void;
}

const FIELD_TYPES: { type: FieldType; label: string }[] = [
  { type: FieldType.Text, label: 'Text' },
  { type: FieldType.Hidden, label: 'Hidden' },
  { type: FieldType.Boolean, label: 'Checkbox' },
];

/** A new login for the page the popup opened over: its address and a name from its host. */
function draftForTab(
  type: CipherType.Login | CipherType.SecureNote,
  url: string | undefined,
): ItemDraft {
  const draft = newDraft(type);
  const page = url ? toWebUrl(url) : null;
  if (page && draft.login) {
    draft.name = page.hostname.replace(/^www\./, '');
    draft.login.uris = [{ uri: page.origin, match: null }];
  }
  return draft;
}

function validate(draft: ItemDraft): string | null {
  if (!draft.name.trim()) return 'Give the item a name';
  const totp = draft.login?.totp.trim();
  if (totp) {
    try {
      parseTotp(totp);
    } catch {
      return 'The one-time password key isn’t valid. Paste the setup key or otpauth:// link.';
    }
  }
  return null;
}

/**
 * Edit an item, or create one. Saves with Mod+S or the Save button; Escape cancels. A save that
 * races another device asks before overwriting it.
 */
export function EditView({ id, type, onSaved, onCancel }: Props) {
  const ctx = usePopup();
  const [draft, setDraft] = useState<ItemDraft | null>(null);
  const [revisionDate, setRevisionDate] = useState<string | undefined>(undefined);
  const [organization, setOrganization] = useState<string | null>(null);
  const [folders, setFolders] = useState<FolderSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const dirtyRef = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    let cancelled = false;
    sendMessage('vault:folders').then(
      (list) => {
        if (!cancelled) setFolders(list);
      },
      () => undefined,
    );
    if (id === null) {
      setDraft(draftForTab(type, ctx.tab?.url));
    } else {
      withReprompt(ctx.askPassword, (masterPassword) =>
        sendMessage('vault:edit', { id, ...pw(masterPassword) }),
      ).then(
        (item) => {
          if (cancelled) return;
          if (!item) {
            onCancel();
            return;
          }
          setDraft(item.draft);
          setRevisionDate(item.revisionDate);
          setOrganization(item.organization);
        },
        (e: unknown) => {
          if (!cancelled) setError(errorMessage(e, 'Could not open this item'));
        },
      );
    }
    return () => {
      cancelled = true;
    };
    // Load once per item; the tab and dialogs don't change while the editor is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, type]);

  function change(update: (draft: ItemDraft) => ItemDraft) {
    dirtyRef.current = true;
    setDraft((current) => (current ? update(current) : current));
  }

  function changeLogin(patch: Partial<NonNullable<ItemDraft['login']>>) {
    change((d) => (d.login ? { ...d, login: { ...d.login, ...patch } } : d));
  }

  function changeField(index: number, patch: Partial<DraftField>) {
    change((d) => ({
      ...d,
      fields: d.fields.map((f, i) => (i === index ? { ...f, ...patch } : f)),
    }));
  }

  async function generatePassword() {
    try {
      const { password } = await sendMessage('generator:generate', {});
      changeLogin({ password });
      setShowPassword(true);
    } catch (e) {
      ctx.toast(errorMessage(e, 'Could not generate a password'));
    }
  }

  async function cancel() {
    if (dirtyRef.current && !(await ctx.confirm('Discard your changes?', 'Discard'))) return;
    onCancel();
  }

  async function save() {
    if (!draft || saving) return;
    const problem = validate(draft);
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(null);
    const request = { id, draft, ...(revisionDate ? { revisionDate } : {}) };
    try {
      let saved;
      try {
        saved = await sendMessage('vault:save', request);
      } catch (e) {
        if (!isCodedError(e, 'conflict')) throw e;
        const overwrite = await ctx.confirm(
          'This item was changed on another device since you opened it. Save your version over it?',
          'Save mine',
        );
        if (!overwrite) return;
        saved = await sendMessage('vault:save', { ...request, overwrite: true });
      }
      dirtyRef.current = false;
      ctx.toast(id ? 'Saved' : 'Item added');
      onSaved(saved.id);
    } catch (e) {
      setError(errorMessage(e, 'Could not save'));
    } finally {
      setSaving(false);
    }
  }

  // Keep the latest handlers for the document-level shortcuts without re-binding each render.
  // A layout effect, so Ctrl+S pressed right after typing saves what was just typed (a plain
  // effect runs after paint, and the shortcut could save the draft from before the last key).
  const handlersRef = useRef({ save, cancel });
  useLayoutEffect(() => {
    handlersRef.current = { save, cancel };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('.dialog')) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        void handlersRef.current.cancel();
      } else if (hasMod(e) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void handlersRef.current.save();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  const login = draft?.login ?? null;
  const title = id ? 'Edit item' : type === CipherType.Login ? 'New login' : 'New note';

  return (
    <main class="screen edit">
      <header class="row item-header">
        <IconButton icon={ArrowLeft} label="Cancel" onClick={() => void cancel()} />
        <h1 class="grow title">{title}</h1>
        <button
          type="button"
          class="primary fill"
          disabled={!draft || saving}
          title={`Save (${modLabel()}S)`}
          onClick={() => void save()}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </header>
      {error && (
        <p role="alert" class="error banner">
          {error}
        </p>
      )}
      {organization && <p class="muted small">Shared in {organization}</p>}
      {draft && (
        <form
          ref={formRef}
          class="stack form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label>
            Name
            <input
              value={draft.name}
              autoFocus
              required
              onInput={(e) => {
                const name = e.currentTarget.value;
                change((d) => ({ ...d, name }));
              }}
            />
          </label>
          {login && (
            <>
              <label>
                Username
                <input
                  value={login.username}
                  autocomplete="off"
                  spellcheck={false}
                  onInput={(e) => {
                    changeLogin({ username: e.currentTarget.value });
                  }}
                />
              </label>
              <div class="labelled">
                <label for="edit-password">Password</label>
                <div class="row input-row">
                  <SecretInput
                    id="edit-password"
                    class="grow mono"
                    shown={showPassword}
                    value={login.password}
                    autocomplete="new-password"
                    onValue={(password) => {
                      changeLogin({ password });
                    }}
                  />
                  <IconButton
                    icon={showPassword ? EyeOff : Eye}
                    label={showPassword ? 'Hide password' : 'Show password'}
                    onClick={() => {
                      setShowPassword((s) => !s);
                    }}
                  />
                  <IconButton
                    icon={RefreshCw}
                    label="Generate a password"
                    onClick={() => void generatePassword()}
                  />
                </div>
              </div>
              <label>
                One-time password key
                <input
                  class="mono"
                  value={login.totp}
                  placeholder="Setup key or otpauth:// link"
                  autocomplete="off"
                  spellcheck={false}
                  onInput={(e) => {
                    changeLogin({ totp: e.currentTarget.value });
                  }}
                />
              </label>
              <fieldset>
                <legend>Websites</legend>
                {login.uris.map((uri, i) => (
                  <div class="row input-row" key={String(i)}>
                    <input
                      class="grow"
                      value={uri.uri}
                      aria-label={`Website ${String(i + 1)}`}
                      placeholder="https://example.com"
                      spellcheck={false}
                      onInput={(e) => {
                        const value = e.currentTarget.value;
                        changeLogin({
                          uris: login.uris.map((u, j) => (j === i ? { ...u, uri: value } : u)),
                        });
                      }}
                    />
                    <IconButton
                      icon={X}
                      label={`Remove website ${String(i + 1)}`}
                      onClick={() => {
                        changeLogin({ uris: login.uris.filter((_, j) => j !== i) });
                      }}
                    />
                  </div>
                ))}
                <button
                  type="button"
                  class="ghost add"
                  onClick={() => {
                    changeLogin({ uris: [...login.uris, { uri: '', match: null }] });
                  }}
                >
                  <Plus size={14} aria-hidden="true" /> Add website
                </button>
              </fieldset>
            </>
          )}
          <label>
            Notes
            <textarea
              rows={4}
              value={draft.notes}
              onInput={(e) => {
                const notes = e.currentTarget.value;
                change((d) => ({ ...d, notes }));
              }}
            />
          </label>
          <fieldset>
            <legend>Custom fields</legend>
            {draft.fields.map((field, i) =>
              field.type === FieldType.Linked ? (
                <p class="muted small" key={String(i)}>
                  {field.name || 'Field'}: linked field, kept as is
                </p>
              ) : (
                <div class="custom-field" key={String(i)}>
                  <div class="row input-row">
                    <input
                      class="grow"
                      value={field.name}
                      aria-label={`Field ${String(i + 1)} name`}
                      placeholder="Name"
                      onInput={(e) => {
                        changeField(i, { name: e.currentTarget.value });
                      }}
                    />
                    <select
                      value={String(field.type)}
                      aria-label={`Field ${String(i + 1)} type`}
                      onChange={(e) => {
                        const picked = e.currentTarget.value;
                        const next =
                          FIELD_TYPES.find((t) => String(t.type) === picked)?.type ??
                          FieldType.Text;
                        changeField(i, {
                          type: next,
                          value:
                            next === FieldType.Boolean
                              ? field.value === 'true'
                                ? 'true'
                                : 'false'
                              : field.value,
                        });
                      }}
                    >
                      {FIELD_TYPES.map((t) => (
                        <option key={t.type} value={String(t.type)}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                    <IconButton
                      icon={X}
                      label={`Remove field ${String(i + 1)}`}
                      onClick={() => {
                        change((d) => ({ ...d, fields: d.fields.filter((_, j) => j !== i) }));
                      }}
                    />
                  </div>
                  {field.type === FieldType.Boolean ? (
                    <label class="check">
                      <input
                        type="checkbox"
                        checked={field.value === 'true'}
                        onChange={(e) => {
                          changeField(i, { value: e.currentTarget.checked ? 'true' : 'false' });
                        }}
                      />
                      {field.name || 'Value'}
                    </label>
                  ) : (
                    <SecretInput
                      class={field.type === FieldType.Hidden ? 'mono' : undefined}
                      shown={field.type !== FieldType.Hidden}
                      value={field.value}
                      label={`Field ${String(i + 1)} value`}
                      placeholder="Value"
                      autocomplete="off"
                      onValue={(value) => {
                        changeField(i, { value });
                      }}
                    />
                  )}
                </div>
              ),
            )}
            <button
              type="button"
              class="ghost add"
              onClick={() => {
                change((d) => ({
                  ...d,
                  fields: [
                    ...d.fields,
                    { name: '', value: '', type: FieldType.Text, linkedId: null },
                  ],
                }));
              }}
            >
              <Plus size={14} aria-hidden="true" /> Add field
            </button>
          </fieldset>
          {
            <label>
              Folder
              <select
                value={draft.folderId ?? ''}
                onChange={(e) => {
                  const folderId = e.currentTarget.value || null;
                  change((d) => ({ ...d, folderId }));
                }}
              >
                <option value="">No folder</option>
                {folders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </label>
          }
          <label class="check">
            <input
              type="checkbox"
              checked={draft.favorite}
              onChange={(e) => {
                const favorite = e.currentTarget.checked;
                change((d) => ({ ...d, favorite }));
              }}
            />
            Favorite
          </label>
          <label class="check">
            <input
              type="checkbox"
              checked={draft.reprompt}
              onChange={(e) => {
                const reprompt = e.currentTarget.checked;
                change((d) => ({ ...d, reprompt }));
              }}
            />
            Ask for my master password before showing or filling
          </label>
          {/* Enter in a field submits; the visible Save button lives in the header. */}
          <button type="submit" hidden tabIndex={-1} />
        </form>
      )}
    </main>
  );
}

/** A text input that can hide its value. Same element either way, so focus stays put. */
function SecretInput(props: {
  shown: boolean;
  value: string;
  onValue: (value: string) => void;
  id?: string;
  class?: string | undefined;
  label?: string;
  placeholder?: string;
  autocomplete: string;
}) {
  const common = {
    id: props.id,
    class: props.class,
    value: props.value,
    'aria-label': props.label,
    placeholder: props.placeholder,
    autocomplete: props.autocomplete,
    spellcheck: false,
    onInput: (e: Event) => {
      props.onValue((e.currentTarget as HTMLInputElement).value);
    },
  };
  return props.shown ? <input type="text" {...common} /> : <input type="password" {...common} />;
}
