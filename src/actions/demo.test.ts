/**
 * Demo trips (SPEC §14) against the in-memory store.
 *
 * Everything runs for real (actions, the fare-search job with its DEFAULT
 * flights source, ranking, emails, the cron) in a production-like env
 * (no ALLOW_DEBUG_ROUTES). Only the JobRoom is replaced, as in
 * search.test.ts. The fake store records every integration call, so "never
 * reaches serpapi/flights or email/send" is checked directly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActionHandler, ActionResult, Job, JobContext } from 'deepspace/worker'
import type { Env } from '../../worker'
import error429 from '../lib/__fixtures__/serpapi-error-429.json'
import { usageKeys, usageRecordId } from '../lib/caps'
import { DEMO_DESTINATIONS, DEMO_GHOSTS, DEMO_ORGANIZER_HOMES, DEMO_TRIP_NAME } from '../lib/demo'
import { LIMITS } from '../lib/limits'
import { selectWatchTrips } from '../lib/watch'
import { tripsSchema } from '../schemas/trips-schema'
import { deliverOnce } from '../server/email-delivery'
import { cacheRecordId, runFareSearch } from '../server/fare-search'
import { runFareWatchCron } from '../server/fare-watch-cron'
import { loadTrip } from '../server/trip-access'
import { createFakeStore, type FakeStore } from '../server/testing/fake-tools'
import { addCandidate } from './candidates'
import { addGhost } from './ghosts'
import { createDemoTrip, DEMO_CAP_MESSAGE } from './demo'
import { lockTrip, setWatch } from './lock'
import { checkFaresNow, startSearch } from './search'
import { createTrip } from './trips'

const enqueue = vi.hoisted(() => vi.fn())
vi.mock('deepspace/worker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('deepspace/worker')>()),
  enqueueJob: enqueue,
}))

const ALICE = 'user_alice'
const BOB = 'user_bob'
const DAY = '2026-11-20'
/** Production-like: no ALLOW_DEBUG_ROUTES, so no test seam applies anywhere. */
const ENV = { JOB_ROOMS: 'JOB_ROOMS_BINDING', DEEPSPACE_APP_ID: 'app123', OWNER_USER_ID: 'owner', APP_NAME: 'halfway-pearl' } as unknown as Env
const TEST_ENV = { ...ENV, ALLOW_DEBUG_ROUTES: 'true' } as Env

let store: FakeStore

function call(action: ActionHandler<Env>, userId: string, params: Record<string, unknown>, env: Env = ENV) {
  return action({ userId, params, tools: store.toolsFor(userId), env, callerJwt: 'jwt' }) as Promise<
    ActionResult<Record<string, unknown>>
  >
}
function data<T = Record<string, unknown>>(res: ActionResult<unknown>): T {
  if (!res.success) throw new Error(`expected success, got ${res.code}: ${res.error}`)
  return res.data as T
}
const server = () => store.toolsFor('server')
const owner = () => store.toolsFor('owner')
const tripRow = (tripId: string) => store.rows('trips').find((r) => r.recordId === tripId)!
const travelersOf = (tripId: string) => store.rows('travelers').filter((r) => r.data.tripId === tripId)
const candidatesOf = (tripId: string) => store.rows('candidates').filter((r) => r.data.tripId === tripId)
const faresOf = (tripId: string) => store.rows('fares').filter((r) => r.data.tripId === tripId)
const usageCount = (key: string) => store.rows('usage').find((r) => r.recordId === usageRecordId(DAY, key))?.data.count ?? 0
const calls = (endpoint?: string) => store.integrationCalls.filter((c) => !endpoint || c.endpoint === endpoint)

function makeJob(tripId: string, id: string, mode: 'full' | 'watch' = 'full'): Job {
  return {
    id,
    type: 'fare-search',
    status: 'running',
    payload: { tripId, mode, countedOn: DAY },
    attempts: 1,
    maxAttempts: 2,
    enqueuedAt: new Date().toISOString(),
  } as Job
}
const ctx = (): JobContext => ({ progress: () => {}, continue: () => {}, signal: new AbortController().signal })
/** The job exactly as the worker runs it: default flights source and email sender, production env. */
const runJob = (job: Job) => runFareSearch(job, ctx(), { tools: owner(), env: ENV, fixtureDelayMs: 0 })

