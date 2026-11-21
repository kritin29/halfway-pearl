/** Airport lookup over `src/data/airports.json` (SPEC §6 addCandidate validation). */
import airportsJson from '../data/airports.json'
import { INPUT_LIMITS } from './limits'
import type { Airport } from './midpoint'

export const AIRPORTS: readonly Airport[] = airportsJson as Airport[]

const BY_IATA: ReadonlyMap<string, Airport> = new Map(AIRPORTS.map((a) => [a.iata, a]))

export function airportByIata(code: string): Airport | undefined {
  return BY_IATA.get(code)
}

export function isKnownIata(code: string): boolean {
  return BY_IATA.has(code)
}

/**
 * Autocomplete: exact code first, then codes starting with the query, then
 * city/name/country matches. Major hubs break ties. `exclude` hides codes
 * already picked.
 */
export function searchAirports(
  query: string,
  exclude: readonly string[] = [],
  limit = 6,
  airports: readonly Airport[] = AIRPORTS,
): Airport[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const scored: Array<{ a: Airport; score: number }> = []
  for (const a of airports) {
    if (exclude.includes(a.iata)) continue
    const code = a.iata.toLowerCase()
    let score = -1
    if (code === q) score = 0
    else if (code.startsWith(q)) score = 1
    else if (a.city.toLowerCase().startsWith(q)) score = 2
    else if (a.city.toLowerCase().includes(q) || a.country.toLowerCase().startsWith(q)) score = 3
    else if (q.length >= 3 && (a as Airport & { name?: string }).name?.toLowerCase().includes(q)) score = 4
    if (score >= 0) scored.push({ a, score: score * 2 + (a.major ? 0 : 1) })
  }
  scored.sort((x, y) => x.score - y.score || x.a.iata.localeCompare(y.a.iata))
  return scored.slice(0, limit).map((s) => s.a)
}

/**
 * A traveler's stored home airports, keeping only known codes: the row is
 * client-written, so its values aren't trusted (NOTES G1). Upper-cased, no
 * repeats, at most `homeAirportsMax`.
 */
export function knownHomeAirports(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const codes: string[] = []
  for (const v of raw) {
    if (typeof v !== 'string') continue
    const code = v.trim().toUpperCase()
    if (isKnownIata(code) && !codes.includes(code)) codes.push(code)
    if (codes.length >= INPUT_LIMITS.homeAirportsMax) break
  }
  return codes
}
