/**
 * Ranking & privacy rules (SPEC §7). Pure and unit-tested.
 *
 * Server side (the fare-search job) calls `aggregateCandidate` with real
 * budgets and stores the result on the candidate row. Clients only ever see
 * the stored aggregates, never budgets. `ownFit` runs client-side with the
 * viewer's own budget row.
 */
import { ARRIVAL_BADGE_MAX_MIN, FITS_ALL_MIN_BUDGETS } from './limits'

export type FareStatus = 'ok' | 'no_results' | 'filtered_out' | 'error'

export interface RankTraveler {
  /** userId for real travelers, `ghost:<uuid>` for ghosts. */
  id: string
  displayName: string
}

export interface RankFare {
  travelerId: string
  status: FareStatus
  /** Round-trip price in USD; only meaningful when status is 'ok'. */
  price: number | null
  /** Outbound arrival, local time at the destination: "YYYY-MM-DD HH:MM". */
  arriveLocal: string | null
  /**
   * The traveler lives at this candidate (price 0, no flight). They are
   * already there, so they don't count toward the arrival spread.
   */
  home?: boolean
}

export interface CandidateAggregate {
  /** Every traveler has an 'ok' fare. */
  complete: boolean
  /** Σ price. Null unless complete (a partial total would look misleadingly cheap). */
  groupTotal: number | null
  maxFare: number | null
  minFare: number | null
  /** Latest arrival − earliest arrival, in minutes. Null unless complete with all times. */
  arrivalSpreadMin: number | null
  /** 1 / 0 when shown, null when hidden by the privacy guard or unknown. */
  fitsAll: 0 | 1 | null
  /** Display names of travelers without an 'ok' fare. */
  missingFor: string[]
}

/**
 * Aggregate one candidate destination.
 *
 * @param travelers everyone on the trip, ghosts included
 * @param fares     the chosen fare per traveler for THIS candidate
 * @param budgets   travelerId → max round-trip USD. Server-only data. Entries for
 *                  ids that aren't travelers on the trip are ignored.
 */
export function aggregateCandidate(
  travelers: readonly RankTraveler[],
  fares: readonly RankFare[],
  budgets: ReadonlyMap<string, number>,
): CandidateAggregate {
  const fareByTraveler = new Map(fares.map((f) => [f.travelerId, f]))
  const okPrices: number[] = []
  const arrivals: number[] = []
  const missingFor: string[] = []
  let flyers = 0

  for (const t of travelers) {
    const fare = fareByTraveler.get(t.id)
    if (!fare || fare.status !== 'ok' || !isPrice(fare.price)) {
      missingFor.push(t.displayName)
      continue
    }
    okPrices.push(fare.price)
    if (fare.home) continue
    flyers++
    const arrive = parseLocalMinutes(fare.arriveLocal)
    if (arrive !== null) arrivals.push(arrive)
  }

  const complete = travelers.length > 0 && missingFor.length === 0
  if (!complete) {
    return {
      complete,
      groupTotal: null,
      maxFare: null,
      minFare: null,
      arrivalSpreadMin: null,
      fitsAll: null,
      missingFor,
    }
  }

  // Spread over the travelers who fly. Nobody flying (everyone lives there) = 0.
  const arrivalSpreadMin =
    flyers === 0 ? 0 : arrivals.length === flyers ? Math.max(...arrivals) - Math.min(...arrivals) : null

  return {
    complete,
    groupTotal: round2(okPrices.reduce((sum, p) => sum + p, 0)),
    maxFare: Math.max(...okPrices),
    minFare: Math.min(...okPrices),
    arrivalSpreadMin,
    fitsAll: computeFitsAll(travelers, fareByTraveler, budgets),
    missingFor,
  }
}

/**
 * fitsAll = every traveler WHO HAS A BUDGET has price ≤ budget.
 *
 * Privacy guard: return null (hidden) unless at least FITS_ALL_MIN_BUDGETS (3)
 * travelers have budgets. With only 2 budgets, a "doesn't fit" badge would tell
 * each of them that the OTHER person's budget is below that person's fare,
 * which leaks an upper bound on a private number. With 3+, nobody can tell
 * whose budget was the constraint.
 */
