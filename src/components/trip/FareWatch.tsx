/**
 * The fare watch on the Book tab (SPEC §3.9, §10): price history for the
 * watched destination (the locked one, or the top of the shortlist), when it
 * was last checked, and for the organizer the daily-watch switch and
 * "Check fares now".
 *
 * Everything comes from rows members can already read: the trip row
 * (`watchEnabled`, `watchQueuedAt`, `watchError`), candidates, votes and
 * `fareSnapshots`. No budgets are involved anywhere here.
 */
import { useEffect, useState } from 'react'
import { useQuery, type RecordData } from 'deepspace'
import { BellRing, RefreshCw, TrendingDown, TrendingUp } from 'lucide-react'
import { Button, Label, Switch, useToast } from '@/components/ui'
import { ErrorState, Retryable } from '@/components/AsyncState'
import { useAction } from '@/hooks/useAction'
import { timeAgo } from '@/lib/format'
import { usd } from '@/lib/results'
import type { CandidateData, FareSnapshotData, TripData, VoteData } from '@/lib/types'
import { dateInZone, isWatchPending, isWatchWindowOpen, selectShortlist } from '@/lib/watch'
import { FareSparkline, type SparkPoint } from './FareSparkline'
import { isProviderOutage, ProviderOutage } from './ProviderOutage'

/** Most recent points shown in the sparkline. */
const MAX_POINTS = 30

/** A clock that ticks every 30 s, for "checked 5 min ago" and the stale-check timeout. */
function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

export function FareWatch({ trip, me }: { trip: RecordData<TripData>; me: string }) {
  return <Retryable>{(retry) => <FareWatchContent trip={trip} me={me} onRetry={retry} />}</Retryable>
}

function FareWatchContent({ trip, me, onRetry }: { trip: RecordData<TripData>; me: string; onRetry: () => void }) {
  const now = useNow()
  const tripId = trip.recordId
  const locked = trip.data.status === 'locked'
  const candidates = useQuery<CandidateData>('candidates', { where: { tripId }, limit: 20 })
  const votes = useQuery<VoteData>('votes', { where: { tripId }, limit: 200 })

  const isOrganizer = trip.data.organizerId === me
  const ended = !isWatchWindowOpen(trip.data.outboundDate, dateInZone(now))
  const pending = isWatchPending(trip.data.watchQueuedAt, now)
  const on = trip.data.watchEnabled === 1

  let body
  if (candidates.status === 'loading' || votes.status === 'loading') {
    body = <p className="text-sm text-muted-foreground">Loading price history…</p>
  } else if (candidates.status === 'error' || votes.status === 'error') {
    body = <ErrorState title="Could not load the price history" message={candidates.error ?? votes.error} onRetry={onRetry} />
  } else {
    const iata = locked
      ? (trip.data.lockedIata ?? '')
      : (selectShortlist(
          trip.data,
          candidates.records.map((c) => ({ iata: c.data.iata, groupTotal: c.data.groupTotal })),
          votes.records.map((v) => v.data),
        )[0] ?? '')
    const city = candidates.records.find((c) => c.data.iata === iata)?.data.city ?? iata
    body = iata ? (
      <History key={iata} tripId={tripId} iata={iata} city={city} locked={locked} now={now} onRetry={onRetry} />
    ) : (
      <p className="text-sm text-muted-foreground">Add destinations and find fares to start a price history.</p>
    )
  }

  const statusLine = ended
    ? 'Watching has stopped: the trip starts within a day.'
    : on
      ? 'On: Halfway checks fares every morning and emails the group when the total drops by $50 or 5%.'
      : 'Off: no daily checks or emails.'

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4 sm:p-5" data-testid="fare-watch" aria-labelledby="fare-watch-heading">
      <div>
        <h2 id="fare-watch-heading" className="flex items-center gap-2 text-base font-semibold">
          <BellRing className="h-4 w-4" aria-hidden /> Fare watch
        </h2>
        {!isOrganizer && (
          <p className="mt-0.5 text-sm text-muted-foreground" data-testid="watch-status">
            {statusLine}
          </p>
        )}
      </div>

      {body}

      {pending && (
        <p role="status" aria-live="polite" className="inline-flex items-center gap-2 text-sm text-muted-foreground" data-testid="watch-pending">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />
          Checking fares…
        </p>
      )}
      {!pending && trip.data.watchError && (
        isProviderOutage(trip.data.watchError) ? (
          <ProviderOutage testId="watch-error" retryHint="Prices found earlier stay as they were. You can check again later." />
        ) : (
          <p role="status" className="rounded-md bg-muted px-3 py-2 text-sm" data-testid="watch-error">
            {trip.data.watchError}
          </p>
        )
      )}

      {isOrganizer && <WatchControls trip={trip} ended={ended} pending={pending} statusLine={statusLine} />}
    </section>
  )
}

