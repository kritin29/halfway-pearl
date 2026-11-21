/**
 * The fare-search job against the in-memory store (SPEC §8). The only thing
 * mocked is the external boundary: `serpapi/flights` answers come from the
 * fake store's integration handler (fixture-shaped responses), so parsing,
 * caching, caps, the ledger and ranking all run for real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActionHandler, ActionResult, ActionTools, Job, JobContext } from 'deepspace/worker'
import type { Env } from '../../worker'
import error429 from '../lib/__fixtures__/serpapi-error-429.json'
import { usageKeys, usageRecordId } from '../lib/caps'
import { PROVIDER_UNAVAILABLE_MESSAGE, GENERIC_SEARCH_ERROR_MESSAGE, type SerpapiFlightsRequest } from '../lib/flights'
import { LIMITS, type Limits } from '../lib/limits'
import { addCandidate } from '../actions/candidates'
import { addGhost } from '../actions/ghosts'
import { createTrip, joinTrip } from '../actions/trips'
import { createFakeStore, type FakeStore } from './testing/fake-tools'
import { fixtureResponse } from './flights-source'
import { cacheRecordId, fareRecordId, runFareSearch, type FareSearchDeps } from './fare-search'

const ALICE = 'user_alice'
const BOB = 'user_bob'
const DANA = 'user_dana'
const DAY = '2026-11-20'

let store: FakeStore
const server = () => store.toolsFor('server')

function call(action: ActionHandler<Env>, userId: string, params: Record<string, unknown>) {
  return action({ userId, params, tools: store.toolsFor(userId), env: {} as Env, callerJwt: 'jwt' }) as Promise<
    ActionResult<Record<string, unknown>>
  >
}
function data<T = Record<string, unknown>>(res: ActionResult<unknown>): T {
  if (!res.success) throw new Error(`expected success, got ${res.code}: ${res.error}`)
  return res.data as T
}

let jobSeq = 0
function makeJob(tripId: string, attempts = 1, maxAttempts = 2, id = `job_${++jobSeq}`): Job {
  return {
    id,
    type: 'fare-search',
    status: 'running',
    payload: { tripId, mode: 'full' },
    attempts,
    maxAttempts,
    enqueuedAt: new Date().toISOString(),
  } as Job
}
function makeCtx(signal = new AbortController().signal) {
  const progress: Array<[number, string | undefined]> = []
  const ctx: JobContext = { progress: (v, m) => progress.push([v, m]), continue: () => {}, signal }
  return { ctx, progress }
}

/** SerpApi answers for the external boundary: the fixture rewritten per route. */
function answerWithFixture() {
  store.onIntegration((endpoint, body) => {
    if (endpoint !== 'serpapi/flights') return { success: false, error: `unexpected ${endpoint}` }
    return { success: true, data: fixtureResponse(body as SerpapiFlightsRequest) }
  })
}
const flightCalls = () => store.integrationCalls.filter((c) => c.endpoint === 'serpapi/flights')
const routesCalled = () =>
  flightCalls()
    .map((c) => `${(c.data as SerpapiFlightsRequest).departure_id}>${(c.data as SerpapiFlightsRequest).arrival_id}`)
    .sort()
const usageCount = (key: string) =>
  store.rows('usage').find((r) => r.recordId === usageRecordId(DAY, key))?.data.count ?? 0
const tripRow = (tripId: string) => store.rows('trips').find((r) => r.recordId === tripId)!
const faresOf = (tripId: string) => store.rows('fares').filter((r) => r.data.tripId === tripId)
const fare = (tripId: string, iata: string, travelerId: string) =>
  store.rows('fares').find((r) => r.recordId === fareRecordId(tripId, iata, travelerId))
const candidate = (tripId: string, iata: string) =>
  store.rows('candidates').find((r) => r.data.tripId === tripId && r.data.iata === iata)!

