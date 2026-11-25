import type { LucideIcon } from 'lucide-preact';
import type { ComponentProps } from 'preact';

interface Props extends Omit<
  ComponentProps<'button'>,
  'children' | 'aria-label' | 'class' | 'className' | 'type'
> {
  icon: LucideIcon;
  label: string;
}

/** A compact action with a visible tooltip and an accessible name. */
export function IconButton({ icon: Icon, label, title, ...props }: Props) {
  return (
    <button
      {...props}
      type="button"
      class="icon-button ghost"
      aria-label={label}
      title={title ?? label}
    >
      <Icon size={14} aria-hidden="true" />
    </button>
  );
}
