import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActionHandler, ActionResult } from 'deepspace/worker'
import type { Env } from '../../worker'
import { createFakeStore, type FakeStore } from '../server/testing/fake-tools'
import { TRIP_SCOPED_COLLECTIONS } from '../server/trip-rows'
import { addGhost, removeGhost, updateGhost } from './ghosts'
import { actions } from './index'
import { createTrip, joinTrip, newInviteCode, previewInvite, seatOrder, testLockTrip } from './trips'

const ALICE = 'user_alice'
const BOB = 'user_bob'
const CAROL = 'user_carol'

let store: FakeStore

function call(action: ActionHandler<Env>, userId: string, params: unknown, env: Partial<Env> = {}) {
  return action({
    userId,
    params: params as Record<string, unknown>,
    tools: store.toolsFor(userId),
    env: env as Env,
    callerJwt: 'jwt',
  }) as Promise<ActionResult<Record<string, unknown>>>
}

function data<T = Record<string, unknown>>(res: ActionResult<unknown>): T {
  if (!res.success) throw new Error(`expected success, got ${res.code}: ${res.error}`)
  return res.data as T
}

const TRIP = { name: 'Spring break', outboundDate: '2026-12-11', returnDate: '2026-12-13', vibe: 'beach' }

async function aliceTrip() {
  return data<{ tripId: string; inviteCode: string }>(await call(createTrip, ALICE, TRIP))
}

const travelersOf = (tripId: string) => store.rows('travelers').filter((r) => r.data.tripId === tripId)
const tripRow = (tripId: string) => store.rows('trips').find((r) => r.recordId === tripId)!

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-20T12:00:00Z'))
  store = createFakeStore()
  store.seed('users', ALICE, { name: 'Alice A.', email: 'alice@example.test' }, ALICE)
  store.seed('users', BOB, { name: 'Bob', email: 'bob@example.test' }, BOB)
})

afterEach(() => {
  vi.useRealTimers()
  // No action in this phase may reach a paid integration.
  expect(store.integrationCalls).toEqual([])
})

describe('registry', () => {
  it('exposes exactly the phase 3-4 actions', () => {
    expect(Object.keys(actions).sort()).toEqual(
      [
        '__testLockTrip',
        'addCandidate',
        'addGhost',
        'addMidpointHubs',
        'createTrip',
        'joinTrip',
        'previewInvite',
        'removeCandidate',
        'removeGhost',
        'suggestCandidates',
        'updateGhost',
      ].sort(),
    )
  })
})