async function setHomes(tripId: string, userId: string, patch: Record<string, unknown>) {
  const row = store.rows('travelers').find((r) => r.data.tripId === tripId && r.data.userId === userId)!
  data(await server().update('travelers', row.recordId, patch))
}
const startSearching = (tripId: string) =>
  server().update('trips', tripId, { status: 'searching', searchJobId: null, searchProgress: 0 })

/**
 * Alice (ORD) and Bob (ORD) share an origin set; Dana flies from BOS; the
 * ghost "Grandpa" lives in Nashville (BNA). Destinations: BNA, AUS, DEN.
 * Pairs: 4 travelers × 3 = 12. Grandpa→BNA is home (no call). Alice and Bob
 * share every route. Calls: ORD→{BNA,AUS,DEN}, BOS→{BNA,AUS,DEN}, BNA→{AUS,DEN} = 8.
 */
async function setup(name = 'Spring break') {
  const { tripId, inviteCode } = data<{ tripId: string; inviteCode: string }>(
    await call(createTrip, ALICE, { name, outboundDate: '2026-12-11', returnDate: '2026-12-13' }),
  )
  data(await call(joinTrip, BOB, { inviteCode }))
  data(await call(joinTrip, DANA, { inviteCode }))
  await setHomes(tripId, ALICE, { homeAirports: ['ORD'] })
  await setHomes(tripId, BOB, { homeAirports: ['ORD'] })
  await setHomes(tripId, DANA, { homeAirports: ['BOS'] })
  const ghost = data<{ ghostId: string }>(
    await call(addGhost, ALICE, { tripId, displayName: 'Grandpa', homeAirports: ['BNA'] }),
  )
  for (const iata of ['BNA', 'AUS', 'DEN']) data(await call(addCandidate, ALICE, { tripId, iata }))
  await startSearching(tripId)
  return { tripId, ghostId: ghost.ghostId }
}

function deps(over: Partial<FareSearchDeps> = {}): FareSearchDeps {
  return { tools: store.toolsFor('owner'), env: {}, fixtureDelayMs: 0, ...over }
}
const limitsWith = (over: Partial<Limits>): Limits => ({ ...LIMITS, ...over })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(`${DAY}T12:00:00Z`))
  store = createFakeStore()
  for (const [id, name] of [
    [ALICE, 'Alice'],
    [BOB, 'Bob'],
    [DANA, 'Dana'],
  ]) {
    store.seed('users', id, { name, email: `${id}@example.test` }, id)
  }
})
afterEach(() => vi.useRealTimers())

