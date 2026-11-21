/**
 * Every spend cap and tunable number in one place (SPEC §8.3, §6, §11).
 * Costs come from `npx deepspace integrations info` (checked 2026-11-20).
 */

/** USD per `serpapi/flights` request. */
export const SERPAPI_COST_USD = 0.0325
/** USD per `email/send` request. */
export const EMAIL_COST_USD = 0.013

export const LIMITS = {
  /** Max SerpApi calls in one fare-search run (≤ $0.98). */
  maxCallsPerRun: 30,
  /** Max full searches per trip per day. */
  maxFullSearchesPerTripPerDay: 2,
  /**
   * Max watch checks per trip per day (cron + "Check fares now").
   * SPEC says watch uses "the same caps"; a separate small budget keeps one
   * organizer from draining the global cap by clicking repeatedly.
   */
  maxWatchChecksPerTripPerDay: 3,
  /** Max distinct trips one user may start searching per day. */
  maxTripsSearchedPerUserPerDay: 3,
  /** Global SerpApi calls per day across the app (≤ $2.60/day). */
  maxSerpapiCallsPerDayGlobal: 80,
  /** AI suggestion calls per user per day. */
  maxAiCallsPerUserPerDay: 5,
  /** Emails per trip per day ($0.013 each). */
  maxEmailsPerTripPerDay: 20,
  /** Emails per day across the app. */
  maxEmailsPerDayGlobal: 100,
  /** Reuse a fare fetched less than this long ago (full mode only). */
  fareCacheMs: 6 * 60 * 60 * 1000,
  /** Parallel SerpApi calls inside one run. */
  searchConcurrency: 4,
  /** Max candidate destinations per trip. */
  maxCandidates: 6,
  /** Max travelers per trip, ghosts included. */
  maxTravelers: 8,
  /** Max trips one cron run enqueues for watching. */
  maxWatchTripsPerCronRun: 10,
  /** A watch run re-checks at most this many destinations (top by votes, or the locked one). */
  watchShortlistSize: 3,
  /**
   * Watching stops once the outbound date is this many days away or fewer
   * (calendar days in WATCH_TIMEZONE). 1 = the cron and "Check fares now"
   * stop the day before departure.
   */
  watchStopsDaysBefore: 1,
  /** A queued "Check fares now" with no result after this long is treated as lost (its job died). */
  staleWatchMs: 20 * 60 * 1000,
  /** Max trips one user may create per day (UTC). Abuse cap; creating a trip costs nothing. */
  maxTripsCreatedPerUserPerDay: 10,
  /** At most one progress write to the trip row per this many ms while a search runs. */
  searchProgressThrottleMs: 1000,
  /**
   * A trip still 'searching' with no trip-row write for this long is treated
   * as stuck (e.g. the job's isolate died; JobRoom gives up after 16 min), so
   * the organizer may start again.
   */
  staleSearchMs: 20 * 60 * 1000,
} as const

/** Input validation limits for action params (SPEC §5, §6). */
export const INPUT_LIMITS = {
  /** trips.name */
  tripNameMax: 80,
  /** trips.vibe */
  vibeMax: 200,
  /** travelers.displayName */
  displayNameMax: 40,
  /** travelers.homeAirports: 1..3 codes */
  homeAirportsMax: 3,
  /** Longest trip, outbound → return, in days. */
  tripDaysMax: 30,
  /** Furthest outbound date from today (UTC), in days. Google Flights shows ~11 months. */
  outboundDaysAheadMax: 330,
  /** trips.inviteCode length (SPEC: random, 10+ chars). */
  inviteCodeLength: 12,
} as const

/** Same keys as LIMITS with plain number values, so tests can pass tuned limits. */
export type Limits = { readonly [K in keyof typeof LIMITS]: number }

/** The fare watch's calendar: the cron's timezone, also used for "how many days until the trip". */
export const WATCH_TIMEZONE = 'America/Chicago'

/** Group drop alert: total must fall by at least max(DROP_MIN_USD, DROP_MIN_FRACTION × previous). */
export const DROP_MIN_USD = 50
export const DROP_MIN_FRACTION = 0.05

/** fitsAll is hidden (null) unless at least this many travelers have budgets (SPEC §7 privacy guard). */
export const FITS_ALL_MIN_BUDGETS = 3

/** Show "Everyone lands within …" only when the arrival spread is at most this many minutes. */
export const ARRIVAL_BADGE_MAX_MIN = 180

/** Anthropic model + output budget for destination suggestions (endpoint defaults to Opus/4096). */
export const AI_MODEL = 'claude-haiku-5-5'
/**
 * Output budget, reasoning included. Haiku 5.5 thinks by default and the
 * endpoint can't turn that off; at 600 the reasoning used the whole budget
 * before any answer (Phase 4 real call, NOTES Q1). The successful call used
 * 974 of 2048; the developer raised it to 3000 for headroom (Phase 5 ruling).
 */
export const AI_MAX_TOKENS = 3000