/** Create a demo trip as Alice and run its first search to the end. */
async function searchedDemo(userId = ALICE) {
  const created = data<{ tripId: string; searchStarted: boolean }>(await call(createDemoTrip, userId, {}))
  const jobId = String(tripRow(created.tripId).data.searchJobId)
  const result = await runJob(makeJob(created.tripId, jobId))
  return { tripId: created.tripId, result }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(`${DAY}T12:00:00Z`))
  store = createFakeStore()
  for (const [id, name] of [
    [ALICE, 'Alice'],
    [BOB, 'Bob'],
  ]) {
    store.seed('users', id, { name, email: `${id}@example.test` }, id)
  }
  // Any integration call at all is a failure of these tests; answer like the real outage.
  store.onIntegration(() => error429 as never)
  enqueue.mockReset()
  let n = 0
  enqueue.mockImplementation(async () => `job_${++n}`)
})
afterEach(() => vi.useRealTimers())

describe('createDemoTrip', () => {
  it('creates a demo trip for the caller: 2 ghosts in other cities, 4 destinations, and starts the normal search', async () => {
    const res = data<{ tripId: string; inviteCode: string; searchStarted: boolean }>(await call(createDemoTrip, ALICE, {}))
    expect(res.searchStarted).toBe(true)

    const trip = tripRow(res.tripId).data
    expect(trip).toMatchObject({
      name: DEMO_TRIP_NAME,
      organizerId: ALICE,
      memberIds: [ALICE],
      isDemo: 1,
      watchEnabled: 0,
      status: 'searching',
      searchJobId: 'job_1',
    })
    // Friday to Sunday, at least 35 days out.
    expect(new Date(`${trip.outboundDate}T00:00:00Z`).getUTCDay()).toBe(5)
    expect(String(trip.outboundDate) >= '2026-12-25').toBe(true)
    expect(trip.returnDate).toBe('2026-12-27')

    const travelers = travelersOf(res.tripId)
    expect(travelers).toHaveLength(1 + DEMO_GHOSTS.length)
    const me = travelers.find((t) => t.data.userId === ALICE)!
    expect(me.data).toMatchObject({ isGhost: 0, displayName: 'Alice', homeAirports: DEMO_ORGANIZER_HOMES })
    const ghosts = travelers.filter((t) => t.data.isGhost === 1)
    expect(ghosts.map((g) => g.data.displayName)).toEqual(DEMO_GHOSTS.map((g) => g.displayName))
    expect(ghosts.every((g) => String(g.data.userId).startsWith('ghost:'))).toBe(true)
    // Three different home cities.
    const homes = travelers.map((t) => (t.data.homeAirports as string[])[0])
    expect(new Set(homes).size).toBe(3)

    expect(candidatesOf(res.tripId).map((c) => c.data.iata).sort()).toEqual([...DEMO_DESTINATIONS].sort())

    // The normal pipeline: a full fare-search job, counted against the trip's daily searches...
    expect(enqueue).toHaveBeenCalledTimes(1)
    expect(enqueue.mock.calls[0][2]).toBe('fare-search')
    expect(enqueue.mock.calls[0][3]).toEqual({ tripId: res.tripId, mode: 'full', countedOn: DAY })
    expect(usageCount(usageKeys.fullSearchTrip(res.tripId))).toBe(1)
    // ...but never against the caller's real search budget.
    expect(usageCount(usageKeys.userTripsSearched(ALICE))).toBe(0)
    expect(usageCount(usageKeys.demoTripsUser(ALICE))).toBe(1)
    expect(calls()).toEqual([])
  })

  it('ignores anything the client sends: the server decides the name, dates and flag', async () => {
    const res = data<{ tripId: string }>(
      await call(createDemoTrip, ALICE, { isDemo: 0, name: 'Mine', outboundDate: '2026-12-01', testName: '__test-x' }),
    )
    expect(tripRow(res.tripId).data).toMatchObject({ name: DEMO_TRIP_NAME, isDemo: 1 })
    expect(tripRow(res.tripId).data.outboundDate).not.toBe('2026-12-01')
  })

  it('still creates the trip when the search can’t be enqueued (Find fares retries it)', async () => {
    enqueue.mockRejectedValueOnce(new Error('enqueueJob failed: 500'))
    const res = data<{ tripId: string; searchStarted: boolean }>(await call(createDemoTrip, ALICE, {}))
    expect(res.searchStarted).toBe(false)
    expect(tripRow(res.tripId).data).toMatchObject({ isDemo: 1, status: 'gathering', searchJobId: null })
    expect(usageCount(usageKeys.fullSearchTrip(res.tripId))).toBe(0)
  })
})