describe('createTrip', () => {
  it('creates the trip and the organizer traveler row', async () => {
    const { tripId, inviteCode } = await aliceTrip()
    expect(inviteCode).toMatch(/^[A-Za-z0-9]{12}$/)
    expect(tripRow(tripId).data).toMatchObject({
      name: 'Spring break',
      organizerId: ALICE,
      memberIds: [ALICE],
      inviteCode,
      status: 'gathering',
      outboundDate: '2026-12-11',
      returnDate: '2026-12-13',
      vibe: 'beach',
      watchEnabled: 1,
    })
    const [traveler] = travelersOf(tripId)
    expect(traveler.data).toMatchObject({
      tripId,
      memberIds: [ALICE],
      userId: ALICE,
      isGhost: 0,
      displayName: 'Alice A.',
      homeAirports: [],
    })
    // Only the name is copied from the users row.
    expect(JSON.stringify(store.rows('travelers'))).not.toContain('example.test')
  })

  it('falls back to "Traveler" without a users row', async () => {
    const res = data<{ tripId: string }>(await call(createTrip, CAROL, TRIP))
    expect(travelersOf(res.tripId)[0].data.displayName).toBe('Traveler')
  })

  it('validates every param and writes nothing on failure', async () => {
    const bad = [
      null,
      [],
      { ...TRIP, name: '' },
      { ...TRIP, name: 'x'.repeat(81) },
      { ...TRIP, vibe: 'x'.repeat(201) },
      { ...TRIP, outboundDate: '2026-11-19' },
      { ...TRIP, returnDate: '2026-12-11' },
      { ...TRIP, outboundDate: 'tomorrow' },
    ]
    for (const params of bad) {
      const res = await call(createTrip, ALICE, params)
      expect(res, JSON.stringify(params)).toMatchObject({ success: false, code: 'invalid_params' })
    }
    expect(store.rows('trips')).toEqual([])
    expect(store.rows('travelers')).toEqual([])
  })

  it('ignores an organizerId or memberIds smuggled into params', async () => {
    const res = data<{ tripId: string }>(
      await call(createTrip, ALICE, { ...TRIP, organizerId: BOB, memberIds: [BOB] }),
    )
    expect(tripRow(res.tripId).data).toMatchObject({ organizerId: ALICE, memberIds: [ALICE] })
  })

  it('caps trip creation at 10 per user per UTC day', async () => {
    for (let i = 0; i < 10; i++) data(await call(createTrip, ALICE, { ...TRIP, name: `Trip ${i}` }))
    expect(await call(createTrip, ALICE, TRIP)).toMatchObject({ success: false, code: 'cap_reached' })
    expect(store.rows('trips')).toHaveLength(10)
    expect(store.rows('usage')).toMatchObject([
      { recordId: `2026-11-20|trips:created:user:${ALICE}`, data: { count: 10 } },
    ])
    // Someone else is unaffected, and the next UTC day starts fresh.
    expect((await call(createTrip, BOB, TRIP)).success).toBe(true)
    vi.setSystemTime(new Date('2026-11-21T00:00:01Z'))
    expect((await call(createTrip, ALICE, TRIP)).success).toBe(true)
  })

  it('failed creates do not count against the cap', async () => {
    await call(createTrip, ALICE, { ...TRIP, name: '' })
    expect(store.rows('usage')).toEqual([])
  })

  it('test trips are exempt only when ALLOW_DEBUG_ROUTES is "true"', async () => {
    const testTrip = { ...TRIP, name: '__test-trip' }
    for (let i = 0; i < 10; i++) data(await call(createTrip, ALICE, testTrip))
    // Production env: the __test- name alone changes nothing.
    expect(await call(createTrip, ALICE, testTrip)).toMatchObject({ code: 'cap_reached' })
    // Dev/test env: exempt, and not counted.
    expect((await call(createTrip, ALICE, testTrip, { ALLOW_DEBUG_ROUTES: 'true' })).success).toBe(true)
    expect(await call(createTrip, ALICE, TRIP, { ALLOW_DEBUG_ROUTES: 'true' })).toMatchObject({
      code: 'cap_reached',
    })
  })

  it('invite codes are random', () => {
    const codes = new Set(Array.from({ length: 200 }, () => newInviteCode()))
    expect(codes.size).toBe(200)
  })
})

