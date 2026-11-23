/**
 * createDemoTrip (SPEC §14): "Try a demo trip" on /trips.
 *
 * Creates a trip for the caller with `isDemo = 1` (the only place that flag
 * is ever written; the column is immutable), the caller as organizer flying
 * from Chicago, two ghost travelers in other cities and four destinations,
 * then starts the normal fare search (`beginFullSearch`). The job answers a
 * demo trip from the fixture, varied per route, in every environment, so a
 * demo never reaches `serpapi/flights`, and no email is ever sent for it.
 *
 * Cap: LIMITS.maxDemoTripsPerUserPerDay per user per UTC day (usage ledger,
 * fails closed), separate from the regular trip-creation cap.
 *
 * Dev/test seam (same double gate as src/server/test-seam.ts): a `testName`
 * starting with `__test-` is honoured only when ALLOW_DEBUG_ROUTES === 'true'.
 * It names the trip and skips the demo cap, so repeated local test runs
 * don't lock the pool accounts out for the day. In production it's ignored.
 */
import type { ActionTools } from 'deepspace/worker'
import type { Env } from '../../worker'
import { mayCreateDemoTrip, usageDay, usageKeys } from '../lib/caps'
import {
  DEMO_GHOSTS,
  DEMO_ORGANIZER_HOMES,
  DEMO_TRIP_NAME,
  DEMO_VIBE,
  demoDates,
  demoDestinations,
} from '../lib/demo'
import { INPUT_LIMITS, LIMITS } from '../lib/limits'
import { GHOST_PREFIX, type TravelerData, type TripData } from '../lib/types'
import { text } from '../lib/validate'
import { isTestTrip } from '../server/test-seam'
import { defineAction, fail, isDuplicate, loadTrip, must, ok } from '../server/trip-access'
import { getUsageCount, incrementUsage } from '../server/usage'
import { beginFullSearch } from './search'
import { callerDisplayName, newInviteCode, newTravelerRow } from './trips'

export const DEMO_CAP_MESSAGE = `You can create up to ${LIMITS.maxDemoTripsPerUserPerDay} demo trips per day. Try again tomorrow, or open one you already have.`

export const createDemoTrip = defineAction<Env>('createDemoTrip', async ({ userId, params, tools, env }) => {
  const now = new Date()
  const day = usageDay(now)

  // Anything else in params (an `isDemo`, a name, dates) is ignored: the server decides.
  let name = DEMO_TRIP_NAME
  const exempt = isTestTrip(env, params.testName)
  if (exempt) {
    const n = text(params.testName, 'Trip name', { max: INPUT_LIMITS.tripNameMax })
    if (!n.ok) return fail('invalid_params', n.error)
    name = n.value
  }

  const capKey = usageKeys.demoTripsUser(userId)
  if (!exempt && !mayCreateDemoTrip(await getUsageCount(tools, day, capKey))) {
    return fail('cap_reached', DEMO_CAP_MESSAGE)
  }

  const displayName = await callerDisplayName(tools, userId)
  const memberIds = [userId]
  const dates = demoDates(day)

  // uniqueOn ['inviteCode'] refuses a collision; try a fresh code a few times.
  let tripId: string | null = null
  let inviteCode = ''
  for (let attempt = 0; attempt < 3 && !tripId; attempt++) {
    inviteCode = newInviteCode()
    const trip: TripData = {
      name,
      organizerId: userId,
      memberIds,
      inviteCode,
      status: 'gathering',
      outboundDate: dates.outboundDate,
      returnDate: dates.returnDate,
      vibe: DEMO_VIBE,
      lockedIata: null,
      // The cron never watches demo trips; "Check fares now" still works.
      watchEnabled: 0,
      lastSearchAt: null,
      searchJobId: null,
      searchProgress: null,
      searchMessage: null,
      searchError: null,
      isDemo: 1,
    }
    const res = await tools.create('trips', { ...trip })
    if (res.success) tripId = res.data.recordId
    else if (!isDuplicate(res)) must(res, 'create demo trip')
  }
  if (!tripId) return fail('conflict', 'Could not create the demo trip. Please try again.')

  try {
    await fillDemoTrip(tools, tripId, memberIds, userId, displayName)
  } catch (err) {
    // Don't leave half a demo behind; defineAction logs and answers server_error.
    await removeDemoTrip(tools, tripId)
    throw err
  }
  if (!exempt) await incrementUsage(tools, day, capKey)

  // The normal pipeline. If it can't start, the trip is still usable: "Find fares" retries it.
  const access = await loadTrip(tools, tripId)
  const search = access.ok ? await beginFullSearch(tools, env, access.trip, userId, now) : null
  return ok({ tripId, inviteCode, searchStarted: Boolean(search?.success) })
})

async function fillDemoTrip(
  tools: ActionTools,
  tripId: string,
  memberIds: string[],
  userId: string,
  displayName: string,
): Promise<void> {
  must(
    await tools.create('travelers', {
      ...newTravelerRow(tripId, memberIds, userId, displayName),
      homeAirports: [...DEMO_ORGANIZER_HOMES],
    }),
    'create demo organizer',
  )
  for (const ghost of DEMO_GHOSTS) {
    const row: TravelerData = {
      tripId,
      memberIds,
      userId: `${GHOST_PREFIX}${crypto.randomUUID()}`,
      isGhost: 1,
      displayName: ghost.displayName,
      homeAirports: [...ghost.homeAirports],
      maxStops: 2,
      noRedeye: 0,
      earliestDepartHour: 0,
      hasBudget: 0,
      booked: 0,
    }
    must(await tools.create('travelers', { ...row }), 'create demo ghost')
  }
  for (const d of demoDestinations()) {
    must(
      await tools.create('candidates', {
        tripId,
        memberIds,
        iata: d.iata,
        city: d.city,
        country: d.country,
        why: d.why,
        source: 'manual',
        addedBy: userId,
        complete: 0,
      }),
      'create demo destination',
    )
  }
}

async function removeDemoTrip(tools: ActionTools, tripId: string): Promise<void> {
  try {
    await tools.deleteWhere('travelers', { tripId }, 20)
    await tools.deleteWhere('candidates', { tripId }, 20)
    await tools.remove('trips', tripId)
  } catch (err) {
    console.error(`[action] createDemoTrip cleanup failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}
