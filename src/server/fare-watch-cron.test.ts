/**
 * The daily `fare-watch` cron task (SPEC §9) against the in-memory store.
 * The JobRoom is the one thing replaced (enqueue is a worker-to-DO call).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../../worker'
import { usageKeys, usageRecordId } from '../lib/caps'
import { LIMITS } from '../lib/limits'
import { tasks } from '../cron'
import { createFakeStore, type FakeStore } from './testing/fake-tools'
import { runFareWatchCron } from './fare-watch-cron'

const DAY = '2026-11-21'
// 08:00 in Chicago (CST, UTC−6) is 14:00 UTC.
const CRON_TIME = new Date(`${DAY}T14:00:00Z`)
const ENV = { JOB_ROOMS: 'JOB_ROOMS_BINDING', DEEPSPACE_APP_ID: 'app123', OWNER_USER_ID: 'owner' } as unknown as Env

let store: FakeStore
let enqueue: ReturnType<typeof vi.fn>
const server = () => store.toolsFor('server')
const usageCount = (key: string) => store.rows('usage').find((r) => r.recordId === usageRecordId(DAY, key))?.data.count ?? 0
const tripRow = (id: string) => store.rows('trips').find((r) => r.recordId === id)!
const enqueuedTrips = () => enqueue.mock.calls.map((c) => (c[3] as { tripId: string }).tripId).sort()

let n = 0
function trip(over: Record<string, unknown> = {}) {
  const id = `trip_${++n}`
  store.seed('trips', id, {
    name: `Trip ${n}`,
    organizerId: 'user_alice',
    memberIds: ['user_alice'],
    inviteCode: `code${n}`,
    status: 'results',
    outboundDate: '2026-12-11',
    returnDate: '2026-12-13',
    watchEnabled: 1,
    ...over,
  })
  return id
}
const run = () => runFareWatchCron(store.toolsFor('owner'), ENV, { now: () => CRON_TIME, enqueue: enqueue as never })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(CRON_TIME)
  store = createFakeStore()
  n = 0
  let jobs = 0
  enqueue = vi.fn(async () => `job_${++jobs}`)
})
afterEach(() => vi.useRealTimers())

describe('the fare-watch task', () => {
  it('is scheduled daily at 08:00 America/Chicago', () => {
    expect(tasks).toEqual([{ name: 'fare-watch', schedule: '0 8 * * *', timezone: 'America/Chicago' }])
  })

  it('enqueues a watch run for eligible trips only, counting each check and setting today’s marker', async () => {
    const results = trip()
    const locked = trip({ status: 'locked', lockedIata: 'BNA' })
    trip({ watchEnabled: 0 })
    trip({ status: 'gathering' })
    trip({ status: 'searching' })
    trip({ outboundDate: '2026-11-22' }) // tomorrow: watching has stopped
    const report = await run()

    expect(report).toMatchObject({ eligible: 2, enqueued: 2, alreadyToday: 0, capped: 0, failed: 0 })
    expect(enqueuedTrips()).toEqual([results, locked].sort())
    expect(enqueue).toHaveBeenCalledWith(
      'JOB_ROOMS_BINDING',
      'app:app123',
      'fare-search',
      { tripId: results, mode: 'watch', countedOn: DAY },
      { maxAttempts: 2, enqueuedBy: 'owner' },
    )
    for (const id of [results, locked]) {
      expect(usageCount(usageKeys.watchTrip(id))).toBe(1)
      expect(usageCount(usageKeys.watchCronTrip(id))).toBe(1)
      expect(tripRow(id).data.watchQueuedAt).toBe(CRON_TIME.toISOString())
    }
  })

  it('at most once per trip per day: a second run the same day enqueues nothing', async () => {
    const id = trip()
    await run()
    // The job finished in between.
    await server().update('trips', id, { watchQueuedAt: null })
    expect(await run()).toMatchObject({ enqueued: 0, alreadyToday: 1 })
    expect(enqueue).toHaveBeenCalledTimes(1)
    expect(usageCount(usageKeys.watchTrip(id))).toBe(1)
  })

  it('at most 10 trips per run, soonest departure first', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => trip({ outboundDate: `2026-12-${String(10 + i).padStart(2, '0')}` }))
    const report = await run()
    expect(report).toMatchObject({ eligible: 12, enqueued: LIMITS.maxWatchTripsPerCronRun })
    expect(enqueuedTrips()).toEqual(ids.slice(0, 10).sort())
  })

  it('skips a trip whose watch check is already queued, or whose daily watch checks are used up', async () => {
    const queued = trip({ watchQueuedAt: new Date(CRON_TIME.getTime() - 60_000).toISOString() })
    const used = trip()
    const key = usageKeys.watchTrip(used)
    await server().create('usage', { day: DAY, key, count: LIMITS.maxWatchChecksPerTripPerDay }, usageRecordId(DAY, key))
    expect(await run()).toMatchObject({ eligible: 2, enqueued: 0, pending: 1, capped: 1 })
    expect(enqueue).not.toHaveBeenCalled()
    expect(usageCount(usageKeys.watchCronTrip(queued))).toBe(0)
  })

  it('stops at the global SerpApi budget', async () => {
    trip()
    const global = usageKeys.serpapiGlobal()
    await server().create('usage', { day: DAY, key: global, count: LIMITS.maxSerpapiCallsPerDayGlobal }, usageRecordId(DAY, global))
    expect(await run()).toMatchObject({ enqueued: 0, capped: 1 })
  })

  it('an enqueue failure rolls the counters and the queued mark back, and the next trip still runs', async () => {
    const first = trip({ outboundDate: '2026-12-01' })
    const second = trip({ outboundDate: '2026-12-02' })
    enqueue.mockRejectedValueOnce(new Error('enqueueJob failed: 500'))
    expect(await run()).toMatchObject({ enqueued: 1, failed: 1 })
    expect(usageCount(usageKeys.watchTrip(first))).toBe(0)
    expect(usageCount(usageKeys.watchCronTrip(first))).toBe(0)
    expect(tripRow(first).data.watchQueuedAt ?? null).toBeNull()
    expect(usageCount(usageKeys.watchCronTrip(second))).toBe(1)
  })
})