function History({
  tripId,
  iata,
  city,
  locked,
  now,
  onRetry,
}: {
  tripId: string
  iata: string
  city: string
  locked: boolean
  now: Date
  onRetry: () => void
}) {
  const snapshots = useQuery<FareSnapshotData>('fareSnapshots', { where: { tripId, candidateIata: iata }, limit: 200 })
  if (snapshots.status === 'loading') return <p className="text-sm text-muted-foreground">Loading price history…</p>
  if (snapshots.status === 'error') {
    return <ErrorState title="Could not load the price history" message={snapshots.error} onRetry={onRetry} />
  }

  const sorted = [...snapshots.records].sort((a, b) => String(a.data.checkedAt).localeCompare(String(b.data.checkedAt)))
  const lastChecked = sorted.at(-1)?.data.checkedAt ?? null
  const points: SparkPoint[] = sorted
    .filter((s) => typeof s.data.groupTotal === 'number')
    .map((s) => ({ checkedAt: s.data.checkedAt, total: s.data.groupTotal as number }))
    .slice(-MAX_POINTS)
  const latest = points.at(-1)
  const previous = points.at(-2)
  const change = latest && previous ? Math.round((latest.total - previous.total) * 100) / 100 : 0
  const label = `Group total to ${city}`

  return (
    <div className="flex flex-col gap-2" data-testid="watch-history" data-iata={iata}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="text-sm text-muted-foreground">
          {label} <span className="font-mono text-xs">{iata}</span>
          {!locked && <span className="text-xs"> · top of the shortlist</span>}
        </p>
        {latest && (
          <p className="inline-flex items-center gap-1.5 text-sm font-semibold tabular-nums" data-testid="watch-latest-total">
            {usd(latest.total)}
            {change !== 0 && (
              <span className="inline-flex items-center gap-0.5 text-xs font-normal text-muted-foreground">
                {change < 0 ? <TrendingDown className="h-3.5 w-3.5" aria-hidden /> : <TrendingUp className="h-3.5 w-3.5" aria-hidden />}
                {change < 0 ? `${usd(-change)} less` : `${usd(change)} more`} than the check before
              </span>
            )}
          </p>
        )}
      </div>
      {points.length > 0 ? (
        <FareSparkline points={points} label={label} />
      ) : (
        <p className="text-sm text-muted-foreground" data-testid="watch-no-history">
          No complete price check yet.
        </p>
      )}
      <p className="text-xs text-muted-foreground" data-testid="watch-last-checked">
        {lastChecked ? `Last checked ${timeAgo(lastChecked, now)}` : 'Not checked yet'}
      </p>
    </div>
  )
}

function WatchControls({
  trip,
  ended,
  pending,
  statusLine,
}: {
  trip: RecordData<TripData>
  ended: boolean
  pending: boolean
  statusLine: string
}) {
  const toast = useToast()
  const toggle = useAction<{ watchEnabled: number }>('setWatch')
  const check = useAction<{ jobId: string }>('checkFaresNow')
  const tripId = trip.recordId
  const searching = trip.data.status === 'searching'

  async function setWatch(enabled: boolean) {
    const res = await toggle.run({ tripId, enabled })
    if (res && !res.success) toast.error('Could not change the fare watch', res.error)
  }
  async function checkNow() {
    check.reset()
    await check.run({ tripId })
  }

  const disabledHint = ended
    ? 'The trip starts within a day, so fares are no longer checked.'
    : searching
      ? 'Wait for the fare search to finish.'
      : null
  const busy = check.pending || pending
  const err = check.error

  return (
    <div className="flex flex-col gap-4 border-t border-border pt-4">
      <div className="flex items-start gap-3" data-testid="watch-toggle">
        <Switch
          id="watch-switch"
          checked={trip.data.watchEnabled === 1}
          onCheckedChange={(v) => void setWatch(Boolean(v))}
          disabled={ended || toggle.pending}
          aria-describedby="watch-hint"
          className="data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50"
        />
        <div>
          <Label htmlFor="watch-switch" className="text-sm font-medium">
            Daily fare watch
          </Label>
          <p id="watch-hint" className="text-xs text-muted-foreground">
            {statusLine}
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void checkNow()}
          loading={busy}
          disabled={busy || ended || searching}
          className="w-full sm:w-auto"
          data-testid="check-fares-now"
        >
          {!busy && <RefreshCw aria-hidden />}
          {pending ? 'Checking fares…' : 'Check fares now'}
        </Button>
        <p className="text-xs text-muted-foreground">{disabledHint ?? 'Re-checks the shortlist now (up to 3 times a day).'}</p>
      </div>

      {err && (
        <ErrorState
          testId="check-fares-error"
          title="Could not check fares"
          message={err.message}
          onRetry={err.code === 'cap_reached' || err.code === 'watch_ended' ? undefined : () => void checkNow()}
        />
      )}
    </div>
  )
}