export function computeFitsAll(
  travelers: readonly RankTraveler[],
  fareByTraveler: ReadonlyMap<string, RankFare>,
  budgets: ReadonlyMap<string, number>,
): 0 | 1 | null {
  const budgeted = travelers.filter((t) => isPrice(budgets.get(t.id)))
  if (budgeted.length < FITS_ALL_MIN_BUDGETS) return null
  for (const t of budgeted) {
    const fare = fareByTraveler.get(t.id)
    if (!fare || fare.status !== 'ok' || !isPrice(fare.price)) return null
    if (fare.price > (budgets.get(t.id) as number)) return 0
  }
  return 1
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

export type SortMode = 'cheapest' | 'fairest' | 'together'

export interface RankedCandidate extends CandidateAggregate {
  iata: string
}

/**
 * Sort candidates for one results tab. Complete candidates always come before
 * incomplete ones; ties fall back to groupTotal, then IATA code so the order is
 * stable.
 *
 * - cheapest: groupTotal ↑
 * - fairest:  maxFare ↑ (protects the person paying the most), then groupTotal ↑
 * - together: arrivalSpreadMin ↑ (missing spread sorts after known), then groupTotal ↑
 */
export function sortCandidates<T extends RankedCandidate>(candidates: readonly T[], mode: SortMode): T[] {
  return [...candidates].sort((a, b) => {
    if (a.complete !== b.complete) return a.complete ? -1 : 1
    if (!a.complete) {
      // Fewer missing fares first, then alphabetical.
      return a.missingFor.length - b.missingFor.length || a.iata.localeCompare(b.iata)
    }
    const primary =
      mode === 'cheapest'
        ? 0
        : mode === 'fairest'
          ? compareNullableAsc(a.maxFare, b.maxFare)
          : compareNullableAsc(a.arrivalSpreadMin, b.arrivalSpreadMin)
    return primary || compareNullableAsc(a.groupTotal, b.groupTotal) || a.iata.localeCompare(b.iata)
  })
}

// ---------------------------------------------------------------------------
// Badges and the viewer's private fit
// ---------------------------------------------------------------------------

/** "Everyone lands within 1h 40m", or null when the spread is unknown or > 3h. */
export function arrivalBadge(arrivalSpreadMin: number | null): string | null {
  if (arrivalSpreadMin === null || arrivalSpreadMin > ARRIVAL_BADGE_MAX_MIN) return null
  return `Everyone lands within ${formatDuration(arrivalSpreadMin)}`
}

/** 100 → "1h 40m", 45 → "45m", 120 → "2h", 0 → "0m". */
export function formatDuration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes))
  const h = Math.floor(m / 60)
  const rest = m % 60
  if (h === 0) return `${rest}m`
  return rest === 0 ? `${h}h` : `${h}h ${rest}m`
}

/**
 * The viewer's own "your fare vs your budget" line, computed client-side from
 * their own budget row. `diff` > 0 means under budget by that much.
 */
export function ownFit(
  price: number | null,
  budget: number | null,
): { fits: boolean; diff: number } | null {
  if (!isPrice(price) || !isPrice(budget)) return null
  return { fits: price <= budget, diff: round2(budget - price) }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minutes since the epoch for a local "YYYY-MM-DD HH:MM" string, treating it
 * as a wall-clock time. All arrivals at one destination share its timezone,
 * so differences between these values are real minutes.
 */
export function parseLocalMinutes(value: string | null | undefined): number | null {
  if (!value) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})/.exec(value)
  if (!m) return null
  const [, y, mo, d, h, mi] = m.map(Number)
  return Date.UTC(y, mo - 1, d, h, mi) / 60000
}

function isPrice(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function compareNullableAsc(a: number | null, b: number | null): number {
  if (a === b) return 0
  if (a === null) return 1
  if (b === null) return -1
  return a - b
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
