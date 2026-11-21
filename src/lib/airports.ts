/** Airport lookup over `src/data/airports.json` (SPEC §6 addCandidate validation). */
import airportsJson from '../data/airports.json'
import type { Airport } from './midpoint'

export const AIRPORTS: readonly Airport[] = airportsJson as Airport[]

const BY_IATA: ReadonlyMap<string, Airport> = new Map(AIRPORTS.map((a) => [a.iata, a]))

export function airportByIata(code: string): Airport | undefined {
  return BY_IATA.get(code)
}

export function isKnownIata(code: string): boolean {
  return BY_IATA.has(code)
}
