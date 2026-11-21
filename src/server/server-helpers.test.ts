import { describe, expect, it, vi } from 'vitest'
import { usageRecordId } from '../lib/caps'
import { createFakeStore } from './testing/fake-tools'
import {
  defineAction,
  fail,
  loadTrip,
  ok,
  parseIdList,
  requireMember,
  requireOrganizer,
} from './trip-access'
import {
  memberIdsFromTravelers,
  propagateMemberIds,
  sameIds,
  syncTripMembers,
  TRIP_SCOPED_COLLECTIONS,
} from './trip-rows'
import { getUsageCount, getUsageCounts, incrementUsage } from './usage'

const ALICE = 'user_alice'
const BOB = 'user_bob'
const CAROL = 'user_carol'
const GHOST = 'ghost:0f8fad5b-d9cb-469f-a165-70867728950e'

function seedTrip(store = createFakeStore(), memberIds = [ALICE, BOB]) {
  store.seed('trips', 't1', {
    name: 'Trip',
    organizerId: ALICE,
    memberIds,
    inviteCode: 'abcdefghij',
    status: 'gathering',
    outboundDate: '2026-12-11',
    returnDate: '2026-12-13',
  })
  return store
}

describe('trip-access', () => {
  it('loadTrip: missing → not_found; memberIds parsed from a JSON string too', async () => {
    const store = seedTrip(createFakeStore(), JSON.stringify([ALICE]) as unknown as string[])
    const tools = store.toolsFor(ALICE)
    expect(await loadTrip(tools, 'nope')).toEqual({
      ok: false,
      result: { success: false, code: 'not_found', error: 'Trip not found.' },
    })
    const found = await loadTrip(tools, 't1')
    expect(found.ok && found.trip.data.memberIds).toEqual([ALICE])
  })

  it('requireMember: a non-member gets the same not_found as a missing trip', async () => {
    const tools = seedTrip().toolsFor(CAROL)
    const missing = await requireMember(tools, 'nope', CAROL)
    const notMine = await requireMember(tools, 't1', CAROL)
    expect(notMine).toEqual(missing)
    expect((await requireMember(tools, 't1', BOB)).ok).toBe(true)
  })

  it('requireOrganizer: members who are not the organizer are forbidden', async () => {
    const tools = seedTrip().toolsFor(BOB)
    const res = await requireOrganizer(tools, 't1', BOB)
    expect(!res.ok && res.result.code).toBe('forbidden')
    expect((await requireOrganizer(tools, 't1', ALICE)).ok).toBe(true)
    // An outsider learns nothing more than "not found".
    expect(!(await requireOrganizer(tools, 't1', CAROL)).ok).toBe(true)
    const outsider = await requireOrganizer(tools, 't1', CAROL)
    expect(!outsider.ok && outsider.result.code).toBe('not_found')
  })

  it('a storage failure throws instead of being treated as "not found"', async () => {
    const tools = createFakeStore([]).toolsFor(ALICE) // no schemas → get fails with a non-404 error
    await expect(loadTrip(tools, 't1')).rejects.toThrow(/load trip/)
  })

  it('parseIdList keeps strings only', () => {
    expect(parseIdList(['a', 3, 'b'])).toEqual(['a', 'b'])
    expect(parseIdList('["a"]')).toEqual(['a'])
    expect(parseIdList('not json')).toEqual([])
    expect(parseIdList(null)).toEqual([])
  })

  it('defineAction: rejects non-object params and hides thrown errors', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    const tools = createFakeStore().toolsFor(ALICE)
    const ctx = { userId: ALICE, tools, env: {}, callerJwt: 'jwt' }
    const echo = defineAction('echo', async ({ params }) => ok(params))
    expect(await echo({ ...ctx, params: null as unknown as Record<string, unknown> })).toMatchObject({
      success: false,
      code: 'invalid_params',
    })
    expect(await echo({ ...ctx, params: { a: 1 } })).toEqual({ success: true, data: { a: 1 } })

    const boom = defineAction('boom', async () => {
      throw new Error('secret detail')
    })
    const res = await boom({ ...ctx, params: {} })
    expect(res).toEqual(fail('server_error', 'Something went wrong. Please try again.'))
    expect(JSON.stringify(res)).not.toContain('secret detail')
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('[action] boom failed'))
    errorLog.mockRestore()
  })
})

