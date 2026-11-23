import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActionHandler, ActionResult } from 'deepspace/worker'
import type { Env } from '../../worker'
import { usageKeys, usageRecordId } from '../lib/caps'
import { LIMITS } from '../lib/limits'
import { sendLockEmails, STALE_CLAIM_MS } from '../server/lock-emails'
import { loadTrip } from '../server/trip-access'
import { createFakeStore, type FakeStore } from '../server/testing/fake-tools'
import { addCandidate } from './candidates'
import { addGhost } from './ghosts'
import { lockTrip, setWatch } from './lock'
import { createTrip, joinTrip } from './trips'

const ALICE = 'user_alice'
const BOB = 'user_bob'
const CAROL = 'user_carol'
const DAY = '2026-11-20'
const ENV = { APP_NAME: 'halfway-pearl' } as unknown as Env
const TEST_ENV = { ...ENV, ALLOW_DEBUG_ROUTES: 'true' } as Env

let store: FakeStore
/** Every email/send body the fake integration received. */
let sent: Array<{ to: string; subject: string; html: string; text: string; [k: string]: unknown }>

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
const tripRow = (tripId: string) => store.rows('trips').find((r) => r.recordId === tripId)!
const usageCount = (key: string) =>
  store.rows('usage').find((r) => r.recordId === usageRecordId(DAY, key))?.data.count ?? 0

interface Ready {
  tripId: string
  inviteCode: string
  ghostId: string
}

/**
 * Alice (ORD) organizes, Bob (BOS) joined, ghost Grandpa (DEN). Searched:
 * BNA is complete, SAN is missing Bob's fare. Alice and Bob have budgets.
 */
async function ready(name = 'Spring break'): Promise<Ready> {
  const { tripId, inviteCode } = data<{ tripId: string; inviteCode: string }>(
    await call(createTrip, ALICE, { name, outboundDate: '2026-12-11', returnDate: '2026-12-13' }),
  )
  data(await call(joinTrip, BOB, { inviteCode }))
  const { ghostId } = data<{ ghostId: string }>(
    await call(addGhost, ALICE, { tripId, displayName: 'Grandpa', homeAirports: ['DEN'] }),
  )
  for (const [userId, homes] of [
    [ALICE, ['ORD']],
    [BOB, ['BOS']],
  ] as const) {
    const row = store.rows('travelers').find((r) => r.data.tripId === tripId && r.data.userId === userId)!
    data(await server().update('travelers', row.recordId, { homeAirports: homes }))
  }
  data(await call(addCandidate, ALICE, { tripId, iata: 'BNA' }))
  data(await call(addCandidate, ALICE, { tripId, iata: 'SAN' }))
  const memberIds = [ALICE, BOB]
  const fare = (iata: string, travelerId: string, price: number, originIata: string) =>
    server().create(
      'fares',
      {
        tripId,
        memberIds,
        candidateIata: iata,
        travelerId,
        originIata,
        price,
        priceLevel: 'typical',
        stops: 0,
        durationMin: 120,
        departLocal: '2026-12-11 07:00',
        arriveLocal: '2026-12-11 09:00',
        airline: 'Southwest',
        bookingUrl: `https://www.google.com/travel/flights?tfs=${travelerId}`,
        status: 'ok',
        fetchedAt: `${DAY}T11:00:00Z`,
      },
      `${tripId}|${iata}|${travelerId}`,
    )
  data(await fare('BNA', ALICE, 211, 'ORD'))
  data(await fare('BNA', BOB, 333, 'BOS'))
  data(await fare('BNA', ghostId, 199, 'DEN'))
  data(await fare('SAN', ALICE, 250, 'ORD'))
  for (const c of store.rows('candidates').filter((r) => r.data.tripId === tripId)) {
    const complete = c.data.iata === 'BNA' ? 1 : 0
    data(await server().update('candidates', c.recordId, { complete, groupTotal: complete ? 743 : null, lastCheckedAt: `${DAY}T11:00:00Z` }))
  }
  // Private budgets with distinctive amounts, to prove they never reach an email.
  store.seed('budgets', `b_${tripId}_a`, { tripId, userId: ALICE, maxUsd: 4321 }, ALICE)
  store.seed('budgets', `b_${tripId}_b`, { tripId, userId: BOB, maxUsd: 9876 }, BOB)
  data(await server().update('trips', tripId, { status: 'results', searchProgress: 1 }))
  return { tripId, inviteCode, ghostId }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(`${DAY}T12:00:00Z`))
  store = createFakeStore()
  for (const [id, name] of [
    [ALICE, 'Alice'],
    [BOB, 'Bob'],
    [CAROL, 'Carol'],
  ]) {
    store.seed('users', id, { name, email: `${id.replace('user_', '')}@example.test` }, id)
  }
  sent = []
  store.onIntegration((endpoint, body) => {
    if (endpoint !== 'email/send') return { success: false, error: `unexpected ${endpoint}` }
    sent.push(body as (typeof sent)[number])
    return { success: true, data: { id: `email_${sent.length}` } }
  })
})
afterEach(() => vi.useRealTimers())

