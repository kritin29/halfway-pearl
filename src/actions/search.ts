/**
 * startSearch (SPEC §6): the organizer's "Find fares". Everything that can
 * refuse happens here, before anything is enqueued:
 *
 *   organizer → not locked / not already searching → ≥ 2 travelers with home
 *   airports and ≥ 1 destination → caps (src/lib/caps.ts `decideRunStart`,
 *   counts from the `usage` ledger, which fails closed) → count the search →
 *   status 'searching' → enqueue `fare-search` → store `searchJobId`.
 *
 * If enqueueing throws, the trip goes back to how it was and the search
 * isn't counted (`enqueue_failed`).
 */
import { enqueueJob } from 'deepspace/worker'
import type { Env } from '../../worker'
import { knownHomeAirports } from '../lib/airports'
import { decideRunStart, usageDay, usageKeys } from '../lib/caps'
import { LIMITS } from '../lib/limits'
import { recordId } from '../lib/validate'
import { isTestTrip } from '../server/test-seam'
import { defineAction, fail, must, ok, requireOrganizer, type Trip } from '../server/trip-access'
import { queryTravelers } from '../server/trip-rows'
import { getUsageCounts, incrementUsage } from '../server/usage'
import { queryCandidates } from './candidates'

/** A 'searching' trip whose row hasn't changed for this long is stuck (its job died), not running. */
export function searchIsStale(trip: Trip, now: Date, staleMs: number = LIMITS.staleSearchMs): boolean {
  const updated = Date.parse(trip.updatedAt)
  return Number.isFinite(updated) && now.getTime() - updated >= staleMs
}

export const startSearch = defineAction<Env>('startSearch', async ({ userId, params, tools, env }) => {
  const tripId = recordId(params.tripId, 'Trip')
  if (!tripId.ok) return fail('invalid_params', tripId.error)
  const access = await requireOrganizer(tools, tripId.value, userId)
  if (!access.ok) return access.result
  const trip = access.trip
  const now = new Date()

  if (trip.data.status === 'locked') return fail('trip_locked', 'This trip is locked, so there’s nothing left to search.')
  if (trip.data.status === 'searching' && !searchIsStale(trip, now)) {
    return fail('search_running', 'Fares are already being checked for this trip.')
  }

  const travelers = await queryTravelers(tools, tripId.value)
  const withAirports = travelers.filter((t) => knownHomeAirports(t.data.homeAirports).length > 0).length
  if (withAirports < 2) {
    return fail('needs_airports', 'At least 2 travelers need home airports before fares can be compared.')
  }
  const candidates = await queryCandidates(tools, tripId.value)
  if (candidates.length === 0) return fail('needs_candidates', 'Add at least one destination first.')

  // Caps, from the ledger. In dev/test only, `__test-` trips (answered from the
  // fixture, so nothing is spent) skip the per-user and global budgets; the
  // per-trip limit still applies so tests can prove it.
  const day = usageDay(now)
  const keys = {
    global: usageKeys.serpapiGlobal(),
    trip: usageKeys.fullSearchTrip(trip.id),
    user: usageKeys.userTripsSearched(userId),
    userTrip: usageKeys.userSearchedTrip(userId, trip.id),
  }
  const counts = await getUsageCounts(tools, day, Object.values(keys))
  const test = isTestTrip(env, trip.data.name)
  const already = counts[keys.userTrip] > 0
  const decision = decideRunStart('full', {
    globalSerpapiCallsToday: test ? 0 : counts[keys.global],
    tripFullSearchesToday: counts[keys.trip],
    tripWatchChecksToday: 0,
    userTripsSearchedToday: test ? 0 : counts[keys.user],
    userAlreadySearchedThisTripToday: already,
  })
  if (!decision.ok) return fail('cap_reached', decision.message)

  await incrementUsage(tools, day, keys.trip)
  if (!already) {
    await incrementUsage(tools, day, keys.user)
    await incrementUsage(tools, day, keys.userTrip)
  }

  const before = {
    status: trip.data.status,
    searchProgress: trip.data.searchProgress ?? null,
    searchMessage: trip.data.searchMessage ?? null,
    searchError: trip.data.searchError ?? null,
    searchJobId: trip.data.searchJobId ?? null,
  }
  must(
    await tools.update('trips', trip.id, {
      status: 'searching',
      searchProgress: 0,
      searchMessage: 'Waiting to start…',
      searchError: null,
      searchJobId: null,
    }),
    'mark searching',
  )

  let jobId: string
  try {
    jobId = await enqueueJob(
      env.JOB_ROOMS,
      `app:${env.DEEPSPACE_APP_ID}`,
      'fare-search',
      { tripId: trip.id, mode: 'full' },
      { maxAttempts: 2, enqueuedBy: userId },
    )
  } catch (err) {
    console.error(`[action] startSearch: enqueue failed: ${err instanceof Error ? err.message : String(err)}`)
    must(await tools.update('trips', trip.id, before), 'roll back search')
    await incrementUsage(tools, day, keys.trip, -1)
    if (!already) {
      await incrementUsage(tools, day, keys.user, -1)
      await incrementUsage(tools, day, keys.userTrip, -1)
    }
    return fail('enqueue_failed', 'The fare search couldn’t be started. Please try again.')
  }

  must(await tools.update('trips', trip.id, { searchJobId: jobId }), 'store job id')
  return ok({ jobId })
})
