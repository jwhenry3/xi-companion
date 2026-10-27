import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'preact';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  "inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-transparent text-sm font-medium outline-none transition-all focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/80',
        outline: 'border-border bg-transparent hover:bg-muted hover:text-foreground',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'hover:bg-muted hover:text-foreground',
        destructive:
          'bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:ring-destructive/40',
      },
      size: {
        default: 'h-8 px-2.5',
        sm: 'h-7 rounded-md px-2.5 text-[0.8rem]',
        xs: 'h-6 gap-1 rounded-md px-2 text-xs',
        icon: 'size-8',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps
  extends ComponentProps<'button'>,
    VariantProps<typeof buttonVariants> {}

export function Button({
  class: cls,
  className,
  variant,
  size,
  type,
  ...props
}: ButtonProps) {
  return (
    <button
      type={type ?? 'button'}
      data-slot="button"
      // `class` must merge too — in preact it spreads onto the element
      // after className and silently replaces the variant classes
      className={cn(buttonVariants({ variant, size }), cls, className)}
      {...props}
    />
  );
}

export { buttonVariants };