describe('a full search', () => {
  it('dedupes shared origin sets, skips home pairs, writes every fare row and aggregates', async () => {
    const { tripId, ghostId } = await setup()
    answerWithFixture()
    const { ctx, progress } = makeCtx()

    const result = await runFareSearch(makeJob(tripId), ctx, deps())

    expect(result).toMatchObject({ pairs: 12, home: 1, cached: 0, calls: 8, errors: 0, providerUnavailable: false, status: 'results' })
    expect(routesCalled()).toEqual(
      ['ORD>BNA', 'ORD>AUS', 'ORD>DEN', 'BOS>BNA', 'BOS>AUS', 'BOS>DEN', 'BNA>AUS', 'BNA>DEN'].sort(),
    )
    // Every request has the SPEC §7 body.
    expect(flightCalls()[0].data).toMatchObject({ outbound_date: '2026-12-11', return_date: '2026-12-13', type: '1', adults: 1, currency: 'USD', hl: 'en' })

    expect(faresOf(tripId)).toHaveLength(12)
    expect(fare(tripId, 'BNA', ghostId)?.data).toMatchObject({ status: 'ok', price: 0, originIata: 'BNA', stops: 0 })
    // Alice and Bob share the call and (same constraints) the fare.
    expect(fare(tripId, 'AUS', ALICE)?.data.price).toBe(fare(tripId, 'AUS', BOB)?.data.price)
    expect(fare(tripId, 'AUS', ALICE)?.data).toMatchObject({ status: 'ok', originIata: 'ORD', candidateIata: 'AUS' })
    for (const row of faresOf(tripId)) expect(row.data.memberIds).toEqual([ALICE, BOB, DANA])

    // Ledger: one count per real call, globally and for the trip.
    expect(usageCount(usageKeys.serpapiGlobal())).toBe(8)
    expect(usageCount(usageKeys.serpapiTrip(tripId))).toBe(8)

    // Aggregates and one snapshot per candidate.
    for (const iata of ['BNA', 'AUS', 'DEN']) {
      const c = candidate(tripId, iata).data
      expect(c.complete, iata).toBe(1)
      expect(c.groupTotal, iata).toBeGreaterThan(0)
      expect(c.missingFor, iata).toEqual([])
      expect(c.lastCheckedAt, iata).toBe(`${DAY}T12:00:00.000Z`)
    }
    const aus = ['user_alice', 'user_bob', 'user_dana', ghostId].map((id) => fare(tripId, 'AUS', id)!.data.price as number)
    expect(candidate(tripId, 'AUS').data.groupTotal).toBe(aus.reduce((a, b) => a + b, 0))
    expect(store.rows('fareSnapshots').filter((r) => r.data.tripId === tripId)).toHaveLength(3)

    expect(tripRow(tripId).data).toMatchObject({ status: 'results', searchProgress: 1, searchError: null })
    expect(tripRow(tripId).data.lastSearchAt).toBe(`${DAY}T12:00:00.000Z`)
    expect(progress.at(-1)).toEqual([1, 'Done'])
    expect(progress.some(([, m]) => m === 'Checked ORD→AUS')).toBe(true)
  })

  it('reuses a route fetched less than 6h ago, with each traveler’s current constraints', async () => {
    const { tripId } = await setup()
    answerWithFixture()
    await runFareSearch(makeJob(tripId), makeCtx().ctx, deps())
    expect(flightCalls()).toHaveLength(8)
    const before = fare(tripId, 'BNA', BOB)!.data

    // Bob now wants nonstop only; a new search 5h later makes no calls.
    await setHomes(tripId, BOB, { maxStops: 0 })
    vi.setSystemTime(new Date(`${DAY}T17:00:00Z`))
    await startSearching(tripId)
    const second = await runFareSearch(makeJob(tripId), makeCtx().ctx, deps())
    expect(second).toMatchObject({ cached: 8, calls: 0 })
    expect(flightCalls()).toHaveLength(8)
    const after = fare(tripId, 'BNA', BOB)!.data
    expect(after.stops).toBe(0)
    // The fixture's cheapest option has 2 stops, so nonstop costs more.
    expect(after.price as number).toBeGreaterThan(before.price as number)
    // Cached fares keep the time they were actually fetched.
    expect(after.fetchedAt).toBe(`${DAY}T12:00:00.000Z`)

    // 6h after the first fetch the cache is stale: every route is called again.
    vi.setSystemTime(new Date(`${DAY}T18:00:00Z`))
    await startSearching(tripId)
    expect(await runFareSearch(makeJob(tripId), makeCtx().ctx, deps())).toMatchObject({ cached: 0, calls: 8 })
    expect(flightCalls()).toHaveLength(16)
  })

  it('re-validates client-written constraints (unknown airports dropped, out-of-range values clamped)', async () => {
    const { tripId } = await setup()
    answerWithFixture()
    await setHomes(tripId, BOB, { homeAirports: ['ZZZ', 'ord', 'not-a-code'], maxStops: 99, earliestDepartHour: -4 })
    await runFareSearch(makeJob(tripId), makeCtx().ctx, deps())
    // Bob still flies from ORD (shares Alice's calls), with "any stops".
    expect(routesCalled().filter((r) => r.startsWith('ORD'))).toHaveLength(3)
    expect(fare(tripId, 'AUS', BOB)?.data).toMatchObject({ status: 'ok', originIata: 'ORD' })
    expect(fare(tripId, 'AUS', BOB)?.data.price).toBe(fare(tripId, 'AUS', ALICE)?.data.price)
  })

  it('a traveler without airports is missing from every card; their old rows are removed', async () => {
    const { tripId } = await setup()
    answerWithFixture()
    await runFareSearch(makeJob(tripId), makeCtx().ctx, deps())
    expect(fare(tripId, 'AUS', DANA)).toBeDefined()

    await setHomes(tripId, DANA, { homeAirports: [] })
    vi.setSystemTime(new Date(`${DAY}T13:00:00Z`))
    await startSearching(tripId)
    await runFareSearch(makeJob(tripId), makeCtx().ctx, deps())
    expect(fare(tripId, 'AUS', DANA)).toBeUndefined()
    expect(candidate(tripId, 'AUS').data).toMatchObject({ complete: 0, groupTotal: null, missingFor: ['Dana'] })
  })
})

