import { useEffect, useRef, useState } from 'preact/hooks';
import { CheckIcon, ChevronRightIcon, ListFilterIcon } from 'lucide-preact';
import { cn } from '@/lib/utils';

export interface FilterOption {
 value: string;
 label?: string;
 disabled?: boolean;
}

/** Pick-one group, rendered as a cascading submenu. */
export interface FilterSection {
 label: string;
 value: string;
 options: FilterOption[];
 /** Value that counts as "no filter" — anything else bumps the badge. */
 defaultValue: string;
 onChange: (value: string) => void;
}

/** Independent on/off row — toggles without closing the menu. */
export interface FilterToggle {
 label: string;
 checked: boolean;
 onChange: (checked: boolean) => void;
}

interface FilterDropdownProps {
 sections: FilterSection[];
 toggles?: FilterToggle[];
 className?: string;
}

const itemCls =
 'relative flex w-full items-center gap-1.5 rounded-md py-1 pl-1.5 pr-2 text-sm select-none outline-none';
const activeCls = 'bg-accent text-accent-foreground';

/**
 * Multi-facet filter menu: sections expand into pick-one submenus on hover,
 * toggles flip in place. Pure DOM — no native popup — so it survives the
 * frameless overlay window.
 */
export function FilterDropdown({ sections, toggles = [], className }: FilterDropdownProps) {
 const [open, setOpen] = useState(false);
 const [sec, setSec] = useState(-1); // expanded section index
 const rootRef = useRef<HTMLDivElement>(null);

 const close = () => {
 setOpen(false);
 setSec(-1);
 };

 useEffect(() => {
 if (!open) return;
 const onDown = (e: MouseEvent) => {
 if (rootRef.current && !rootRef.current.contains(e.target as Node)) close();
 };
 const onKey = (e: KeyboardEvent) => {
 if (e.key === 'Escape') close();
 };
 document.addEventListener('mousedown', onDown);
 document.addEventListener('keydown', onKey);
 return () => {
 document.removeEventListener('mousedown', onDown);
 document.removeEventListener('keydown', onKey);
 };
 }, [open]);

 const activeCount =
 sections.filter((s) => s.value !== s.defaultValue).length +
 toggles.filter((t) => t.checked).length;

 return (
 <div ref={rootRef} className={cn('relative', className)}>
 <button
 type="button"
 data-slot="filter-dropdown-trigger"
 aria-expanded={open}
 className={cn(
 'flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg border border-input bg-card py-2 pl-2.5 pr-2 text-sm outline-none transition-colors select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
 activeCount > 0 ? 'text-sky-300' : 'text-muted-foreground',
 )}
 onClick={() => setOpen((o) => !o)}
 >
 <ListFilterIcon className="size-4" />
 Filters
 {activeCount > 0 && (
 <span className="rounded-full bg-sky-900 px-1.5 text-[10px] font-semibold text-sky-200">
 {activeCount}
 </span>
 )}
 </button>

 {open && (
 <div
 data-slot="filter-dropdown-content"
 className="absolute isolate z-50 mt-1 min-w-44 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10"
 >
 {sections.map((s, i) => {
 const cur = s.options.find((o) => o.value === s.value);
 const isOpen = sec === i;
 return (
 <div key={s.label} className="relative">
 <div
 role="menuitem"
 className={cn(itemCls, isOpen && activeCls)}
 onMouseEnter={() => setSec(i)}
 >
 <span className="flex-1 truncate">{s.label}</span>
 <span className="max-w-24 truncate text-[10px] text-muted-foreground">
 {cur?.label ?? cur?.value ?? s.value}
 </span>
 <ChevronRightIcon className="size-4 text-muted-foreground" />
 </div>

 {isOpen && (
 <div
 role="listbox"
 className="absolute right-full top-0 z-50 mr-1 max-h-60 min-w-44 overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10"
 >
 {s.options.map((o) => (
 <div
 key={o.value}
 role="option"
 aria-selected={o.value === s.value}
 aria-disabled={o.disabled || undefined}
 className={cn(
 itemCls,
 'pr-8',
 o.disabled
 ? ' text-muted-foreground opacity-50'
 : 'hover:bg-accent hover:text-accent-foreground',
 )}
 onClick={() => {
 if (o.disabled) return;
 s.onChange(o.value);
 }}
 >
 <span className="flex-1 truncate">{o.label ?? o.value}</span>
 {o.value === s.value && (
 <CheckIcon className="pointer-events-none absolute right-2 size-4" />
 )}
 </div>
 ))}
 </div>
 )}
 </div>
 );
 })}

 {toggles.length > 0 && sections.length > 0 && (
 <div className="my-1 border-t border-border" />
 )}
 {toggles.map((t) => (
 <div
 key={t.label}
 role="menuitemcheckbox"
 aria-checked={t.checked}
 className={cn(itemCls, 'pr-8 hover:bg-accent hover:text-accent-foreground')}
 onMouseEnter={() => setSec(-1)}
 onClick={() => t.onChange(!t.checked)}
 >
 <span className="flex-1 truncate">{t.label}</span>
 {t.checked && (
 <CheckIcon className="pointer-events-none absolute right-2 size-4" />
 )}
 </div>
 ))}
 </div>
 )}
 </div>
 );
}
