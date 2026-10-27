import type { ComponentProps, Ref } from 'preact';
import { cn } from '@/lib/utils';

// One control look for the whole app — themed bg + border so inputs and
// dropdown triggers read as the same control in every theme. Call sites
// pass layout classes only (widths, group joins, mono).
export const controlClasses =
  'h-8 rounded-lg border border-input bg-card px-2.5 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50';

// `ref` can't reach the DOM node through a function component (preact
// strips it from props), so the composer gets an explicit inputRef.
export function Input({
  class: cls,
  className,
  type,
  inputRef,
  ...props
}: ComponentProps<'input'> & { inputRef?: Ref<HTMLInputElement> }) {
  return (
    <input
      ref={inputRef}
      type={type}
      data-slot="input"
      // `class` must merge too — in preact it spreads onto the element
      // after className and silently replaces the base classes
      className={cn(controlClasses, 'w-full min-w-0 py-1', cls, className)}
      {...props}
    />
  );
}
