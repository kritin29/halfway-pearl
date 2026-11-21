/**
 * Fare selection per traveler × candidate (SPEC §7 "Fare selection"). Pure.
 *
 * Written against SerpApi's published Google Flights format
 * (https://serpapi.com/google-flights-api, "JSON structure overview", read
 * 2026-11-20) because the one real call we were allowed returned a provider
 * 429. CHECK AGAINST A REAL RESPONSE when the quota is back. Fields relied on:
 *
 *   best_flights[] / other_flights[]      "best_flights is not always returned";
 *                                         "When the results are not separated …
 *                                         they are in other_flights"
 *     .flights[].departure_airport.{id,time}   time "2023-10-03 15:10" (local)
 *     .flights[].arrival_airport.{id,time}
 *     .flights[].airline, .overnight (Boolean)
 *     .layovers[]                            one entry per stop
 *     .total_duration                        minutes
 *     .price                                 "This ticket price in the selected currency"
 *                                            (round trip when type=1; the response lists
 *                                            outbound legs only — returns need a
 *                                            departure_token request)
 *   price_insights.price_level              "Price level of the lowest_price"
 *   price_insights.typical_price_range      "A two-integer array … low bound and high bound"
 *   search_metadata.google_flights_url      the docs' example is a generic
 *                                            "https://www.google.com/travel/flights?hl=en",
 *                                            so we only use it when it carries a search
 *   error                                   "If a search has failed, error will contain
 *                                            an error message"
 *
 * Defensive by design: anything malformed is skipped, never thrown.
 */

export interface FlightSearch {
  /** Traveler's home airports, 1–3 IATA codes. */
  homeAirports: readonly string[]
  candidateIata: string
  /** YYYY-MM-DD */
  outboundDate: string
  /** YYYY-MM-DD */
  returnDate: string
}

export interface FlightConstraints {
  /** 0 = nonstop, 1 = up to one stop, 2 = any. */
  maxStops: number
  noRedeye: boolean
  /** Drop outbound departures before this local hour (0–23). */
  earliestDepartHour: number
}

export type PriceLevel = 'low' | 'typical' | 'high' | 'unknown'

interface PriceContext {
  priceLevel: PriceLevel
  typicalLow: number | null
  typicalHigh: number | null
  bookingUrl: string
}

export interface ChosenFare extends PriceContext {
  status: 'ok'
  /** Round-trip price in USD. */
  price: number
  /** The home airport actually used (e.g. MDW out of ORD,MDW). */
  originIata: string
  stops: number
  durationMin: number
  /** Outbound departure, local "YYYY-MM-DD HH:MM". Null for a home fare. */
  departLocal: string | null
  /** Outbound arrival, local "YYYY-MM-DD HH:MM". Null for a home fare. */
  arriveLocal: string | null
  airline: string
  /** True when the candidate is one of the traveler's home airports (no flight needed). */
  home: boolean
}

export interface NoFare extends PriceContext {
  status: 'no_results' | 'filtered_out'
}

export type FareResult = ChosenFare | NoFare

/** SerpApi request body (input schema from `integrations info serpapi/flights`). */
export interface SerpapiFlightsRequest {
  departure_id: string
  arrival_id: string
  outbound_date: string
  return_date: string
  type: '1'
  adults: 1
  currency: 'USD'
  hl: 'en'
}

/** Normalize home airports: trimmed, upper-case, de-duplicated, sorted. */
export function normalizeHomes(homeAirports: readonly string[]): string[] {
  return [...new Set(homeAirports.map((c) => c.trim().toUpperCase()).filter(Boolean))].sort()
}

export function buildFlightsRequest(search: FlightSearch): SerpapiFlightsRequest {
  return {
    departure_id: normalizeHomes(search.homeAirports).join(','),
    arrival_id: search.candidateIata.toUpperCase(),
    outbound_date: search.outboundDate,
    return_date: search.returnDate,
    type: '1',
    adults: 1,
    currency: 'USD',
    hl: 'en',
  }
}