describe('lockTrip', () => {
  it('organizer locks a complete destination: status locked, lockedIata, one email per REAL member (ghost excluded)', async () => {
    const { tripId } = await ready()
    const res = data<{ emails: Record<string, unknown>; alreadyLocked: boolean }>(
      await call(lockTrip, ALICE, { tripId, iata: 'bna' }),
    )
    expect(tripRow(tripId).data).toMatchObject({ status: 'locked', lockedIata: 'BNA' })
    expect(res.alreadyLocked).toBe(false)
    expect(res.emails).toEqual({ sent: 2, alreadySent: 0, noEmail: 0, capped: 0, failed: 0, mocked: false, emailsOff: false })
    expect(sent.map((m) => m.to).sort()).toEqual(['alice@example.test', 'bob@example.test'])
    // Each person gets their own fare and link, nobody else's.
    const bob = sent.find((m) => m.to === 'bob@example.test')!
    expect(bob.text).toContain('$333 round trip from BOS to BNA')
    expect(bob.text).toContain('tfs=user_bob')
    expect(bob.text).not.toContain('$211')
    expect(bob.text).not.toContain('Grandpa')
    // email/send bodies: one recipient, no from / reply_to / cc / bcc.
    for (const m of sent) {
      expect(Object.keys(m).sort()).toEqual(['html', 'subject', 'text', 'to'])
      expect(m.subject).toMatch(/^Halfway: /)
      for (const part of [m.subject, m.text, m.html]) {
        for (const secret of ['4321', '4,321', '9876', '9,876', 'alice@example.test', 'bob@example.test']) {
          if (secret === m.to) continue
          expect(part, `${m.to} must not contain ${secret}`).not.toContain(secret)
        }
      }
    }
    // Counted against the email caps; the log holds no addresses.
    expect(usageCount(usageKeys.emailTrip(tripId))).toBe(2)
    expect(usageCount(usageKeys.emailGlobal())).toBe(2)
    const log = store.rows('emailLog')
    expect(log.map((r) => r.data.status)).toEqual(['sent', 'sent'])
    expect(JSON.stringify(log)).not.toContain('@example.test')
  })

  it('retry: calling it again for the same destination sends nothing new; a different destination is refused', async () => {
    const { tripId } = await ready()
    data(await call(lockTrip, ALICE, { tripId, iata: 'BNA' }))
    expect(sent).toHaveLength(2)

    const again = data<{ emails: Record<string, unknown>; alreadyLocked: boolean }>(
      await call(lockTrip, ALICE, { tripId, iata: 'BNA' }),
    )
    expect(again.alreadyLocked).toBe(true)
    expect(again.emails).toMatchObject({ sent: 0, alreadySent: 2 })
    expect(sent).toHaveLength(2)
    expect(usageCount(usageKeys.emailTrip(tripId))).toBe(2)

    expect(await call(lockTrip, ALICE, { tripId, iata: 'SAN' })).toMatchObject({ success: false, code: 'trip_locked' })
  })

  it('two lock calls at once still send each person one email', async () => {
    const { tripId } = await ready()
    const [a, b] = await Promise.all([
      call(lockTrip, ALICE, { tripId, iata: 'BNA' }),
      call(lockTrip, ALICE, { tripId, iata: 'BNA' }),
    ])
    expect(a.success && b.success).toBe(true)
    expect(sent.map((m) => m.to).sort()).toEqual(['alice@example.test', 'bob@example.test'])
  })

  it('an email failure does not undo the lock; the retry sends only the missing one', async () => {
    const { tripId } = await ready()
    store.onIntegration((_endpoint, body) => {
      const msg = body as (typeof sent)[number]
      if (msg.to === 'bob@example.test') return { success: false, error: 'email (502): provider down', code: 'upstream_provider_error' } as never
      sent.push(msg)
      return { success: true, data: {} }
    })
    const first = data<{ emails: Record<string, unknown> }>(await call(lockTrip, ALICE, { tripId, iata: 'BNA' }))
    expect(first.emails).toMatchObject({ sent: 1, failed: 1 })
    expect(tripRow(tripId).data).toMatchObject({ status: 'locked', lockedIata: 'BNA' })
    // A failed send may have been billed, so it counts.
    expect(usageCount(usageKeys.emailTrip(tripId))).toBe(2)
    expect(store.rows('emailLog')).toHaveLength(1)

    store.onIntegration((_endpoint, body) => {
      sent.push(body as (typeof sent)[number])
      return { success: true, data: {} }
    })
    const retry = data<{ emails: Record<string, unknown> }>(await call(lockTrip, ALICE, { tripId, iata: 'BNA' }))
    expect(retry.emails).toMatchObject({ sent: 1, alreadySent: 1, failed: 0 })
    expect(sent.map((m) => m.to)).toEqual(['alice@example.test', 'bob@example.test'])
  })

  it('a failure with billing released is not counted', async () => {
    const { tripId } = await ready()
    store.onIntegration(() => ({ success: false, error: 'email (429): quota', code: 'upstream_provider_error', billing: 'released' }) as never)
    const res = data<{ emails: Record<string, unknown> }>(await call(lockTrip, ALICE, { tripId, iata: 'BNA' }))
    expect(res.emails).toMatchObject({ sent: 0, failed: 2 })
    expect(usageCount(usageKeys.emailTrip(tripId))).toBe(0)
  })

  it('respects the per-trip and global email caps; capped emails go out on a later retry', async () => {
    const { tripId } = await ready()
    // One email left on this trip today.
    store.seed('usage', usageRecordId(DAY, usageKeys.emailTrip(tripId)), {
      day: DAY,
      key: usageKeys.emailTrip(tripId),
      count: LIMITS.maxEmailsPerTripPerDay - 1,
    })
    const first = data<{ emails: Record<string, unknown> }>(await call(lockTrip, ALICE, { tripId, iata: 'BNA' }))
    expect(first.emails).toMatchObject({ sent: 1, capped: 1 })
    expect(sent).toHaveLength(1)
    expect(usageCount(usageKeys.emailTrip(tripId))).toBe(LIMITS.maxEmailsPerTripPerDay)

    // Global cap reached too: nothing more today.
    store.seed('usage', usageRecordId(DAY, usageKeys.emailGlobal()), {
      day: DAY,
      key: usageKeys.emailGlobal(),
      count: LIMITS.maxEmailsPerDayGlobal,
    })
    const blocked = data<{ emails: Record<string, unknown> }>(await call(lockTrip, ALICE, { tripId, iata: 'BNA' }))
    expect(blocked.emails).toMatchObject({ sent: 0, alreadySent: 1, capped: 1 })

    // Tomorrow the counters reset and the retry sends the missing one.
    vi.setSystemTime(new Date('2026-11-21T09:00:00Z'))
    const retry = data<{ emails: Record<string, unknown> }>(await call(lockTrip, ALICE, { tripId, iata: 'BNA' }))
    expect(retry.emails).toMatchObject({ sent: 1, alreadySent: 1, capped: 0 })
    expect(sent).toHaveLength(2)
  })

  it('members without a usable address are skipped and reported', async () => {
    const { tripId } = await ready()
    store.seed('users', BOB, { name: 'Bob', email: 'not an address' }, BOB)
    const res = data<{ emails: Record<string, unknown> }>(await call(lockTrip, ALICE, { tripId, iata: 'BNA' }))
    expect(res.emails).toMatchObject({ sent: 1, noEmail: 1 })
  })

  it('dev/test seam: __test- trips build the emails but never call email/send, and spend nothing', async () => {
    const { tripId } = await ready('__test-lock')
    const res = data<{ emails: Record<string, unknown> }>(await call(lockTrip, ALICE, { tripId, iata: 'BNA' }, TEST_ENV))
    expect(res.emails).toEqual({ sent: 2, alreadySent: 0, noEmail: 0, capped: 0, failed: 0, mocked: true, emailsOff: false })
    expect(store.integrationCalls).toEqual([])
    expect(usageCount(usageKeys.emailTrip(tripId))).toBe(0)
    // Dedupe still applies.
    const again = data<{ emails: Record<string, unknown> }>(await call(lockTrip, ALICE, { tripId, iata: 'BNA' }, TEST_ENV))
    expect(again.emails).toMatchObject({ sent: 0, alreadySent: 2 })
  })

  it('the seam is inert without ALLOW_DEBUG_ROUTES, and __test-real-email- trips send for real in dev/test', async () => {
    const prod = await ready('__test-lock-prod')
    data(await call(lockTrip, ALICE, { tripId: prod.tripId, iata: 'BNA' }, ENV))
    expect(sent).toHaveLength(2)

    const real = await ready('__test-real-email-x')
    const res = data<{ emails: Record<string, unknown> }>(await call(lockTrip, ALICE, { tripId: real.tripId, iata: 'BNA' }, TEST_ENV))
    expect(res.emails).toMatchObject({ sent: 2, mocked: false })
    expect(sent).toHaveLength(4)
  })

  it('a stale "sending" claim (worker died mid-send) is retried; a fresh one is left alone', async () => {
    const { tripId } = await ready()
    store.seed('emailLog', 'claim_bob', {
      key: `lock|${tripId}|BNA|${BOB}`,
      kind: 'lock',
      tripId,
      userId: BOB,
      iata: 'BNA',
      status: 'sending',
      claimedAt: new Date(Date.now() - 60_000).toISOString(),
    })
    const first = data<{ emails: Record<string, unknown> }>(await call(lockTrip, ALICE, { tripId, iata: 'BNA' }))
    expect(first.emails).toMatchObject({ sent: 1, alreadySent: 1 })

    vi.setSystemTime(new Date(Date.now() + STALE_CLAIM_MS + 1000))
    const later = data<{ emails: Record<string, unknown> }>(await call(lockTrip, ALICE, { tripId, iata: 'BNA' }))
    expect(later.emails).toMatchObject({ sent: 1, alreadySent: 1 })
    expect(sent.map((m) => m.to)).toEqual(['alice@example.test', 'bob@example.test'])
  })

  it('refuses: non-organizer, non-member, wrong status, incomplete or unknown destination', async () => {
    const { tripId } = await ready()
    expect(await call(lockTrip, BOB, { tripId, iata: 'BNA' })).toMatchObject({ code: 'forbidden' })
    expect(await call(lockTrip, CAROL, { tripId, iata: 'BNA' })).toMatchObject({ code: 'not_found' })
    expect(await call(lockTrip, ALICE, { tripId, iata: 'SAN' })).toMatchObject({ code: 'incomplete' })
    expect(await call(lockTrip, ALICE, { tripId, iata: 'MIA' })).toMatchObject({ code: 'not_found' })
    expect(await call(lockTrip, ALICE, { tripId, iata: 'B1' })).toMatchObject({ code: 'invalid_params' })
    expect(await call(lockTrip, ALICE, { tripId: 'bad id!', iata: 'BNA' })).toMatchObject({ code: 'invalid_params' })

    data(await server().update('trips', tripId, { status: 'searching' }))
    expect(await call(lockTrip, ALICE, { tripId, iata: 'BNA' })).toMatchObject({ code: 'search_running' })
    data(await server().update('trips', tripId, { status: 'gathering' }))
    expect(await call(lockTrip, ALICE, { tripId, iata: 'BNA' })).toMatchObject({ code: 'not_ready' })

    expect(sent).toEqual([])
    expect(tripRow(tripId).data.status).toBe('gathering')
  })

  it('after the lock, newcomers are refused (joinTrip trip_locked)', async () => {
    const { tripId, inviteCode } = await ready()
    data(await call(lockTrip, ALICE, { tripId, iata: 'BNA' }))
    expect(await call(joinTrip, CAROL, { inviteCode })).toMatchObject({ success: false, code: 'trip_locked' })
    expect((await loadTrip(server(), tripId)).ok && tripRow(tripId).data.memberIds).toEqual([ALICE, BOB])
  })

  it('a thrown storage error while emailing still leaves the trip locked', async () => {
    const { tripId } = await ready()
    store.onIntegration(() => {
      throw new Error('boom')
    })
    const res = data<{ emails: unknown }>(await call(lockTrip, ALICE, { tripId, iata: 'BNA' }))
    expect(res.emails).toBeNull()
    expect(tripRow(tripId).data).toMatchObject({ status: 'locked', lockedIata: 'BNA' })
  })
})

