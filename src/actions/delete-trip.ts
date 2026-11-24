/**
 * deleteTrip: the organizer removes a trip and every row that belongs to it
 * (SPEC §6). RBAC is off, so the organizer check below is the only check.
 *
 * Order matters: the trip-scoped rows go first and the trip row last. If a
 * delete fails part-way, the trip is still there and the organizer can press
 * Delete again; nothing is left orphaned and unreachable. Deleting the rows
 * (rather than dropping members) also means nobody keeps read access through
 * `createdBy` (SPEC §5 known limitation), which is why delete is safe to ship
 * while leave-trip is not.
 *
 * Kept on purpose: `usage` (the spend ledger, so deleting can't reset a cap)
 * and `fareCache` (keyed by route, not trip; expires after 6 h).
 *
 * Refused while a fare search or a "Check fares now" run is in flight: the
 * job would write fares and snapshots for a trip that no longer exists.
 */
import type { Env } from '../../worker'
import { isWatchPending } from '../lib/watch'
import { recordId } from '../lib/validate'
import { defineAction, fail, must, ok, requireOrganizer } from '../server/trip-access'
import { searchIsStale } from './search'

/** Every collection with a `tripId` column, children before parents. */
export const TRIP_COLLECTIONS = ['votes', 'fares', 'fareSnapshots', 'candidates', 'budgets', 'emailLog', 'travelers'] as const

const PAGE = 100

export const deleteTrip = defineAction<Env>('deleteTrip', async ({ userId, params, tools }) => {
  const tripId = recordId(params.tripId, 'Trip')
  if (!tripId.ok) return fail('invalid_params', tripId.error)
  const access = await requireOrganizer(tools, tripId.value, userId)
  if (!access.ok) return access.result
  const trip = access.trip

  const now = new Date()
  if (trip.data.status === 'searching' && !searchIsStale(trip, now)) {
    return fail('search_running', 'Fares are being checked right now. You can delete the trip when the search finishes.')
  }
  if (isWatchPending(trip.data.watchQueuedAt, now)) {
    return fail('watch_running', 'Fares are being re-checked right now. Try again in a minute.')
  }

  let deleted = 0
  for (const collection of TRIP_COLLECTIONS) {
    // deleteWhere removes at most one page per call; repeat until a short page.
    for (;;) {
      const page = must(await tools.deleteWhere(collection, { tripId: tripId.value }, PAGE), `delete ${collection}`)
      deleted += page.deleted
      if (page.deleted < PAGE) break
    }
  }
  must(await tools.remove('trips', tripId.value), 'delete trip')
  return ok({ tripId: tripId.value, deleted })
})
