import { describe, expect, it } from 'vitest'
import { isKnownIata, knownHomeAirports } from './airports'
import {
  addDays,
  DEMO_DESTINATIONS,
  DEMO_EMAILS_OFF,
  DEMO_GHOSTS,
  DEMO_LABEL,
  DEMO_LEAD_DAYS,
  DEMO_ORGANIZER_HOMES,
  DEMO_TRIP_NAME,
  DEMO_VIBE,
  demoDates,
  demoDestinations,
  isDemoTrip,
} from './demo'
import { INPUT_LIMITS } from './limits'
import { tripDates } from './validate'

describe('demo copy', () => {
  it('uses the exact label and email wording', () => {
    expect(DEMO_LABEL).toBe('Demo trip: sample prices, not live fares.')
    expect(DEMO_EMAILS_OFF).toBe('Emails are off in demo trips.')
  })
  it('fits the trip limits', () => {
    expect(DEMO_TRIP_NAME.length).toBeLessThanOrEqual(INPUT_LIMITS.tripNameMax)
    expect(DEMO_VIBE.length).toBeLessThanOrEqual(INPUT_LIMITS.vibeMax)
  })
})

describe('isDemoTrip', () => {
  it('is true only for isDemo === 1', () => {
    expect(isDemoTrip({ isDemo: 1 })).toBe(true)
    for (const v of [0, undefined, null, '1', true, 2]) expect(isDemoTrip({ isDemo: v })).toBe(false)
    expect(isDemoTrip(null)).toBe(false)
    expect(isDemoTrip(undefined)).toBe(false)
  })
})

describe('demo travelers and destinations', () => {
  it('2 ghosts, every traveler in a different city, all airports known', () => {
    expect(DEMO_GHOSTS).toHaveLength(2)
    const homes = [DEMO_ORGANIZER_HOMES, ...DEMO_GHOSTS.map((g) => g.homeAirports)]
    for (const h of homes) expect(knownHomeAirports(h)).toEqual(h)
    expect(new Set(homes.flat()).size).toBe(homes.flat().length)
  })
  it('4 known destinations, none of them anyone’s home airport, with city and country', () => {
    const homes = new Set([...DEMO_ORGANIZER_HOMES, ...DEMO_GHOSTS.flatMap((g) => g.homeAirports)])
    expect(DEMO_DESTINATIONS).toHaveLength(4)
    for (const d of demoDestinations()) {
      expect(isKnownIata(d.iata)).toBe(true)
      expect(homes.has(d.iata)).toBe(false)
      expect(d.city).not.toBe(d.iata)
      expect(d.country).toBeTruthy()
      expect(d.why.length).toBeLessThanOrEqual(140)
    }
  })
})

describe('demoDates', () => {
  it('is the first Friday at least 35 days out, back on Sunday, and passes trip validation', () => {
    // 2026-11-20 is a Friday: +35 = Fri 2026-12-25.
    expect(demoDates('2026-11-20')).toEqual({ outboundDate: '2026-12-25', returnDate: '2026-12-27' })
    // 2026-11-21 (Sat) + 35 = Sat 2026-12-26 → next Friday 2027-01-01.
    expect(demoDates('2026-11-21')).toEqual({ outboundDate: '2027-01-01', returnDate: '2027-01-03' })
    for (let i = 0; i < 14; i++) {
      const today = addDays('2026-12-28', i) // across a year end
      const { outboundDate, returnDate } = demoDates(today)
      expect(new Date(`${outboundDate}T00:00:00Z`).getUTCDay()).toBe(5)
      expect(outboundDate >= addDays(today, DEMO_LEAD_DAYS)).toBe(true)
      expect(outboundDate < addDays(today, DEMO_LEAD_DAYS + 7)).toBe(true)
      expect(tripDates(outboundDate, returnDate, today)).toEqual({ ok: true, value: { outboundDate, returnDate } })
    }
  })
  it('addDays crosses months and years in UTC', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2027-03-01', -1)).toBe('2027-02-28')
  })
})
