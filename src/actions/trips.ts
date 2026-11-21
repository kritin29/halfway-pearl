/**
 * Trip actions (SPEC §6): createTrip, joinTrip.
 * RBAC is off inside actions; every check below is the only check.
 */
import type { ActionTools } from 'deepspace/worker'
import type { Env } from '../../worker'
import { mayCreateTrip, usageDay, usageKeys } from '../lib/caps'
import { INPUT_LIMITS, LIMITS } from '../lib/limits'
import type { TravelerData, TripData } from '../lib/types'
import { inviteCode as validInviteCode, recordId, text, tripDates } from '../lib/validate'
import { isTestTrip } from '../server/test-seam'
import { defineAction, fail, isDuplicate, must, ok, parseIdList, requireOrganizer } from '../server/trip-access'
import { queryTravelers, syncTripMembers } from '../server/trip-rows'
import { getUsageCount, incrementUsage } from '../server/usage'

const ALPHANUMERIC = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/** Random alphanumeric invite code (rejection sampling, so every character is equally likely). */
export function newInviteCode(length: number = INPUT_LIMITS.inviteCodeLength): string {
  let code = ''
  const limit = 256 - (256 % ALPHANUMERIC.length) // 248
  while (code.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (byte < limit && code.length < length) code += ALPHANUMERIC[byte % ALPHANUMERIC.length]
    }
  }
  return code
}

/**
 * The caller's display name, copied from their own `users` row (SPEC §5
 * users). Only the name, never email or the raw row. Falls back to
 * "Traveler" when the user has no row yet (e.g. never opened the app).
 */
export async function callerDisplayName(tools: ActionTools, userId: string): Promise<string> {
  const res = await tools.get('users', userId)
  const name = res.success ? res.data.record.data.name : undefined
  const cleaned = text(name, 'Name', { max: INPUT_LIMITS.displayNameMax })
  return cleaned.ok ? cleaned.value : 'Traveler'
}

/** Oldest row first (ties by id), so concurrent joiners agree on who got the last seat. */
export function seatOrder<T extends { recordId: string; createdAt: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) =>
    a.createdAt === b.createdAt ? a.recordId.localeCompare(b.recordId) : a.createdAt.localeCompare(b.createdAt),
  )
}

/** A real traveler's starting row: no airports yet, permissive constraints. */
function newTravelerRow(tripId: string, memberIds: string[], userId: string, displayName: string): TravelerData {
  return {
    tripId,
    memberIds,
    userId,
    isGhost: 0,
    displayName,
    homeAirports: [],
    maxStops: 2,
    noRedeye: 0,
    earliestDepartHour: 0,
    hasBudget: 0,
    booked: 0,
  }
}

const TRIP_FULL = `This trip already has ${LIMITS.maxTravelers} travelers.`
const TRIP_LOCKED = 'This trip is locked: the destination is chosen and nobody new can join.'

export const createTrip = defineAction<Env>('createTrip', async ({ userId, params, tools, env }) => {
  const name = text(params.name, 'Trip name', { max: INPUT_LIMITS.tripNameMax })
  if (!name.ok) return fail('invalid_params', name.error)
  const vibe = text(params.vibe, 'Vibe', { max: INPUT_LIMITS.vibeMax, optional: true })
  if (!vibe.ok) return fail('invalid_params', vibe.error)
  const dates = tripDates(params.outboundDate, params.returnDate, usageDay(new Date()))
  if (!dates.ok) return fail('invalid_params', dates.error)

  // Abuse cap: N trips per user per UTC day (usage ledger, fails closed).
  // Test trips in a dev/test env are exempt (src/server/test-seam.ts), so
  // repeated local test runs don't lock the pool accounts out for the day.
  const day = usageDay(new Date())
  const capKey = usageKeys.tripsCreatedUser(userId)
  const exempt = isTestTrip(env, name.value)
  if (!exempt && !mayCreateTrip(await getUsageCount(tools, day, capKey))) {
    return fail(
      'cap_reached',
      `You can create up to ${LIMITS.maxTripsCreatedPerUserPerDay} trips per day. Try again tomorrow.`,
    )
  }

  const displayName = await callerDisplayName(tools, userId)
  const memberIds = [userId]

  // uniqueOn ['inviteCode'] refuses a collision; try a fresh code a few times.
  let tripId: string | null = null
  let inviteCode = ''
  for (let attempt = 0; attempt < 3 && !tripId; attempt++) {
    inviteCode = newInviteCode()
    const trip: TripData = {
      name: name.value,
      organizerId: userId, // userBound: the room stamps the caller regardless
      memberIds,
      inviteCode,
      status: 'gathering',
      outboundDate: dates.value.outboundDate,
      returnDate: dates.value.returnDate,
      vibe: vibe.value,
      lockedIata: null,
      watchEnabled: 1,
      lastSearchAt: null,
      searchJobId: null,
      searchProgress: null,
      searchMessage: null,
      searchError: null,
    }
    const res = await tools.create('trips', { ...trip })
    if (res.success) tripId = res.data.recordId
    else if (!isDuplicate(res)) must(res, 'create trip')
  }
  if (!tripId) return fail('conflict', 'Could not create the trip. Please try again.')

  const traveler = await tools.create('travelers', { ...newTravelerRow(tripId, memberIds, userId, displayName) })
  if (!traveler.success) {
    // Don't leave a trip with no traveler row behind.
    await tools.remove('trips', tripId)
    must(traveler, 'create organizer traveler')
  }
  if (!exempt) await incrementUsage(tools, day, capKey)
  return ok({ tripId, inviteCode })
})

