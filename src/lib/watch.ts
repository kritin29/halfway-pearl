/**
 * Fare-watch decisions (SPEC §3.9, §8.7). Pure and unit-tested.
 *
 * - Group drop: email the group when a candidate's complete group total falls
 *   by at least max($50, 5% of the previous total) since the previous snapshot.
 * - Private budget crossing: email one traveler (privately) when their fare
 *   for a candidate goes from ABOVE their budget to AT OR BELOW it. Staying
 *   under budget on later days sends nothing, so they get one email per crossing.
 */
import { DROP_MIN_FRACTION, DROP_MIN_USD } from './limits'

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