describe('spend caps inside the run', () => {
  it('stops at the per-run call cap; the rest are marked and the trip says why', async () => {
    const { tripId } = await setup()
    answerWithFixture()
    const result = await runFareSearch(makeJob(tripId), makeCtx().ctx, deps({ limits: limitsWith({ maxCallsPerRun: 3 }) }))
    expect(result).toMatchObject({ calls: 3, capSkipped: 5, status: 'results' })
    expect(flightCalls()).toHaveLength(3)
    expect(usageCount(usageKeys.serpapiGlobal())).toBe(3)
    // Routes are planned candidate by candidate, so BNA (the first) is complete.
    expect(candidate(tripId, 'BNA').data.complete).toBe(1)
    expect(faresOf(tripId).filter((f) => f.data.status === 'error')).toHaveLength(6)
    expect(tripRow(tripId).data.searchError).toMatch(/fare-check limit, so 5 routes weren’t checked/)
  })

  it('never goes past the global daily budget', async () => {
    const { tripId } = await setup()
    answerWithFixture()
    const global = usageKeys.serpapiGlobal()
    data(await server().create('usage', { day: DAY, key: global, count: LIMITS.maxSerpapiCallsPerDayGlobal - 2 }, usageRecordId(DAY, global)))
    const result = await runFareSearch(makeJob(tripId), makeCtx().ctx, deps())
    expect(result).toMatchObject({ calls: 2, capSkipped: 6 })
    expect(usageCount(global)).toBe(LIMITS.maxSerpapiCallsPerDayGlobal)
  })

  it('makes no call at all when the global budget is already spent', async () => {
    const { tripId } = await setup()
    answerWithFixture()
    const global = usageKeys.serpapiGlobal()
    data(await server().create('usage', { day: DAY, key: global, count: LIMITS.maxSerpapiCallsPerDayGlobal }, usageRecordId(DAY, global)))
    expect(await runFareSearch(makeJob(tripId), makeCtx().ctx, deps())).toMatchObject({ calls: 0, capSkipped: 8 })
    expect(flightCalls()).toHaveLength(0)
  })
})

