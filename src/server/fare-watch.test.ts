/**
 * The fare-search job in mode 'watch' (SPEC §3.9, §8.7) against the
 * in-memory store. Only the external boundary is replaced: `serpapi/flights`
 * answers are the saved fixture with every price shifted by a chosen amount
 * (so a test can make fares rise or drop), and `email/send` is recorded.
 * Shortlist choice, caching, ranking, snapshots, drop detection, budget
 * crossings, emailLog claims and caps all run for real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActionHandler, ActionResult, Job, JobContext } from 'deepspace/worker'
import type { Env } from '../../worker'
import error429 from '../lib/__fixtures__/serpapi-error-429.json'
import { usageKeys, usageRecordId } from '../lib/caps'
import { PROVIDER_UNAVAILABLE_MESSAGE, type SerpapiFlightsRequest } from '../lib/flights'
import { LIMITS, type Limits } from '../lib/limits'
import { addCandidate } from '../actions/candidates'
import { addGhost } from '../actions/ghosts'
import { createTrip, joinTrip } from '../actions/trips'
import { toggleVote } from '../actions/votes'
import { createFakeStore, type FakeStore } from './testing/fake-tools'
import { fixtureResponse } from './flights-source'
import { fareRecordId, runFareSearch, type FareSearchDeps } from './fare-search'

const ALICE = 'user_alice'
const BOB = 'user_bob'
const DANA = 'user_dana'
const DAY = '2026-11-20'
const at = (hhmm: string) => new Date(`${DAY}T${hhmm}:00Z`)

let store: FakeStore
const server = () => store.toolsFor('server')
interface SentEmail {
  to: string
  subject: string
  html: string
  text: string
}
let sent: SentEmail[]
let priceShift = 0
let serpapiMode: 'answer' | 'outage' | { okCalls: number } = 'answer'

function call(action: ActionHandler<Env>, userId: string, params: Record<string, unknown>) {
  return action({ userId, params, tools: store.toolsFor(userId), env: {} as Env, callerJwt: 'jwt' }) as Promise<
    ActionResult<Record<string, unknown>>
  >
}
function data<T = Record<string, unknown>>(res: ActionResult<unknown>): T {
  if (!res.success) throw new Error(`expected success, got ${res.code}: ${res.error}`)
  return res.data as T
}

/** The fixture for the route with every price moved by `priceShift`. */
function shifted(req: SerpapiFlightsRequest) {
  const raw = fixtureResponse(req) as Record<string, unknown>
  for (const list of ['best_flights', 'other_flights']) {
    // The fixture includes deliberately malformed entries (null, no price): leave them as they are.
    for (const item of (raw[list] as Array<Record<string, unknown> | null>) ?? []) {
      if (item && typeof item.price === 'number') item.price += priceShift
    }
  }
  return raw
}

let serpapiCalls = 0
function installBoundary() {
  store.onIntegration((endpoint, body) => {
    if (endpoint === 'email/send') {
      sent.push(body as SentEmail)
      return { success: true, data: { id: `email_${sent.length}` } }
    }
    if (endpoint !== 'serpapi/flights') return { success: false, error: `unexpected ${endpoint}` }
    serpapiCalls++
    if (serpapiMode === 'outage') return error429 as unknown as ActionResult<unknown>
    if (typeof serpapiMode === 'object' && serpapiCalls > serpapiMode.okCalls) return error429 as unknown as ActionResult<unknown>
    return { success: true, data: shifted(body as SerpapiFlightsRequest) }
  })
}
const flightRoutes = () =>
  store.integrationCalls
    .filter((c) => c.endpoint === 'serpapi/flights')
    .map((c) => `${(c.data as SerpapiFlightsRequest).departure_id}>${(c.data as SerpapiFlightsRequest).arrival_id}`)

let jobSeq = 0
function job(tripId: string, mode: 'full' | 'watch', id = `job_${++jobSeq}`, extra: Record<string, unknown> = {}): Job {
  return {
    id,
    type: 'fare-search',
    status: 'running',
    payload: { tripId, mode, ...extra },
    attempts: 1,
    maxAttempts: 2,
    enqueuedAt: new Date().toISOString(),
  } as Job
}
const ctx = (): JobContext => ({ progress: () => {}, continue: () => {}, signal: new AbortController().signal })
const deps = (over: Partial<FareSearchDeps> = {}): FareSearchDeps => ({
  tools: store.toolsFor('owner'),
  env: { APP_NAME: 'halfway-pearl' },
  fixtureDelayMs: 0,
  ...over,
})
const limitsWith = (over: Partial<Limits>): Limits => ({ ...LIMITS, ...over })

