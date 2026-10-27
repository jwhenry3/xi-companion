import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { CheckIcon, ChevronDownIcon, ChevronRightIcon } from 'lucide-preact';
import { cn } from '@/lib/utils';

export interface NestedDropdownOption {
  value: string;
  label?: string;
}

export interface NestedDropdownSection {
  label: string;
  options: NestedDropdownOption[];
}

interface NestedDropdownProps {
  value: string;
  sections: NestedDropdownSection[];
  placeholder?: string;
  /** If set, renders a leading row that selects '' (e.g. "top level"). */
  emptyLabel?: string;
  /** Typed text that matches nothing becomes a "use" row. */
  allowCustom?: boolean;
  className?: string;
  onChange: (value: string) => void;
}

const itemCls =
  'relative flex w-full cursor-default items-center gap-1.5 rounded-md py-1 pl-1.5 pr-2 text-sm select-none outline-none';
const activeCls = 'bg-accent text-accent-foreground';

/**
 * Cascading dropdown: root sections expand into a submenu on hover or with
 * ->/Enter. Typing in the filter flattens the tree for search and offers a
 * custom-value row. Esc/Tab/click-outside closes.
 */
export function NestedDropdown({
  value,
  sections,
  placeholder = 'select…',
  emptyLabel,
  allowCustom = true,
  className,
  onChange,
}: NestedDropdownProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [rootHl, setRootHl] = useState(0); // highlighted root row (incl. empty row)
  const [leafHl, setLeafHl] = useState(0); // highlighted row in open submenu
  const [flatHl, setFlatHl] = useState(0); // highlighted row in filtered mode
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filtering = query.trim() !== '';

  // Root rows: optional '' row followed by one row per section.
  const rootRowCount = (emptyLabel ? 1 : 0) + sections.length;
  const openSection = !filtering && rootHl >= (emptyLabel ? 1 : 0)
    ? sections[rootHl - (emptyLabel ? 1 : 0)]
    : null;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = sections.flatMap((s) =>
      s.options.map((o) => ({ ...o, section: s.label })),
    );
    return q
      ? all.filter(
          (o) =>
            (o.label ?? o.value).toLowerCase().includes(q) ||
            o.value.toLowerCase().includes(q) ||
            o.section.toLowerCase().includes(q),
        )
      : [];
  }, [sections, query]);

  const customValue = query.trim();
  const showCustom =
    filtering &&
    allowCustom &&
    !sections.some((s) =>
      s.options.some((o) => o.value.toLowerCase() === customValue.toLowerCase()),
    );
  const flatCount = filtered.length + (showCustom ? 1 : 0);

  const close = () => {
    setOpen(false);
    setQuery('');
    setRootHl(0);
    setLeafHl(0);
    setFlatHl(0);
  };

  const choose = (v: string) => {
    onChange(v);
    close();
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-row="${filtering ? flatHl : leafHl}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [flatHl, leafHl, filtering]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (filtering) setFlatHl((h) => Math.min(h + 1, flatCount - 1));
        else if (openSection) setLeafHl((h) => Math.min(h + 1, openSection.options.length - 1));
        else setRootHl((h) => Math.min(h + 1, rootRowCount - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (filtering) setFlatHl((h) => Math.max(h - 1, 0));
        else if (openSection) setLeafHl((h) => Math.max(h - 1, 0));
        else setRootHl((h) => Math.max(h - 1, 0));
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (!filtering && !openSection && rootHl >= (emptyLabel ? 1 : 0)) setLeafHl(0);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (!filtering && openSection) setLeafHl(-1); // leafHl<0 → focus back on root row
        break;
      case 'Enter': {
        e.preventDefault();
        if (filtering) {
          if (showCustom && flatHl === filtered.length) choose(customValue);
          else if (filtered[flatHl]) choose(filtered[flatHl].value);
        } else if (openSection && leafHl >= 0) {
          choose(openSection.options[leafHl].value);
        } else if (emptyLabel && rootHl === 0) {
          choose('');
        } else if (openSection == null && rootHl >= (emptyLabel ? 1 : 0)) {
          setLeafHl(0); // enter opens submenu
        }
        break;
      }
      case 'Escape':
        e.preventDefault();
        close();
        break;
      case 'Tab':
        close();
        break;
    }
  };

  return (
    <div ref={rootRef} className={cn('relative', className)} onKeyDown={onKeyDown}>
      <button
        type="button"
        data-slot="nested-dropdown-trigger"
        aria-expanded={open}
        className={cn(
          'flex h-8 w-full items-center justify-between gap-1.5 whitespace-nowrap rounded-lg border border-input bg-card py-2 pl-2.5 pr-2 text-sm outline-none transition-colors select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
          !value && 'text-muted-foreground',
        )}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="line-clamp-1 flex-1 text-left">{value || placeholder}</span>
        <ChevronDownIcon className="size-4 text-muted-foreground" />
      </button>

      {open && (
        <div
          data-slot="nested-dropdown-content"
          className="absolute isolate z-50 mt-1 overflow-visible rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10"
          style={{ minWidth: '11rem' }}
        >
          <input
            ref={inputRef}
            className="h-8 w-full border-b border-border bg-transparent px-2.5 text-sm outline-none placeholder:text-muted-foreground"
            placeholder="filter or type a group…"
            value={query}
            onInput={(e) => {
              setQuery((e.target as HTMLInputElement).value);
              setFlatHl(0);
            }}
          />

          {filtering ? (
            <div ref={listRef} className="max-h-60 min-w-44 overflow-y-auto p-1" role="listbox">
              {filtered.length === 0 && !showCustom && (
                <p className="px-1.5 py-2 text-xs text-muted-foreground">no matches</p>
              )}
              {filtered.map((o, i) => (
                <div
                  key={o.value}
                  role="option"
                  aria-selected={o.value === value}
                  data-row={i}
                  className={cn(itemCls, 'pr-8', i === flatHl && activeCls)}
                  onMouseEnter={() => setFlatHl(i)}
                  onClick={() => choose(o.value)}
                >
                  <span className="flex-1 truncate">
                    {o.label ?? o.value}
                    <span className="ml-1 text-[10px] text-muted-foreground">{o.section}</span>
                  </span>
                  {o.value === value && (
                    <CheckIcon className="pointer-events-none absolute right-2 size-4" />
                  )}
                </div>
              ))}
              {showCustom && (
                <div
                  role="option"
                  aria-selected={false}
                  data-row={filtered.length}
                  className={cn(itemCls, flatHl === filtered.length && activeCls)}
                  onMouseEnter={() => setFlatHl(filtered.length)}
                  onClick={() => choose(customValue)}
                >
                  <span className="truncate">
                    use <span className="font-medium">{customValue}</span>
                  </span>
                </div>
              )}
            </div>
          ) : (
            <div className="p-1" onMouseLeave={() => setLeafHl(-1)}>
              {emptyLabel != null && (
                <div
                  role="option"
                  aria-selected={value === ''}
                  className={cn(itemCls, 'text-muted-foreground', rootHl === 0 && activeCls)}
                  onMouseEnter={() => {
                    setRootHl(0);
                    setLeafHl(-1);
                  }}
                  onClick={() => choose('')}
                >
                  <span className="flex-1 truncate italic">{emptyLabel}</span>
                  {value === '' && <CheckIcon className="size-4" />}
                </div>
              )}
              {sections.map((sec, i) => {
                const rowIdx = i + (emptyLabel ? 1 : 0);
                const isOpen = openSection === sec;
                return (
                  <div key={sec.label} className="relative">
                    <div
                      role="menuitem"
                      className={cn(itemCls, rootHl === rowIdx && activeCls)}
                      onMouseEnter={() => {
                        setRootHl(rowIdx);
                        setLeafHl(-1);
                      }}
                      onClick={() => {
                        setRootHl(rowIdx);
                        setLeafHl(leafHl >= 0 && isOpen ? -1 : 0);
                      }}
                    >
                      <span className="flex-1 truncate">{sec.label}</span>
                      {sec.options.some((o) => o.value === value) && (
                        <CheckIcon className="size-3.5 text-primary" />
                      )}
                      <ChevronRightIcon className="size-4 text-muted-foreground" />
                    </div>

                    {isOpen && (
                      <div
                        ref={listRef}
                        role="listbox"
                        className="absolute left-full top-0 z-50 ml-1 max-h-60 min-w-44 overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10"
                      >
                        {sec.options.map((o, li) => (
                          <div
                            key={o.value}
                            role="option"
                            aria-selected={o.value === value}
                            data-row={li}
                            className={cn(itemCls, 'pr-8', li === leafHl && activeCls)}
                            onMouseEnter={() => setLeafHl(li)}
                            onClick={() => choose(o.value)}
                          >
                            <span className="flex-1 truncate">{o.label ?? o.value}</span>
                            {o.value === value && (
                              <CheckIcon className="pointer-events-none absolute right-2 size-4" />
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