describe('provider failures', () => {
  it('provider_unavailable: stops calling, marks the rest, isn’t counted, doesn’t throw', async () => {
    const { tripId } = await setup()
    store.onIntegration(() => error429 as unknown as ActionResult<unknown>)
    const result = await runFareSearch(
      makeJob(tripId),
      makeCtx().ctx,
      deps({ limits: limitsWith({ searchConcurrency: 1 }) }),
    )
    expect(result).toMatchObject({ calls: 0, providerUnavailable: true, capSkipped: 0, status: 'gathering' })
    expect(flightCalls()).toHaveLength(1)
    expect(usageCount(usageKeys.serpapiGlobal())).toBe(0)
    // Home fare stays ok; every other pair is marked.
    expect(faresOf(tripId).filter((f) => f.data.status === 'error')).toHaveLength(11)
    expect(tripRow(tripId).data).toMatchObject({ status: 'gathering', searchError: PROVIDER_UNAVAILABLE_MESSAGE })
  })

  it('provider_unavailable after earlier results: back to results, banner message set', async () => {
    const { tripId } = await setup()
    answerWithFixture()
    await runFareSearch(makeJob(tripId), makeCtx().ctx, deps())
    vi.setSystemTime(new Date(`${DAY}T19:00:00Z`)) // cache is stale
    await startSearching(tripId)
    let n = 0
    store.onIntegration((_e, body) =>
      ++n <= 2 ? { success: true, data: fixtureResponse(body as SerpapiFlightsRequest) } : (error429 as unknown as ActionResult<unknown>),
    )
    const result = await runFareSearch(makeJob(tripId), makeCtx().ctx, deps({ limits: limitsWith({ searchConcurrency: 1 }) }))
    expect(result).toMatchObject({ calls: 2, providerUnavailable: true, status: 'results' })
    expect(n).toBe(3)
    expect(tripRow(tripId).data).toMatchObject({ status: 'results', searchError: PROVIDER_UNAVAILABLE_MESSAGE })
  })

  it('a generic error marks only that route, counts the call and the run continues', async () => {
    const { tripId } = await setup()
    store.onIntegration((_e, body) => {
      const req = body as SerpapiFlightsRequest
      if (req.departure_id === 'BOS' && req.arrival_id === 'DEN') return { success: false, error: 'upstream exploded', code: 'upstream_provider_error' }
      return { success: true, data: fixtureResponse(req) }
    })
    const result = await runFareSearch(makeJob(tripId), makeCtx().ctx, deps())
    expect(result).toMatchObject({ calls: 8, errors: 1, providerUnavailable: false, status: 'results' })
    expect(usageCount(usageKeys.serpapiGlobal())).toBe(8)
    expect(fare(tripId, 'DEN', DANA)?.data).toMatchObject({ status: 'error', price: null })
    expect(candidate(tripId, 'DEN').data).toMatchObject({ complete: 0, missingFor: ['Dana'] })
    expect(candidate(tripId, 'AUS').data.complete).toBe(1)
    // Users see a generic line, never the provider's text.
    expect(tripRow(tripId).data.searchError).toBe('Some fares couldn’t be checked. Try again later.')
  })
})

