/**
 * Where fare-search gets SerpApi responses (SPEC §8 "Fixture seam", NOTES C12).
 *
 * Playwright can't intercept worker-side integration calls, so the job asks
 * this module instead of calling `tools.integration` itself. It answers from
 * the saved fixture when EITHER:
 *
 *   - the trip is a demo trip (`isDemo = 1`, set only by `createDemoTrip`;
 *     SPEC §14). This holds in production too: a demo trip never reaches
 *     `serpapi/flights`. Or
 *   - both test gates hold: `env.ALLOW_DEBUG_ROUTES === 'true'` (set by
 *     `deepspace dev start` / `test run`, never in production) AND the
 *     trip's name starts with `__test-`.
 *
 * Otherwise it makes the real `serpapi/flights` call. Unit-tested every way.
 * Fixture answers are cached under per-trip keys (`cacheRecordId` in
 * fare-search.ts), so sample prices can never answer a real trip's search.
 *
 * Fixture answers are varied per route so destinations rank differently:
 * prices, times and the price level shift by amounts derived from a hash of
 * "origins>destination". Same route, same answer, every run.
 */
import type { ActionResult, ActionTools } from 'deepspace/worker'
import sample from '../lib/__fixtures__/serpapi-flights-sample.json'
import type { SerpapiFlightsRequest } from '../lib/flights'
import { isTestTrip } from './test-seam'

export type FlightsEnv = { ALLOW_DEBUG_ROUTES?: string }

/** True when this trip's searches are answered from the fixture: a demo trip, or a `__test-` trip in dev/test. */
export function usesFixture(env: FlightsEnv, tripName: unknown, isDemo: unknown = 0): boolean {
  return isDemo === 1 || isTestTrip(env, tripName)
}

/**
 * Fixture answers wait this long, so a two-user test can watch progress move
 * (a real call takes a few seconds; an instant answer would finish before the
 * other browser renders the progress bar).
 */
export const FIXTURE_DELAY_MS = 600

export interface FlightsAnswer {
  result: ActionResult<unknown>
  source: 'fixture' | 'live'
}

export async function searchFlights(
  tools: ActionTools,
  env: FlightsEnv,
  request: SerpapiFlightsRequest,
  tripName: string,
  options: { fixtureDelayMs?: number; isDemo?: unknown } = {},
): Promise<FlightsAnswer> {
  if (usesFixture(env, tripName, options.isDemo)) {
    const delay = options.fixtureDelayMs ?? FIXTURE_DELAY_MS
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
    return { result: { success: true, data: fixtureResponse(request) }, source: 'fixture' }
  }
  return { result: await tools.integration('serpapi/flights', request), source: 'live' }
}

// ---------------------------------------------------------------------------
// Fixture synthesis (pure, exported for tests)
// ---------------------------------------------------------------------------

