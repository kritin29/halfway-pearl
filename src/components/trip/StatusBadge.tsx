import { Loader2, LockKeyhole, Trophy, Users, type LucideIcon } from 'lucide-react'
import { Badge, cn } from '@/components/ui'
import type { TripStatus } from '@/lib/types'

/** One color and icon per trip status, matching the section it points to. */
const LABELS: Record<
  TripStatus,
  { label: string; variant: 'info' | 'primary' | 'coral' | 'success'; Icon: LucideIcon; spin?: boolean }
> = {
  gathering: { label: 'Gathering', variant: 'info', Icon: Users },
  searching: { label: 'Searching fares', variant: 'primary', Icon: Loader2, spin: true },
  results: { label: 'Results ready', variant: 'coral', Icon: Trophy },
  locked: { label: 'Locked', variant: 'success', Icon: LockKeyhole },
}

export function StatusBadge({ status, className }: { status: TripStatus; className?: string }) {
  const s = LABELS[status] ?? LABELS.gathering
  return (
    <Badge variant={s.variant} className={className}>
      <s.Icon className={cn(s.spin && 'motion-safe:animate-spin')} aria-hidden />
      {s.label}
    </Badge>
  )
}
