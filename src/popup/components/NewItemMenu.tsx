import { CreditCard, KeyRound, Plus, StickyNote, UserRound } from 'lucide-preact';
import type { LucideIcon } from 'lucide-preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { NewItemType } from '../../vault/draft';
import { CipherType } from '../../vault/types';
import { IconButton } from './IconButton';

const CHOICES: { type: NewItemType; label: string; icon: LucideIcon }[] = [
  { type: CipherType.Login, label: 'Login', icon: KeyRound },
  { type: CipherType.SecureNote, label: 'Secure note', icon: StickyNote },
  { type: CipherType.Card, label: 'Card', icon: CreditCard },
  { type: CipherType.Identity, label: 'Identity', icon: UserRound },
];

/**
 * The "New item" button and its menu. Keyboard: Enter or Space opens it on the first choice,
 * Up and Down move, Enter picks, Escape or Tab closes it.
 */
export function NewItemMenu({ onNew }: { onNew: (type: NewItemType) => void }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const onPointer = (e: PointerEvent) => {
      if (!anchorRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  function close() {
    setOpen(false);
    anchorRef.current?.querySelector<HTMLButtonElement>('.icon-button')?.focus();
  }

  function onKeyDown(e: KeyboardEvent) {
    const items = Array.from(menuRef.current?.querySelectorAll('button') ?? []);
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      items[(index + step + items.length) % items.length]?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  }

  return (
    <div class="menu-anchor" ref={anchorRef}>
      <IconButton
        icon={Plus}
        label="New item"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setOpen((o) => !o);
        }}
      />
      {open && (
        <div class="menu" role="menu" aria-label="New item" ref={menuRef} onKeyDown={onKeyDown}>
          {CHOICES.map(({ type, label, icon: Icon }) => (
            <button
              key={type}
              type="button"
              role="menuitem"
              class="ghost"
              onClick={() => {
                setOpen(false);
                onNew(type);
              }}
            >
              <Icon size={14} aria-hidden="true" />
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
