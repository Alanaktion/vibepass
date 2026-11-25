import {
  ArrowLeft,
  Copy,
  Download,
  Eye,
  EyeOff,
  Pencil,
  RotateCcw,
  Star,
  Trash2,
} from 'lucide-preact';
import { useEffect, useState } from 'preact/hooks';
import { sendMessage } from '../../shared/messaging';
import { displayHost, toWebUrl } from '../../vault/uri';
import type { TotpCode } from '../../vault/totp';
import {
  CipherType,
  type CipherDetail,
  type DetailField,
  type FolderSummary,
} from '../../vault/types';
import { fillItem, pw } from '../actions';
import { usePopup, type PopupContext } from '../context';
import { copyText, downloadBase64, errorMessage, iconUrl, withReprompt } from '../lib';
import { ItemIcon } from './Dialogs';
import { IconButton } from './IconButton';

interface Props {
  id: string;
  onBack: () => void;
  /** Open the editor for this item (only offered when editing is turned on). */
  onEdit: (id: string) => void;
}

/** Item detail: large title, labeled fields with copy and reveal, websites, notes, files. */
export function ItemView({ id, onBack, onEdit }: Props) {
  const ctx = usePopup();
  const [item, setItem] = useState<CipherDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const writable = Boolean(ctx.settings?.allowEdits && item?.canEdit && !item.deletedDate);

  useEffect(() => {
    let cancelled = false;
    setItem(null);
    sendMessage('vault:item', { id }).then(
      (detail) => {
        if (!cancelled) setItem(detail);
      },
      (e: unknown) => {
        if (!cancelled) setError(errorMessage(e, 'Could not open this item'));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [id, ctx.status.version]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing =
        e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (document.querySelector('.dialog') || e.target instanceof HTMLSelectElement) return;
      if (e.key === 'Escape' || (!typing && (e.key === 'ArrowLeft' || e.key === 'Backspace'))) {
        e.preventDefault();
        onBack();
      } else if (!typing && e.key === 'e' && !e.metaKey && !e.ctrlKey && writable) {
        e.preventDefault();
        onEdit(id);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [onBack, onEdit, id, writable]);

  const host = item ? displayHost(item.uris) : null;
  const canFill = item?.type === CipherType.Login && Boolean(ctx.tab?.url);

  return (
    <main class="screen item">
      <header class="row item-header">
        <IconButton icon={ArrowLeft} label="Back" onClick={onBack} autoFocus />
        {item && (
          <ItemIcon
            name={item.name}
            src={ctx.settings?.showIcons ? iconUrl(ctx.status.serverUrl, host) : null}
          />
        )}
        <h1 class="grow title">{item?.name ?? ''}</h1>
        {item && writable && (
          <>
            <IconButton
              icon={Star}
              label={item.favorite ? 'Remove from favorites' : 'Add to favorites'}
              aria-pressed={item.favorite}
              onClick={() => {
                void organize(ctx, item.id, { favorite: !item.favorite });
              }}
            />
            <IconButton
              icon={Pencil}
              label="Edit"
              title="Edit (E)"
              onClick={() => {
                onEdit(item.id);
              }}
            />
          </>
        )}
        {item && canFill && !item.deletedDate && (
          <button
            type="button"
            class="fill"
            onClick={() => {
              void fillItem(ctx, item.id);
            }}
          >
            Fill
          </button>
        )}
      </header>
      {error && (
        <p role="alert" class="error">
          {error}
        </p>
      )}
      {!item && !error && <p class="muted" aria-busy="true" />}
      {item?.deletedDate && <TrashBanner item={item} ctx={ctx} onGone={onBack} />}
      {item && <Detail item={item} ctx={ctx} />}
      {item && writable && <Organize item={item} ctx={ctx} onTrashed={onBack} />}
    </main>
  );
}

async function organize(
  ctx: PopupContext,
  id: string,
  patch: { favorite?: boolean; folderId?: string | null },
): Promise<boolean> {
  try {
    await sendMessage('vault:organize', { id, ...patch });
    return true;
  } catch (error) {
    ctx.toast(errorMessage(error, 'Could not save'));
    return false;
  }
}

/** Folder and trash, under the item's fields. */
function Organize({
  item,
  ctx,
  onTrashed,
}: {
  item: CipherDetail;
  ctx: PopupContext;
  onTrashed: () => void;
}) {
  const [folders, setFolders] = useState<FolderSummary[]>([]);
  useEffect(() => {
    sendMessage('vault:folders').then(setFolders, () => undefined);
  }, [ctx.status.version]);

  return (
    <div class="row organize">
      <label class="grow inline">
        <span class="muted small">Folder</span>
        <select
          value={item.folderId ?? ''}
          onChange={(e) => {
            const folderId = e.currentTarget.value || null;
            void organize(ctx, item.id, { folderId }).then((ok) => {
              if (ok) ctx.toast(folderId ? 'Moved' : 'Removed from folder');
            });
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
      <button
        type="button"
        class="ghost danger"
        onClick={() => {
          void ctx
            .confirm(
              `Move “${item.name}” to the trash? You can restore it from there.`,
              'Move to trash',
            )
            .then(async (ok) => {
              if (!ok) return;
              try {
                await sendMessage('vault:trash-item', { id: item.id });
                ctx.toast('Moved to trash');
                onTrashed();
              } catch (error) {
                ctx.toast(errorMessage(error, 'Could not delete'));
              }
            });
        }}
      >
        <Trash2 size={14} aria-hidden="true" /> Move to trash
      </button>
    </div>
  );
}

function TrashBanner({
  item,
  ctx,
  onGone,
}: {
  item: CipherDetail;
  ctx: PopupContext;
  onGone: () => void;
}) {
  const writable = Boolean(ctx.settings?.allowEdits && item.canEdit);
  return (
    <div class="banner info row">
      <span class="grow">
        In the trash since {new Date(item.deletedDate ?? '').toLocaleDateString()}
      </span>
      {writable && (
        <>
          <IconButton
            icon={RotateCcw}
            label="Restore"
            onClick={() => {
              sendMessage('vault:restore', { id: item.id }).then(
                () => {
                  ctx.toast('Item restored');
                },
                (error: unknown) => {
                  ctx.toast(errorMessage(error, 'Could not restore'));
                },
              );
            }}
          />
          <IconButton
            icon={Trash2}
            label="Delete for good"
            onClick={() => {
              void ctx
                .confirm(`Delete “${item.name}” for good? This can’t be undone.`, 'Delete for good')
                .then(async (ok) => {
                  if (!ok) return;
                  try {
                    await sendMessage('vault:delete-forever', { id: item.id });
                    ctx.toast('Item deleted for good');
                    onGone();
                  } catch (error) {
                    ctx.toast(errorMessage(error, 'Could not delete'));
                  }
                });
            }}
          />
        </>
      )}
    </div>
  );
}

function Detail({ item, ctx }: { item: CipherDetail; ctx: PopupContext }) {
  const location = [item.organization, ...item.collections, item.folder].filter(Boolean);
  return (
    <div class="detail">
      {location.length > 0 && <p class="muted location">{location.join(' · ')}</p>}
      {item.organization && <p class="muted badge">Shared, read-only</p>}
      {item.sections.map((section, i) => (
        <section class="fields" key={section.title ?? String(i)}>
          {section.title && <h2>{section.title}</h2>}
          {section.fields.map((field) =>
            field.kind === 'totp' ? (
              <TotpRow key={field.id} itemId={item.id} label={field.label} ctx={ctx} />
            ) : (
              <FieldRow key={field.id} itemId={item.id} field={field} ctx={ctx} />
            ),
          )}
        </section>
      ))}
      {item.uris.length > 0 && (
        <section class="fields">
          <h2>{item.uris.length === 1 ? 'Website' : 'Websites'}</h2>
          {item.uris.map((uri, i) => {
            const parsed = toWebUrl(uri.uri);
            return (
              <div class="field" key={`${uri.uri}-${String(i)}`}>
                {parsed ? (
                  <a href={parsed.href} target="_blank" rel="noopener noreferrer">
                    {uri.uri}
                  </a>
                ) : (
                  <span>{uri.uri}</span>
                )}
                <IconButton
                  icon={Copy}
                  label={`Copy website ${uri.uri}`}
                  onClick={() => {
                    void copyText(uri.uri).then(() => {
                      ctx.toast('Website copied');
                    });
                  }}
                />
              </div>
            );
          })}
        </section>
      )}
      {item.notes && (
        <section class="fields">
          <h2>Notes</h2>
          <p class="notes">{item.notes}</p>
        </section>
      )}
      {item.attachments.length > 0 && (
        <section class="fields">
          <h2>Attachments</h2>
          {item.attachments.map((file) => (
            <div class="field" key={file.id}>
              <span class="grow">
                {file.fileName}
                {file.sizeName && <span class="muted"> · {file.sizeName}</span>}
              </span>
              <IconButton
                icon={Download}
                label={`Download ${file.fileName}`}
                onClick={() => {
                  void download(ctx, item.id, file.id);
                }}
              />
            </div>
          ))}
        </section>
      )}
      <p class="muted updated">Updated {new Date(item.revisionDate).toLocaleString()}</p>
    </div>
  );
}

async function download(ctx: PopupContext, id: string, attachmentId: string) {
  try {
    ctx.toast('Downloading…');
    const file = await withReprompt(ctx.askPassword, (masterPassword) =>
      sendMessage('vault:attachment', { id, attachmentId, ...pw(masterPassword) }),
    );
    if (file) downloadBase64(file.fileName, file.base64);
  } catch (error) {
    ctx.toast(errorMessage(error, 'Download failed'));
  }
}

function FieldRow({
  itemId,
  field,
  ctx,
}: {
  itemId: string;
  field: DetailField;
  ctx: PopupContext;
}) {
  const [revealed, setRevealed] = useState<string | null>(null);
  const concealed = field.kind === 'concealed';
  const shown = concealed ? revealed : field.value;
  const masked = concealed && shown === null;
  const copyLabel = `Copy ${field.label}`;
  const valueClass = `value ${field.kind}${masked ? ' masked' : ''}`;

  async function secret(): Promise<string | null> {
    if (!concealed) return field.value;
    if (revealed !== null) return revealed;
    return withReprompt(ctx.askPassword, (masterPassword) =>
      sendMessage('vault:reveal', { id: itemId, fieldId: field.id, ...pw(masterPassword) }),
    );
  }

  async function copy() {
    try {
      const value = await secret();
      if (value === null) return;
      await copyText(value);
      const seconds = ctx.settings?.clipboardClearSeconds ?? 0;
      ctx.toast(
        `${field.label} copied${concealed && seconds > 0 ? ` · clears in ${String(seconds)}s` : ''}`,
      );
    } catch (error) {
      ctx.toast(errorMessage(error, 'Could not copy'));
    }
  }

  async function toggle() {
    if (revealed !== null) {
      setRevealed(null);
      return;
    }
    try {
      setRevealed(await secret());
    } catch (error) {
      ctx.toast(errorMessage(error, 'Could not reveal'));
    }
  }

  return (
    <div class="field">
      <span class="label">{field.label}</span>
      {masked && field.canReveal ? (
        <button
          type="button"
          class={`ghost copy-value ${valueClass}`}
          aria-label={`${copyLabel} (masked)`}
          title={copyLabel}
          onClick={() => void copy()}
        >
          <span aria-hidden="true">••••••••••</span>
        </button>
      ) : (
        <span class={valueClass}>{shown ?? '••••••••••'}</span>
      )}
      <span class="actions">
        {concealed && field.canReveal && (
          <IconButton
            icon={revealed === null ? Eye : EyeOff}
            label={`${revealed === null ? 'Reveal' : 'Hide'} ${field.label}`}
            onClick={() => void toggle()}
          />
        )}
        {(field.canReveal || !concealed) && field.kind !== 'boolean' && (
          <IconButton icon={Copy} label={copyLabel} onClick={() => void copy()} />
        )}
        {!field.canReveal && <span class="muted small">Hidden by your organization</span>}
      </span>
    </div>
  );
}

/** Current code with a countdown; fetches the next code when this one expires. */
function TotpRow({ itemId, label, ctx }: { itemId: string; label: string; ctx: PopupContext }) {
  const [code, setCode] = useState<TotpCode | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [needsPassword, setNeedsPassword] = useState(false);
  const [password, setPassword] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      sendMessage('vault:totp', { id: itemId, ...pw(password) }).then(
        (next) => {
          if (cancelled) return;
          setCode(next);
          setRemaining(next.remaining);
          setNeedsPassword(false);
          timer = setTimeout(load, next.remaining * 1000 + 50);
        },
        (e: unknown) => {
          if (cancelled) return;
          if (e instanceof Error && 'code' in e && e.code === 'reprompt-required') {
            setNeedsPassword(true);
          } else setError(errorMessage(e, 'Could not get the code'));
        },
      );
    };
    load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [itemId, password]);

  useEffect(() => {
    const tick = setInterval(() => {
      setRemaining((r) => Math.max(0, r - 1));
    }, 1000);
    return () => {
      clearInterval(tick);
    };
  }, [code]);

  async function unlockCode() {
    const value = await ctx.askPassword();
    if (value !== null) setPassword(value);
  }

  const formatted = code ? formatCode(code.code) : null;
  return (
    <div class="field totp">
      <span class="label">{label}</span>
      {needsPassword ? (
        <IconButton icon={Eye} label={`Show ${label}`} onClick={() => void unlockCode()} />
      ) : (
        <span class="value code" aria-live="off">
          {error ?? formatted ?? '••• •••'}
        </span>
      )}
      <span class="actions">
        {code && (
          <span
            class="countdown"
            aria-label={`${String(remaining)} seconds left`}
            style={{ '--progress': String(remaining / code.period) }}
          >
            {remaining}
          </span>
        )}
        {code && (
          <IconButton
            icon={Copy}
            label={`Copy ${label}`}
            onClick={() => {
              void copyText(code.code).then(() => {
                ctx.toast('One-time password copied');
              });
            }}
          />
        )}
      </span>
    </div>
  );
}

function formatCode(code: string): string {
  if (code.length === 6) return `${code.slice(0, 3)} ${code.slice(3)}`;
  if (code.length === 8) return `${code.slice(0, 4)} ${code.slice(4)}`;
  return code;
}
