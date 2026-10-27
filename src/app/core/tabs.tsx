// Physical tab strip — rounded tops, square bottoms, a divider under
// the strip, and the active tab raised on three borders overlapping the
// divider so it reads connected to the pane. divs, not nav: the flat
// themes zero nav borders. Borders use --border so they stay visible
// through theme remaps.
import type { ComponentChildren } from 'preact';
import { Link } from '@preact-mvc/core';
import { cn } from '@/lib/utils';

export function TabBar({
  class: c,
  children,
}: {
  class?: string;
  children?: ComponentChildren;
}) {
  return (
    <div
      class={cn(
        'flex items-end gap-0.5 border-b border-border px-2 pt-1.5',
        c,
      )}
    >
      {children}
    </div>
  );
}

export function Tab({
  to,
  onClick,
  active,
  class: c,
  children,
}: {
  /** router link target — omit for an in-page tab (renders a button) */
  to?: string;
  onClick?: () => void;
  active: boolean;
  class?: string;
  children?: ComponentChildren;
}) {
  const cls = cn(
    '-mb-px rounded-t-md border-x border-t border-border px-4 py-1.5 text-xs font-medium transition-colors',
    active
      ? 'bg-slate-900 text-sky-300'
      : 'cursor-pointer border-transparent text-slate-500 hover:bg-slate-800/60 hover:text-slate-300',
    c,
  );
  return to != null ? (
    <Link to={to} class={cls}>
      {children}
    </Link>
  ) : (
    <button class={cls} onClick={onClick}>
      {children}
    </button>
  );
}