describe('retries and failure', () => {
  /** Tools whose Nth `fares` write throws (a storage hiccup mid-run). */
  function failingOnFareWrite(n: number): ActionTools {
    const real = store.toolsFor('owner')
    let writes = 0
    return {
      ...real,
      create: async (collection, row, id) => {
        if (collection === 'fares' && ++writes === n) return { success: false, error: 'storage unavailable' }
        return real.create(collection, row, id)
      },
    }
  }

  it('a retry finishes the job without duplicating rows or repeating answered calls', async () => {
    const { tripId } = await setup()
    answerWithFixture()
    const job = makeJob(tripId, 1, 2)
    await expect(runFareSearch(job, makeCtx().ctx, deps({ tools: failingOnFareWrite(6), limits: limitsWith({ searchConcurrency: 1 }) }))).rejects.toThrow(
      /write fare/,
    )
    // Not the final attempt: still searching, with a note.
    expect(tripRow(tripId).data).toMatchObject({ status: 'searching', searchMessage: 'Something went wrong. Retrying…' })
    const firstCalls = flightCalls().length
    expect(firstCalls).toBeGreaterThan(0)

    const retry = { ...job, attempts: 2 }
    const result = await runFareSearch(retry, makeCtx().ctx, deps())
    expect(result).toMatchObject({ status: 'results' })
    // Routes answered in attempt 1 came from the cache in attempt 2.
    expect((result as { cached: number }).cached).toBe(firstCalls)
    expect(flightCalls()).toHaveLength(8)
    expect(faresOf(tripId)).toHaveLength(12)
    expect(store.rows('fareSnapshots').filter((r) => r.data.tripId === tripId)).toHaveLength(3)
    expect(store.rows('fareCache')).toHaveLength(8)
  })

  it('running the same job twice (a duplicate delivery) still leaves one row per pair and per snapshot', async () => {
    const { tripId } = await setup()
    answerWithFixture()
    const job = makeJob(tripId)
    await runFareSearch(job, makeCtx().ctx, deps())
    await startSearching(tripId)
    await runFareSearch(job, makeCtx().ctx, deps())
    expect(faresOf(tripId)).toHaveLength(12)
    expect(store.rows('fareSnapshots').filter((r) => r.data.tripId === tripId)).toHaveLength(3)
  })

  it('the final failed attempt leaves searching with a generic error, then rethrows', async () => {
    const { tripId } = await setup()
    answerWithFixture()
    await expect(
      runFareSearch(makeJob(tripId, 2, 2), makeCtx().ctx, deps({ tools: failingOnFareWrite(2), limits: limitsWith({ searchConcurrency: 1 }) })),
    ).rejects.toThrow()
    expect(tripRow(tripId).data).toMatchObject({
      status: 'gathering',
      searchError: GENERIC_SEARCH_ERROR_MESSAGE,
      searchProgress: null,
    })
  })

  it('skips a superseded job, a trip that isn’t searching, a missing trip and a bad payload', async () => {
    const { tripId } = await setup()
    answerWithFixture()
    data(await server().update('trips', tripId, { searchJobId: 'job_newer' }))
    expect(await runFareSearch(makeJob(tripId, 1, 2, 'job_older'), makeCtx().ctx, deps())).toEqual({ skipped: 'superseded' })
    data(await server().update('trips', tripId, { searchJobId: null, status: 'results' }))
    expect(await runFareSearch(makeJob(tripId), makeCtx().ctx, deps())).toEqual({ skipped: 'not_searching' })
    expect(await runFareSearch(makeJob('trip_missing'), makeCtx().ctx, deps())).toEqual({ skipped: 'trip_gone' })
    expect(await runFareSearch({ ...makeJob(tripId), payload: { tripId } }, makeCtx().ctx, deps())).toEqual({ skipped: 'bad_payload' })
    expect(await runFareSearch({ ...makeJob(tripId), payload: { tripId, mode: 'watch' } }, makeCtx().ctx, deps())).toEqual({
      skipped: 'unsupported_mode',
    })
    expect(flightCalls()).toHaveLength(0)
  })

  it('honors ctx.signal: no calls after a cancel, the trip says it stopped', async () => {
    const { tripId } = await setup()
    answerWithFixture()
    const controller = new AbortController()
    controller.abort()
    const result = await runFareSearch(makeJob(tripId), makeCtx(controller.signal).ctx, deps())
    expect(result).toMatchObject({ calls: 0, aborted: true, status: 'results' })
    expect(flightCalls()).toHaveLength(0)
    expect(tripRow(tripId).data.searchError).toBe('The fare search was stopped before it finished.')
  })
})