describe('sendLockEmails', () => {
  it('skips a member who left memberIds and every ghost row', async () => {
    const { tripId } = await ready()
    const access = await loadTrip(server(), tripId)
    if (!access.ok) throw new Error('no trip')
    const trip = { ...access.trip, data: { ...access.trip.data, memberIds: [ALICE] } }
    const report = await sendLockEmails(server(), ENV, trip, { iata: 'BNA', city: 'Nashville', country: 'United States' })
    expect(report).toMatchObject({ sent: 1 })
    expect(sent.map((m) => m.to)).toEqual(['alice@example.test'])
  })
})

describe('setWatch', () => {
  it('organizer turns the watch off and on; others are refused; params validated', async () => {
    const { tripId } = await ready()
    expect(data(await call(setWatch, ALICE, { tripId, enabled: false }))).toMatchObject({ watchEnabled: 0 })
    expect(tripRow(tripId).data.watchEnabled).toBe(0)
    expect(data(await call(setWatch, ALICE, { tripId, enabled: 1 }))).toMatchObject({ watchEnabled: 1 })
    expect(await call(setWatch, BOB, { tripId, enabled: false })).toMatchObject({ code: 'forbidden' })
    expect(await call(setWatch, CAROL, { tripId, enabled: false })).toMatchObject({ code: 'not_found' })
    expect(await call(setWatch, ALICE, { tripId, enabled: 'yes' })).toMatchObject({ code: 'invalid_params' })
    expect(tripRow(tripId).data.watchEnabled).toBe(1)
  })
})
