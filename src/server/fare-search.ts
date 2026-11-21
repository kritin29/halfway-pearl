/**
 * The `fare-search` background job (SPEC §8), mode 'full'. Dispatched from
 * src/jobs.ts with `createAppTools(env, env.OWNER_USER_ID)`: RBAC is off, so
 * this module only ever touches the one trip named in the payload.
 *
 * 1. Load the trip, travelers (constraints re-validated, NOTES G1),
 *    candidates and budgets (server-only; real travelers, positive amounts).
 * 2. Pairs = traveler × candidate. Home pairs get `homeFare()` with no call.
 *    Pairs with identical (origin set, destination, dates) share one call.
 * 3. Fresh (< 6h) cached routes are reused (`fareCache`).
 * 4. The rest run 4 at a time, at most `maxCallsPerRun` and never past the
 *    global daily budget. Each fare row is written as it arrives; progress
 *    goes to `ctx.progress` and (throttled) to the trip row. `usage`
 *    increments run through one serial chain.
 * 5. provider_unavailable → stop calling, mark the rest 'error', human
 *    message in `searchError`, the failed call isn't counted, no retry.
 * 6. `ranking.ts` aggregates every candidate → candidate rows + a
 *    `fareSnapshots` row each; status → results.
 *
 * Retries re-run everything: fare rows and snapshots have deterministic ids
 * (upserts, never duplicates) and the cache makes repeated routes free. On
 * the final failed attempt the trip leaves 'searching' with a generic error.
 *
 * Never logs or writes budgets, names with prices, or provider text to rows.
 */
import type { ActionTools, Job, JobContext } from 'deepspace/worker'
import { knownHomeAirports } from '../lib/airports'
import { mayMakeCall, planCalls, usageDay, usageKeys } from '../lib/caps'
import {
  buildFlightsRequest,
  chooseFare,
  classifyIntegrationFailure,
  extractFlightOptions,
  fareCacheKey,
  GENERIC_SEARCH_ERROR_MESSAGE,
  homeFare,
  PROVIDER_UNAVAILABLE_MESSAGE,
  type FareResult,
  type FlightConstraints,
  type FlightOptions,
  type FlightSearch,
  type SerpapiFlightsRequest,
} from '../lib/flights'
import { LIMITS, type Limits } from '../lib/limits'
import { aggregateCandidate, type RankFare, type RankTraveler } from '../lib/ranking'
import { isGhostId, type TripData } from '../lib/types'
import { searchFlights as defaultSearchFlights, usesFixture, type FlightsEnv } from './flights-source'
import { isNotFound, loadTrip, must, type Trip } from './trip-access'
import { propagateMemberIds, sameIds } from './trip-rows'
import { getUsageCount, incrementUsage } from './usage'

export interface FareSearchPayload {
  tripId: string
  mode: 'full' | 'watch'
}

export interface FareSearchDeps {
  tools: ActionTools
  env: FlightsEnv
  now?: () => Date
  /** The flights source (src/server/flights-source.ts); swapped in tests. */
  searchFlights?: typeof defaultSearchFlights
  limits?: Limits
  fixtureDelayMs?: number
}

export type FareSearchResult =
  | { skipped: 'bad_payload' | 'unsupported_mode' | 'trip_gone' | 'superseded' | 'not_searching' }
  | {
      pairs: number
      home: number
      cached: number
      calls: number
      errors: number
      capSkipped: number
      providerUnavailable: boolean
      aborted: boolean
      status: TripData['status']
    }

/** A traveler as the search sees them: validated airports and constraints. */
interface SearchTraveler {
  id: string
  displayName: string
  homes: string[]
  constraints: FlightConstraints
}

interface RouteGroup {
  key: string
  search: FlightSearch
  request: SerpapiFlightsRequest
  /** Travelers flying this route (same origin set) to this candidate. */
  travelers: SearchTraveler[]
}

export function parsePayload(raw: unknown): FareSearchPayload | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { tripId, mode } = raw as Record<string, unknown>
  if (typeof tripId !== 'string' || !tripId || (mode !== 'full' && mode !== 'watch')) return null
  return { tripId, mode }
}

/** Deterministic row ids, so a retry overwrites instead of duplicating. */
export const fareRecordId = (tripId: string, iata: string, travelerId: string) => `${tripId}|${iata}|${travelerId}`
export const snapshotRecordId = (tripId: string, iata: string, jobId: string) => `${tripId}|${iata}|${jobId}`
/**
 * Fixture answers are cached under their own keys, per trip, so they can
 * never answer a real search and test runs never share cached routes.
 */