describe('trip-rows', () => {
  it('memberIdsFromTravelers: organizer first, real travelers, no ghosts, no duplicates', () => {
    expect(
      memberIdsFromTravelers(ALICE, [{ userId: ALICE }, { userId: GHOST }, { userId: BOB }, { userId: BOB }, {}]),
    ).toEqual([ALICE, BOB])
    // The organizer stays a member even before their traveler row exists.
    expect(memberIdsFromTravelers(ALICE, [{ userId: BOB }])).toEqual([ALICE, BOB])
  })

  it('sameIds ignores order', () => {
    expect(sameIds([ALICE, BOB], [BOB, ALICE])).toBe(true)
    expect(sameIds([ALICE], [ALICE, BOB])).toBe(false)
    expect(sameIds([ALICE, ALICE], [ALICE, BOB])).toBe(false)
  })

  it('propagateMemberIds updates the trip and every trip-scoped row, only where different', async () => {
    const store = seedTrip(createFakeStore(), [ALICE])
    for (const collection of TRIP_SCOPED_COLLECTIONS) {
      store.seed(collection, `${collection}-1`, { tripId: 't1', memberIds: [ALICE] })
      store.seed(collection, `${collection}-other`, { tripId: 't2', memberIds: [CAROL] })
    }
    const tools = store.toolsFor(ALICE)
    expect(await propagateMemberIds(tools, 't1', [ALICE, BOB])).toBe(1 + TRIP_SCOPED_COLLECTIONS.length)

    expect(store.rows('trips')[0].data.memberIds).toEqual([ALICE, BOB])
    for (const collection of TRIP_SCOPED_COLLECTIONS) {
      const rows = store.rows(collection)
      expect(rows.find((r) => r.data.tripId === 't1')?.data.memberIds).toEqual([ALICE, BOB])
      // Other trips are untouched.
      expect(rows.find((r) => r.data.tripId === 't2')?.data.memberIds).toEqual([CAROL])
    }
    // Second run: nothing left to write.
    expect(await propagateMemberIds(tools, 't1', [BOB, ALICE])).toBe(0)
  })

  it('syncTripMembers derives members from traveler rows and repairs a stale trip row', async () => {
    const store = seedTrip(createFakeStore(), [ALICE]) // stale: Bob's row exists but he isn't listed
    store.seed('travelers', 'tr-a', { tripId: 't1', userId: ALICE, memberIds: [ALICE] })
    store.seed('travelers', 'tr-b', { tripId: 't1', userId: BOB, memberIds: [ALICE] })
    store.seed('travelers', 'tr-g', { tripId: 't1', userId: GHOST, isGhost: 1, memberIds: [ALICE] })
    store.seed('votes', 'v1', { tripId: 't1', userId: ALICE, memberIds: [ALICE] })

    expect(await syncTripMembers(store.toolsFor(BOB), 't1', ALICE)).toEqual([ALICE, BOB])
    expect(store.rows('trips')[0].data.memberIds).toEqual([ALICE, BOB])
    for (const row of [...store.rows('travelers'), ...store.rows('votes')]) {
      expect(row.data.memberIds).toEqual([ALICE, BOB])
    }
  })
})

describe('usage ledger', () => {
  const day = '2026-11-20'

  it('counts start at 0 and increment by upserting one row per (day, key)', async () => {
    const store = createFakeStore()
    const tools = store.toolsFor('owner')
    expect(await getUsageCount(tools, day, 'serpapi:global')).toBe(0)
    expect(await incrementUsage(tools, day, 'serpapi:global')).toBe(1)
    expect(await incrementUsage(tools, day, 'serpapi:global', 3)).toBe(4)
    expect(await getUsageCount(tools, day, 'serpapi:global')).toBe(4)
    expect(await getUsageCount(tools, '2026-11-21', 'serpapi:global')).toBe(0)

    const rows = store.rows('usage')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      recordId: usageRecordId(day, 'serpapi:global'),
      data: { day, key: 'serpapi:global', count: 4 },
    })
  })

  it('reads several keys at once', async () => {
    const tools = createFakeStore().toolsFor('owner')
    await incrementUsage(tools, day, 'a', 2)
    expect(await getUsageCounts(tools, day, ['a', 'b'])).toEqual({ a: 2, b: 0 })
  })

  it('fails closed when the ledger cannot be read', async () => {
    const tools = createFakeStore([]).toolsFor('owner') // usage collection not registered
    await expect(getUsageCount(tools, day, 'serpapi:global')).rejects.toThrow(/read usage/)
    await expect(incrementUsage(tools, day, 'serpapi:global')).rejects.toThrow()
  })
})