describe('joinTrip', () => {
  it('adds the caller, creates their row and propagates memberIds to every trip-scoped row', async () => {
    const { tripId, inviteCode } = await aliceTrip()
    for (const collection of TRIP_SCOPED_COLLECTIONS.filter((c) => c !== 'travelers')) {
      store.seed(collection, `${collection}-1`, { tripId, memberIds: [ALICE] }, ALICE)
    }

    expect(data(await call(joinTrip, BOB, { inviteCode }))).toEqual({ tripId, alreadyMember: false })

    expect(tripRow(tripId).data.memberIds).toEqual([ALICE, BOB])
    const bob = travelersOf(tripId).find((t) => t.data.userId === BOB)
    expect(bob?.data).toMatchObject({ displayName: 'Bob', isGhost: 0, memberIds: [ALICE, BOB] })
    for (const collection of TRIP_SCOPED_COLLECTIONS) {
      for (const row of store.rows(collection).filter((r) => r.data.tripId === tripId)) {
        expect(row.data.memberIds, collection).toEqual([ALICE, BOB])
      }
    }
  })

  it('is idempotent', async () => {
    const { tripId, inviteCode } = await aliceTrip()
    await call(joinTrip, BOB, { inviteCode })
    expect(data(await call(joinTrip, BOB, { inviteCode }))).toEqual({ tripId, alreadyMember: true })
    expect(data(await call(joinTrip, ALICE, { inviteCode }))).toEqual({ tripId, alreadyMember: true })
    expect(travelersOf(tripId)).toHaveLength(2)
    expect(tripRow(tripId).data.memberIds).toEqual([ALICE, BOB])
  })

  it('repairs memberIds when a traveler row exists but the trip row missed the member', async () => {
    const { tripId, inviteCode } = await aliceTrip()
    store.seed('travelers', 'bob-row', { tripId, userId: BOB, memberIds: [ALICE], displayName: 'Bob' }, BOB)
    expect(data(await call(joinTrip, BOB, { inviteCode }))).toEqual({ tripId, alreadyMember: true })
    expect(tripRow(tripId).data.memberIds).toEqual([ALICE, BOB])
  })

  it('refuses newcomers to a locked trip; existing travelers are still members', async () => {
    const { tripId, inviteCode } = await aliceTrip()
    await call(joinTrip, BOB, { inviteCode })
    await store.toolsFor(ALICE).update('trips', tripId, { status: 'locked' })
    expect(await call(joinTrip, CAROL, { inviteCode })).toMatchObject({ success: false, code: 'trip_locked' })
    expect(tripRow(tripId).data.memberIds).toEqual([ALICE, BOB])
    expect(data(await call(joinTrip, BOB, { inviteCode }))).toEqual({ tripId, alreadyMember: true })
  })

  it('refuses bad and unknown codes', async () => {
    await aliceTrip()
    expect(await call(joinTrip, BOB, { inviteCode: 'short' })).toMatchObject({ code: 'invalid_params' })
    expect(await call(joinTrip, BOB, {})).toMatchObject({ code: 'invalid_params' })
    expect(await call(joinTrip, BOB, { inviteCode: 'Unknown12345' })).toMatchObject({ code: 'not_found' })
  })

  it('allows at most 8 travelers, ghosts included', async () => {
    const { tripId, inviteCode } = await aliceTrip()
    for (let i = 0; i < 5; i++) {
      store.seed('travelers', `real-${i}`, { tripId, userId: `user_${i}`, memberIds: [ALICE] })
    }
    for (let i = 0; i < 2; i++) {
      data(await call(addGhost, ALICE, { tripId, displayName: `Ghost ${i}`, homeAirports: ['ORD'] }))
    }
    expect(travelersOf(tripId)).toHaveLength(8)

    expect(await call(joinTrip, BOB, { inviteCode })).toMatchObject({ success: false, code: 'trip_full' })
    expect(travelersOf(tripId)).toHaveLength(8)
    expect(tripRow(tripId).data.memberIds).not.toContain(BOB)
  })

  it('seatOrder: oldest first, ties by id', () => {
    const rows = [
      { recordId: 'b', createdAt: '2026-11-20T00:00:01Z' },
      { recordId: 'c', createdAt: '2026-11-20T00:00:00Z' },
      { recordId: 'a', createdAt: '2026-11-20T00:00:01Z' },
    ]
    expect(seatOrder(rows).map((r) => r.recordId)).toEqual(['c', 'a', 'b'])
  })
})