const tripRow = (tripId: string) => store.rows('trips').find((r) => r.recordId === tripId)!
const candidate = (tripId: string, iata: string) =>
  store.rows('candidates').find((r) => r.data.tripId === tripId && r.data.iata === iata)!
const fareOf = (tripId: string, iata: string, travelerId: string) =>
  store.rows('fares').find((r) => r.recordId === fareRecordId(tripId, iata, travelerId))!.data
const snapshotsFor = (tripId: string, iata?: string) =>
  store.rows('fareSnapshots').filter((r) => r.data.tripId === tripId && (!iata || r.data.candidateIata === iata))
const usageCount = (key: string) => store.rows('usage').find((r) => r.recordId === usageRecordId(DAY, key))?.data.count ?? 0
const subjects = () => sent.map((m) => `${m.to}: ${m.subject}`)

/**
 * Alice and Bob fly from ORD, Dana from BOS, ghost Grandpa lives in
 * Nashville (BNA). Destinations BNA, AUS, DEN, MIA. A full search at 12:00
 * with every price +$200, then votes: DEN ×3, MIA ×2, AUS ×1, so the watch
 * shortlist is DEN, MIA, AUS (BNA has no votes).
 */
async function setup(name = 'Spring break') {
  const { tripId, inviteCode } = data<{ tripId: string; inviteCode: string }>(
    await call(createTrip, ALICE, { name, outboundDate: '2026-12-11', returnDate: '2026-12-13' }),
  )
  data(await call(joinTrip, BOB, { inviteCode }))
  data(await call(joinTrip, DANA, { inviteCode }))
  for (const [userId, homes] of [
    [ALICE, ['ORD']],
    [BOB, ['ORD']],
    [DANA, ['BOS']],
  ] as const) {
    const row = store.rows('travelers').find((r) => r.data.tripId === tripId && r.data.userId === userId)!
    data(await server().update('travelers', row.recordId, { homeAirports: homes }))
  }
  const { ghostId } = data<{ ghostId: string }>(await call(addGhost, ALICE, { tripId, displayName: 'Grandpa', homeAirports: ['BNA'] }))
  for (const iata of ['BNA', 'AUS', 'DEN', 'MIA']) data(await call(addCandidate, ALICE, { tripId, iata }))

  priceShift = 200
  data(await server().update('trips', tripId, { status: 'searching' }))
  vi.setSystemTime(at('12:00'))
  expect(await runFareSearch(job(tripId, 'full'), ctx(), deps())).toMatchObject({ status: 'results' })
  for (const [userId, iata] of [
    [ALICE, 'DEN'],
    [BOB, 'DEN'],
    [DANA, 'DEN'],
    [ALICE, 'MIA'],
    [BOB, 'MIA'],
    [DANA, 'AUS'],
  ] as const) {
    data(await call(toggleVote, userId, { tripId, iata }))
  }
  store.integrationCalls.length = 0
  serpapiCalls = 0
  return { tripId, ghostId }
}

/** A watch run at `time` (≥ 18:00 means the 12:00 cache is stale). */
async function watchAt(tripId: string, time: string, over: Partial<FareSearchDeps> = {}, id?: string, extra?: Record<string, unknown>) {
  vi.setSystemTime(time.includes('T') ? new Date(time) : at(time))
  data(await server().update('trips', tripId, { watchQueuedAt: new Date().toISOString() }))
  return runFareSearch(job(tripId, 'watch', id, extra), ctx(), deps(over))
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(at('11:00'))
  store = createFakeStore()
  sent = []
  priceShift = 0
  serpapiMode = 'answer'
  serpapiCalls = 0
  for (const [id, name] of [
    [ALICE, 'Alice'],
    [BOB, 'Bob'],
    [DANA, 'Dana'],
  ]) {
    store.seed('users', id, { name, email: `${id}@example.test` }, id)
  }
  installBoundary()
})
afterEach(() => vi.useRealTimers())