/**
 * Cache / dedupe key: two friends from the same airports on the same dates
 * share one call (SPEC §8.2). Constraints are applied after the call, so they
 * are not part of the key.
 */
export function fareCacheKey(search: FlightSearch): string {
  return [
    normalizeHomes(search.homeAirports).join(','),
    search.candidateIata.toUpperCase(),
    search.outboundDate,
    search.returnDate,
  ].join('|')
}

/**
 * Traveler already lives at the candidate: price 0, status 'ok', stops 0, and
 * the caller makes NO API call for this pair. Returns null otherwise.
 */
export function homeFare(search: FlightSearch): ChosenFare | null {
  const dest = search.candidateIata.toUpperCase()
  if (!normalizeHomes(search.homeAirports).includes(dest)) return null
  return {
    status: 'ok',
    price: 0,
    originIata: dest,
    stops: 0,
    durationMin: 0,
    departLocal: null,
    arriveLocal: null,
    airline: 'Already there',
    home: true,
    priceLevel: 'unknown',
    typicalLow: null,
    typicalHigh: null,
    bookingUrl: googleFlightsUrl(search),
  }
}

export interface Itinerary {
  price: number
  originIata: string
  stops: number
  durationMin: number
  departLocal: string
  arriveLocal: string
  airline: string
  overnight: boolean
}

/**
 * Pick the fare for one traveler × candidate from a raw SerpApi response.
 *
 * 1. Merge best_flights + other_flights; skip malformed itineraries.
 * 2. Apply constraints: stops ≤ maxStops (2 = any), drop red-eyes when
 *    noRedeye, drop departures before earliestDepartHour.
 * 3. Cheapest remaining wins (ties: shorter, fewer stops, earlier departure).
 *    None remain but valid itineraries existed → 'filtered_out'; none → 'no_results'.
 * 4. Copy price_insights level and typical range when present.
 */
export function parseFlights(raw: unknown, constraints: FlightConstraints, search: FlightSearch): FareResult {
  const body = unwrap(raw)
  const context: PriceContext = {
    ...priceInsights(body),
    bookingUrl: googleFlightsUrl(search, searchMetadataUrl(body)),
  }

  const itineraries = [...asArray(body?.best_flights), ...asArray(body?.other_flights)]
    .map(parseItinerary)
    .filter((it): it is Itinerary => it !== null)

  if (itineraries.length === 0) return { status: 'no_results', ...context }

  const allowed = itineraries.filter((it) => passesConstraints(it, constraints))
  if (allowed.length === 0) return { status: 'filtered_out', ...context }

  allowed.sort(
    (a, b) =>
      a.price - b.price ||
      a.durationMin - b.durationMin ||
      a.stops - b.stops ||
      a.departLocal.localeCompare(b.departLocal),
  )
  const best = allowed[0]
  return {
    status: 'ok',
    price: best.price,
    originIata: best.originIata,
    stops: best.stops,
    durationMin: best.durationMin,
    departLocal: best.departLocal,
    arriveLocal: best.arriveLocal,
    airline: best.airline,
    home: false,
    ...context,
  }
}

export function passesConstraints(it: Itinerary, c: FlightConstraints): boolean {
  if (c.maxStops < 2 && it.stops > c.maxStops) return false
  if (c.noRedeye && isRedeye(it.departLocal, it.arriveLocal, it.overnight)) return false
  const departHour = hourOf(it.departLocal)
  if (departHour === null || departHour < c.earliestDepartHour) return false
  return true
}

/**
 * Red-eye (SPEC §7): outbound departs 21:00–04:59 local, or arrives on a
 * later calendar day than it departs. SerpApi's per-flight `overnight` flag
 * counts as arriving the next day.
 */