describe('ghosts', () => {
  async function tripWithBob() {
    const trip = await aliceTrip()
    await call(joinTrip, BOB, { inviteCode: trip.inviteCode })
    return trip
  }

  it('addGhost: organizer adds a ghost:<uuid> row that is not a member', async () => {
    const { tripId } = await tripWithBob()
    const { ghostId } = data<{ ghostId: string }>(
      await call(addGhost, ALICE, { tripId, displayName: ' Grandpa ', homeAirports: ['ord', 'MDW'] }),
    )
    expect(ghostId).toMatch(/^ghost:[0-9a-f-]{36}$/)
    const ghost = travelersOf(tripId).find((t) => t.data.userId === ghostId)
    expect(ghost?.data).toMatchObject({
      isGhost: 1,
      displayName: 'Grandpa',
      homeAirports: ['ORD', 'MDW'],
      memberIds: [ALICE, BOB],
      maxStops: 2,
      noRedeye: 0,
      earliestDepartHour: 0,
      hasBudget: 0,
      booked: 0,
    })
    expect(tripRow(tripId).data.memberIds).toEqual([ALICE, BOB])
  })

  it('addGhost: members who are not the organizer are forbidden; outsiders see not_found', async () => {
    const { tripId } = await tripWithBob()
    const params = { tripId, displayName: 'G', homeAirports: ['ORD'] }
    expect(await call(addGhost, BOB, params)).toMatchObject({ code: 'forbidden' })
    expect(await call(addGhost, CAROL, params)).toMatchObject({ code: 'not_found' })
    expect(travelersOf(tripId).filter((t) => t.data.isGhost === 1)).toEqual([])
  })

  it('addGhost: validates params', async () => {
    const { tripId } = await aliceTrip()
    for (const params of [
      { tripId: '../trips', displayName: 'G', homeAirports: ['ORD'] },
      { tripId, displayName: '', homeAirports: ['ORD'] },
      { tripId, displayName: 'G', homeAirports: [] },
      { tripId, displayName: 'G', homeAirports: ['XXX'] },
      { tripId, displayName: 'G', homeAirports: ['ORD'], maxStops: 5 },
      { tripId, displayName: 'G', homeAirports: ['ORD'], earliestDepartHour: 24 },
    ]) {
      expect(await call(addGhost, ALICE, params), JSON.stringify(params)).toMatchObject({
        code: 'invalid_params',
      })
    }
  })

  it('addGhost: trip_full at 8 travelers', async () => {
    const { tripId } = await aliceTrip()
    for (let i = 0; i < 7; i++) {
      data(await call(addGhost, ALICE, { tripId, displayName: `G${i}`, homeAirports: ['ORD'] }))
    }
    expect(await call(addGhost, ALICE, { tripId, displayName: 'G8', homeAirports: ['ORD'] })).toMatchObject({
      code: 'trip_full',
    })
    expect(travelersOf(tripId)).toHaveLength(8)
  })

  it('updateGhost: changes only the allowed fields', async () => {
    const { tripId } = await tripWithBob()
    const { ghostId } = data<{ ghostId: string }>(
      await call(addGhost, ALICE, { tripId, displayName: 'G', homeAirports: ['ORD'] }),
    )
    data(
      await call(updateGhost, ALICE, {
        tripId,
        ghostId,
        displayName: 'Grandma',
        maxStops: 0,
        booked: true,
        userId: BOB, // ignored
        memberIds: [CAROL], // ignored
      }),
    )
    const ghost = travelersOf(tripId).find((t) => t.data.isGhost === 1)!
    expect(ghost.data).toMatchObject({
      userId: ghostId,
      displayName: 'Grandma',
      maxStops: 0,
      booked: 1,
      homeAirports: ['ORD'],
      memberIds: [ALICE, BOB],
    })
    expect(await call(updateGhost, ALICE, { tripId, ghostId })).toMatchObject({ code: 'invalid_params' })
    expect(await call(updateGhost, BOB, { tripId, ghostId, maxStops: 1 })).toMatchObject({ code: 'forbidden' })
  })

  it('updateGhost/removeGhost: cannot reach real travelers or another trip’s ghosts', async () => {
    const mine = await tripWithBob()
    const theirs = data<{ tripId: string }>(await call(createTrip, CAROL, TRIP))
    const { ghostId: carolsGhost } = data<{ ghostId: string }>(
      await call(addGhost, CAROL, { tripId: theirs.tripId, displayName: 'CG', homeAirports: ['BNA'] }),
    )
    // Real user ids are not ghost ids.
    expect(await call(updateGhost, ALICE, { tripId: mine.tripId, ghostId: BOB, maxStops: 0 })).toMatchObject({
      code: 'invalid_params',
    })
    // Carol's ghost through Alice's trip: not in this trip.
    for (const action of [updateGhost, removeGhost]) {
      expect(
        await call(action, ALICE, { tripId: mine.tripId, ghostId: carolsGhost, maxStops: 0 }),
      ).toMatchObject({ code: 'not_found' })
      // ...and through Carol's trip: Alice isn't a member.
      expect(
        await call(action, ALICE, { tripId: theirs.tripId, ghostId: carolsGhost, maxStops: 0 }),
      ).toMatchObject({ code: 'not_found' })
    }
    expect(travelersOf(theirs.tripId).find((t) => t.data.userId === carolsGhost)?.data.maxStops).toBe(2)
  })

  it('removeGhost: deletes the row and only that ghost’s fares', async () => {
    const { tripId } = await tripWithBob()
    const { ghostId } = data<{ ghostId: string }>(
      await call(addGhost, ALICE, { tripId, displayName: 'G', homeAirports: ['ORD'] }),
    )
    store.seed('fares', 'f-ghost', { tripId, candidateIata: 'BNA', travelerId: ghostId })
    store.seed('fares', 'f-bob', { tripId, candidateIata: 'BNA', travelerId: BOB })

    expect(await call(removeGhost, BOB, { tripId, ghostId })).toMatchObject({ code: 'forbidden' })
    data(await call(removeGhost, ALICE, { tripId, ghostId }))

    expect(travelersOf(tripId).map((t) => t.data.userId)).toEqual([ALICE, BOB])
    expect(store.rows('fares').map((f) => f.recordId)).toEqual(['f-bob'])
    expect(await call(removeGhost, ALICE, { tripId, ghostId })).toMatchObject({ code: 'not_found' })
  })
})