describe('what a watch run re-checks', () => {
  it('only the shortlist (top 3 by votes): new fares, aggregates and one snapshot each; status and search fields untouched', async () => {
    const { tripId } = await setup()
    const before = tripRow(tripId).data
    const result = await watchAt(tripId, '19:00')

    expect(result).toMatchObject({ mode: 'watch', status: 'results', snapshots: 3, providerUnavailable: false, refunded: false })
    // DEN, MIA, AUS from ORD (Alice+Bob share), BOS and BNA (Grandpa) = 9 calls; nothing to BNA.
    expect(flightRoutes().sort()).toEqual(
      ['ORD>DEN', 'BOS>DEN', 'BNA>DEN', 'ORD>MIA', 'BOS>MIA', 'BNA>MIA', 'ORD>AUS', 'BOS>AUS', 'BNA>AUS'].sort(),
    )
    for (const iata of ['DEN', 'MIA', 'AUS']) {
      expect(snapshotsFor(tripId, iata), iata).toHaveLength(2)
      expect(candidate(tripId, iata).data.lastCheckedAt, iata).toBe(`${DAY}T19:00:00.000Z`)
    }
    expect(snapshotsFor(tripId, 'BNA')).toHaveLength(1)
    expect(candidate(tripId, 'BNA').data.lastCheckedAt).toBe(`${DAY}T12:00:00.000Z`)

    const after = tripRow(tripId).data
    expect(after).toMatchObject({ status: 'results', watchQueuedAt: null, watchError: null })
    // The full search's fields (Destinations progress, lastSearchAt) are left alone.
    expect(after.lastSearchAt).toBe(before.lastSearchAt)
    expect(after.searchProgress).toBe(before.searchProgress)
    expect(after.searchMessage).toBe(before.searchMessage)
    // Same prices as the search: no drop, no email.
    expect(sent).toEqual([])
  })

  it('reuses routes fetched less than 6h ago, and still writes a snapshot', async () => {
    const { tripId } = await setup()
    const result = await watchAt(tripId, '14:00')
    expect(result).toMatchObject({ calls: 0, cached: 9, snapshots: 3 })
    expect(flightRoutes()).toEqual([])
    expect(snapshotsFor(tripId, 'DEN')).toHaveLength(2)
  })

  it('a locked trip re-checks only the locked destination and stays locked', async () => {
    const { tripId } = await setup()
    data(await server().update('trips', tripId, { status: 'locked', lockedIata: 'BNA' }))
    const result = await watchAt(tripId, '19:00')
    expect(result).toMatchObject({ status: 'locked', snapshots: 1 })
    // Grandpa lives there (no call); Alice+Bob share ORD.
    expect(flightRoutes().sort()).toEqual(['BOS>BNA', 'ORD>BNA'])
    expect(snapshotsFor(tripId, 'BNA')).toHaveLength(2)
    expect(snapshotsFor(tripId, 'DEN')).toHaveLength(1)
    expect(tripRow(tripId).data).toMatchObject({ status: 'locked', lockedIata: 'BNA', watchQueuedAt: null })
  })

  it('skips (and clears the pending mark) when a full search is running, there are no results, or departure is ≤ 1 day away', async () => {
    const { tripId } = await setup()
    data(await server().update('trips', tripId, { status: 'searching' }))
    expect(await watchAt(tripId, '19:00')).toEqual({ skipped: 'not_watchable' })
    expect(tripRow(tripId).data.watchQueuedAt).toBeNull()

    data(await server().update('trips', tripId, { status: 'results', outboundDate: '2026-11-21' }))
    expect(await watchAt(tripId, '19:00')).toEqual({ skipped: 'watch_ended' })
    expect(tripRow(tripId).data.watchQueuedAt).toBeNull()
    expect(flightRoutes()).toEqual([])
  })
})