describe('the demo cap', () => {
  it(`allows ${LIMITS.maxDemoTripsPerUserPerDay} demo trips per user per day, then refuses; other users are unaffected`, async () => {
    for (let i = 0; i < LIMITS.maxDemoTripsPerUserPerDay; i++) data(await call(createDemoTrip, ALICE, {}))
    const refused = await call(createDemoTrip, ALICE, {})
    expect(refused).toEqual({ success: false, code: 'cap_reached', error: DEMO_CAP_MESSAGE })
    expect(store.rows('trips').filter((t) => t.data.organizerId === ALICE)).toHaveLength(LIMITS.maxDemoTripsPerUserPerDay)

    data(await call(createDemoTrip, BOB, {}))
    // Demo trips don't use up the regular trip-creation cap either.
    data(await call(createTrip, ALICE, { name: 'Real one', outboundDate: '2026-12-11', returnDate: '2026-12-13' }))

    // The next UTC day starts fresh.
    vi.setSystemTime(new Date('2026-11-21T00:00:01Z'))
    data(await call(createDemoTrip, ALICE, {}))
  })

  it('the cap fails closed when the ledger can’t be read', async () => {
    const tools = store.toolsFor(ALICE)
    const broken = { ...tools, get: async () => ({ success: false, error: 'storage down' }) } as typeof tools
    const res = await createDemoTrip({ userId: ALICE, params: {}, tools: broken, env: ENV, callerJwt: 'jwt' })
    expect(res).toMatchObject({ success: false, code: 'server_error' })
    expect(store.rows('trips')).toEqual([])
  })

  it('the __test- name seam (which skips the cap) works only when ALLOW_DEBUG_ROUTES is "true"', async () => {
    for (let i = 0; i < LIMITS.maxDemoTripsPerUserPerDay + 2; i++) {
      const res = data<{ tripId: string }>(await call(createDemoTrip, ALICE, { testName: `__test-demo ${i}` }, TEST_ENV))
      expect(tripRow(res.tripId).data).toMatchObject({ name: `__test-demo ${i}`, isDemo: 1 })
    }
    expect(usageCount(usageKeys.demoTripsUser(ALICE))).toBe(0)
    // In production the same param is ignored and the cap counts.
    for (let i = 0; i < LIMITS.maxDemoTripsPerUserPerDay; i++) data(await call(createDemoTrip, ALICE, { testName: '__test-demo' }))
    expect(await call(createDemoTrip, ALICE, { testName: '__test-demo' })).toMatchObject({ code: 'cap_reached' })
  })
})

describe('clients can’t set the demo flag', () => {
  it('trips are written only by server code, and isDemo is immutable', () => {
    for (const rules of Object.values(tripsSchema.permissions ?? {})) {
      expect(rules.create).toBe(false)
      expect(rules.update).toBe(false)
      expect(rules.delete).toBe(false)
    }
    expect(tripsSchema.columns.find((c) => c.name === 'isDemo')).toMatchObject({ immutable: true, default: 0 })
  })

  it('createTrip never makes a demo trip, whatever the params say', async () => {
    const { tripId } = data<{ tripId: string }>(
      await call(createTrip, ALICE, { name: 'Sneaky', outboundDate: '2026-12-11', returnDate: '2026-12-13', isDemo: 1 }),
    )
    expect(tripRow(tripId).data.isDemo).toBe(0)
  })

  it('not even server code can flip it after creation', async () => {
    const { tripId } = data<{ tripId: string }>(await call(createDemoTrip, ALICE, {}))
    const flip = await server().update('trips', tripId, { isDemo: 0 })
    expect(flip.success).toBe(false)
    expect(tripRow(tripId).data.isDemo).toBe(1)
  })
})

