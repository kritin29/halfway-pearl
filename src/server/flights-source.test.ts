import { describe, expect, it } from 'vitest'
import { buildFlightsRequest, parseFlights, type FlightConstraints } from '../lib/flights'
import { createFakeStore } from './testing/fake-tools'
import { fixtureResponse, routeVariation, searchFlights, shiftTime, usesFixture } from './flights-source'

const anything: FlightConstraints = { maxStops: 2, noRedeye: false, earliestDepartHour: 0 }
const search = (homes: string[], dest: string) => ({
  homeAirports: homes,
  candidateIata: dest,
  outboundDate: '2027-01-15',
  returnDate: '2027-01-18',
})

describe('usesFixture (both gates)', () => {
  it('needs ALLOW_DEBUG_ROUTES exactly "true" AND a __test- trip name', () => {
    expect(usesFixture({ ALLOW_DEBUG_ROUTES: 'true' }, '__test-x')).toBe(true)
    expect(usesFixture({ ALLOW_DEBUG_ROUTES: 'true' }, 'Spring break')).toBe(false)
    expect(usesFixture({}, '__test-x')).toBe(false)
    expect(usesFixture({ ALLOW_DEBUG_ROUTES: '1' }, '__test-x')).toBe(false)
    expect(usesFixture({ ALLOW_DEBUG_ROUTES: 'TRUE' }, '__test-x')).toBe(false)
  })
  it('a demo trip (isDemo === 1) always uses the fixture, in production too; nothing else turns it on', () => {
    expect(usesFixture({}, 'Demo trip: long weekend', 1)).toBe(true)
    expect(usesFixture({}, 'Spring break', 1)).toBe(true)
    for (const v of [0, undefined, null, '1', true]) expect(usesFixture({}, 'Spring break', v)).toBe(false)
  })
})

describe('searchFlights', () => {
  const request = buildFlightsRequest(search(['ORD'], 'AUS'))

  it('production (flag unset) makes the real serpapi/flights call, even for a __test- name', async () => {
    const store = createFakeStore()
    store.onIntegration(() => ({ success: true, data: { best_flights: [] } }))
    const answer = await searchFlights(store.toolsFor('owner'), {}, request, '__test-trip', { fixtureDelayMs: 0 })
    expect(answer.source).toBe('live')
    expect(store.integrationCalls).toEqual([{ endpoint: 'serpapi/flights', data: request }])
  })

  it('production + demo trip: fixture answer, no integration call', async () => {
    const store = createFakeStore()
    store.onIntegration(() => ({ success: true, data: { best_flights: [] } }))
    const answer = await searchFlights(store.toolsFor('owner'), {}, request, 'Demo trip', { fixtureDelayMs: 0, isDemo: 1 })
    expect(answer.source).toBe('fixture')
    expect(answer.result.success).toBe(true)
    expect(store.integrationCalls).toEqual([])
  })

  it('dev/test + __test- trip: fixture answer, no integration call', async () => {
    const store = createFakeStore()
    const answer = await searchFlights(store.toolsFor('owner'), { ALLOW_DEBUG_ROUTES: 'true' }, request, '__test-trip', {
      fixtureDelayMs: 0,
    })
    expect(answer.source).toBe('fixture')
    expect(answer.result.success).toBe(true)
    expect(store.integrationCalls).toEqual([])
  })
})

describe('fixtureResponse (deterministic per route)', () => {
  it('rewrites origins, destination and dates for the requested route', () => {
    const s = search(['DEN', 'COS'], 'MSY')
    const fare = parseFlights(fixtureResponse(buildFlightsRequest(s)), anything, s)
    expect(fare.status).toBe('ok')
    if (fare.status !== 'ok') return
    expect(['COS', 'DEN']).toContain(fare.originIata)
    expect(fare.departLocal?.slice(0, 10)).toBe('2027-01-15')
  })

  it('same route → same answer; different routes → different prices', () => {
    const a = buildFlightsRequest(search(['ORD'], 'AUS'))
    expect(fixtureResponse(a)).toEqual(fixtureResponse(a))
    const prices = ['AUS', 'BNA', 'DEN', 'MSY', 'SEA', 'MIA'].map((dest) => {
      const s = search(['ORD'], dest)
      const fare = parseFlights(fixtureResponse(buildFlightsRequest(s)), anything, s)
      return fare.status === 'ok' ? fare.price : null
    })
    expect(new Set(prices).size).toBeGreaterThan(3)
    expect(prices.every((p) => typeof p === 'number' && p > 0)).toBe(true)
  })

  it('variation stays in its documented ranges', () => {
    for (const dest of ['AUS', 'BNA', 'DEN', 'MSY', 'SEA', 'MIA', 'LAX', 'JFK']) {
      const v = routeVariation({ departure_id: 'ORD', arrival_id: dest })
      expect(v.priceOffset).toBeGreaterThanOrEqual(-60)
      expect(v.priceOffset).toBeLessThanOrEqual(180)
      expect(v.timeShiftMin % 20).toBe(0)
      expect(v.timeShiftMin).toBeLessThanOrEqual(120)
    }
  })

  it('keeps the fixture’s malformed itineraries malformed (parsing is exercised the same way)', () => {
    const raw = fixtureResponse(buildFlightsRequest(search(['ORD'], 'AUS'))) as { other_flights: Array<{ price?: number }> }
    expect(raw.other_flights.some((it) => it.price === undefined)).toBe(true)
  })
})

describe('shiftTime', () => {
  it('moves fixture day 0 to the outbound date, adds the shift, rolls past midnight', () => {
    expect(shiftTime('2026-12-11 7:05', '2027-01-15', 0)).toBe('2027-01-15 07:05')
    expect(shiftTime('2026-12-11 23:10', '2027-01-15', 120)).toBe('2027-01-16 01:10')
    expect(shiftTime('2026-12-12 00:20', '2027-01-15', 40)).toBe('2027-01-16 01:00')
    expect(shiftTime('soon', '2027-01-15', 40)).toBe('soon')
  })
})