describe('group drop emails', () => {
  it('a drop ≥ max($50, 5%) emails each real member once, with group totals and their own fare, never a budget', async () => {
    const { tripId } = await setup()
    // Budgets exist (one of them a distinctive amount) but must never reach a group email.
    data(await store.toolsFor(BOB).create('budgets', { tripId, userId: BOB, maxUsd: 4321 }))
    const denBefore = candidate(tripId, 'DEN').data.groupTotal as number

    priceShift = 100 // every fare $100 cheaper than the search
    const result = await watchAt(tripId, '19:00')
    const denAfter = candidate(tripId, 'DEN').data.groupTotal as number
    expect(denBefore - denAfter).toBe(400) // 4 travelers flying

    expect(result).toMatchObject({ emails: { group: { sent: 3 }, private: { sent: 0 }, mocked: false } })
    // Alice, Bob and Dana (Grandpa is a ghost: no account, no email).
    expect(sent.map((m) => m.to).sort()).toEqual([ALICE, BOB, DANA].map((id) => `${id}@example.test`))
    for (const m of sent) {
      expect(m.subject).toBe('Halfway: fares dropped for Spring break')
      expect(m.text).toContain(`Denver (DEN): group total $${denBefore.toLocaleString('en-US')} → $${denAfter.toLocaleString('en-US')}`)
      expect(`${m.text}${m.html}`).not.toContain('4,321')
      expect(`${m.text}${m.html}`).not.toContain('4321')
      expect(`${m.text}${m.html}`.toLowerCase()).not.toContain('budget')
      expect(Object.keys(m).sort()).toEqual(['html', 'subject', 'text', 'to'])
    }
    // Each person sees their own fare.
    const dana = sent.find((m) => m.to.startsWith(DANA))!
    expect(dana.text).toContain(`Your fare: $${fareOf(tripId, 'DEN', DANA).price}`)
    expect(store.rows('emailLog').filter((r) => r.data.kind === 'drop' && r.data.status === 'sent')).toHaveLength(3)
    expect(usageCount(usageKeys.emailTrip(tripId))).toBe(3)
  })

  it('a retry or duplicate delivery of the same run resends nothing; a later run with no new drop sends nothing', async () => {
    const { tripId } = await setup()
    priceShift = 100
    await watchAt(tripId, '19:00', {}, 'job_watch_1')
    expect(sent).toHaveLength(3)

    // Same job delivered again (its own snapshot is ignored, the drop is seen again, the claims stop it).
    const again = await watchAt(tripId, '19:05', {}, 'job_watch_1')
    expect(again).toMatchObject({ emails: { group: { sent: 0, alreadySent: 3 } } })

    // A new run at the same prices compares with the lowered snapshot: no drop.
    const later = await watchAt(tripId, '23:30')
    expect(later).toMatchObject({ emails: { group: { sent: 0, alreadySent: 0 } } })
    expect(sent).toHaveLength(3)
  })

  it('a drop under the threshold sends nothing', async () => {
    const { tripId } = await setup()
    priceShift = 195 // $5 × 4 travelers = $20 < $50
    expect(await watchAt(tripId, '19:00')).toMatchObject({ snapshots: 3, emails: { group: { sent: 0 } } })
    expect(sent).toEqual([])
  })

  it('respects the per-trip email cap; the rest are reported as capped', async () => {
    const { tripId } = await setup()
    const key = usageKeys.emailTrip(tripId)
    data(await server().create('usage', { day: DAY, key, count: LIMITS.maxEmailsPerTripPerDay - 1 }, usageRecordId(DAY, key)))
    priceShift = 100
    expect(await watchAt(tripId, '19:00')).toMatchObject({ emails: { group: { sent: 1, capped: 2 } } })
    expect(sent).toHaveLength(1)
    expect(usageCount(key)).toBe(LIMITS.maxEmailsPerTripPerDay)
  })

  it('a __test- trip in dev/test builds the emails but mocks the send (nothing counted)', async () => {
    const { tripId } = await setup('__test-watch emails')
    // Fixture answers don't move, so fake a pricier earlier check to create a drop.
    const den = candidate(tripId, 'DEN').data.groupTotal as number
    store.seed('fareSnapshots', `${tripId}|DEN|older`, {
      tripId,
      memberIds: [ALICE, BOB, DANA],
      candidateIata: 'DEN',
      groupTotal: den + 500,
      maxFare: null,
      checkedAt: `${DAY}T12:30:00.000Z`,
    })
    const result = await watchAt(tripId, '13:00', { env: { APP_NAME: 'halfway-pearl', ALLOW_DEBUG_ROUTES: 'true' } })
    expect(result).toMatchObject({ emails: { group: { sent: 3 }, mocked: true } })
    expect(sent).toEqual([])
    expect(store.rows('emailLog').every((r) => r.data.mocked === 1)).toBe(true)
    expect(usageCount(usageKeys.emailTrip(tripId))).toBe(0)
  })
})

