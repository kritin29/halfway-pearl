/**
 * Fare-search progress and outcome, read from the trip row only (SPEC §3.5:
 * clients never use `useJobs`; the job copies progress onto the trip).
 */
import type { RecordData } from 'deepspace'
import { AlertTriangle } from 'lucide-react'
import { isProviderOutage, ProviderOutage } from './ProviderOutage'
import type { TripData } from '@/lib/types'

export function SearchStatus({ trip }: { trip: RecordData<TripData> }) {
  const { status, searchProgress, searchMessage, searchError } = trip.data

  if (status === 'searching') {
    const pct = Math.round(Math.min(1, Math.max(0, searchProgress ?? 0)) * 100)
    return (
      <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4" data-testid="search-progress">
        <div className="flex items-baseline justify-between gap-3 text-sm">
          <span className="font-medium">Checking fares…</span>
          <span className="tabular-nums text-muted-foreground">{pct}%</span>
        </div>
        <div
          role="progressbar"
          aria-label="Fare search progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          className="h-2 overflow-hidden rounded-full bg-secondary"
        >
          <div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${pct}%` }} />
        </div>
        <p className="min-h-5 text-sm text-muted-foreground" aria-live="polite" data-testid="search-message">
          {searchMessage ?? 'Starting…'}
        </p>
      </div>
    )
  }

  if (!searchError) return null
  if (isProviderOutage(searchError)) {
    return <ProviderOutage retryHint="The organizer can press Find fares again later." />
  }
  return (
    <div
      role="status"
      data-testid="search-error"
      className="flex items-start gap-2 rounded-lg border border-border bg-muted px-4 py-3 text-sm"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      <p>{searchError}</p>
    </div>
  )
}
