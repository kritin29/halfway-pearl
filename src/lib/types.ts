/**
 * Row data shapes shared by the worker and the client (SPEC §5).
 * 0/1 flags are numbers; dates are ISO `YYYY-MM-DD` text; json columns arrive parsed.
 */

export const TRIP_STATUSES = ['gathering', 'searching', 'results', 'locked'] as const
export type TripStatus = (typeof TRIP_STATUSES)[number]

export interface TripData {
  name: string
  organizerId: string
  memberIds: string[]
  inviteCode: string
  status: TripStatus
  outboundDate: string
  returnDate: string
  vibe: string
  lockedIata: string | null
  watchEnabled: number
  lastSearchAt: string | null
  searchJobId: string | null
  searchProgress: number | null
  searchMessage: string | null
  searchError: string | null
}

export interface TravelerData {
  tripId: string
  memberIds: string[]
  userId: string
  isGhost: number
  displayName: string
  homeAirports: string[]
  maxStops: number
  noRedeye: number
  earliestDepartHour: number
  hasBudget: number
  booked: number
}

export interface BudgetData {
  tripId: string
  userId: string
  maxUsd: number
}

/** Ghost traveler ids are `ghost:<uuid>` and are never in `memberIds`. */
export const GHOST_PREFIX = 'ghost:'

export function isGhostId(id: string): boolean {
  return id.startsWith(GHOST_PREFIX)
}