describe('private "now within your budget" emails', () => {
  it('only the traveler whose fare crossed under their budget, only the first time', async () => {
    const { tripId } = await setup()
    const aliceDen = fareOf(tripId, 'DEN', ALICE).price as number
    // Alice's budget sits between the search price and $100 less. Dana's is far below either.
    const budget = aliceDen - 37
    data(await store.toolsFor(ALICE).create('budgets', { tripId, userId: ALICE, maxUsd: budget }))
    data(await store.toolsFor(DANA).create('budgets', { tripId, userId: DANA, maxUsd: 1 }))

    // Every destination where Alice goes from above her budget to at-or-below it with fares $100 lower.
    const crossing = ['DEN', 'MIA', 'AUS'].filter((iata) => {
      const p = fareOf(tripId, iata, ALICE).price as number
      return p > budget && p - 100 <= budget
    })
    expect(crossing).toContain('DEN')

    priceShift = 100
    const first = await watchAt(tripId, '19:00')
    expect(first).toMatchObject({ emails: { private: { sent: crossing.length } } })
    const privateMails = sent.filter((m) => m.subject.includes('fits your budget'))
    // Only Alice: Dana's fares stay far above her $1, Bob has no budget, Grandpa is a ghost.
    expect(new Set(privateMails.map((m) => m.to))).toEqual(new Set([`${ALICE}@example.test`]))
    const den = privateMails.find((m) => m.subject === 'Halfway: your fare to Denver now fits your budget')!
    expect(den.text).toContain(`is now $${aliceDen - 100}`)
    // The amount itself is never written, not even to its owner.
    for (const m of sent) expect(`${m.text}${m.html}`).not.toContain(String(budget))

    // Back above the budget (7h later, so the cache is stale), then under again:
    // the crossing repeats but the email doesn't.
    priceShift = 200
    await watchAt(tripId, '2026-11-21T02:00:00Z')
    priceShift = 100
    const again = await watchAt(tripId, '2026-11-21T09:00:00Z')
    expect(again).toMatchObject({ emails: { private: { sent: 0, alreadySent: crossing.length } } })
    expect(sent.filter((m) => m.subject.includes('fits your budget'))).toHaveLength(crossing.length)
  })

  it('no email when the fare was already within budget before the check', async () => {
    const { tripId } = await setup()
    data(await store.toolsFor(ALICE).create('budgets', { tripId, userId: ALICE, maxUsd: 100_000 }))
    priceShift = 100
    expect(await watchAt(tripId, '19:00')).toMatchObject({ emails: { private: { sent: 0 } } })
  })
})

describe('provider outages during a watch run', () => {
  it('a total outage keeps every previous fare, writes no snapshot, says why, and refunds the watch check', async () => {
    const { tripId } = await setup()
    const watchKey = usageKeys.watchTrip(tripId)
    data(await server().create('usage', { day: DAY, key: watchKey, count: 1 }, usageRecordId(DAY, watchKey)))
    const denBefore = fareOf(tripId, 'DEN', DANA)

    serpapiMode = 'outage'
    const result = await watchAt(tripId, '19:00', { limits: limitsWith({ searchConcurrency: 1 }) }, undefined, { countedOn: DAY })
    expect(result).toMatchObject({ providerUnavailable: true, refunded: true, snapshots: 0, status: 'results' })
    expect(fareOf(tripId, 'DEN', DANA)).toEqual(denBefore)
    expect(candidate(tripId, 'DEN').data.complete).toBe(1)
    expect(snapshotsFor(tripId, 'DEN')).toHaveLength(1)
    expect(tripRow(tripId).data).toMatchObject({ status: 'results', watchQueuedAt: null, watchError: PROVIDER_UNAVAILABLE_MESSAGE })
    expect(usageCount(watchKey)).toBe(0)
    expect(sent).toEqual([])
  })

  it('a partial outage snapshots only fully re-checked destinations and still counts', async () => {
    const { tripId } = await setup()
    const watchKey = usageKeys.watchTrip(tripId)
    data(await server().create('usage', { day: DAY, key: watchKey, count: 1 }, usageRecordId(DAY, watchKey)))
    serpapiMode = { okCalls: 3 } // DEN's three routes come first (shortlist order)
    const result = await watchAt(tripId, '19:00', { limits: limitsWith({ searchConcurrency: 1 }) })
    expect(result).toMatchObject({ providerUnavailable: true, refunded: false, snapshots: 1 })
    expect(snapshotsFor(tripId, 'DEN')).toHaveLength(2)
    expect(snapshotsFor(tripId, 'MIA')).toHaveLength(1)
    expect(candidate(tripId, 'MIA').data.lastCheckedAt).toBe(`${DAY}T12:00:00.000Z`)
    expect(usageCount(watchKey)).toBe(1)
  })
})
