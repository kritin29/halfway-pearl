import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActionHandler, ActionResult } from 'deepspace/worker'
import type { Env } from '../../worker'
import { usageKeys, usageRecordId } from '../lib/caps'
import { LIMITS } from '../lib/limits'
import { createFakeStore, type FakeStore } from '../server/testing/fake-tools'
import { addCandidate } from './candidates'
import { addGhost } from './ghosts'
import { checkFaresNow, startSearch } from './search'
import { createTrip, joinTrip } from './trips'
import { toggleVote } from './votes'

// The JobRoom is the one thing replaced: enqueueJob is a worker-to-DO call.
const enqueue = vi.hoisted(() => vi.fn())
vi.mock('deepspace/worker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('deepspace/worker')>()),
  enqueueJob: enqueue,
}))

const ALICE = 'user_alice'
const BOB = 'user_bob'
const CAROL = 'user_carol'
const DAY = '2026-11-20'
const ENV = { JOB_ROOMS: 'JOB_ROOMS_BINDING', DEEPSPACE_APP_ID: 'app123' } as unknown as Env
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
const tripRow = (tripId: string) => store.rows('trips').find((r) => r.recordId === tripId)!
const usageCount = (key: string) =>
  store.rows('usage').find((r) => r.recordId === usageRecordId(DAY, key))?.data.count ?? 0
const server = () => store.toolsFor('server')

async function setHomes(tripId: string, userId: string, homeAirports: string[]) {
  const row = store.rows('travelers').find((r) => r.data.tripId === tripId && r.data.userId === userId)!
  data(await server().update('travelers', row.recordId, { homeAirports }))
}

/** A trip ready to search: Alice (ORD) organizes, Bob (BOS) joined, one destination. */
async function ready(name = 'Spring break') {
  const { tripId, inviteCode } = data<{ tripId: string; inviteCode: string }>(
    await call(createTrip, ALICE, { name, outboundDate: '2026-12-11', returnDate: '2026-12-13' }),
  )
  data(await call(joinTrip, BOB, { inviteCode }))
  await setHomes(tripId, ALICE, ['ORD'])
  await setHomes(tripId, BOB, ['BOS'])
  data(await call(addCandidate, ALICE, { tripId, iata: 'AUS' }))
  return tripId
}
/** What the job would do at the end of a run. */
const finish = (tripId: string) => server().update('trips', tripId, { status: 'results', searchProgress: 1 })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(`${DAY}T12:00:00Z`))
  store = createFakeStore()
  for (const [id, name] of [
    [ALICE, 'Alice'],
    [BOB, 'Bob'],
    [CAROL, 'Carol'],
  ]) {
    store.seed('users', id, { name, email: `${id}@example.test` }, id)
  }
  enqueue.mockReset()
  let n = 0
  enqueue.mockImplementation(async () => `job_${++n}`)
})
afterEach(() => vi.useRealTimers())

