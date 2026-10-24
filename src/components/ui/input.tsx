import type { ComponentProps, Ref } from 'preact';
import { cn } from '@/lib/utils';

// `ref` can't reach the DOM node through a function component (preact
// strips it from props), so the composer gets an explicit inputRef.
export function Input({
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
      className={cn(
        'h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}