export const cacheRecordId = (key: string, fixture: boolean, tripId: string) =>
  fixture ? `fixture|${tripId}|${key}` : key

export async function runFareSearch(job: Job, ctx: JobContext, deps: FareSearchDeps): Promise<FareSearchResult> {
  const payload = parsePayload(job.payload)
  if (!payload) return { skipped: 'bad_payload' }
  // Watch mode (cron / "Check fares now") is a later phase.
  if (payload.mode !== 'full') return { skipped: 'unsupported_mode' }

  const { tools } = deps
  const access = await loadTrip(tools, payload.tripId)
  if (!access.ok) return { skipped: 'trip_gone' }
  const trip = access.trip
  // startSearch writes searchJobId right after enqueueing, so it may still be
  // empty when we start; a different id means a newer search replaced this one.
  if (trip.data.searchJobId && trip.data.searchJobId !== job.id) return { skipped: 'superseded' }
  if (trip.data.status !== 'searching') return { skipped: 'not_searching' }

  try {
    return await search(job, ctx, deps, trip)
  } catch (err) {
    const final = job.attempts >= job.maxAttempts
    console.error(
      `[fare-search] trip ${trip.id} attempt ${job.attempts}/${job.maxAttempts} failed: ${err instanceof Error ? err.message : String(err)}`,
    )
    try {
      if (final) await giveUp(tools, trip.id)
      else await tools.update('trips', trip.id, { searchMessage: 'Something went wrong. Retrying…' })
    } catch (inner) {
      console.error(`[fare-search] trip ${trip.id} could not record the failure: ${String(inner)}`)
    }
    throw err
  }
}

