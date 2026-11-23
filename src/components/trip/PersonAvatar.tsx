import { cn } from '@/components/ui'
import { initial, personHue, type PersonHue } from '@/lib/person-hue'

/* White text on each passes 4.5:1 (themes.css). */
const HUE_CLASS: Record<PersonHue, string> = {
  navy: 'bg-primary text-primary-foreground',
  terracotta: 'bg-coral-ink text-coral-foreground',
  slate: 'bg-info text-info-foreground',
  pine: 'bg-success text-success-foreground',
  plum: 'bg-berry text-white',
  ochre: 'bg-sun text-sun-foreground',
}

const SIZE = {
  sm: 'h-7 w-7 text-xs',
  md: 'h-9 w-9 text-sm',
} as const

/** A traveler's initial on their own stable color. Decorative: the name is always next to it. */
export function PersonAvatar({
  id,
  name,
  size = 'md',
  className,
}: {
  id: string
  name: string | null | undefined
  size?: keyof typeof SIZE
  className?: string
}) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold ring-2 ring-card',
        HUE_CLASS[personHue(id)],
        SIZE[size],
        className,
      )}
    >
      {initial(name)}
    </span>
  )
}