describe('previewInvite', () => {
  it('shows name, dates and capacity; the trip id only to members', async () => {
    const { tripId, inviteCode } = await aliceTrip()
    expect(data(await call(previewInvite, BOB, { inviteCode }))).toEqual({
      name: 'Spring break',
      outboundDate: '2026-12-11',
      returnDate: '2026-12-13',
      travelerCount: 1,
      maxTravelers: 8,
      locked: false,
      full: false,
      alreadyMember: false,
      tripId: null,
    })
    expect(data(await call(previewInvite, ALICE, { inviteCode }))).toMatchObject({ alreadyMember: true, tripId })
    // Previewing joins nobody.
    expect(tripRow(tripId).data.memberIds).toEqual([ALICE])
  })

  it('reports locked and full trips', async () => {
    const { tripId, inviteCode } = await aliceTrip()
    for (let i = 0; i < 7; i++) {
      await call(addGhost, ALICE, { tripId, displayName: `G${i}`, homeAirports: ['ORD'] })
    }
    await store.toolsFor(ALICE).update('trips', tripId, { status: 'locked' })
    expect(data(await call(previewInvite, BOB, { inviteCode }))).toMatchObject({ locked: true, full: true })
  })

  it('refuses bad and unknown codes', async () => {
    expect(await call(previewInvite, BOB, { inviteCode: 'x' })).toMatchObject({ code: 'invalid_params' })
    expect(await call(previewInvite, BOB, { inviteCode: 'Unknown12345' })).toMatchObject({ code: 'not_found' })
  })
})

describe('__testLockTrip (test seam)', () => {
  const DEBUG = { ALLOW_DEBUG_ROUTES: 'true' }

  it('is refused without ALLOW_DEBUG_ROUTES === "true" (production)', async () => {
    const { tripId } = data<{ tripId: string }>(await call(createTrip, ALICE, { ...TRIP, name: '__test-lock' }))
    for (const env of [{}, { ALLOW_DEBUG_ROUTES: 'false' }, { ALLOW_DEBUG_ROUTES: 'TRUE' }]) {
      expect(await call(testLockTrip, ALICE, { tripId }, env)).toMatchObject({ code: 'not_found' })
    }
    expect(tripRow(tripId).data.status).toBe('gathering')
  })

  it('only locks __test- trips, and only for the organizer', async () => {
    const real = await aliceTrip()
    expect(await call(testLockTrip, ALICE, { tripId: real.tripId }, DEBUG)).toMatchObject({ code: 'not_found' })
    const test = data<{ tripId: string; inviteCode: string }>(
      await call(createTrip, ALICE, { ...TRIP, name: '__test-lock' }, DEBUG),
    )
    await call(joinTrip, BOB, { inviteCode: test.inviteCode })
    expect(await call(testLockTrip, BOB, { tripId: test.tripId }, DEBUG)).toMatchObject({ code: 'forbidden' })
    expect(await call(testLockTrip, CAROL, { tripId: test.tripId }, DEBUG)).toMatchObject({ code: 'not_found' })
    data(await call(testLockTrip, ALICE, { tripId: test.tripId }, DEBUG))
    expect(tripRow(test.tripId).data.status).toBe('locked')
    expect(tripRow(real.tripId).data.status).toBe('gathering')
  })
})
