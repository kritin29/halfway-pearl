import { Badge } from '@/components/ui'
import type { TripStatus } from '@/lib/types'

const LABELS: Record<TripStatus, { label: string; variant: 'secondary' | 'info' | 'success' | 'warning' }> = {
  gathering: { label: 'Gathering', variant: 'secondary' },
  searching: { label: 'Searching fares', variant: 'info' },
  results: { label: 'Results ready', variant: 'success' },
  locked: { label: 'Locked', variant: 'warning' },
}

export function StatusBadge({ status }: { status: TripStatus }) {
  const s = LABELS[status] ?? LABELS.gathering
  return <Badge variant={s.variant}>{s.label}</Badge>
}
