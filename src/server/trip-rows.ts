/**
 * Keeping `memberIds` right on every trip-scoped row (SPEC §5, §6 joinTrip).
 *
 * Source of truth: the trip's real (non-ghost) traveler rows plus the
 * organizer. Traveler rows are protected by `uniqueOn ['tripId','userId']`,
 * so each insert is atomic; `memberIds` on the trip and every other row is
 * derived from them. Two people joining at once can interleave their
 * read-modify-write of `memberIds`, so `syncTripMembers` re-reads after
 * writing and repeats until the trip row matches the traveler rows. Whoever
 * writes last also verifies last, so the final state includes everyone.
 */
import type { ActionTools } from 'deepspace/worker'
import { isGhostId } from '../lib/types'
import { must, parseIdList } from './trip-access'

/** Collections that carry `tripId` + `memberIds` (the trip row itself is handled separately). */
export const TRIP_SCOPED_COLLECTIONS = [
  'travelers',
  'candidates',
  'fares',
  'votes',
  'fareSnapshots',
] as const

/** Organizer first, then real travelers in row order; ghosts never; no duplicates. */
export function memberIdsFromTravelers(
  organizerId: string,
  travelers: ReadonlyArray<{ userId?: unknown }>,
): string[] {
  const ids = [organizerId]
  for (const t of travelers) {
    if (typeof t.userId !== 'string' || !t.userId || isGhostId(t.userId)) continue
    if (!ids.includes(t.userId)) ids.push(t.userId)
  }
  return ids
}

/** Same members, ignoring order. */
export function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((id) => set.has(id))
}

/**
 * Write `memberIds` onto the trip and every trip-scoped row whose value
 * differs. Returns how many rows were written. Throws on storage errors.
 */
export async function propagateMemberIds(
  tools: ActionTools,
  tripId: string,
  memberIds: readonly string[],
): Promise<number> {
  let written = 0
  const trip = must(await tools.get('trips', tripId), 'load trip')
  if (!sameIds(parseIdList(trip.record.data.memberIds), memberIds)) {
    must(await tools.update('trips', tripId, { memberIds: [...memberIds] }), 'update trip members')
    written++
  }
  for (const collection of TRIP_SCOPED_COLLECTIONS) {
    // No limit: server queries are unbounded, and a partial update would leave rows hidden.
    const { records } = must(await tools.query(collection, { where: { tripId } }), `query ${collection}`)
    for (const row of records) {
      if (sameIds(parseIdList(row.data.memberIds), memberIds)) continue
      must(
        await tools.update(collection, row.recordId, { memberIds: [...memberIds] }),
        `update ${collection} members`,
      )
      written++
    }
  }
  return written
}

/** Real travelers' rows for a trip (query helper shared by actions). */
export async function queryTravelers(tools: ActionTools, tripId: string) {
  return must(await tools.query('travelers', { where: { tripId } }), 'query travelers').records
}

/**
 * Recompute `memberIds` from the traveler rows and propagate it, re-checking
 * up to `maxRounds` times so concurrent joins converge. Returns the final list.
 */
export async function syncTripMembers(
  tools: ActionTools,
  tripId: string,
  organizerId: string,
  maxRounds = 3,
): Promise<string[]> {
  let memberIds: string[] = []
  for (let round = 0; round < maxRounds; round++) {
    const travelers = await queryTravelers(tools, tripId)
    memberIds = memberIdsFromTravelers(
      organizerId,
      travelers.map((t) => t.data),
    )
    const written = await propagateMemberIds(tools, tripId, memberIds)
    if (written === 0) return memberIds
  }
  return memberIds
}
