/**
 * Authorization helpers for server actions (SPEC §6). Actions run with RBAC
 * OFF, so each one loads the trip itself and checks the caller against it:
 *
 *   const access = await requireMember(tools, tripId, userId)
 *   if (!access.ok) return access.result
 *
 * A missing trip and a trip the caller isn't in give the same `not_found`
 * answer, so trip ids can't be probed.
 */
import type { ActionHandler, ActionResult, ActionTools } from 'deepspace/worker'
import { RECORD_NOT_FOUND } from 'deepspace/worker'
import { parseIdList, type TripData } from '../lib/types'
import { asParams } from '../lib/validate'

export type ErrorCode =
  | 'invalid_params'
  | 'not_found'
  | 'forbidden'
  | 'trip_full'
  | 'trip_locked'
  | 'cap_reached'
  | 'conflict'
  | 'server_error'
  // Destinations (src/actions/candidates.ts)
  | 'candidates_full'
  | 'duplicate'
  | 'search_running'
  | 'needs_airports'
  | 'provider_unavailable'
  | 'ai_error'
  // Fare search and votes (src/actions/search.ts, src/actions/votes.ts)
  | 'needs_candidates'
  | 'enqueue_failed'

export type Failure = { success: false; error: string; code: ErrorCode }

export function ok<T>(data: T): ActionResult<T> {
  return { success: true, data }
}

export function fail(code: ErrorCode, error: string): Failure {
  return { success: false, error, code }
}

export const NOT_FOUND_TRIP = (): Failure => fail('not_found', 'Trip not found.')

/** Thrown inside an action when a storage call fails unexpectedly; `defineAction` turns it into `server_error`. */
export class ToolError extends Error {}

/** Unwrap a tools result or throw `ToolError` (message is logged, never returned to the client). */
export function must<T>(result: ActionResult<T>, what: string): T {
  if (!result.success) throw new ToolError(`${what}: ${result.error}`)
  return result.data
}

export function isNotFound(result: ActionResult<unknown>): boolean {
  return !result.success && result.error.startsWith(RECORD_NOT_FOUND)
}

export function isDuplicate(result: ActionResult<unknown>): boolean {
  return !result.success && result.error.startsWith('Duplicate:')
}

export { parseIdList }

export interface Trip {
  id: string
  data: TripData
  createdBy: string
  /** Last write to the trip row (ISO). Used to spot a search that died mid-run. */
  updatedAt: string
}

export type Access = { ok: true; trip: Trip } | { ok: false; result: Failure }

/** Load a trip by id. Missing → `not_found`; any other storage error throws. */
export async function loadTrip(tools: ActionTools, tripId: string): Promise<Access> {
  const res = await tools.get<Record<string, unknown>>('trips', tripId)
  if (isNotFound(res)) return { ok: false, result: NOT_FOUND_TRIP() }
  const { record } = must(res, 'load trip')
  const data = record.data as unknown as TripData
  return {
    ok: true,
    trip: {
      id: record.recordId,
      createdBy: record.createdBy,
      updatedAt: record.updatedAt,
      data: { ...data, memberIds: parseIdList(record.data.memberIds) },
    },
  }
}

export function isMember(trip: Trip, userId: string): boolean {
  return trip.data.memberIds.includes(userId)
}

export function isOrganizer(trip: Trip, userId: string): boolean {
  return trip.data.organizerId === userId
}

/** The caller must be in `memberIds`. Non-members get the same answer as a missing trip. */
export async function requireMember(tools: ActionTools, tripId: string, userId: string): Promise<Access> {
  const access = await loadTrip(tools, tripId)
  if (!access.ok) return access
  if (!isMember(access.trip, userId)) return { ok: false, result: NOT_FOUND_TRIP() }
  return access
}

/** The caller must be a member and the trip's organizer. */
export async function requireOrganizer(tools: ActionTools, tripId: string, userId: string): Promise<Access> {
  const access = await requireMember(tools, tripId, userId)
  if (!access.ok) return access
  if (!isOrganizer(access.trip, userId)) {
    return { ok: false, result: fail('forbidden', 'Only the trip organizer can do that.') }
  }
  return access
}

/**
 * Wrap an action: params must be a plain object, and any thrown error becomes
 * a generic `server_error` (details go to the log with the action name only,
 * never params, which may carry user input).
 */
export function defineAction<TEnv>(
  name: string,
  handler: (ctx: Parameters<ActionHandler<TEnv>>[0] & { params: Record<string, unknown> }) => Promise<ActionResult>,
): ActionHandler<TEnv> {
  return async (ctx) => {
    const params = asParams(ctx.params)
    if (!params) return fail('invalid_params', 'Expected an object of parameters.')
    try {
      return await handler({ ...ctx, params })
    } catch (err) {
      console.error(`[action] ${name} failed: ${err instanceof Error ? err.message : String(err)}`)
      return fail('server_error', 'Something went wrong. Please try again.')
    }
  }
}
