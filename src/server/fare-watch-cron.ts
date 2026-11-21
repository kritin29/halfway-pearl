/**
 * The daily `fare-watch` cron task (SPEC §9): enqueue a watch run for each
 * trip worth watching.
 *
 *   trips with watchEnabled = 1 (the `where` is equality-only) →
 *   status results or locked, outbound date more than a day away
 *   (src/lib/watch.ts `selectWatchTrips`, soonest first, max 10) →
 *   per trip: skip if a watch run is already queued, skip if today's
 *   once-per-trip marker is set, skip if the caps say no (3 watch checks per
 *   trip per day, shared with "Check fares now"; global SerpApi budget) →
 *   count + marker + enqueue (src/server/watch-start.ts).
 *
 * Runs as the app owner with RBAC-off tools. Logs counts only, never trip
 * names or ids.
 */
import type { ActionTools } from 'deepspace/worker'
import type { Env } from '../../worker'
import { decideRunStart, usageDay, usageKeys } from '../lib/caps'
import { LIMITS, type Limits } from '../lib/limits'
import { dateInZone, isWatchPending, selectWatchTrips } from '../lib/watch'
import { isTestTrip } from './test-seam'
import { loadTrip, must } from './trip-access'
import { getUsageCounts } from './usage'
import { enqueueWatchRun, type Enqueue } from './watch-start'

export interface FareWatchCronReport {
  /** Trips that pass the filter (before the per-run maximum). */
  eligible: number
  enqueued: number
  /** Already watched today (the once-per-trip marker). */
  alreadyToday: number
  /** A watch run was already queued (e.g. "Check fares now"). */
  pending: number
  /** Refused by a cap. */
  capped: number
  /** Enqueue threw; counters were rolled back. */
  failed: number
}

export interface FareWatchCronDeps {
  now?: () => Date
  limits?: Limits
  enqueue?: Enqueue
}

export async function runFareWatchCron(
  tools: ActionTools,
  env: Pick<Env, 'JOB_ROOMS' | 'DEEPSPACE_APP_ID' | 'OWNER_USER_ID' | 'ALLOW_DEBUG_ROUTES'>,
  deps: FareWatchCronDeps = {},
): Promise<FareWatchCronReport> {
  const now = (deps.now ?? (() => new Date()))()
  const limits = deps.limits ?? LIMITS
  const day = usageDay(now)
  const report: FareWatchCronReport = { eligible: 0, enqueued: 0, alreadyToday: 0, pending: 0, capped: 0, failed: 0 }

  const { records } = must(await tools.query('trips', { where: { watchEnabled: 1 } }), 'query watched trips')
  const { selected, eligible } = selectWatchTrips(
    records.map((r) => ({ id: r.recordId, watchEnabled: r.data.watchEnabled, status: r.data.status, outboundDate: r.data.outboundDate })),
    dateInZone(now),
    limits,
  )
  report.eligible = eligible

  for (const pick of selected) {
    const access = await loadTrip(tools, pick.id)
    if (!access.ok) continue
    const trip = access.trip
    if (isWatchPending(trip.data.watchQueuedAt, now, limits)) {
      report.pending++
      continue
    }
    const keys = {
      marker: usageKeys.watchCronTrip(trip.id),
      watch: usageKeys.watchTrip(trip.id),
      global: usageKeys.serpapiGlobal(),
    }
    const counts = await getUsageCounts(tools, day, Object.values(keys))
    if (counts[keys.marker] > 0) {
      report.alreadyToday++
      continue
    }
    const decision = decideRunStart(
      'watch',
      {
        globalSerpapiCallsToday: isTestTrip(env, trip.data.name) ? 0 : counts[keys.global],
        tripFullSearchesToday: 0,
        tripWatchChecksToday: counts[keys.watch],
        userTripsSearchedToday: 0,
        userAlreadySearchedThisTripToday: true,
      },
      limits,
    )
    if (!decision.ok) {
      report.capped++
      continue
    }
    const started = await enqueueWatchRun(tools, env, trip, {
      day,
      now,
      enqueuedBy: env.OWNER_USER_ID,
      extraKeys: [keys.marker],
      enqueue: deps.enqueue,
    })
    if (started.ok) report.enqueued++
    else report.failed++
  }

  console.log(
    `[fare-watch] eligible ${report.eligible}, enqueued ${report.enqueued}, already today ${report.alreadyToday}, pending ${report.pending}, capped ${report.capped}, failed ${report.failed}`,
  )
  return report
}
