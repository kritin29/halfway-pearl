import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

/*
 * Every variant answers the pointer three ways: hover changes color (and
 * filled buttons lift a pixel with a stronger shadow), press sinks back and
 * shrinks slightly, and keyboard focus gets a 3px ring. Motion is skipped for
 * reduced-motion users; the color changes stay.
 */
const buttonVariants = cva(
  "inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-semibold transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-out motion-safe:active:scale-[0.97] motion-safe:active:translate-y-0 disabled:pointer-events-none disabled:opacity-45 disabled:shadow-none [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:ring-ring/40 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default:
          'bg-primary text-primary-foreground shadow-[0_1px_2px_rgba(26,22,54,0.12),0_4px_12px_-4px_rgba(91,61,245,0.55)] hover:bg-primary-hover hover:shadow-[0_2px_4px_rgba(26,22,54,0.14),0_8px_20px_-6px_rgba(91,61,245,0.6)] motion-safe:hover:-translate-y-px',
        destructive:
          'bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90 hover:shadow-md motion-safe:hover:-translate-y-px focus-visible:ring-destructive/30',
        success:
          'bg-success text-success-foreground shadow-[0_1px_2px_rgba(26,22,54,0.12),0_4px_12px_-4px_rgba(11,122,85,0.55)] hover:bg-success/90 hover:shadow-[0_8px_20px_-6px_rgba(11,122,85,0.6)] motion-safe:hover:-translate-y-px focus-visible:ring-success/40',
        ink: 'bg-foreground text-background shadow-sm hover:bg-foreground/85 hover:shadow-md motion-safe:hover:-translate-y-px',
        outline:
          'border border-border bg-card text-foreground shadow-[0_1px_2px_rgba(26,22,54,0.06)] hover:border-primary/50 hover:bg-accent hover:text-accent-foreground',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-accent hover:text-accent-foreground',
        soft: 'bg-accent text-accent-foreground hover:bg-primary/20',
        ghost: 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm: 'h-9 rounded-md px-3 text-xs',
        lg: 'h-11 rounded-md px-8',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  loading?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, loading = false, disabled, children, type, ...props }, ref) => (
    <button
      ref={ref}
      data-slot="button"
      type={type ?? 'button'}
      className={cn(buttonVariants({ variant, size, className }))}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading && (
        <span
          aria-hidden="true"
          className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      )}
      {children}
    </button>
  ),
)
Button.displayName = 'Button'

export { Button, buttonVariants }