async function search(job: Job, ctx: JobContext, deps: FareSearchDeps, trip: Trip): Promise<FareSearchResult> {
  const { tools, env } = deps
  const limits = deps.limits ?? LIMITS
  const now = deps.now ?? (() => new Date())
  const searchFlights = deps.searchFlights ?? defaultSearchFlights
  const tripId = trip.id
  const fixture = usesFixture(env, trip.data.name)
  const memberIds = [...trip.data.memberIds]
  const day = usageDay(now())

  // 1. Load.
  const travelerRows = must(await tools.query('travelers', { where: { tripId } }), 'query travelers').records
  const travelers = travelerRows.map((r) => toSearchTraveler(r.data))
  const flyers = travelers.filter((t) => t.homes.length > 0)
  const candidateRows = must(await tools.query('candidates', { where: { tripId } }), 'query candidates').records
  const candidates = [...candidateRows]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.recordId.localeCompare(b.recordId))
    .map((r) => ({ recordId: r.recordId, iata: String(r.data.iata) }))
  const budgets = await readBudgets(tools, tripId, travelers)

  // Fare rows for travelers or candidates that are gone (or have no airports now) would mislead.
  const flyerIds = new Set(flyers.map((t) => t.id))
  const candidateCodes = new Set(candidates.map((c) => c.iata))
  const existingFares = must(await tools.query('fares', { where: { tripId } }), 'query fares').records
  for (const row of existingFares) {
    if (!flyerIds.has(String(row.data.travelerId)) || !candidateCodes.has(String(row.data.candidateIata))) {
      must(await tools.remove('fares', row.recordId), 'remove stale fare')
    }
  }

  // Progress: ctx.progress every step, the trip row at most once per throttle window.
  const total = flyers.length * candidates.length
  let done = 0
  let lastWrite = 0
  async function step(count: number, message: string) {
    done += count
    const progress = total === 0 ? 0 : Math.min(0.99, done / total)
    ctx.progress(progress, message)
    const t = Date.now()
    if (t - lastWrite >= limits.searchProgressThrottleMs) {
      lastWrite = t
      must(await tools.update('trips', tripId, { searchProgress: progress, searchMessage: message }), 'write progress')
    }
  }

  async function writeFare(travelerId: string, iata: string, fare: FareResult | null, fetchedAt: string) {
    must(
      await tools.create(
        'fares',
        { tripId, memberIds, candidateIata: iata, travelerId, ...fareColumns(fare), fetchedAt },
        fareRecordId(tripId, iata, travelerId),
      ),
      'write fare',
    )
  }

  // 2. Pairs: home pairs now (no call); the rest grouped by route.
  let home = 0
  const groups = new Map<string, RouteGroup>()
  for (const candidate of candidates) {
    for (const traveler of flyers) {
      const s: FlightSearch = {
        homeAirports: traveler.homes,
        candidateIata: candidate.iata,
        outboundDate: trip.data.outboundDate,
        returnDate: trip.data.returnDate,
      }
      const atHome = homeFare(s)
      if (atHome) {
        await writeFare(traveler.id, candidate.iata, atHome, now().toISOString())
        home++
        await step(1, `${traveler.homes.join(',')} is home for ${candidate.iata}`)
        continue
      }
      const key = fareCacheKey(s)
      const group = groups.get(key)
      if (group) group.travelers.push(traveler)
      else groups.set(key, { key, search: s, request: buildFlightsRequest(s), travelers: [traveler] })
    }
  }

  async function applyOptions(group: RouteGroup, options: FlightOptions, fetchedAt: string) {
    for (const t of group.travelers) {
      await writeFare(t.id, group.search.candidateIata, chooseFare(options, t.constraints), fetchedAt)
    }
  }
  async function markError(group: RouteGroup) {
    for (const t of group.travelers) await writeFare(t.id, group.search.candidateIata, null, now().toISOString())
  }
  const label = (g: RouteGroup) => `Checked ${g.request.departure_id}→${g.request.arrival_id}`

  // 3. Cache (full mode): reuse routes fetched < 6h ago.
  let cached = 0
  const needed: RouteGroup[] = []
  for (const group of groups.values()) {
    const hit = await readCache(tools, cacheRecordId(group.key, fixture, tripId), now(), limits.fareCacheMs)
    if (hit) {
      await applyOptions(group, hit.options, hit.fetchedAt)
      cached++
      await step(group.travelers.length, label(group))
    } else {
      needed.push(group)
    }
  }

  // 4. Calls, within the run cap and today's global budget. Fixture answers
  //    spend nothing, so they don't touch the global budget or the ledger.
  const globalKey = usageKeys.serpapiGlobal()
  let globalNow = fixture ? 0 : await getUsageCount(tools, day, globalKey)
  const maxCalls = fixture
    ? limits.maxCallsPerRun
    : Math.max(0, Math.min(limits.maxCallsPerRun, limits.maxSerpapiCallsPerDayGlobal - globalNow))
  const plan = planCalls(needed, maxCalls)

  let ledger: Promise<unknown> = Promise.resolve()
  const countCall = () => {
    globalNow++
    ledger = ledger
      .then(() => incrementUsage(tools, day, globalKey))
      .then(() => incrementUsage(tools, day, usageKeys.serpapiTrip(tripId)))
  }

  let calls = 0
  let errors = 0
  let providerUnavailable = false
  let next = 0
  const finished = new Set<RouteGroup>()

  // A storage failure in one worker stops the others, and the run waits for
  // every worker to settle before failing, so nothing writes after the job
  // has given up.
  let failure: unknown = null
  async function worker() {
    try {
      await work()
    } catch (err) {
      failure ??= err
    }
  }
  async function work() {
    for (;;) {
      if (ctx.signal.aborted || providerUnavailable || failure) return
      if (next >= plan.run.length) return
      const group = plan.run[next++]
      if (!fixture && !mayMakeCall(calls, maxCalls, globalNow, limits)) return
      calls++
      let answer: Awaited<ReturnType<typeof searchFlights>>
      try {
        answer = await searchFlights(tools, env, group.request, trip.data.name, { fixtureDelayMs: deps.fixtureDelayMs })
      } catch (err) {
        answer = { result: { success: false, error: err instanceof Error ? err.message : String(err) }, source: fixture ? 'fixture' : 'live' }
      }
      const res = answer.result
      if (res.success) {
        if (answer.source === 'live') countCall()
        const options = extractFlightOptions(res.data, group.search)
        const fetchedAt = now().toISOString()
        await writeCache(tools, cacheRecordId(group.key, answer.source === 'fixture', tripId), group.key, options, fetchedAt)
        await applyOptions(group, options, fetchedAt)
      } else {
        const failed = classifyIntegrationFailure(res)
        console.error(`[fare-search] trip ${tripId} ${group.key}: ${failed.code}: ${failed.detail.slice(0, 300)}`)
        if (failed.code === 'provider_unavailable') {
          // Billing was released: not counted, and no further calls this run.
          providerUnavailable = true
          calls--
        } else {
          // We can't know a failed call wasn't billed, so it counts.
          if (answer.source === 'live') countCall()
          errors++
        }
        await markError(group)
      }
      finished.add(group)
      await step(group.travelers.length, label(group))
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, limits.searchConcurrency) }, () => worker()))
  await ledger
  if (failure) throw failure

  // Everything not answered (cap, provider down, cancelled) is marked so the
  // card says which fares are missing instead of showing an old price.
  const unanswered = [...plan.skipped, ...plan.run.filter((g) => !finished.has(g))]
  for (const group of unanswered) await markError(group)
  const capSkipped = providerUnavailable || ctx.signal.aborted ? 0 : unanswered.length

  // 6. Aggregate every candidate with ranking.ts (budgets stay server-side).
  const fares = must(await tools.query('fares', { where: { tripId } }), 'query fares').records
  const rankTravelers: RankTraveler[] = travelers.map((t) => ({ id: t.id, displayName: t.displayName }))
  const checkedAt = now().toISOString()
  for (const candidate of candidates) {
    const rankFares: RankFare[] = fares
      .filter((f) => f.data.candidateIata === candidate.iata)
      .map((f) => ({
        travelerId: String(f.data.travelerId),
        status: f.data.status as RankFare['status'],
        price: typeof f.data.price === 'number' ? f.data.price : null,
        arriveLocal: typeof f.data.arriveLocal === 'string' ? f.data.arriveLocal : null,
        home: f.data.originIata === candidate.iata && f.data.price === 0,
      }))
    const agg = aggregateCandidate(rankTravelers, rankFares, budgets)
    must(
      await tools.update('candidates', candidate.recordId, {
        complete: agg.complete ? 1 : 0,
        groupTotal: agg.groupTotal,
        maxFare: agg.maxFare,
        minFare: agg.minFare,
        arrivalSpreadMin: agg.arrivalSpreadMin,
        fitsAll: agg.fitsAll,
        missingFor: agg.missingFor,
        lastCheckedAt: checkedAt,
      }),
      'update candidate',
    )
    must(
      await tools.create(
        'fareSnapshots',
        { tripId, memberIds, candidateIata: candidate.iata, groupTotal: agg.groupTotal, maxFare: agg.maxFare, checkedAt },
        snapshotRecordId(tripId, candidate.iata, job.id),
      ),
      'write snapshot',
    )
  }

  // 8. Finish. Someone may have joined mid-run: give them the rows we wrote.
  const fresh = await loadTrip(tools, tripId)
  if (fresh.ok && !sameIds(fresh.trip.data.memberIds, memberIds)) {
    await propagateMemberIds(tools, tripId, fresh.trip.data.memberIds)
  }
  const hasResults = fares.some((f) => f.data.status === 'ok' && !(f.data.originIata === f.data.candidateIata && f.data.price === 0))
  const status: TripData['status'] =
    fresh.ok && fresh.trip.data.status === 'locked' ? 'locked' : providerUnavailable && !hasResults ? 'gathering' : 'results'
  const aborted = ctx.signal.aborted
  const searchError = providerUnavailable
    ? PROVIDER_UNAVAILABLE_MESSAGE
    : aborted
      ? 'The fare search was stopped before it finished.'
      : capSkipped > 0
        ? `Halfway reached its fare-check limit, so ${capSkipped} ${capSkipped === 1 ? 'route wasn’t' : 'routes weren’t'} checked. Try again tomorrow.`
        : errors > 0
          ? 'Some fares couldn’t be checked. Try again later.'
          : null
  must(
    await tools.update('trips', tripId, {
      status,
      lastSearchAt: checkedAt,
      searchProgress: 1,
      searchMessage: `Checked fares for ${candidates.length} ${candidates.length === 1 ? 'destination' : 'destinations'}`,
      searchError,
    }),
    'finish search',
  )
  ctx.progress(1, 'Done')
  return { pairs: total, home, cached, calls, errors, capSkipped, providerUnavailable, aborted, status }
}

