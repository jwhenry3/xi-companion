// Shared panel chrome — the spellbook/journal layout language:
// bordered shell, dark sidebar (sections + footer), content column with
// a slim header, optional right detail pane. All side panels (sets,
// macros, chat, map) render through these so the theme treatment stays
// in one place.
import type { ComponentChildren } from 'preact';
import { cn } from '@/lib/utils';

type El = { class?: string; children?: ComponentChildren };

export function PanelShell({ class: c, children }: El) {
  return (
    <div
      class={cn(
        'flex h-full min-h-0 overflow-hidden rounded border border-slate-800',
        c,
      )}
    >
      {children}
    </div>
  );
}

export function PanelSidebar({ class: c, children }: El) {
  return (
    <aside
      class={cn(
        'flex w-56 shrink-0 flex-col border-r border-slate-800 bg-black/40',
        c,
      )}
    >
      {children}
    </aside>
  );
}

/** the scrollable middle of a sidebar — rows and section labels */
export function SidebarBody({ class: c, children }: El) {
  return <div class={cn('flex-1 overflow-y-auto p-2', c)}>{children}</div>;
}

export function SidebarLabel({ class: c, children }: El) {
  return (
    <p
      class={cn(
        'px-2 pb-1 pt-3 text-[10px] font-semibold tracking-wider text-slate-500 first:pt-1',
        c,
      )}
    >
      {children}
    </p>
  );
}

export function SidebarFoot({ class: c, children }: El) {
  return (
    <div class={cn('border-t border-slate-800 p-2 text-[10px] text-slate-500', c)}>
      {children}
    </div>
  );
}

export function PanelMain({ class: c, children }: El) {
  return <section class={cn('flex min-w-0 flex-1 flex-col', c)}>{children}</section>;
}

export function PanelHeader({ class: c, children }: El) {
  return (
    <header
      class={cn(
        'flex h-10 shrink-0 items-center gap-3 border-b border-slate-800 px-4',
        c,
      )}
    >
      {children}
    </header>
  );
}

/** right-side detail pane — w-72 default; pass class to widen (journal
 *  uses w-96) */
export function DetailPane({ class: c, children }: El) {
  return (
    <div
      class={cn(
        'w-72 shrink-0 overflow-y-auto border-l border-slate-800 bg-black/40 p-4',
        c,
      )}
    >
      {children}
    </div>
  );
}
