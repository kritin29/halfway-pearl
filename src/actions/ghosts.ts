/**
 * Ghost travelers (SPEC §3.2, §6): people who won't use the app, added by the
 * organizer. Ids are `ghost:<uuid>`, never in `memberIds`, no private budget.
 * Clients can't create or edit these rows (travelers `create: false`, and
 * `update: 'own'` never matches a ghost id), so only these actions touch them.
 */
import type { Env } from '../../worker'
import { INPUT_LIMITS, LIMITS } from '../lib/limits'
import { GHOST_PREFIX, type TravelerData } from '../lib/types'
import {
  departHour,
  flag,
  ghostId as validGhostId,
  homeAirports,
  maxStops,
  recordId,
  text,
  type Valid,
} from '../lib/validate'
import { defineAction, fail, must, ok, requireOrganizer } from '../server/trip-access'
import { queryTravelers } from '../server/trip-rows'
import { seatOrder } from './trips'

const TRIP_FULL = `This trip already has ${LIMITS.maxTravelers} travelers.`

/** Optional constraint params: absent → `fallback` (or left out of an update when fallback is undefined). */
function optional<T>(
  value: unknown,
  check: (v: unknown) => Valid<T>,
  fallback?: T,
): Valid<T | undefined> {
  if (value === undefined) return { ok: true, value: fallback }
  return check(value)
}

type GhostFields = Pick<
  TravelerData,
  'displayName' | 'homeAirports' | 'maxStops' | 'noRedeye' | 'earliestDepartHour' | 'booked'
>

/**
 * Validate the ghost fields in `params`. `creating` requires a name and
 * airports and fills defaults; otherwise only the fields present are returned.
 */
function ghostFields(
  params: Record<string, unknown>,
  creating: boolean,
): { ok: true; value: Partial<GhostFields> } | { ok: false; error: string } {
  const checks: { [K in keyof GhostFields]: Valid<GhostFields[K] | undefined> } = {
    displayName:
      creating || params.displayName !== undefined
        ? text(params.displayName, 'Name', { max: INPUT_LIMITS.displayNameMax })
        : { ok: true, value: undefined },
    homeAirports:
      creating || params.homeAirports !== undefined
        ? homeAirports(params.homeAirports)
        : { ok: true, value: undefined },
    maxStops: optional(params.maxStops, maxStops, creating ? 2 : undefined),
    noRedeye: optional(params.noRedeye, (v) => flag(v, 'No red-eyes'), creating ? 0 : undefined),
    earliestDepartHour: optional(params.earliestDepartHour, departHour, creating ? 0 : undefined),
    booked: optional(params.booked, (v) => flag(v, 'Booked'), creating ? 0 : undefined),
  }
  const value: Record<string, unknown> = {}
  for (const [field, check] of Object.entries(checks)) {
    if (!check.ok) return check
    if (check.value !== undefined) value[field] = check.value
  }
  return { ok: true, value: value as Partial<GhostFields> }
}

/** Find a ghost row by (tripId, ghostId). Scoping by the already-authorized tripId keeps other trips out of reach. */
async function findGhost(tools: Parameters<typeof queryTravelers>[0], tripId: string, ghostId: string) {
  const { records } = must(
    await tools.query('travelers', { where: { tripId, userId: ghostId }, limit: 1 }),
    'find ghost',
  )
  const row = records[0]
  return row && row.data.isGhost === 1 ? row : null
}

/**
 * The traveler list is frozen while a fare search runs: the job loaded it at
 * the start, so a ghost added or removed mid-run would be priced (or not)
 * against the wrong group. A locked trip takes no new travelers (same as
 * joinTrip).
 */
function rosterFrozen(status: string, adding: boolean) {
  if (status === 'searching') {
    return fail('search_running', 'Fares are being checked right now. Try again when the search finishes.')
  }
  if (adding && status === 'locked') return fail('trip_locked', 'This trip is locked, so nobody new can be added.')
  return null
}

export const addGhost = defineAction<Env>('addGhost', async ({ userId, params, tools }) => {
  const tripId = recordId(params.tripId, 'Trip')
  if (!tripId.ok) return fail('invalid_params', tripId.error)
  const access = await requireOrganizer(tools, tripId.value, userId)
  if (!access.ok) return access.result
  const blocked = rosterFrozen(access.trip.data.status, true)
  if (blocked) return blocked
  const fields = ghostFields(params, true)
  if (!fields.ok) return fail('invalid_params', fields.error)

  const travelers = await queryTravelers(tools, tripId.value)
  if (travelers.length >= LIMITS.maxTravelers) return fail('trip_full', TRIP_FULL)

  const ghostId = `${GHOST_PREFIX}${crypto.randomUUID()}`
  const row: TravelerData = {
    tripId: tripId.value,
    memberIds: access.trip.data.memberIds,
    userId: ghostId,
    isGhost: 1,
    hasBudget: 0,
    ...(fields.value as GhostFields),
  }
  const created = must(await tools.create('travelers', { ...row }), 'create ghost')

  // Same last-seat race guard as joinTrip.
  const after = await queryTravelers(tools, tripId.value)
  if (after.length > LIMITS.maxTravelers) {
    const rank = seatOrder(after).findIndex((t) => t.recordId === created.recordId)
    if (rank >= LIMITS.maxTravelers) {
      must(await tools.remove('travelers', created.recordId), 'undo ghost')
      return fail('trip_full', TRIP_FULL)
    }
  }
  return ok({ ghostId })
})

export const updateGhost = defineAction<Env>('updateGhost', async ({ userId, params, tools }) => {
  const tripId = recordId(params.tripId, 'Trip')
  if (!tripId.ok) return fail('invalid_params', tripId.error)
  const ghostId = validGhostId(params.ghostId)
  if (!ghostId.ok) return fail('invalid_params', ghostId.error)
  const access = await requireOrganizer(tools, tripId.value, userId)
  if (!access.ok) return access.result
  const fields = ghostFields(params, false)
  if (!fields.ok) return fail('invalid_params', fields.error)
  if (Object.keys(fields.value).length === 0) return fail('invalid_params', 'Nothing to update.')

  const ghost = await findGhost(tools, tripId.value, ghostId.value)
  if (!ghost) return fail('not_found', 'Traveler not found.')
  must(await tools.update('travelers', ghost.recordId, fields.value), 'update ghost')
  return ok({ ghostId: ghostId.value })
})

export const removeGhost = defineAction<Env>('removeGhost', async ({ userId, params, tools }) => {
  const tripId = recordId(params.tripId, 'Trip')
  if (!tripId.ok) return fail('invalid_params', tripId.error)
  const ghostId = validGhostId(params.ghostId)
  if (!ghostId.ok) return fail('invalid_params', ghostId.error)
  const access = await requireOrganizer(tools, tripId.value, userId)
  if (!access.ok) return access.result
  const blocked = rosterFrozen(access.trip.data.status, false)
  if (blocked) return blocked

  const ghost = await findGhost(tools, tripId.value, ghostId.value)
  if (!ghost) return fail('not_found', 'Traveler not found.')
  must(await tools.remove('travelers', ghost.recordId), 'remove ghost')
  // Their fares go too (≤ 6 candidates per trip, well under one batch).
  must(
    await tools.deleteWhere('fares', { tripId: tripId.value, travelerId: ghostId.value }, 100),
    'remove ghost fares',
  )
  return ok({ ghostId: ghostId.value })
})
