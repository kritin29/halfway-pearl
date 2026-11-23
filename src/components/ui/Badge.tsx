import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

type Variant =
  | 'default'
  | 'secondary'
  | 'destructive'
  | 'outline'
  | 'success'
  | 'warning'
  | 'info'
  | 'coral'
  | 'primary'
  | 'sun'
type Size = 'default' | 'sm' | 'lg'

/*
 * `default` and `destructive` are solid. The status variants are soft: a
 * light tint of the hue with its darker *-ink text and a faint ring, so a row
 * of badges reads as distinct colors without shouting (contrast in
 * themes.css).
 */
const VARIANTS: Record<Variant, string> = {
  default: 'bg-primary text-primary-foreground',
  secondary: 'bg-muted text-muted-foreground ring-1 ring-inset ring-border',
  destructive: 'bg-destructive text-destructive-foreground',
  outline: 'ring-1 ring-inset ring-border bg-card text-foreground',
  success: 'bg-success/12 text-success-ink ring-1 ring-inset ring-success/25',
  warning: 'bg-warning/12 text-warning-ink ring-1 ring-inset ring-warning/25',
  info: 'bg-info/12 text-info-ink ring-1 ring-inset ring-info/25',
  coral: 'bg-coral/12 text-coral-ink ring-1 ring-inset ring-coral/30',
  primary: 'bg-primary/12 text-accent-foreground ring-1 ring-inset ring-primary/25',
  sun: 'bg-sun-soft text-sun-foreground ring-1 ring-inset ring-sun',
}

const SIZES: Record<Size, string> = {
  default: 'px-2.5 py-0.5 text-xs [&_svg]:size-3.5',
  sm: 'px-2 py-0.5 text-[11px] [&_svg]:size-3',
  lg: 'px-3 py-1 text-sm [&_svg]:size-4',
}

export interface BadgeProps extends ComponentProps<'span'> {
  variant?: Variant
  size?: Size
}

export function Badge({ className, variant = 'default', size = 'default', ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full font-semibold [&_svg]:shrink-0',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    />
  )
}
