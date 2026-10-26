// Custom dropdown for NOACTIVATE overlay windows — a native <select>'s
// popup needs window activation to stay open, so it dismisses instantly
// on the fab-layer panels. This in-page menu has no such requirement.
// It closes on click-outside or Escape (never on mouseleave — a menu
// clipped to the window edge would self-close the moment the cursor
// left the panel), flips upward when there's no room below, and caps
// its height to the window so it still works in a 64px HUD strip.
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { cn } from '@/lib/utils';

export interface DropdownOption {
  value: string;
  label?: string;
}

export function Dropdown(props: {
  value: string;
  options: readonly (string | DropdownOption)[];
  onChange: (value: string) => void;
  /** button element classes */
  class?: string;
  /** title/tooltip for the button */
  title?: string;
  /** which side of the button the menu hugs */
  align?: 'left' | 'right';
  /** render the current value — defaults to the option's label/value */
  formatValue?: (v: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const [maxH, setMaxH] = useState(240);
  const root = useRef<HTMLSpanElement>(null);

  // click-outside + Escape while open; the opening click is
  // stopPropagation'd so it can't immediately close again
  useLayoutEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const toggle = (e: MouseEvent) => {
    e.stopPropagation();
    if (!open && root.current) {
      const r = root.current.getBoundingClientRect();
      const below = window.innerHeight - r.bottom - 4;
      const above = r.top - 4;
      const goUp = below < 96 && above > below;
      setUp(goUp);
      // cap to whatever space the window actually has — scroll picks
      // up the rest instead of clipping past the panel edge
      setMaxH(Math.max(40, goUp ? above : below));
    }
    setOpen(!open);
  };

  const labelOf = (o: string | DropdownOption) =>
    typeof o === 'string' ? o : (o.label ?? o.value);
  const valueOf = (o: string | DropdownOption) =>
    typeof o === 'string' ? o : o.value;

  return (
    <span ref={root} class="relative inline-flex">
      <button
        class={props.class}
        title={props.title}
        onClick={toggle}
      >
        {props.formatValue ? props.formatValue(props.value) : props.value}
      </button>
      {open && (
        <span
          class={cn(
            'absolute z-50 flex flex-col overflow-y-auto rounded border border-slate-600 bg-slate-900 py-0.5 shadow-lg',
            up ? 'bottom-full mb-0.5' : 'top-full mt-0.5',
            props.align === 'right' ? 'right-0' : 'left-0',
          )}
          style={`max-height:${maxH}px`}
          onClick={(e) => e.stopPropagation()}
        >
          {props.options.map((o) => {
            const v = valueOf(o);
            return (
              <button
                key={v}
                class={cn(
                  'shrink-0 cursor-pointer px-2 py-1 text-left text-[10px] capitalize',
                  v === props.value
                    ? 'bg-indigo-500/30 text-slate-100'
                    : 'text-slate-300 hover:bg-slate-700',
                )}
                onClick={() => {
                  props.onChange(v);
                  setOpen(false);
                }}
              >
                {labelOf(o)}
              </button>
            );
          })}
        </span>
      )}
    </span>
  );
}