describe('budgets stay server-side', () => {
  async function setBudget(tripId: string, userId: string, maxUsd: number) {
    data(await store.toolsFor(userId).create('budgets', { tripId, userId, maxUsd }))
  }

  it('fitsAll is hidden with 2 budgets and shown with 3 (stray and bogus rows ignored)', async () => {
    const { tripId, ghostId } = await setup()
    answerWithFixture()
    await setBudget(tripId, ALICE, 5000)
    await setBudget(tripId, BOB, 5000)
    // Not travelers / not positive: never count toward the guard.
    store.seed('budgets', 'b_ghost', { tripId, userId: ghostId, maxUsd: 5000 })
    store.seed('budgets', 'b_stranger', { tripId, userId: 'user_stranger', maxUsd: 5000 })
    await runFareSearch(makeJob(tripId), makeCtx().ctx, deps())
    expect(candidate(tripId, 'AUS').data.fitsAll).toBeNull()

    await setBudget(tripId, DANA, -1)
    vi.setSystemTime(new Date(`${DAY}T13:00:00Z`))
    await startSearching(tripId)
    await runFareSearch(makeJob(tripId), makeCtx().ctx, deps())
    expect(candidate(tripId, 'AUS').data.fitsAll).toBeNull()

    const danaBudget = store.rows('budgets').find((r) => r.data.userId === DANA)!
    data(await server().update('budgets', danaBudget.recordId, { maxUsd: 1 }))
    await startSearching(tripId)
    await runFareSearch(makeJob(tripId), makeCtx().ctx, deps())
    expect(candidate(tripId, 'AUS').data.fitsAll).toBe(0)

    data(await server().update('budgets', danaBudget.recordId, { maxUsd: 5000 }))
    await startSearching(tripId)
    await runFareSearch(makeJob(tripId), makeCtx().ctx, deps())
    expect(candidate(tripId, 'AUS').data.fitsAll).toBe(1)

    // No budget amount ever lands on a row members can read.
    for (const collection of ['trips', 'candidates', 'fares', 'fareSnapshots']) {
      expect(JSON.stringify(store.rows(collection)), collection).not.toContain('5000')
    }
  })
})

describe('the flights-source seam', () => {
  it('a __test- trip with ALLOW_DEBUG_ROUTES=true is answered from the fixture: no integration call, nothing counted', async () => {
    const { tripId } = await setup('__test-fixture trip')
    const result = await runFareSearch(makeJob(tripId), makeCtx().ctx, deps({ env: { ALLOW_DEBUG_ROUTES: 'true' } }))
    expect(result).toMatchObject({ calls: 8, status: 'results' })
    expect(store.integrationCalls).toEqual([])
    expect(usageCount(usageKeys.serpapiGlobal())).toBe(0)
    // Fixture answers are cached under their own keys.
    expect(store.rows('fareCache').every((r) => r.recordId.startsWith(`fixture|${tripId}|`))).toBe(true)
    expect(candidate(tripId, 'AUS').data.complete).toBe(1)
  })

  it('without the flag the same __test- trip takes the real path', async () => {
    const { tripId } = await setup('__test-fixture trip')
    answerWithFixture()
    await runFareSearch(makeJob(tripId), makeCtx().ctx, deps({ env: {} }))
    expect(flightCalls()).toHaveLength(8)
    expect(store.rows('fareCache').some((r) => r.recordId.startsWith('fixture|'))).toBe(false)
    expect(cacheRecordId('ORD|AUS|2026-12-11|2026-12-13', false, tripId)).toBe('ORD|AUS|2026-12-11|2026-12-13')
    expect(cacheRecordId('ORD|AUS|2026-12-11|2026-12-13', true, tripId)).toBe(`fixture|${tripId}|ORD|AUS|2026-12-11|2026-12-13`)
  })

  it('a member who joins mid-run can read the rows written before they joined', async () => {
    const { tripId } = await setup()
    const inviteCode = String(tripRow(tripId).data.inviteCode)
    store.seed('users', 'user_eve', { name: 'Eve', email: 'eve@example.test' }, 'user_eve')
    let joined = false
    store.onIntegration(async (_e, body) => {
      if (!joined) {
        joined = true
        data(await call(joinTrip, 'user_eve', { inviteCode }))
      }
      return { success: true, data: fixtureResponse(body as SerpapiFlightsRequest) }
    })
    await runFareSearch(makeJob(tripId), makeCtx().ctx, deps())
    for (const collection of ['fares', 'fareSnapshots', 'candidates']) {
      for (const row of store.rows(collection).filter((r) => r.data.tripId === tripId)) {
        expect(row.data.memberIds, collection).toContain('user_eve')
      }
    }
  })
})