describe('the demo search pipeline (production env, default flights source)', () => {
  it('ranks all 4 destinations from fixture fares varied per route, with zero real calls', async () => {
    const { tripId, result } = await searchedDemo()
    expect(result).toMatchObject({ mode: 'full', status: 'results', calls: 12, errors: 0, providerUnavailable: false, snapshots: 4 })
    expect(calls()).toEqual([])
    expect(usageCount(usageKeys.serpapiGlobal())).toBe(0)

    const candidates = candidatesOf(tripId)
    expect(candidates.every((c) => c.data.complete === 1)).toBe(true)
    const totals = candidates.map((c) => c.data.groupTotal as number)
    expect(new Set(totals).size).toBe(4) // varied per route
    expect(faresOf(tripId).filter((f) => f.data.status === 'ok')).toHaveLength(12)
    // Fixture answers are cached only under this trip's own keys.
    const cacheIds = store.rows('fareCache').map((r) => r.recordId)
    expect(cacheIds.length).toBeGreaterThan(0)
    expect(cacheIds.every((id) => id.startsWith(`fixture|${tripId}|`))).toBe(true)
  })

  it('demo prices never reach a real trip: the same routes on a real trip go to the real source', async () => {
    await searchedDemo()
    expect(calls()).toEqual([])

    // A real trip with the same travelers' airports and a demo destination.
    const { tripId, inviteCode } = data<{ tripId: string; inviteCode: string }>(
      await call(createTrip, BOB, { name: 'Real trip', outboundDate: '2026-12-11', returnDate: '2026-12-13' }),
    )
    void inviteCode
    const bobRow = travelersOf(tripId).find((t) => t.data.userId === BOB)!
    data(await server().update('travelers', bobRow.recordId, { homeAirports: ['ORD'] }))
    data(await call(addGhost, BOB, { tripId, displayName: 'Sam', homeAirports: ['BOS'] }))
    data(await call(addCandidate, BOB, { tripId, iata: 'BNA' }))
    data(await call(startSearch, BOB, { tripId }))
    const jobId = String(tripRow(tripId).data.searchJobId)
    const result = await runJob(makeJob(tripId, jobId))

    // It asked the real integration (which is out of quota here), not the fixture or the demo's cache.
    expect(calls('serpapi/flights').length).toBeGreaterThan(0)
    expect(result).toMatchObject({ providerUnavailable: true })
    expect(faresOf(tripId).some((f) => typeof f.data.price === 'number' && f.data.status === 'ok')).toBe(false)
    expect(store.rows('fareCache').every((r) => r.recordId.startsWith('fixture|') && !r.recordId.includes(tripId))).toBe(true)
  })

  it('"Find fares" again on a demo trip works even when the global SerpApi budget is spent', async () => {
    const { tripId } = await searchedDemo()
    data(await server().create('usage', { day: DAY, key: usageKeys.serpapiGlobal(), count: LIMITS.maxSerpapiCallsPerDayGlobal }, usageRecordId(DAY, usageKeys.serpapiGlobal())))
    data(await call(startSearch, ALICE, { tripId }))
    const result = await runJob(makeJob(tripId, String(tripRow(tripId).data.searchJobId)))
    expect(result).toMatchObject({ status: 'results', capSkipped: 0 })
    expect(calls()).toEqual([])
  })
})

describe('demo trips never send email', () => {
  it('lockTrip locks and reports emailsOff; nothing is claimed or sent, also on "Email booking links again"', async () => {
    const { tripId } = await searchedDemo()
    const res = data<{ emails: Record<string, unknown> }>(await call(lockTrip, ALICE, { tripId, iata: 'BNA' }))
    expect(tripRow(tripId).data).toMatchObject({ status: 'locked', lockedIata: 'BNA' })
    expect(res.emails).toEqual({ sent: 0, alreadySent: 0, noEmail: 0, capped: 0, failed: 0, mocked: false, emailsOff: true })

    const again = data<{ emails: Record<string, unknown> }>(await call(lockTrip, ALICE, { tripId, iata: 'BNA' }))
    expect(again.emails).toMatchObject({ emailsOff: true, sent: 0 })
    expect(calls()).toEqual([])
    expect(store.rows('emailLog')).toEqual([])
    expect(usageCount(usageKeys.emailTrip(tripId))).toBe(0)
  })

  it('a watch run with a group drop and a budget crossing sends nothing', async () => {
    const { tripId } = await searchedDemo()
    // Make the next check look like a big drop for every destination, and a first crossing under Alice's budget.
    for (const iata of DEMO_DESTINATIONS) {
      data(await server().create('fareSnapshots', { tripId, memberIds: [ALICE], candidateIata: iata, groupTotal: 99_999, maxFare: 99_999, checkedAt: `${DAY}T06:00:00Z` }, `old|${iata}`))
    }
    for (const f of faresOf(tripId).filter((r) => r.data.travelerId === ALICE)) {
      data(await server().update('fares', f.recordId, { price: 99_999 }))
    }
    data(await store.toolsFor(ALICE).create('budgets', { tripId, userId: ALICE, maxUsd: 5_000 }))

    data(await call(checkFaresNow, ALICE, { tripId }))
    const watchJob = enqueue.mock.calls.at(-1)!
    expect(watchJob[3]).toMatchObject({ tripId, mode: 'watch' })
    const result = await runJob(makeJob(tripId, 'job_watch', 'watch'))

    expect(result).toMatchObject({ mode: 'watch', snapshots: 3 })
    expect((result as { emails: unknown }).emails).toEqual({
      group: { sent: 0, alreadySent: 0, noEmail: 0, capped: 0, failed: 0 },
      private: { sent: 0, alreadySent: 0, noEmail: 0, capped: 0, failed: 0 },
      mocked: false,
      emailsOff: true,
    })
    expect(calls()).toEqual([])
    expect(store.rows('emailLog')).toEqual([])
  })

  it('deliverOnce itself refuses a demo trip (backstop)', async () => {
    const { tripId } = data<{ tripId: string }>(await call(createDemoTrip, ALICE, {}))
    const access = await loadTrip(owner(), tripId)
    if (!access.ok) throw new Error('trip missing')
    const build = vi.fn()
    await expect(
      deliverOnce(owner(), { APP_NAME: 'halfway-pearl' }, access.trip, { key: 'k', kind: 'lock', userId: ALICE }, build),
    ).rejects.toThrow(/emails are off in demo trips/)
    expect(build).not.toHaveBeenCalled()
    expect(calls()).toEqual([])
    expect(store.rows('emailLog')).toEqual([])
  })
})

