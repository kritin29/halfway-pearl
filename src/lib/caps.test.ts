import { describe, expect, it } from 'vitest'
import {
  decideRunStart,
  emailsAllowed,
  mayCallAi,
  mayCreateTrip,
  mayMakeCall,
  planCalls,
  usageDay,
  usageKeys,
  usageRecordId,
  type UsageCounts,
} from './caps'
import { LIMITS } from './limits'

const fresh: UsageCounts = {
  globalSerpapiCallsToday: 0,
  tripFullSearchesToday: 0,
  tripWatchChecksToday: 0,
  userTripsSearchedToday: 0,
  userAlreadySearchedThisTripToday: false,
}

describe('decideRunStart', () => {
  it('allows a fresh full search with the per-run cap of 30 calls', () => {
    expect(decideRunStart('full', fresh)).toEqual({ ok: true, maxCalls: 30 })
  })

  it('allows the 2nd full search of the day but blocks the 3rd', () => {
    expect(decideRunStart('full', { ...fresh, tripFullSearchesToday: 1 }).ok).toBe(true)
    expect(decideRunStart('full', { ...fresh, tripFullSearchesToday: 2 })).toMatchObject({
      ok: false,
      code: 'trip_full_search_cap',
    })
  })

  it('blocks a 4th distinct trip for the same user, but not a re-search of one of their 3', () => {
    const three = { ...fresh, userTripsSearchedToday: 3 }
    expect(decideRunStart('full', three)).toMatchObject({ ok: false, code: 'user_trip_cap' })
    expect(decideRunStart('full', { ...three, userAlreadySearchedThisTripToday: true }).ok).toBe(true)
  })

  it('shrinks maxCalls to what is left of the global daily budget', () => {
    expect(decideRunStart('full', { ...fresh, globalSerpapiCallsToday: 70 })).toEqual({ ok: true, maxCalls: 10 })
  })

  it('blocks when the global daily budget is used up', () => {
    expect(decideRunStart('full', { ...fresh, globalSerpapiCallsToday: 80 })).toMatchObject({
      ok: false,
      code: 'global_daily_cap',
    })
    expect(decideRunStart('watch', { ...fresh, globalSerpapiCallsToday: 95 })).toMatchObject({
      ok: false,
      code: 'global_daily_cap',
    })
  })

  it('watch mode ignores full-search counters but has its own per-trip cap', () => {
    const busy = { ...fresh, tripFullSearchesToday: 2, userTripsSearchedToday: 3 }
    expect(decideRunStart('watch', busy).ok).toBe(true)
    expect(decideRunStart('watch', { ...fresh, tripWatchChecksToday: 3 })).toMatchObject({
      ok: false,
      code: 'trip_watch_cap',
    })
  })

  it('never lets one run exceed 30 calls even with custom limits that allow more globally', () => {
    const d = decideRunStart('full', fresh, { ...LIMITS, maxSerpapiCallsPerDayGlobal: 1000 })
    expect(d).toEqual({ ok: true, maxCalls: 30 })
  })
})

describe('planCalls / mayMakeCall', () => {
  it('keeps the first maxCalls items in order and reports the rest as skipped', () => {
    const needed = Array.from({ length: 35 }, (_, i) => i)
    const { run, skipped } = planCalls(needed, 30)
    expect(run).toHaveLength(30)
    expect(run[0]).toBe(0)
    expect(skipped).toEqual([30, 31, 32, 33, 34])
  })

  it('handles zero and fractional limits', () => {
    expect(planCalls([1, 2], 0)).toEqual({ run: [], skipped: [1, 2] })
    expect(planCalls([1, 2, 3], 1.9).run).toEqual([1])
  })

  it('mayMakeCall stops at the run budget, the 30-call cap, and the global cap', () => {
    expect(mayMakeCall(9, 10, 0)).toBe(true)
    expect(mayMakeCall(10, 10, 0)).toBe(false)
    expect(mayMakeCall(30, 999, 0)).toBe(false)
    expect(mayMakeCall(0, 30, 80)).toBe(false)
  })
})

describe('AI and email caps', () => {
  it('allows 5 AI calls per user per day', () => {
    expect(mayCallAi(4)).toBe(true)
    expect(mayCallAi(5)).toBe(false)
  })

  it('emailsAllowed respects 20/trip/day and 100/day globally', () => {
    expect(emailsAllowed(8, 0, 0)).toBe(8)
    expect(emailsAllowed(8, 15, 0)).toBe(5)
    expect(emailsAllowed(8, 0, 97)).toBe(3)
    expect(emailsAllowed(8, 20, 0)).toBe(0)
    expect(emailsAllowed(8, 25, 0)).toBe(0)
  })
})

describe('ledger helpers', () => {
  it('usageDay is the UTC date', () => {
    expect(usageDay(new Date('2026-11-21T03:30:00Z'))).toBe('2026-11-21')
    expect(usageDay(new Date('2026-11-20T23:59:59Z'))).toBe('2026-11-20')
  })

  it('builds stable keys and record ids', () => {
    expect(usageKeys.serpapiTrip('t1')).toBe('serpapi:trip:t1')
    expect(usageKeys.userSearchedTrip('u1', 't1')).toBe('search:user:u1:trip:t1')
    expect(usageRecordId('2026-11-20', usageKeys.serpapiGlobal())).toBe('2026-11-20|serpapi:global')
  })
})

describe('mayCreateTrip', () => {
  it('allows up to maxTripsCreatedPerUserPerDay', () => {
    expect(mayCreateTrip(9)).toBe(true)
    expect(mayCreateTrip(10)).toBe(false)
    expect(mayCreateTrip(0, { ...LIMITS, maxTripsCreatedPerUserPerDay: 0 })).toBe(false)
  })
})