describe('startSearch', () => {
  it('organizer: counts the search, marks the trip searching, enqueues fare-search, stores the job id', async () => {
    const tripId = await ready()
    expect(data(await call(startSearch, ALICE, { tripId }))).toEqual({ jobId: 'job_1' })
    expect(enqueue).toHaveBeenCalledTimes(1)
    expect(enqueue).toHaveBeenCalledWith(
      'JOB_ROOMS_BINDING',
      'app:app123',
      'fare-search',
      { tripId, mode: 'full', countedOn: DAY },
      { maxAttempts: 2, enqueuedBy: ALICE },
    )
    expect(tripRow(tripId).data).toMatchObject({
      status: 'searching',
      searchJobId: 'job_1',
      searchProgress: 0,
      searchError: null,
    })
    expect(usageCount(usageKeys.fullSearchTrip(tripId))).toBe(1)
    expect(usageCount(usageKeys.userTripsSearched(ALICE))).toBe(1)
    expect(store.integrationCalls).toEqual([])
  })

  it('a member who isn’t the organizer is forbidden; a non-member gets not_found; nothing is enqueued', async () => {
    const tripId = await ready()
    expect(await call(startSearch, BOB, { tripId })).toMatchObject({ success: false, code: 'forbidden' })
    expect(await call(startSearch, CAROL, { tripId })).toMatchObject({ success: false, code: 'not_found' })
    expect(await call(startSearch, ALICE, { tripId: '' })).toMatchObject({ success: false, code: 'invalid_params' })
    expect(enqueue).not.toHaveBeenCalled()
    // Only createTrip's own counter; no search was counted.
    expect(store.rows('usage').map((r) => r.data.key)).toEqual([usageKeys.tripsCreatedUser(ALICE)])
  })

  it('needs 2 travelers with airports and at least one destination', async () => {
    const { tripId, inviteCode } = data<{ tripId: string; inviteCode: string }>(
      await call(createTrip, ALICE, { name: 'Empty', outboundDate: '2026-12-11', returnDate: '2026-12-13' }),
    )
    data(await call(joinTrip, BOB, { inviteCode }))
    await setHomes(tripId, ALICE, ['ORD'])
    expect(await call(startSearch, ALICE, { tripId })).toMatchObject({ success: false, code: 'needs_airports' })
    // A ghost with airports counts as a traveler.
    data(await call(addGhost, ALICE, { tripId, displayName: 'Grandpa', homeAirports: ['BNA'] }))
    expect(await call(startSearch, ALICE, { tripId })).toMatchObject({ success: false, code: 'needs_candidates' })
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('refuses while searching and on a locked trip, but recovers a search that died', async () => {
    const tripId = await ready()
    data(await call(startSearch, ALICE, { tripId }))
    expect(await call(startSearch, ALICE, { tripId })).toMatchObject({ success: false, code: 'search_running' })

    // No trip-row write for 20 minutes: the job is gone, the organizer may start again.
    vi.setSystemTime(new Date(Date.parse(`${DAY}T12:00:00Z`) + LIMITS.staleSearchMs))
    expect(data(await call(startSearch, ALICE, { tripId }))).toEqual({ jobId: 'job_2' })

    data(await server().update('trips', tripId, { status: 'locked' }))
    expect(await call(startSearch, ALICE, { tripId })).toMatchObject({ success: false, code: 'trip_locked' })
    expect(enqueue).toHaveBeenCalledTimes(2)
  })

  it('a third full search of the same trip on the same day is refused (cap_reached)', async () => {
    const tripId = await ready()
    data(await call(startSearch, ALICE, { tripId }))
    await finish(tripId)
    data(await call(startSearch, ALICE, { tripId }))
    await finish(tripId)
    const third = await call(startSearch, ALICE, { tripId })
    expect(third).toMatchObject({ success: false, code: 'cap_reached' })
    expect(!third.success && third.error).toMatch(/already ran 2 fare searches today/)
    expect(enqueue).toHaveBeenCalledTimes(2)
    expect(tripRow(tripId).data.status).toBe('results')
    // Re-searching one trip counts once toward the per-user limit.
    expect(usageCount(usageKeys.userTripsSearched(ALICE))).toBe(1)

    // Tomorrow (UTC) it's allowed again.
    vi.setSystemTime(new Date('2026-11-21T00:00:01Z'))
    expect(await call(startSearch, ALICE, { tripId })).toMatchObject({ success: true })
  })

  it('one user can start searches for at most 3 different trips per day', async () => {
    const trips = [await ready('One'), await ready('Two'), await ready('Three'), await ready('Four')]
    for (const tripId of trips.slice(0, 3)) data(await call(startSearch, ALICE, { tripId }))
    expect(await call(startSearch, ALICE, { tripId: trips[3] })).toMatchObject({ success: false, code: 'cap_reached' })
  })

  it('refuses when the global daily SerpApi budget is spent', async () => {
    const tripId = await ready()
    const key = usageKeys.serpapiGlobal()
    data(await server().create('usage', { day: DAY, key, count: LIMITS.maxSerpapiCallsPerDayGlobal }, usageRecordId(DAY, key)))
    expect(await call(startSearch, ALICE, { tripId })).toMatchObject({ success: false, code: 'cap_reached' })
  })

  it('dev/test __test- trips skip the per-user and global budgets, never the per-trip one', async () => {
    const trips = [await ready('__test-1'), await ready('__test-2'), await ready('__test-3'), await ready('__test-4')]
    const key = usageKeys.serpapiGlobal()
    data(await server().create('usage', { day: DAY, key, count: LIMITS.maxSerpapiCallsPerDayGlobal }, usageRecordId(DAY, key)))
    for (const tripId of trips) data(await call(startSearch, ALICE, { tripId }, TEST_ENV))
    await finish(trips[0])
    data(await call(startSearch, ALICE, { tripId: trips[0] }, TEST_ENV))
    await finish(trips[0])
    expect(await call(startSearch, ALICE, { tripId: trips[0] }, TEST_ENV)).toMatchObject({ code: 'cap_reached' })
    // Without the flag the same names get no exemption.
    expect(await call(startSearch, ALICE, { tripId: await ready('__test-5') })).toMatchObject({ code: 'cap_reached' })
  })

  it('enqueue failure: the trip goes back to how it was and the search isn’t counted', async () => {
    const tripId = await ready()
    data(await server().update('trips', tripId, { status: 'results', searchError: 'old note', searchProgress: 1 }))
    enqueue.mockRejectedValueOnce(new Error('enqueueJob failed: 500'))
    expect(await call(startSearch, ALICE, { tripId })).toMatchObject({ success: false, code: 'enqueue_failed' })
    expect(tripRow(tripId).data).toMatchObject({ status: 'results', searchError: 'old note', searchProgress: 1, searchJobId: null })
    expect(usageCount(usageKeys.fullSearchTrip(tripId))).toBe(0)
    expect(usageCount(usageKeys.userTripsSearched(ALICE))).toBe(0)
    // And a retry works.
    expect(await call(startSearch, ALICE, { tripId })).toMatchObject({ success: true })
  })

  it('destinations are frozen while the search runs', async () => {
    const tripId = await ready()
    data(await call(startSearch, ALICE, { tripId }))
    expect(await call(addCandidate, BOB, { tripId, iata: 'DEN' })).toMatchObject({ code: 'search_running' })
  })
})

describe('toggleVote', () => {
  const votes = (tripId: string) => store.rows('votes').filter((r) => r.data.tripId === tripId)

  it('any member votes and unvotes; the vote is theirs whatever the params say', async () => {
    const tripId = await ready()
    expect(data(await call(toggleVote, BOB, { tripId, iata: 'AUS', userId: ALICE }))).toEqual({ iata: 'AUS', voted: true })
    expect(votes(tripId)).toHaveLength(1)
    expect(votes(tripId)[0].data).toMatchObject({ userId: BOB, candidateIata: 'AUS', memberIds: [ALICE, BOB] })

    expect(data(await call(toggleVote, ALICE, { tripId, iata: 'aus' }))).toEqual({ iata: 'AUS', voted: true })
    expect(votes(tripId)).toHaveLength(2)
    expect(data(await call(toggleVote, BOB, { tripId, iata: 'AUS' }))).toEqual({ iata: 'AUS', voted: false })
    expect(votes(tripId).map((v) => v.data.userId)).toEqual([ALICE])
  })

  it('refuses non-members, unknown destinations, bad params and locked trips', async () => {
    const tripId = await ready()
    expect(await call(toggleVote, CAROL, { tripId, iata: 'AUS' })).toMatchObject({ code: 'not_found' })
    expect(await call(toggleVote, BOB, { tripId, iata: 'DEN' })).toMatchObject({ code: 'not_found' })
    expect(await call(toggleVote, BOB, { tripId, iata: 'AUSTIN' })).toMatchObject({ code: 'invalid_params' })
    data(await server().update('trips', tripId, { status: 'locked' }))
    expect(await call(toggleVote, BOB, { tripId, iata: 'AUS' })).toMatchObject({ code: 'trip_locked' })
    expect(votes(tripId)).toEqual([])
  })

  it('a duplicate (double click) is answered as voted, not an error', async () => {
    const tripId = await ready()
    const tools = store.toolsFor(BOB)
    let first = true
    const racing = {
      ...tools,
      // The "find my vote" read misses once, as if two clicks read at the same moment.
      query: (async (collection, options) => {
        if (collection === 'votes' && first) {
          first = false
          await tools.create('votes', { tripId, memberIds: [ALICE, BOB], userId: BOB, candidateIata: 'AUS' })
          return { success: true, data: { records: [], count: 0 } }
        }
        return tools.query(collection, options)
      }) as typeof tools.query,
    }
    const res = await toggleVote({ userId: BOB, params: { tripId, iata: 'AUS' }, tools: racing, env: ENV, callerJwt: 'jwt' })
    expect(data(res)).toEqual({ iata: 'AUS', voted: true })
    expect(votes(tripId)).toHaveLength(1)
  })
})

describe('checkFaresNow', () => {
  /** A trip with results, the way the full search leaves it. */
  async function withResults(name?: string) {
    const tripId = await ready(name)
    await finish(tripId)
    return tripId
  }

  it('organizer: counts a watch check, marks the trip queued, enqueues a watch run', async () => {
    const tripId = await withResults()
    expect(data(await call(checkFaresNow, ALICE, { tripId }))).toEqual({ jobId: 'job_1' })
    expect(enqueue).toHaveBeenCalledWith(
      'JOB_ROOMS_BINDING',
      'app:app123',
      'fare-search',
      { tripId, mode: 'watch', countedOn: DAY },
      { maxAttempts: 2, enqueuedBy: ALICE },
    )
    expect(tripRow(tripId).data).toMatchObject({ status: 'results', watchQueuedAt: `${DAY}T12:00:00.000Z`, watchError: null })
    expect(usageCount(usageKeys.watchTrip(tripId))).toBe(1)
    // A watch check isn't a full search.
    expect(usageCount(usageKeys.fullSearchTrip(tripId))).toBe(0)
    expect(store.integrationCalls).toEqual([])
  })

  it('works on a locked trip too', async () => {
    const tripId = await withResults()
    data(await server().update('trips', tripId, { status: 'locked', lockedIata: 'AUS' }))
    expect(data(await call(checkFaresNow, ALICE, { tripId }))).toEqual({ jobId: 'job_1' })
  })

  it('organizer only; non-members get not_found', async () => {
    const tripId = await withResults()
    expect(await call(checkFaresNow, BOB, { tripId })).toMatchObject({ success: false, code: 'forbidden' })
    expect(await call(checkFaresNow, CAROL, { tripId })).toMatchObject({ success: false, code: 'not_found' })
    expect(await call(checkFaresNow, ALICE, {})).toMatchObject({ success: false, code: 'invalid_params' })
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('refused while searching, before results, and while a check is already queued (until it goes stale)', async () => {
    const tripId = await ready()
    expect(await call(checkFaresNow, ALICE, { tripId })).toMatchObject({ success: false, code: 'not_ready' })
    data(await call(startSearch, ALICE, { tripId }))
    expect(await call(checkFaresNow, ALICE, { tripId })).toMatchObject({ success: false, code: 'search_running' })

    await finish(tripId)
    data(await call(checkFaresNow, ALICE, { tripId }))
    expect(await call(checkFaresNow, ALICE, { tripId })).toMatchObject({ success: false, code: 'watch_running' })
    // The job clears the mark when it's done; a mark left by a dead job expires.
    vi.setSystemTime(new Date(Date.parse(`${DAY}T12:00:00Z`) + LIMITS.staleWatchMs))
    expect(data(await call(checkFaresNow, ALICE, { tripId }))).toMatchObject({ jobId: expect.any(String) })
  })

  it('refused once departure is a day away or less', async () => {
    const tripId = await withResults()
    data(await server().update('trips', tripId, { outboundDate: '2026-11-21' }))
    expect(await call(checkFaresNow, ALICE, { tripId })).toMatchObject({ success: false, code: 'watch_ended' })
    data(await server().update('trips', tripId, { outboundDate: '2026-11-22' }))
    expect(await call(checkFaresNow, ALICE, { tripId })).toMatchObject({ success: true })
  })

  it('at most 3 checks per trip per day (cap_reached), counting the cron’s', async () => {
    const tripId = await withResults()
    const key = usageKeys.watchTrip(tripId)
    data(await server().create('usage', { day: DAY, key, count: 2 }, usageRecordId(DAY, key)))
    data(await call(checkFaresNow, ALICE, { tripId }))
    data(await server().update('trips', tripId, { watchQueuedAt: null }))
    const refused = await call(checkFaresNow, ALICE, { tripId })
    expect(refused).toMatchObject({ success: false, code: 'cap_reached' })
    expect(refused.success ? '' : refused.error).toContain('3 times today')
    expect(usageCount(key)).toBe(LIMITS.maxWatchChecksPerTripPerDay)
  })

  it('refused when the global SerpApi budget is spent, except for __test- trips in dev/test', async () => {
    const global = usageKeys.serpapiGlobal()
    data(await server().create('usage', { day: DAY, key: global, count: LIMITS.maxSerpapiCallsPerDayGlobal }, usageRecordId(DAY, global)))
    const real = await withResults()
    expect(await call(checkFaresNow, ALICE, { tripId: real }, TEST_ENV)).toMatchObject({ success: false, code: 'cap_reached' })
    const test = await withResults('__test-watch')
    expect(await call(checkFaresNow, ALICE, { tripId: test }, TEST_ENV)).toMatchObject({ success: true })
    // Without the dev/test flag the same trip is held to the global budget.
    data(await server().update('trips', test, { watchQueuedAt: null }))
    expect(await call(checkFaresNow, ALICE, { tripId: test })).toMatchObject({ success: false, code: 'cap_reached' })
  })

  it('enqueue failure: the trip goes back to how it was and the check isn’t counted', async () => {
    const tripId = await withResults()
    enqueue.mockRejectedValueOnce(new Error('enqueueJob failed: 500'))
    expect(await call(checkFaresNow, ALICE, { tripId })).toMatchObject({ success: false, code: 'enqueue_failed' })
    expect(tripRow(tripId).data.watchQueuedAt ?? null).toBeNull()
    expect(usageCount(usageKeys.watchTrip(tripId))).toBe(0)
  })
})
