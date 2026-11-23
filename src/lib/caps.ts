/**
 * Spend-cap decisions (SPEC §8.3). Pure: callers read the `usage` ledger,
 * pass the counts in, and act on the decision. Nothing here talks to storage.
 */
import { LIMITS, type Limits } from './limits'

export type SearchMode = 'full' | 'watch'

export type CapCode =
  | 'trip_full_search_cap'
  | 'trip_watch_cap'
  | 'user_trip_cap'
  | 'global_daily_cap'

/** Counts for "today" (see `usageDay`), read from the `usage` collection. */
export interface UsageCounts {
  /** SerpApi calls made today across the whole app. */
  globalSerpapiCallsToday: number
  /** Full searches already started for this trip today. */
  tripFullSearchesToday: number
  /** Watch checks already run for this trip today. */
  tripWatchChecksToday: number
  /** Distinct trips this user has started searching today. */
  userTripsSearchedToday: number
  /** True when this trip is already one of those distinct trips. */
  userAlreadySearchedThisTripToday: boolean
}

export type RunDecision =
  | { ok: true; maxCalls: number }
  | { ok: false; code: CapCode; message: string }

/**
 * May a run start, and how many SerpApi calls may it make?
 * `maxCalls` = min(per-run cap, calls left in today's global budget).
 */
export function decideRunStart(
  mode: SearchMode,
  counts: UsageCounts,
  limits: Limits = LIMITS,
): RunDecision {
  if (mode === 'full') {
    if (counts.tripFullSearchesToday >= limits.maxFullSearchesPerTripPerDay) {
      return {
        ok: false,
        code: 'trip_full_search_cap',
        message: `This trip already ran ${limits.maxFullSearchesPerTripPerDay} fare searches today. Try again tomorrow.`,
      }
    }
    if (
      !counts.userAlreadySearchedThisTripToday &&
      counts.userTripsSearchedToday >= limits.maxTripsSearchedPerUserPerDay
    ) {
      return {
        ok: false,
        code: 'user_trip_cap',
        message: `You can search fares for up to ${limits.maxTripsSearchedPerUserPerDay} trips per day.`,
      }
    }
  } else if (counts.tripWatchChecksToday >= limits.maxWatchChecksPerTripPerDay) {
    return {
      ok: false,
      code: 'trip_watch_cap',
      message: `Fares for this trip were already checked ${limits.maxWatchChecksPerTripPerDay} times today.`,
    }
  }

  const globalLeft = limits.maxSerpapiCallsPerDayGlobal - counts.globalSerpapiCallsToday
  if (globalLeft <= 0) {
    return {
      ok: false,
      code: 'global_daily_cap',
      message: 'Halfway has reached its daily fare-check limit. Try again tomorrow.',
    }
  }
  return { ok: true, maxCalls: Math.min(limits.maxCallsPerRun, globalLeft) }
}

/**
 * Split the calls a run needs into the ones it may make and the ones it must
 * skip. Order is preserved, so callers put the most important calls first.
 */
export function planCalls<T>(needed: readonly T[], maxCalls: number): { run: T[]; skipped: T[] } {
  const n = Math.max(0, Math.floor(maxCalls))
  return { run: needed.slice(0, n), skipped: needed.slice(n) }
}

/** Guard before each individual call inside a run (the global budget can move mid-run). */
export function mayMakeCall(
  callsMadeThisRun: number,
  maxCallsThisRun: number,
  globalCallsToday: number,
  limits: Limits = LIMITS,
): boolean {
  return (
    callsMadeThisRun < Math.min(maxCallsThisRun, limits.maxCallsPerRun) &&
    globalCallsToday < limits.maxSerpapiCallsPerDayGlobal
  )
}

/** May this user create another trip today? */
export function mayCreateTrip(userTripsCreatedToday: number, limits: Limits = LIMITS): boolean {
  return userTripsCreatedToday < limits.maxTripsCreatedPerUserPerDay
}

/** May this user create another demo trip today? (Demo trips spend nothing; this is an abuse cap.) */
export function mayCreateDemoTrip(userDemoTripsToday: number, limits: Limits = LIMITS): boolean {
  return userDemoTripsToday < limits.maxDemoTripsPerUserPerDay
}

/** May another AI suggestion call be made for this user today? */
export function mayCallAi(userAiCallsToday: number, limits: Limits = LIMITS): boolean {
  return userAiCallsToday < limits.maxAiCallsPerUserPerDay
}

/**
 * How many of `wanted` emails may be sent now, given today's per-trip and
 * global email counts.
 */
export function emailsAllowed(
  wanted: number,
  tripEmailsToday: number,
  globalEmailsToday: number,
  limits: Limits = LIMITS,
): number {
  const left = Math.min(
    limits.maxEmailsPerTripPerDay - tripEmailsToday,
    limits.maxEmailsPerDayGlobal - globalEmailsToday,
  )
  return Math.max(0, Math.min(wanted, left))
}

/**
 * Does a finished run give back the daily search it was counted against?
 * Only when it ended because the provider was unavailable AND it made no
 * successful real call and no failed call that may have been billed: the
 * platform released billing for the provider failure, so the run cost
 * nothing. Partial outages (some fares fetched) still count.
 */
export function refundsDailyCount(run: {
  providerUnavailable: boolean
  /** Real SerpApi calls that returned flights. */
  liveSuccesses: number
  /** Real SerpApi calls that failed with something other than provider_unavailable (counted as billed). */
  billedErrors: number
}): boolean {
  return run.providerUnavailable && run.liveSuccesses === 0 && run.billedErrors === 0
}

/** The ledger's day bucket: the UTC calendar date, `YYYY-MM-DD`. */
export function usageDay(now: Date): string {
  return now.toISOString().slice(0, 10)
}

/** `usage` ledger keys, so every caller spells them the same way. */
export const usageKeys = {
  serpapiGlobal: () => 'serpapi:global',
  serpapiTrip: (tripId: string) => `serpapi:trip:${tripId}`,
  fullSearchTrip: (tripId: string) => `search:full:trip:${tripId}`,
  watchTrip: (tripId: string) => `search:watch:trip:${tripId}`,
  /** Set by the daily cron once it has enqueued a watch for this trip today. */
  watchCronTrip: (tripId: string) => `watch:cron:trip:${tripId}`,
  userTripsSearched: (userId: string) => `search:user:${userId}`,
  userSearchedTrip: (userId: string, tripId: string) => `search:user:${userId}:trip:${tripId}`,
  aiUser: (userId: string) => `ai:user:${userId}`,
  emailTrip: (tripId: string) => `email:trip:${tripId}`,
  emailGlobal: () => 'email:global',
  tripsCreatedUser: (userId: string) => `trips:created:user:${userId}`,
  demoTripsUser: (userId: string) => `demo:created:user:${userId}`,
}

/** The `usage` row id for a (day, key) pair — upserted with `tools.create(..., recordId)`. */
export function usageRecordId(day: string, key: string): string {
  return `${day}|${key}`
}
