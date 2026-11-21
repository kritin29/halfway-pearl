import { describe, expect, it } from 'vitest'
import {
  asParams,
  daysBetween,
  departHour,
  flag,
  ghostId,
  homeAirports,
  iata,
  inviteCode,
  isoDate,
  maxStops,
  recordId,
  text,
  tripDates,
} from './validate'

const value = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`)
  return r.value
}

describe('asParams', () => {
  it('accepts plain objects only', () => {
    expect(asParams({ a: 1 })).toEqual({ a: 1 })
    for (const bad of [null, undefined, [], 'x', 3]) expect(asParams(bad)).toBeNull()
  })
})

describe('text', () => {
  it('trims, collapses whitespace and strips control/bidi characters', () => {
    expect(value(text('  Spring \n\t break  ', 'Name', { max: 80 }))).toBe('Spring break')
    expect(value(text('Bob‮evil\u0007', 'Name', { max: 80 }))).toBe('Bobevil')
  })
  it('enforces required and max length', () => {
    expect(text('', 'Name', { max: 5 }).ok).toBe(false)
    expect(text('   ', 'Name', { max: 5 }).ok).toBe(false)
    expect(text(undefined, 'Name', { max: 5 }).ok).toBe(false)
    expect(text('abcdef', 'Name', { max: 5 }).ok).toBe(false)
    expect(text(42, 'Name', { max: 5 }).ok).toBe(false)
  })
  it('optional text may be missing', () => {
    expect(value(text(undefined, 'Vibe', { max: 5, optional: true }))).toBe('')
    expect(value(text('  ', 'Vibe', { max: 5, optional: true }))).toBe('')
    expect(text(7, 'Vibe', { max: 5, optional: true }).ok).toBe(false)
  })
})

describe('dates', () => {
  it('isoDate accepts real dates only', () => {
    expect(value(isoDate('2026-12-11', 'd'))).toBe('2026-12-11')
    for (const bad of ['2026-02-30', '2026-13-01', '26-12-11', '2026-12-11T00:00:00Z', 20261211, null]) {
      expect(isoDate(bad, 'd').ok, String(bad)).toBe(false)
    }
  })

  it('daysBetween counts whole days across month ends', () => {
    expect(daysBetween('2026-11-30', '2026-12-02')).toBe(2)
  })

  it('tripDates: return after outbound, not in the past, bounded', () => {
    const today = '2026-11-20'
    expect(value(tripDates('2026-12-11', '2026-12-13', today))).toEqual({
      outboundDate: '2026-12-11',
      returnDate: '2026-12-13',
    })
    expect(tripDates('2026-11-20', '2026-11-21', today).ok).toBe(true) // today is allowed
    expect(tripDates('2026-11-19', '2026-11-21', today).ok).toBe(false) // past
    expect(tripDates('2026-12-11', '2026-12-11', today).ok).toBe(false) // same day
    expect(tripDates('2026-12-11', '2026-12-10', today).ok).toBe(false) // backwards
    expect(tripDates('2026-12-01', '2027-01-05', today).ok).toBe(false) // > 30 days
    expect(tripDates('2027-11-20', '2027-11-22', today).ok).toBe(false) // > 330 days ahead
  })
})

describe('airports', () => {
  const known = (c: string) => ['ORD', 'MDW', 'BNA'].includes(c)

  it('iata upper-cases and checks the airport list', () => {
    expect(value(iata(' bna ', 'Destination', known))).toBe('BNA')
    expect(iata('XXX', 'Destination', known).ok).toBe(false)
    expect(iata('BN', 'Destination', known).ok).toBe(false)
    expect(iata(null, 'Destination', known).ok).toBe(false)
  })

  it('iata uses the real airport list by default', () => {
    expect(iata('ORD', 'x').ok).toBe(true)
    expect(iata('ZZZ', 'x').ok).toBe(false)
  })

  it('homeAirports: 1..3 distinct known codes', () => {
    expect(value(homeAirports(['ord', 'MDW'], known))).toEqual(['ORD', 'MDW'])
    expect(homeAirports([], known).ok).toBe(false)
    expect(homeAirports(['ORD', 'MDW', 'BNA', 'ORD'], known).ok).toBe(false)
    expect(homeAirports(['ORD', 'ord'], known).ok).toBe(false)
    expect(homeAirports(['ORD', 'XXX'], known).ok).toBe(false)
    expect(homeAirports('ORD', known).ok).toBe(false)
  })
})

describe('numbers and flags', () => {
  it('maxStops is 0..2', () => {
    expect([0, 1, 2].map((n) => value(maxStops(n)))).toEqual([0, 1, 2])
    for (const bad of [-1, 3, 1.5, '1', null]) expect(maxStops(bad).ok).toBe(false)
  })
  it('departHour is 0..23', () => {
    expect(value(departHour(23))).toBe(23)
    expect(departHour(24).ok).toBe(false)
  })
  it('flag accepts booleans and 0/1', () => {
    expect([true, false, 1, 0].map((v) => value(flag(v, 'f')))).toEqual([1, 0, 1, 0])
    expect(flag('true', 'f').ok).toBe(false)
  })
})

describe('ids', () => {
  it('recordId matches generated ids and refuses junk', () => {
    expect(recordId('1732140000000_abc123', 'Trip').ok).toBe(true)
    for (const bad of ['', '../x', 'a b', 'x'.repeat(65), 5, null, 'constructor()']) {
      expect(recordId(bad, 'Trip').ok, String(bad)).toBe(false)
    }
  })
  it('ghostId requires ghost:<uuid>', () => {
    expect(ghostId('ghost:0f8fad5b-d9cb-469f-a165-70867728950e').ok).toBe(true)
    expect(ghostId('0f8fad5b-d9cb-469f-a165-70867728950e').ok).toBe(false)
    expect(ghostId('ghost:user_alice').ok).toBe(false)
  })
  it('inviteCode is 10..32 alphanumerics', () => {
    expect(value(inviteCode(' AbCdEf1234 '))).toBe('AbCdEf1234')
    expect(inviteCode('short').ok).toBe(false)
    expect(inviteCode('abc-def-ghij').ok).toBe(false)
  })
})
