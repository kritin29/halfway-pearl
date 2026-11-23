/**
 * Demo trips (SPEC §14): a ready-made trip a reviewer can open while live
 * fares are unavailable (SerpApi's shared quota is out, NOTES R7).
 *
 * A demo trip is an ordinary trip with `isDemo = 1`, written only by the
 * `createDemoTrip` action (the column is immutable and clients can't write
 * trips at all). Everything runs through the normal pipeline, except:
 *
 *   - fares come from the saved fixture, varied per route
 *     (src/server/flights-source.ts), never from `serpapi/flights`;
 *   - no email is ever sent (lock, resend, watch alerts);
 *   - the daily fare-watch cron skips it (`Check fares now` still works);
 *   - the label below is shown on every demo screen and card.
 *
 * Pure: no SDK imports, so the client can use the label and the flag check.
 */
import { airportByIata } from './airports'

/** `YYYY-MM-DD` plus `days`, in UTC. */
export function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
}

/** The exact label shown on every demo screen and card. */
export const DEMO_LABEL = 'Demo trip: sample prices, not live fares.'

/** Shown wherever an email would have gone out. */
export const DEMO_EMAILS_OFF = 'Emails are off in demo trips.'

/** True only for a trip row the server marked as a demo. */
export function isDemoTrip(data: { isDemo?: unknown } | null | undefined): boolean {
  return data?.isDemo === 1
}

export const DEMO_TRIP_NAME = 'Demo trip: long weekend'
export const DEMO_VIBE = 'Warm, walkable, good food'

/** The caller's own home airport on a demo trip (they can change it on the Crew tab). */
export const DEMO_ORGANIZER_HOMES = ['ORD']

/** Ghost travelers, each in a different city from each other and from the organizer. */
export const DEMO_GHOSTS: ReadonlyArray<{ displayName: string; homeAirports: string[] }> = [
  { displayName: 'Sam', homeAirports: ['BOS'] },
  { displayName: 'Priya', homeAirports: ['DEN'] },
]

/**
 * Destinations. With the travelers above, the fixture prices these so the
 * Cheapest, Fairest and Together tabs each order them differently (the same
 * set the Phase 5 results e2e test relies on).
 */
export const DEMO_DESTINATIONS = ['AUS', 'BNA', 'SAN', 'MIA'] as const

export const DEMO_WHY = 'Sample destination for this demo trip.'

export interface DemoDestination {
  iata: string
  city: string
  country: string
  why: string
}

export function demoDestinations(): DemoDestination[] {
  return DEMO_DESTINATIONS.map((iata) => {
    const airport = airportByIata(iata)
    return { iata, city: airport?.city ?? iata, country: airport?.country ?? '', why: DEMO_WHY }
  })
}

/** Days from today to the earliest possible demo outbound date. */
export const DEMO_LEAD_DAYS = 35

/**
 * Demo dates: the first Friday at least DEMO_LEAD_DAYS after `today`
 * (UTC `YYYY-MM-DD`), back on Sunday. Far enough out for the fare watch to
 * stay open, well inside the 330-day limit.
 */
export function demoDates(today: string): { outboundDate: string; returnDate: string } {
  const start = addDays(today, DEMO_LEAD_DAYS)
  const weekday = new Date(`${start}T00:00:00Z`).getUTCDay() // 0 = Sunday … 5 = Friday
  const outboundDate = addDays(start, (5 - weekday + 7) % 7)
  return { outboundDate, returnDate: addDays(outboundDate, 2) }
}
