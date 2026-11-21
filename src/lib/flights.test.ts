import { describe, expect, it } from 'vitest'
import sample from './__fixtures__/serpapi-flights-sample.json'
import realError429 from './__fixtures__/serpapi-error-429.json'
import {
  buildFlightsRequest,
  classifyIntegrationFailure,
  fareCacheKey,
  googleFlightsUrl,
  homeFare,
  isRedeye,
  parseFlights,
  PROVIDER_UNAVAILABLE_MESSAGE,
  type FlightConstraints,
  type FlightSearch,
} from './flights'

const search: FlightSearch = {
  homeAirports: ['ORD', 'MDW'],
  candidateIata: 'BNA',
  outboundDate: '2026-12-11',
  returnDate: '2026-12-13',
}
const anything: FlightConstraints = { maxStops: 2, noRedeye: false, earliestDepartHour: 0 }

describe('fixture', () => {
  it('is labelled as hand-made, not a real response', () => {
    expect(sample._note).toMatch(/HAND-MADE/)
  })
})

describe('buildFlightsRequest', () => {
  it('builds the SerpApi round-trip body from SPEC §7', () => {
    expect(buildFlightsRequest({ ...search, homeAirports: ['mdw', ' ORD ', 'ORD'] })).toEqual({
      departure_id: 'MDW,ORD',
      arrival_id: 'BNA',
      outbound_date: '2026-12-11',
      return_date: '2026-12-13',
      type: '1',
      adults: 1,
      currency: 'USD',
      hl: 'en',
    })
  })

  it('cache key ignores airport order and case so friends from the same airports share a call', () => {
    expect(fareCacheKey(search)).toBe(fareCacheKey({ ...search, homeAirports: ['mdw', 'ord'] }))
    expect(fareCacheKey(search)).not.toBe(fareCacheKey({ ...search, candidateIata: 'AUS' }))
  })
})

describe('parseFlights against the hand-made fixture', () => {
  it('any stops, red-eyes allowed: picks the cheapest valid itinerary ($99, 2 stops)', () => {
    const fare = parseFlights(sample, anything, search)
    expect(fare).toMatchObject({
      status: 'ok',
      price: 99,
      originIata: 'MDW',
      stops: 2,
      durationMin: 600,
      departLocal: '2026-12-11 10:00',
      arriveLocal: '2026-12-11 20:00',
      airline: 'Frontier',
      home: false,
    })
  })

  it('skips malformed itineraries (no price, empty flights, bad time, non-objects) instead of crashing', () => {
    // The malformed ones are priced $40-$50, cheaper than anything valid.
    const fare = parseFlights(sample, anything, search)
    expect(fare.status === 'ok' && fare.price).toBe(99)
  })

  it('maxStops 1: the overnight 1-stop ($109) wins when red-eyes are allowed', () => {
    const fare = parseFlights(sample, { ...anything, maxStops: 1 }, search)
    expect(fare).toMatchObject({ status: 'ok', price: 109, stops: 1, arriveLocal: '2026-12-12 00:20' })
  })

  it('noRedeye drops the 21:40 departure and the next-day arrival', () => {
    const fare = parseFlights(sample, { maxStops: 1, noRedeye: true, earliestDepartHour: 0 }, search)
    expect(fare).toMatchObject({ status: 'ok', price: 139, stops: 1, airline: 'Delta', originIata: 'ORD' })
  })

  it('nonstop only, no red-eyes: 06:00 is early but not a red-eye ($149), and "6:00" is normalized', () => {
    const fare = parseFlights(sample, { maxStops: 0, noRedeye: true, earliestDepartHour: 0 }, search)
    expect(fare).toMatchObject({ status: 'ok', price: 149, departLocal: '2026-12-11 06:00', airline: 'American' })
  })

  it('earliestDepartHour 7 drops the 06:00 flight and picks MDW 07:15 ($158)', () => {
    const fare = parseFlights(sample, { maxStops: 0, noRedeye: true, earliestDepartHour: 7 }, search)
    expect(fare).toMatchObject({ status: 'ok', price: 158, originIata: 'MDW', airline: 'Southwest' })
  })

  it('returns filtered_out when valid itineraries exist but none pass the constraints', () => {
    const fare = parseFlights(sample, { maxStops: 0, noRedeye: true, earliestDepartHour: 9 }, search)
    expect(fare.status).toBe('filtered_out')
  })

  it('copies price insights and builds a search-specific booking URL (fixture URL is generic)', () => {
    const fare = parseFlights(sample, anything, search)
    expect(fare.priceLevel).toBe('low')
    expect(fare.typicalLow).toBe(140)
    expect(fare.typicalHigh).toBe(260)
    expect(fare.bookingUrl).toBe(googleFlightsUrl(search))
    expect(fare.bookingUrl).toContain('q=Flights%20to%20BNA%20from%20MDW%2CORD%20on%202026-12-11%20through%202026-12-13')
  })
})