/** FNV-1a, 32-bit. Small, stable, good enough to spread routes apart. */
export function routeHash(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

export interface RouteVariation {
  /** Added to every itinerary price (USD). */
  priceOffset: number
  /** Added to every departure and arrival time (minutes). */
  timeShiftMin: number
  priceLevel: 'low' | 'typical' | 'high'
}

/** The per-route shifts: price −60…+180 USD, times +0…+120 min, a price level. */
export function routeVariation(request: Pick<SerpapiFlightsRequest, 'departure_id' | 'arrival_id'>): RouteVariation {
  const h = routeHash(`${request.departure_id}>${request.arrival_id}`)
  return {
    priceOffset: (h % 241) - 60,
    timeShiftMin: ((h >>> 8) % 7) * 20,
    priceLevel: (['low', 'typical', 'high'] as const)[(h >>> 16) % 3],
  }
}

const FIXTURE_ORIGINS = ['ORD', 'MDW']
const FIXTURE_DESTINATION = 'BNA'
const FIXTURE_OUTBOUND = '2026-12-11'
const MIN_PRICE = 39

/**
 * The saved fixture rewritten for `request`: its origins become the
 * requested home airports (ORD → first, MDW → second or first), BNA becomes
 * the destination, dates move to the requested outbound date, and the route's
 * variation is applied. Malformed itineraries stay malformed, so parsing is
 * exercised the same way as with the raw fixture.
 */
export function fixtureResponse(request: SerpapiFlightsRequest): Record<string, unknown> {
  const homes = request.departure_id.split(',').filter(Boolean)
  const originFor = (id: string) => {
    const i = FIXTURE_ORIGINS.indexOf(id)
    return i < 0 ? id : (homes[i] ?? homes[0] ?? id)
  }
  const v = routeVariation(request)
  const raw = structuredClone(sample) as Record<string, unknown>

  const rewriteAirport = (airport: unknown, role: 'from' | 'to') => {
    if (!isRecord(airport)) return airport
    const id = typeof airport.id === 'string' ? airport.id : ''
    const next = { ...airport }
    if (role === 'from' && FIXTURE_ORIGINS.includes(id)) next.id = originFor(id)
    if (role === 'to' && id === FIXTURE_DESTINATION) next.id = request.arrival_id
    if (typeof airport.time === 'string') next.time = shiftTime(airport.time, request.outbound_date, v.timeShiftMin)
    return next
  }

  for (const list of ['best_flights', 'other_flights'] as const) {
    const items = Array.isArray(raw[list]) ? (raw[list] as unknown[]) : []
    raw[list] = items.map((item) => {
      if (!isRecord(item)) return item
      const next: Record<string, unknown> = { ...item }
      if (typeof item.price === 'number' && item.price > 0) next.price = Math.max(MIN_PRICE, item.price + v.priceOffset)
      if (Array.isArray(item.flights)) {
        next.flights = item.flights.map((leg) =>
          isRecord(leg)
            ? {
                ...leg,
                departure_airport: rewriteAirport(leg.departure_airport, 'from'),
                arrival_airport: rewriteAirport(leg.arrival_airport, 'to'),
              }
            : leg,
        )
      }
      return next
    })
  }

  const insights = isRecord(raw.price_insights) ? raw.price_insights : {}
  const range = Array.isArray(insights.typical_price_range) ? insights.typical_price_range : [140, 260]
  raw.price_insights = {
    ...insights,
    lowest_price: typeof insights.lowest_price === 'number' ? Math.max(MIN_PRICE, insights.lowest_price + v.priceOffset) : undefined,
    price_level: v.priceLevel,
    typical_price_range: range.map((n) => (typeof n === 'number' ? Math.max(MIN_PRICE, n + v.priceOffset) : n)),
  }
  raw.search_parameters = {
    ...(isRecord(raw.search_parameters) ? raw.search_parameters : {}),
    departure_id: request.departure_id,
    arrival_id: request.arrival_id,
    outbound_date: request.outbound_date,
    return_date: request.return_date,
  }
  raw._note = 'FIXTURE (demo trips and dev/test only): the hand-made sample rewritten for this route by src/server/flights-source.ts.'
  return raw
}

/**
 * "2026-12-11 7:05" (fixture day 0) → the same wall time on `outbound` plus
 * the fixture's day offset, plus `shiftMin`, as "YYYY-MM-DD HH:MM". Anything
 * unparseable is returned unchanged.
 */
export function shiftTime(time: string, outbound: string, shiftMin: number): string {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{1,2}):(\d{2})$/.exec(time.trim())
  if (!m || !/^\d{4}-\d{2}-\d{2}$/.test(outbound)) return time
  const dayOffset = Math.round((Date.parse(`${m[1]}T00:00:00Z`) - Date.parse(`${FIXTURE_OUTBOUND}T00:00:00Z`)) / 86_400_000)
  const minutes = dayOffset * 1440 + Number(m[2]) * 60 + Number(m[3]) + shiftMin
  const at = new Date(Date.parse(`${outbound}T00:00:00Z`) + minutes * 60_000)
  if (Number.isNaN(at.getTime())) return time
  const iso = at.toISOString()
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
