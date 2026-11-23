/**
 * Fare-watch decisions (SPEC §3.9, §8.7, §9). Pure and unit-tested.
 *
 * - Shortlist: the locked destination, or else the top destinations by
 *   votes (ties → cheapest complete group total, then IATA).
 * - Window: watching stops once the outbound date is ≤ 1 day away
 *   (calendar days in America/Chicago, the cron's timezone).
 * - Cron filter: which trips the daily cron enqueues.
 * - Group drop: email the group when a candidate's complete group total falls
 *   by at least max($50, 5% of the previous total) since the previous snapshot.
 * - Private budget crossing: a traveler's fare for a candidate goes from
 *   ABOVE their budget to AT OR BELOW it. The sender keys that email per
 *   (trip, destination, traveler) with no date, so only the FIRST crossing
 *   is ever emailed (src/lib/email.ts `underBudgetEmailKey`).
 */
import { DROP_MIN_FRACTION, DROP_MIN_USD, LIMITS, WATCH_TIMEZONE, type Limits } from './limits'

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** `YYYY-MM-DD` for `now` in `timeZone` (default: the watch's timezone). */
export function dateInZone(now: Date, timeZone: string = WATCH_TIMEZONE): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

/** Calendar days from `fromIso` to `toIso` (both `YYYY-MM-DD`); null if either isn't a date. */
export function daysBetween(fromIso: string, toIso: string): number | null {
  const a = isoDayNumber(fromIso)
  const b = isoDayNumber(toIso)
  return a === null || b === null ? null : b - a
}

function isoDayNumber(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return null
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Number.isFinite(t) ? Math.round(t / 86_400_000) : null
}

/**
 * Is the trip still far enough away to watch? True when the outbound date
 * is MORE than `watchStopsDaysBefore` (1) calendar days after `today`.
 */
export function isWatchWindowOpen(outboundDate: string, today: string, limits: Limits = LIMITS): boolean {
  const days = daysBetween(today, outboundDate)
  return days !== null && days > limits.watchStopsDaysBefore
}

/**
 * Is a watch run queued or running? `watchQueuedAt` is set when a run is
 * enqueued and cleared by the job; one older than `staleWatchMs` is treated
 * as lost (its job died), so the organizer may check again.
 */
export function isWatchPending(watchQueuedAt: unknown, now: Date, limits: Limits = LIMITS): boolean {
  if (typeof watchQueuedAt !== 'string' || !watchQueuedAt) return false
  const queued = Date.parse(watchQueuedAt)
  return Number.isFinite(queued) && now.getTime() - queued < limits.staleWatchMs
}

// ---------------------------------------------------------------------------
// Shortlist
// ---------------------------------------------------------------------------

export interface ShortlistTrip {
  status: string
  lockedIata?: string | null
}

export interface ShortlistCandidate {
  iata: string
  /** Null while the candidate isn't complete. */
  groupTotal: number | null
}

/**
 * The destinations a watch run re-checks, best first.
 *
 * - Locked trip: just the locked destination (if it's still a candidate).
 * - Otherwise the top `size` by approval votes. Ties go to the cheaper
 *   complete group total (incomplete ones last), then IATA, so the order is
 *   stable. Destinations with no votes still fill free places.
 */
export function selectShortlist(
  trip: ShortlistTrip,
  candidates: readonly ShortlistCandidate[],
  votes: ReadonlyArray<{ candidateIata: unknown }>,
  size: number = LIMITS.watchShortlistSize,
): string[] {
  if (trip.status === 'locked' && trip.lockedIata) {
    return candidates.some((c) => c.iata === trip.lockedIata) ? [trip.lockedIata] : []
  }
  const tally = new Map<string, number>()
  for (const v of votes) {
    if (typeof v.candidateIata === 'string') tally.set(v.candidateIata, (tally.get(v.candidateIata) ?? 0) + 1)
  }
  const total = (c: ShortlistCandidate) => (isAmount(c.groupTotal) ? c.groupTotal : Number.POSITIVE_INFINITY)
  return [...candidates]
    .sort(
      (a, b) =>
        (tally.get(b.iata) ?? 0) - (tally.get(a.iata) ?? 0) ||
        total(a) - total(b) ||
        (a.iata < b.iata ? -1 : a.iata > b.iata ? 1 : 0),
    )
    .slice(0, Math.max(0, size))
    .map((c) => c.iata)
}

// ---------------------------------------------------------------------------
// Cron filter
// ---------------------------------------------------------------------------

export interface WatchTripCandidate {
  id: string
  watchEnabled: unknown
  status: unknown
  outboundDate: unknown
  /** Demo trips (isDemo = 1) are never watched by the cron (SPEC §14). */
  isDemo?: unknown
}

/**
 * The trips the daily cron watches: watch on, not a demo trip, status results
 * or locked, and the outbound date more than a day away. Soonest trips first
 * (their prices matter most), then id; at most `maxWatchTripsPerCronRun`.
 */
export function selectWatchTrips<T extends WatchTripCandidate>(
  trips: readonly T[],
  today: string,
  limits: Limits = LIMITS,
): { selected: T[]; eligible: number } {
  const eligible = trips.filter(
    (t) =>
      t.watchEnabled === 1 &&
      t.isDemo !== 1 &&
      (t.status === 'results' || t.status === 'locked') &&
      typeof t.outboundDate === 'string' &&
      isWatchWindowOpen(t.outboundDate, today, limits),
  )
  const sorted = [...eligible].sort(
    (a, b) =>
      String(a.outboundDate).localeCompare(String(b.outboundDate)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )
  return { selected: sorted.slice(0, Math.max(0, limits.maxWatchTripsPerCronRun)), eligible: eligible.length }
}

export interface SnapshotTotals {
  /** Null when the candidate wasn't complete at that check. */
  groupTotal: number | null
}

export interface GroupDrop {
  previousTotal: number
  currentTotal: number
  /** previousTotal − currentTotal, rounded to cents. */
  amount: number
  /** The minimum drop that would have counted. */
  threshold: number
}

/** max($50, 5% of the previous total). */
export function dropThreshold(previousTotal: number): number {
  return Math.max(DROP_MIN_USD, round2(previousTotal * DROP_MIN_FRACTION))
}

/**
 * Compare the previous snapshot with the current one. Returns the drop when it
 * qualifies, otherwise null. Both totals must exist (complete candidates).
 */
export function detectGroupDrop(
  previous: SnapshotTotals | null | undefined,
  current: SnapshotTotals,
): GroupDrop | null {
  const prev = previous?.groupTotal
  const curr = current.groupTotal
  if (!isAmount(prev) || !isAmount(curr)) return null
  const amount = round2(prev - curr)
  const threshold = dropThreshold(prev)
  return amount >= threshold ? { previousTotal: prev, currentTotal: curr, amount, threshold } : null
}

export interface WatchFare {
  travelerId: string
  candidateIata: string
  /** Null when there's no 'ok' fare. */
  price: number | null
}

export interface BudgetCrossing {
  travelerId: string
  candidateIata: string
  previousPrice: number
  price: number
  budget: number
}

/**
 * Find travelers whose fare just crossed under their private budget.
 *
 * A crossing needs a previous 'ok' price ABOVE the budget and a current 'ok'
 * price AT OR BELOW it. With no previous price there's nothing to cross from:
 * the traveler already sees their own fit in the app, so no email.
 *
 * @param previous fares before this check (e.g. the rows about to be overwritten)
 * @param current  fares from this check
 * @param budgets  travelerId → budget. Server-only; travelers without one are skipped.
 */
export function findBudgetCrossings(
  previous: readonly WatchFare[],
  current: readonly WatchFare[],
  budgets: ReadonlyMap<string, number>,
): BudgetCrossing[] {
  const prevByKey = new Map(previous.map((f) => [fareKey(f), f.price]))
  const crossings: BudgetCrossing[] = []
  for (const fare of current) {
    const budget = budgets.get(fare.travelerId)
    const previousPrice = prevByKey.get(fareKey(fare))
    if (!isAmount(budget) || !isAmount(fare.price) || !isAmount(previousPrice)) continue
    if (previousPrice > budget && fare.price <= budget) {
      crossings.push({
        travelerId: fare.travelerId,
        candidateIata: fare.candidateIata,
        previousPrice,
        price: fare.price,
        budget,
      })
    }
  }
  return crossings
}

function fareKey(f: WatchFare): string {
  return `${f.travelerId}\u0000${f.candidateIata}`
}

function isAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