describe('parseFlights edge cases (hand-written)', () => {
  const leg = (dep: string, arr: string, from = 'ORD', to = 'BNA') => ({
    departure_airport: { id: from, time: dep },
    arrival_airport: { id: to, time: arr },
    airline: 'Test Air',
    duration: 60,
  })

  it('no_results for empty, missing, or non-object responses, and for a SerpApi "error" body', () => {
    for (const raw of [{}, null, undefined, 'nope', 42, { best_flights: [], other_flights: [] }, { error: "Google Flights hasn't returned any results for this query." }]) {
      expect(parseFlights(raw, anything, search).status).toBe('no_results')
    }
  })

  it('no_results when every itinerary is malformed', () => {
    const raw = { other_flights: [{ price: 'cheap', flights: [leg('2026-12-11 10:00', '2026-12-11 11:00')] }, { price: 100 }] }
    expect(parseFlights(raw, anything, search).status).toBe('no_results')
  })

  it('works with only other_flights (best_flights is not always returned)', () => {
    const raw = { other_flights: [{ price: 120, flights: [leg('2026-12-11 10:00', '2026-12-11 11:00')] }] }
    expect(parseFlights(raw, anything, search)).toMatchObject({ status: 'ok', price: 120, stops: 0 })
  })

  it('accepts the response wrapped in { data } by the proxy', () => {
    const raw = { data: { best_flights: [{ price: 130, flights: [leg('2026-12-11 10:00', '2026-12-11 11:00')] }] } }
    expect(parseFlights(raw, anything, search)).toMatchObject({ status: 'ok', price: 130 })
  })

  it('counts stops from layovers even when legs are merged, and sums durations without total_duration', () => {
    const raw = {
      best_flights: [
        { price: 100, flights: [leg('2026-12-11 10:00', '2026-12-11 13:00')], layovers: [{ duration: 40, id: 'STL' }] },
      ],
    }
    const fare = parseFlights(raw, anything, search)
    expect(fare).toMatchObject({ status: 'ok', stops: 1, durationMin: 100 })
    expect(parseFlights(raw, { ...anything, maxStops: 0 }, search).status).toBe('filtered_out')
  })

  it('breaks price ties by shorter duration', () => {
    const raw = {
      best_flights: [
        { price: 100, total_duration: 300, flights: [leg('2026-12-11 08:00', '2026-12-11 13:00')] },
        { price: 100, total_duration: 90, flights: [leg('2026-12-11 09:00', '2026-12-11 10:30')] },
      ],
    }
    expect(parseFlights(raw, anything, search)).toMatchObject({ durationMin: 90 })
  })

  it('treats an unknown price_level as unknown and a bad typical range as null', () => {
    const raw = {
      best_flights: [{ price: 100, flights: [leg('2026-12-11 10:00', '2026-12-11 11:00')] }],
      price_insights: { price_level: 'very high', typical_price_range: ['a', 3] },
    }
    expect(parseFlights(raw, anything, search)).toMatchObject({ priceLevel: 'unknown', typicalLow: null, typicalHigh: null })
  })

  it('uses search_metadata.google_flights_url when it carries a real search', () => {
    const url = 'https://www.google.com/travel/flights?tfs=CBwQAhoeEgoyMDI2LTEyLTEx&hl=en'
    const raw = {
      search_metadata: { google_flights_url: url },
      best_flights: [{ price: 100, flights: [leg('2026-12-11 10:00', '2026-12-11 11:00')] }],
    }
    expect(parseFlights(raw, anything, search).bookingUrl).toBe(url)
  })

  it('never trusts a non-Google URL from the response', () => {
    expect(googleFlightsUrl(search, 'https://evil.example/travel/flights?tfs=x')).toBe(googleFlightsUrl(search))
  })
})