export const joinTrip = defineAction<Env>('joinTrip', async ({ userId, params, tools }) => {
  const code = validInviteCode(params.inviteCode)
  if (!code.ok) return fail('invalid_params', code.error)

  const found = must(
    await tools.query('trips', { where: { inviteCode: code.value }, limit: 1 }),
    'find trip by invite code',
  ).records[0]
  if (!found) return fail('not_found', 'No trip matches that invite code.')
  const tripId = found.recordId
  const organizerId = String(found.data.organizerId)

  const travelers = await queryTravelers(tools, tripId)
  const alreadyTraveler = travelers.some((t) => t.data.userId === userId)

  if (!alreadyTraveler) {
    // Existing travelers of a locked trip still get `alreadyMember`; only newcomers are refused.
    if (found.data.status === 'locked') return fail('trip_locked', TRIP_LOCKED)
    if (travelers.length >= LIMITS.maxTravelers) return fail('trip_full', TRIP_FULL)
    const displayName = await callerDisplayName(tools, userId)
    const memberIds = [...new Set([...parseIdList(found.data.memberIds), userId])]
    const res = await tools.create('travelers', { ...newTravelerRow(tripId, memberIds, userId, displayName) })
    // A duplicate means a concurrent join by the same user won the race: carry on.
    if (!res.success && !isDuplicate(res)) must(res, 'create traveler')

    if (res.success) {
      // Two different people taking the last seat at once: the later row backs out.
      const after = await queryTravelers(tools, tripId)
      if (after.length > LIMITS.maxTravelers) {
        const rank = seatOrder(after).findIndex((t) => t.recordId === res.data.recordId)
        if (rank >= LIMITS.maxTravelers) {
          must(await tools.remove('travelers', res.data.recordId), 'undo traveler')
          return fail('trip_full', TRIP_FULL)
        }
      }
    }
  }

  // Idempotent: also repairs memberIds if an earlier join stopped half-way.
  await syncTripMembers(tools, tripId, organizerId)
  return ok({ tripId, alreadyMember: alreadyTraveler })
})

/**
 * What the invite page shows before joining (SPEC §10 /join/:code). A
 * non-member can't read the trip row, so this returns only what the invite
 * code's holder needs to decide: name, dates, how full, whether it's locked.
 * The trip id is returned only to someone who is already on the trip.
 */
export const previewInvite = defineAction<Env>('previewInvite', async ({ userId, params, tools }) => {
  const code = validInviteCode(params.inviteCode)
  if (!code.ok) return fail('invalid_params', code.error)
  const found = must(
    await tools.query('trips', { where: { inviteCode: code.value }, limit: 1 }),
    'find trip by invite code',
  ).records[0]
  if (!found) return fail('not_found', 'No trip matches that invite code.')

  const travelers = await queryTravelers(tools, found.recordId)
  const alreadyMember = travelers.some((t) => t.data.userId === userId)
  return ok({
    name: String(found.data.name ?? ''),
    outboundDate: String(found.data.outboundDate ?? ''),
    returnDate: String(found.data.returnDate ?? ''),
    travelerCount: travelers.length,
    maxTravelers: LIMITS.maxTravelers,
    locked: found.data.status === 'locked',
    full: travelers.length >= LIMITS.maxTravelers,
    alreadyMember,
    tripId: alreadyMember ? found.recordId : null,
  })
})

/**
 * TEST ONLY: lock a `__test-` trip so e2e can cover the trip_locked path
 * before the real `lockTrip` (which also sends emails) exists. Refused unless
 * ALLOW_DEBUG_ROUTES === 'true' and the trip name starts with `__test-`
 * (src/server/test-seam.ts); organizer only.
 */
export const testLockTrip = defineAction<Env>('__testLockTrip', async ({ userId, params, tools, env }) => {
  if (env.ALLOW_DEBUG_ROUTES !== 'true') return fail('not_found', 'Not available.')
  const tripId = recordId(params.tripId, 'Trip')
  if (!tripId.ok) return fail('invalid_params', tripId.error)
  const access = await requireOrganizer(tools, tripId.value, userId)
  if (!access.ok) return access.result
  if (!isTestTrip(env, access.trip.data.name)) return fail('not_found', 'Not available.')
  must(await tools.update('trips', tripId.value, { status: 'locked' }), 'lock test trip')
  return ok({ tripId: tripId.value })
})
