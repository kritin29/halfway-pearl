/**
 * Fare-search progress and outcome, read from the trip row only (SPEC §3.5:
 * clients never use `useJobs`; the job copies progress onto the trip).
 */
import type { RecordData } from 'deepspace'
import { AlertTriangle, Plane } from 'lucide-react'
import { isProviderOutage, ProviderOutage } from './ProviderOutage'
import type { TripData } from '@/lib/types'

export function SearchStatus({ trip }: { trip: RecordData<TripData> }) {
  const { status, searchProgress, searchMessage, searchError } = trip.data

  if (status === 'searching') {
    const pct = Math.round(Math.min(1, Math.max(0, searchProgress ?? 0)) * 100)
    return (
      <div className="surface flex flex-col gap-2 border-primary/30 p-4" data-testid="search-progress">
        <div className="flex items-baseline justify-between gap-3 text-sm">
          <span className="inline-flex items-center gap-2 font-semibold">
            <Plane className="h-4 w-4 text-primary motion-safe:animate-pulse" aria-hidden />
            Checking fares…
          </span>
          <span className="font-mono font-semibold tabular-nums text-accent-foreground">{pct}%</span>
        </div>
        <div
          role="progressbar"
          aria-label="Fare search progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          className="h-2.5 overflow-hidden rounded-full bg-muted"
        >
          <div
            className="h-full rounded-full bg-gradient-to-r from-primary to-coral transition-[width] duration-500"
            style={{ width: `${pct}%` }}
          />
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
