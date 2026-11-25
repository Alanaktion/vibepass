import { ArrowLeft, Check, Pencil, Trash2, X } from 'lucide-preact';
import { useEffect, useState } from 'preact/hooks';
import { sendMessage } from '../../shared/messaging';
import type { FolderSummary } from '../../vault/types';
import { usePopup } from '../context';
import { errorMessage } from '../lib';
import { IconButton } from './IconButton';

/** Create, rename, and delete folders. Deleting a folder keeps its items. */
export function FoldersView({ onBack }: { onBack: () => void }) {
  const ctx = usePopup();
  const [folders, setFolders] = useState<FolderSummary[] | null>(null);
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);

  const load = () => {
    sendMessage('vault:folders').then(setFolders, (e: unknown) => {
      ctx.toast(errorMessage(e, 'Could not load folders'));
    });
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [ctx.status.version]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('.dialog')) {
        e.preventDefault();
        if (editing) setEditing(null);
        else onBack();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [onBack, editing]);

  async function run(action: () => Promise<unknown>, done: string) {
    try {
      await action();
      ctx.toast(done);
      load();
    } catch (e) {
      ctx.toast(errorMessage(e, 'Something went wrong'));
    }
  }

  return (
    <main class="screen folders">
      <header class="row item-header">
        <IconButton icon={ArrowLeft} label="Back" onClick={onBack} />
        <h1 class="grow title">Folders</h1>
      </header>
      <form
        class="row stack-tight"
        onSubmit={(e) => {
          e.preventDefault();
          const value = name;
          void run(() => sendMessage('folder:create', { name: value }), 'Folder added').then(() => {
            setName('');
          });
        }}
      >
        <input
          class="grow"
          aria-label="New folder name"
          placeholder="New folder"
          value={name}
          autoFocus
          onInput={(e) => {
            setName(e.currentTarget.value);
          }}
        />
        <button type="submit" disabled={!name.trim()}>
          Add
        </button>
      </form>
      <section class="fields">
        {folders?.length === 0 && <p class="muted small field">No folders yet</p>}
        {folders?.map((folder) =>
          editing?.id === folder.id ? (
            <form
              class="field"
              key={folder.id}
              onSubmit={(e) => {
                e.preventDefault();
                const next = editing.name;
                void run(
                  () => sendMessage('folder:rename', { id: folder.id, name: next }),
                  'Folder renamed',
                ).then(() => {
                  setEditing(null);
                });
              }}
            >
              <input
                aria-label={`Rename ${folder.name}`}
                value={editing.name}
                autoFocus
                onInput={(e) => {
                  setEditing({ id: folder.id, name: e.currentTarget.value });
                }}
              />
              <span class="actions">
                <button type="submit" class="icon-button ghost" aria-label="Save name" title="Save">
                  <Check size={14} aria-hidden="true" />
                </button>
                <IconButton
                  icon={X}
                  label="Cancel renaming"
                  onClick={() => {
                    setEditing(null);
                  }}
                />
              </span>
            </form>
          ) : (
            <div class="field" key={folder.id}>
              <span>{folder.name}</span>
              <span class="actions">
                <IconButton
                  icon={Pencil}
                  label={`Rename ${folder.name}`}
                  onClick={() => {
                    setEditing({ id: folder.id, name: folder.name });
                  }}
                />
                <IconButton
                  icon={Trash2}
                  label={`Delete ${folder.name}`}
                  onClick={() => {
                    void ctx
                      .confirm(
                        `Delete the folder “${folder.name}”? Its items stay in your vault.`,
                        'Delete folder',
                      )
                      .then((ok) => {
                        if (ok) {
                          void run(
                            () => sendMessage('folder:delete', { id: folder.id }),
                            'Folder deleted',
                          );
                        }
                      });
                  }}
                />
              </span>
            </div>
          ),
        )}
      </section>
    </main>
  );
}