/** Final attempt failed: leave 'searching' so the trip isn't stuck, with a generic message. */
async function giveUp(tools: ActionTools, tripId: string) {
  const { records } = must(await tools.query('fares', { where: { tripId, status: 'ok' } }), 'query fares')
  const hasResults = records.some((f) => !(f.data.originIata === f.data.candidateIata && f.data.price === 0))
  const fresh = await loadTrip(tools, tripId)
  if (!fresh.ok || fresh.trip.data.status !== 'searching') return
  must(
    await tools.update('trips', tripId, {
      status: hasResults ? 'results' : 'gathering',
      searchProgress: null,
      searchMessage: null,
      searchError: GENERIC_SEARCH_ERROR_MESSAGE,
    }),
    'record search failure',
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Client-written constraint rows are re-validated here (NOTES G1): bad values are clamped. */
export function toSearchTraveler(data: Record<string, unknown>): SearchTraveler {
  return {
    id: String(data.userId ?? ''),
    displayName: typeof data.displayName === 'string' && data.displayName ? data.displayName : 'A traveler',
    homes: knownHomeAirports(data.homeAirports),
    constraints: {
      maxStops: clampInt(data.maxStops, 0, 2, 2),
      noRedeye: data.noRedeye === 1,
      earliestDepartHour: clampInt(data.earliestDepartHour, 0, 23, 0),
    },
  }
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

/**
 * travelerId → budget, server-side only. Only real (non-ghost) travelers on
 * this trip, only positive finite amounts (NOTES G2); anything else is ignored.
 */
export async function readBudgets(
  tools: ActionTools,
  tripId: string,
  travelers: readonly SearchTraveler[],
): Promise<Map<string, number>> {
  const real = new Set(travelers.map((t) => t.id).filter((id) => id && !isGhostId(id)))
  const { records } = must(await tools.query('budgets', { where: { tripId } }), 'query budgets')
  const budgets = new Map<string, number>()
  for (const row of records) {
    const userId = row.data.userId
    const maxUsd = row.data.maxUsd
    if (typeof userId !== 'string' || !real.has(userId)) continue
    if (typeof maxUsd !== 'number' || !Number.isFinite(maxUsd) || maxUsd <= 0) continue
    budgets.set(userId, maxUsd)
  }
  return budgets
}

/** Every fares column, explicitly, so an upsert never leaves an old price behind. */
function fareColumns(fare: FareResult | null): Record<string, unknown> {
  const base = {
    originIata: null,
    price: null,
    priceLevel: 'unknown',
    typicalLow: null,
    typicalHigh: null,
    stops: null,
    durationMin: null,
    departLocal: null,
    arriveLocal: null,
    airline: null,
    bookingUrl: null,
  }
  if (!fare) return { ...base, status: 'error' }
  const context = {
    priceLevel: fare.priceLevel,
    typicalLow: fare.typicalLow,
    typicalHigh: fare.typicalHigh,
    bookingUrl: fare.bookingUrl,
  }
  if (fare.status !== 'ok') return { ...base, ...context, status: fare.status }
  return {
    ...context,
    status: 'ok',
    originIata: fare.originIata,
    price: fare.price,
    stops: fare.stops,
    durationMin: fare.durationMin,
    departLocal: fare.departLocal,
    arriveLocal: fare.arriveLocal,
    airline: fare.airline.slice(0, 120),
  }
}

async function readCache(
  tools: ActionTools,
  recordId: string,
  now: Date,
  maxAgeMs: number,
): Promise<{ options: FlightOptions; fetchedAt: string } | null> {
  const res = await tools.get('fareCache', recordId)
  if (isNotFound(res)) return null
  const { record } = must(res, 'read fare cache')
  const fetchedAt = String(record.data.fetchedAt ?? '')
  const age = now.getTime() - Date.parse(fetchedAt)
  if (!Number.isFinite(age) || age < 0 || age >= maxAgeMs) return null
  const d = record.data
  const level = d.priceLevel
  return {
    fetchedAt,
    options: {
      itineraries: Array.isArray(d.itineraries) ? (d.itineraries as FlightOptions['itineraries']) : [],
      priceLevel: level === 'low' || level === 'typical' || level === 'high' ? level : 'unknown',
      typicalLow: typeof d.typicalLow === 'number' ? d.typicalLow : null,
      typicalHigh: typeof d.typicalHigh === 'number' ? d.typicalHigh : null,
      bookingUrl: typeof d.bookingUrl === 'string' ? d.bookingUrl : '',
    },
  }
}

async function writeCache(tools: ActionTools, recordId: string, key: string, options: FlightOptions, fetchedAt: string) {
  must(
    await tools.create(
      'fareCache',
      {
        key: recordId,
        itineraries: options.itineraries,
        priceLevel: options.priceLevel,
        typicalLow: options.typicalLow,
        typicalHigh: options.typicalHigh,
        bookingUrl: options.bookingUrl,
        fetchedAt,
      },
      recordId,
    ),
    `write fare cache ${key}`,
  )
}