describe('isRedeye', () => {
  it('departure window 21:00-04:59', () => {
    expect(isRedeye('2026-12-11 21:00', '2026-12-11 23:00')).toBe(true)
    expect(isRedeye('2026-12-11 04:59', '2026-12-11 07:00')).toBe(true)
    expect(isRedeye('2026-12-11 05:00', '2026-12-11 07:00')).toBe(false)
    expect(isRedeye('2026-12-11 20:59', '2026-12-11 22:30')).toBe(false)
  })
  it('arriving the next day, or an overnight leg, is a red-eye', () => {
    expect(isRedeye('2026-12-11 19:00', '2026-12-12 00:05')).toBe(true)
    expect(isRedeye('2026-12-11 19:00', '2026-12-11 23:00', true)).toBe(true)
  })
})

describe('homeFare: traveler lives at the candidate', () => {
  it('is price 0, status ok, stops 0 when the candidate is one of the home airports', () => {
    const fare = homeFare({ ...search, candidateIata: 'mdw' })
    expect(fare).toMatchObject({
      status: 'ok',
      price: 0,
      stops: 0,
      durationMin: 0,
      originIata: 'MDW',
      home: true,
      departLocal: null,
      arriveLocal: null,
    })
  })

  it('is null otherwise, so the caller makes the API call', () => {
    expect(homeFare(search)).toBeNull()
  })
})

describe('classifyIntegrationFailure', () => {
  it('classifies the REAL 429 envelope we received as provider_unavailable', () => {
    expect(realError429._note).toMatch(/REAL error envelope/)
    const f = classifyIntegrationFailure(realError429)
    expect(f.code).toBe('provider_unavailable')
    expect(f.message).toBe(PROVIDER_UNAVAILABLE_MESSAGE)
    expect(f.detail).toContain('run out of searches')
  })

  it('classifies the same failure in the worker tools envelope shape', () => {
    const workerShape = {
      success: false,
      code: 'upstream_provider_error',
      status: 502,
      error: realError429.error,
    }
    expect(classifyIntegrationFailure(workerShape).code).toBe('provider_unavailable')
    expect(classifyIntegrationFailure({ success: false, status: 429, error: 'Too Many Requests' }).code).toBe(
      'provider_unavailable',
    )
  })

  it('classifies other failures as error with a generic, safe message', () => {
    for (const env of [
      { success: false, code: 'upstream_provider_error', status: 502, error: 'serpapi/flights (502): SerpAPI error 500: boom' },
      { success: false, code: 'insufficient_credits', status: 402, error: 'Not enough credits' },
      { success: false, code: 'validation_failed', status: 400, error: 'arrival_id required' },
      null,
      'socket hang up',
    ]) {
      const f = classifyIntegrationFailure(env)
      expect(f.code).toBe('error')
      expect(f.message).not.toMatch(/serpapi|credits|arrival_id/i)
    }
  })

  it('does not mistake a price or flight number containing 429 for a rate limit', () => {
    expect(classifyIntegrationFailure({ success: false, error: 'Bad fare 429.50 on UA 1429' }).code).toBe('error')
  })
})
