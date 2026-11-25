import { ArrowLeft, RotateCcw, Trash2 } from 'lucide-preact';
import { useEffect, useState } from 'preact/hooks';
import { sendMessage } from '../../shared/messaging';
import type { TrashItem } from '../../vault/types';
import { usePopup } from '../context';
import { errorMessage } from '../lib';
import { IconButton } from './IconButton';

/** Items in the server's trash: restore them, or delete them for good. */
export function TrashView({
  onBack,
  onOpen,
}: {
  onBack: () => void;
  onOpen: (id: string) => void;
}) {
  const ctx = usePopup();
  const [items, setItems] = useState<TrashItem[] | null>(null);

  useEffect(() => {
    sendMessage('vault:trash').then(setItems, (e: unknown) => {
      ctx.toast(errorMessage(e, 'Could not load the trash'));
    });
    // Reload when the vault changes; ctx itself changes with every status.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.status.version]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('.dialog')) {
        e.preventDefault();
        onBack();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [onBack]);

  async function act(id: string, action: 'restore' | 'delete') {
    try {
      if (action === 'restore') {
        await sendMessage('vault:restore', { id });
        ctx.toast('Item restored');
      } else {
        await sendMessage('vault:delete-forever', { id });
        ctx.toast('Item deleted for good');
      }
      setItems((list) => list?.filter((i) => i.id !== id) ?? null);
    } catch (e) {
      ctx.toast(errorMessage(e, 'Something went wrong'));
    }
  }

  return (
    <main class="screen trash">
      <header class="row item-header">
        <IconButton icon={ArrowLeft} label="Back" onClick={onBack} autoFocus />
        <h1 class="grow title">Trash</h1>
      </header>
      {items?.length === 0 && <p class="empty muted">The trash is empty</p>}
      {items && items.length > 0 && (
        <section class="fields">
          {items.map((item) => (
            <div class="field" key={item.id}>
              <button
                type="button"
                class="ghost copy-value"
                onClick={() => {
                  onOpen(item.id);
                }}
              >
                <span class="name">{item.name}</span>
                {item.subtitle && <span class="muted"> · {item.subtitle}</span>}
              </button>
              <span class="actions">
                <IconButton
                  icon={RotateCcw}
                  label={`Restore ${item.name}`}
                  onClick={() => void act(item.id, 'restore')}
                />
                <IconButton
                  icon={Trash2}
                  label={`Delete ${item.name} for good`}
                  onClick={() => {
                    void ctx
                      .confirm(
                        `Delete “${item.name}” for good? This can’t be undone.`,
                        'Delete for good',
                      )
                      .then((ok) => {
                        if (ok) void act(item.id, 'delete');
                      });
                  }}
                />
              </span>
              <span class="label">Deleted {new Date(item.deletedDate).toLocaleString()}</span>
            </div>
          ))}
        </section>
      )}
    </main>
  );
}