describe('demo trips and the fare watch', () => {
  it('"Check fares now" works on a demo trip with fixture data, even with the global budget spent', async () => {
    const { tripId } = await searchedDemo()
    data(await server().create('usage', { day: DAY, key: usageKeys.serpapiGlobal(), count: LIMITS.maxSerpapiCallsPerDayGlobal }, usageRecordId(DAY, usageKeys.serpapiGlobal())))
    data(await call(checkFaresNow, ALICE, { tripId }))
    const result = await runJob(makeJob(tripId, 'job_watch', 'watch'))
    expect(result).toMatchObject({ mode: 'watch', snapshots: 3, providerUnavailable: false, capSkipped: 0 })
    expect(tripRow(tripId).data).toMatchObject({ watchQueuedAt: null, watchError: null })
    expect(calls()).toEqual([])
  })

  it('the daily switch can’t be turned on for a demo trip', async () => {
    const { tripId } = data<{ tripId: string }>(await call(createDemoTrip, ALICE, {}))
    expect(await call(setWatch, ALICE, { tripId, enabled: 1 })).toMatchObject({ success: false, code: 'demo_trip' })
    expect(tripRow(tripId).data.watchEnabled).toBe(0)
  })

  it('the cron skips demo trips even if their watch flag were on', async () => {
    const seed = (id: string, over: Record<string, unknown>) =>
      store.seed('trips', id, {
        name: id,
        organizerId: ALICE,
        memberIds: [ALICE],
        inviteCode: id,
        status: 'results',
        outboundDate: '2026-12-11',
        returnDate: '2026-12-13',
        watchEnabled: 1,
        ...over,
      })
    seed('demo_trip', { isDemo: 1 })
    seed('real_trip', { isDemo: 0 })
    seed('old_trip', {}) // rows from before the column existed

    const cronEnqueue = vi.fn(async () => 'job_cron')
    const report = await runFareWatchCron(owner(), ENV, { now: () => new Date(`${DAY}T14:00:00Z`), enqueue: cronEnqueue as never })
    expect(report).toMatchObject({ eligible: 2, enqueued: 2 })
    const enqueued = cronEnqueue.mock.calls.map((c) => (c as unknown[])[3] as { tripId: string }).map((p) => p.tripId).sort()
    expect(enqueued).toEqual(['old_trip', 'real_trip'])
    expect(usageCount(usageKeys.watchCronTrip('demo_trip'))).toBe(0)
  })

  it('selectWatchTrips drops demo trips before the per-run maximum', () => {
    const base = { watchEnabled: 1, status: 'results', outboundDate: '2026-12-11' }
    const trips = [
      { id: 'a', ...base, isDemo: 1 },
      { id: 'b', ...base },
      { id: 'c', ...base, isDemo: 0 },
    ]
    const { selected, eligible } = selectWatchTrips(trips, DAY, { ...LIMITS, maxWatchTripsPerCronRun: 1 })
    expect(eligible).toBe(2)
    expect(selected.map((t) => t.id)).toEqual(['b'])
  })
})

describe('cache ids', () => {
  it('fixture answers are keyed per trip, so they can never answer a real search', () => {
    expect(cacheRecordId('ORD>BNA|2026-12-11|2026-12-13', true, 't1')).toBe('fixture|t1|ORD>BNA|2026-12-11|2026-12-13')
    expect(cacheRecordId('ORD>BNA|2026-12-11|2026-12-13', false, 't1')).toBe('ORD>BNA|2026-12-11|2026-12-13')
  })
})
