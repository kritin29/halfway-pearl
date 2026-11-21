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
  /** Set while a watch run is queued or running (ISO datetime), else null. */
  watchQueuedAt?: string | null
  /** Why the last watch run couldn't check everything; null when it did. */
  watchError?: string | null
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

export interface FareSnapshotData {
  tripId: string
  memberIds: string[]
  candidateIata: string
  /** Null when the candidate wasn't complete at that check. */
  groupTotal: number | null
  maxFare: number | null
  checkedAt: string
}

export interface VoteData {
  tripId: string
  memberIds: string[]
  userId: string
  candidateIata: string
}

export interface BudgetData {
  tripId: string
  userId: string
  maxUsd: number
}

export const CANDIDATE_SOURCES = ['ai', 'midpoint', 'manual'] as const
export type CandidateSource = (typeof CANDIDATE_SOURCES)[number]

export interface CandidateData {
  tripId: string
  memberIds: string[]
  iata: string
  city: string
  country: string
  why: string
  source: CandidateSource
  addedBy: string
  // Aggregates written by the fare-search job (Phase 5); null until then.
  complete: number
  groupTotal: number | null
  maxFare: number | null
  minFare: number | null
  arrivalSpreadMin: number | null
  fitsAll: number | null
  missingFor: string[] | null
  lastCheckedAt: string | null
}

/** Ghost traveler ids are `ghost:<uuid>` and are never in `memberIds`. */
export const GHOST_PREFIX = 'ghost:'

export function isGhostId(id: string): boolean {
  return id.startsWith(GHOST_PREFIX)
}

/** json columns arrive parsed, but accept a JSON string too (the runtime does). Strings only. */
export function parseIdList(raw: unknown): string[] {
  let value = raw
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return []
    }
  }
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}