export function isRedeye(departLocal: string, arriveLocal: string, overnight = false): boolean {
  const h = hourOf(departLocal)
  if (h !== null && (h >= 21 || h < 5)) return true
  if (overnight) return true
  const d0 = departLocal.slice(0, 10)
  const d1 = arriveLocal.slice(0, 10)
  return DATE_RE.test(d0) && DATE_RE.test(d1) && d1 > d0
}

/**
 * Google Flights link for this search. Uses SerpApi's
 * search_metadata.google_flights_url only when it carries an actual search
 * (the docs' example is just "…/travel/flights?hl=en"); otherwise builds a
 * natural-language query URL.
 */
export function googleFlightsUrl(search: FlightSearch, metadataUrl?: string | null): string {
  if (metadataUrl && isSearchSpecificFlightsUrl(metadataUrl)) return metadataUrl
  const q = `Flights to ${search.candidateIata.toUpperCase()} from ${normalizeHomes(search.homeAirports).join(',')} on ${search.outboundDate} through ${search.returnDate}`
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(q)}&curr=USD&hl=en`
}

// ---------------------------------------------------------------------------
// Integration failures
// ---------------------------------------------------------------------------

export type ProviderFailureCode = 'provider_unavailable' | 'error'

export interface ProviderFailure {
  code: ProviderFailureCode
  /** Safe to show users (stored in trips.searchError). */
  message: string
  /** The provider's own text, for logs. */
  detail: string
}

export const PROVIDER_UNAVAILABLE_MESSAGE =
  'Live flight prices are temporarily unavailable from our data provider. This did not count against your daily search limit. Please try again later.'

export const GENERIC_SEARCH_ERROR_MESSAGE = 'Something went wrong while checking fares. Please try again.'

/**
 * Classify a failed integration envelope.
 *
 * 'provider_unavailable' = SerpApi itself is out of quota / rate-limited
 * (HTTP 429 or "run out of searches"). The platform releases billing for these,
 * so the job must not retry and must not count the call against our caps.
 * Everything else is 'error'.
 *
 * Accepts both shapes we've seen or expect:
 *   - CLI:    { ok:false, success:false, code:'upstream_provider_error',
 *               error:'serpapi/flights (502, …): SerpAPI error 429: {…}', billing:'released' }
 *   - worker: { success:false, code, error, status, details } (normalizeApiError)
 */
export function classifyIntegrationFailure(envelope: unknown): ProviderFailure {
  const { quota, detail } = detectProviderQuota(envelope)
  return quota
    ? { code: 'provider_unavailable', message: PROVIDER_UNAVAILABLE_MESSAGE, detail }
    : { code: 'error', message: GENERIC_SEARCH_ERROR_MESSAGE, detail }
}

/**
 * The provider-agnostic half of `classifyIntegrationFailure`: is this failed
 * envelope a provider quota / rate limit (429, "run out of searches",
 * a rate-limit code)? Shared with AI suggestions (`src/lib/suggest.ts`) so
 * both integrations are classified the same way; each caller supplies its
 * own user-facing messages.
 */
export function detectProviderQuota(envelope: unknown): { quota: boolean; detail: string } {
  const e = isRecord(envelope) ? envelope : {}
  const text = [e.error, e.message, isRecord(e.details) ? JSON.stringify(e.details) : '']
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .join(' ')
  const detail = text || (typeof envelope === 'string' ? envelope : 'Unknown integration error')

  const quota =
    /run out of searches/i.test(detail) ||
    /\b(?:error|status|HTTP)\s*429\b/i.test(detail) ||
    e.status === 429 ||
    /rate[_ -]?limit/i.test(String(e.code ?? ''))
  return { quota, detail }
}

// ---------------------------------------------------------------------------
// Parsing helpers (all tolerant)
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const LOCAL_TIME_RE = /^\d{4}-\d{2}-\d{2} \d{1,2}:\d{2}$/

type Rec = Record<string, unknown>

function isRecord(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

/** Accept the raw SerpApi JSON, or the same wrapped in `{ data: … }`. */
function unwrap(raw: unknown): Rec | null {
  if (!isRecord(raw)) return null
  const hasResults = 'best_flights' in raw || 'other_flights' in raw || 'price_insights' in raw
  if (!hasResults && isRecord(raw.data)) return raw.data
  return raw
}

function parseItinerary(value: unknown): Itinerary | null {
  if (!isRecord(value)) return null
  const price = value.price
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return null

  const legs = asArray(value.flights).filter(isRecord)
  if (legs.length === 0) return null
  const first = legs[0]
  const last = legs[legs.length - 1]
  const dep = isRecord(first.departure_airport) ? first.departure_airport : null
  const arr = isRecord(last.arrival_airport) ? last.arrival_airport : null
  const departLocal = normalizeLocalTime(dep?.time)
  const arriveLocal = normalizeLocalTime(arr?.time)
  const originIata = typeof dep?.id === 'string' ? dep.id.toUpperCase() : null
  if (!departLocal || !arriveLocal || !originIata) return null

  const layovers = asArray(value.layovers)
  const stops = Math.max(layovers.length, legs.length - 1)

  const legMinutes = legs.reduce((sum, l) => sum + (typeof l.duration === 'number' ? l.duration : 0), 0)
  const layoverMinutes = layovers.reduce<number>(
    (sum, l) => sum + (isRecord(l) && typeof l.duration === 'number' ? l.duration : 0),
    0,
  )
  const durationMin =
    typeof value.total_duration === 'number' && value.total_duration > 0
      ? value.total_duration
      : legMinutes + layoverMinutes

  const airlines = [...new Set(legs.map((l) => l.airline).filter((a): a is string => typeof a === 'string'))]
  return {
    price,
    originIata,
    stops,
    durationMin,
    departLocal,
    arriveLocal,
    airline: airlines.join(' + ') || 'Unknown airline',
    overnight: legs.some((l) => l.overnight === true),
  }
}

/** "2026-12-11 7:05" → "2026-12-11 07:05"; anything else → null. */
function normalizeLocalTime(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim().replace('T', ' ')
  if (!LOCAL_TIME_RE.test(s)) return null
  const [date, time] = s.split(' ')
  const [h, m] = time.split(':')
  const hour = Number(h)
  if (hour > 23 || Number(m) > 59) return null
  return `${date} ${String(hour).padStart(2, '0')}:${m}`
}

function hourOf(local: string): number | null {
  const m = /^\d{4}-\d{2}-\d{2} (\d{2}):\d{2}$/.exec(local)
  return m ? Number(m[1]) : null
}

function priceInsights(body: Rec | null): Omit<PriceContext, 'bookingUrl'> {
  const pi = isRecord(body?.price_insights) ? body.price_insights : null
  const level = pi?.price_level
  const priceLevel: PriceLevel = level === 'low' || level === 'typical' || level === 'high' ? level : 'unknown'
  const range = Array.isArray(pi?.typical_price_range) ? pi.typical_price_range : []
  const [lo, hi] = range
  const valid = typeof lo === 'number' && typeof hi === 'number' && Number.isFinite(lo) && Number.isFinite(hi)
  return {
    priceLevel,
    typicalLow: valid ? Math.min(lo, hi) : null,
    typicalHigh: valid ? Math.max(lo, hi) : null,
  }
}

function searchMetadataUrl(body: Rec | null): string | null {
  const meta = isRecord(body?.search_metadata) ? body.search_metadata : null
  return typeof meta?.google_flights_url === 'string' ? meta.google_flights_url : null
}

function isSearchSpecificFlightsUrl(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' || !/(^|\.)google\.com$/.test(u.hostname)) return false
    if (!u.pathname.startsWith('/travel/flights')) return false
    return u.searchParams.has('tfs') || u.searchParams.has('q') || u.pathname.length > '/travel/flights/'.length
  } catch {
    return false
  }
}
