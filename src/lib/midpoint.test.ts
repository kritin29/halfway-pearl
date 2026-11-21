import { describe, expect, it } from 'vitest'
import airportsJson from '../data/airports.json'
import { centroid, haversineKm, nearestMajorHubs, travelersCentroid, type Airport } from './midpoint'

const airports = airportsJson as Airport[]
const get = (iata: string) => airports.find((a) => a.iata === iata)!

describe('airports.json', () => {
  it('has ~250 unique, well-formed airports with some major hubs', () => {
    expect(airports.length).toBeGreaterThanOrEqual(240)
    expect(new Set(airports.map((a) => a.iata)).size).toBe(airports.length)
    for (const a of airports) {
      expect(a.iata).toMatch(/^[A-Z]{3}$/)
      expect(a.city.length).toBeGreaterThan(0)
      expect(a.country.length).toBeGreaterThan(0)
      expect(Math.abs(a.lat)).toBeLessThanOrEqual(90)
      expect(Math.abs(a.lon)).toBeLessThanOrEqual(180)
      expect(typeof a.major).toBe('boolean')
    }
    expect(airports.filter((a) => a.major).length).toBeGreaterThan(50)
  })
})

describe('haversineKm', () => {
  it('is zero for the same point', () => {
    expect(haversineKm(get('ORD'), get('ORD'))).toBe(0)
  })
  it('matches known great-circle distances within 1%', () => {
    expect(haversineKm(get('JFK'), get('LHR'))).toBeCloseTo(5540, -2) // ≈ 5,540 km
    expect(haversineKm(get('LAX'), get('JFK'))).toBeCloseTo(3975, -2) // ≈ 3,975 km
  })
  it('is symmetric', () => {
    expect(haversineKm(get('SFO'), get('BOS'))).toBeCloseTo(haversineKm(get('BOS'), get('SFO')), 6)
  })
})

describe('centroid', () => {
  it('returns null for no points and the point itself for one', () => {
    expect(centroid([])).toBeNull()
    const c = centroid([{ lat: 10, lon: 20 }])!
    expect(c.lat).toBeCloseTo(10, 6)
    expect(c.lon).toBeCloseTo(20, 6)
  })
  it('handles the antimeridian (Fiji and Samoa-ish average to ~180°, not 0°)', () => {
    const c = centroid([
      { lat: -17, lon: 178 },
      { lat: -14, lon: -172 },
    ])!
    expect(Math.abs(c.lon)).toBeGreaterThan(170)
  })
})

describe('travelersCentroid', () => {
  it('weights each traveler once, however many airports they list', () => {
    const oneEach = travelersCentroid([['ORD'], ['BOS']], airports)!
    const chicagoTwice = travelersCentroid([['ORD', 'MDW'], ['BOS']], airports)!
    expect(haversineKm(oneEach, chicagoTwice)).toBeLessThan(30)
  })
  it('ignores unknown codes and travelers with no known airport', () => {
    expect(travelersCentroid([['XXX']], airports)).toBeNull()
    const c = travelersCentroid([['ORD', 'XXX'], ['ZZZ']], airports)!
    expect(haversineKm(c, get('ORD'))).toBeLessThan(1)
  })
})

describe('nearestMajorHubs', () => {
  it('Chicago + Atlanta friends: the middle is around Nashville/Louisville', () => {
    const hubs = nearestMajorHubs([['ORD', 'MDW'], ['ATL']], airports, { n: 2 })
    expect(hubs).toHaveLength(2)
    expect(hubs[0].airport.iata).toBe('BNA')
    expect(hubs.every((h) => h.airport.major)).toBe(true)
  })

  it('skips existing candidates and everyone’s home airports', () => {
    const hubs = nearestMajorHubs([['ORD'], ['ATL']], airports, { n: 3, exclude: ['BNA'] })
    const codes = hubs.map((h) => h.airport.iata)
    expect(codes).not.toContain('BNA')
    expect(codes).not.toContain('ORD')
    expect(codes).not.toContain('ATL')
  })

  it('returns hubs sorted by distance', () => {
    const hubs = nearestMajorHubs([['SEA'], ['MIA']], airports, { n: 4 })
    const d = hubs.map((h) => h.distanceKm)
    expect([...d].sort((a, b) => a - b)).toEqual(d)
  })

  it('returns nothing without known airports or with n = 0', () => {
    expect(nearestMajorHubs([], airports)).toEqual([])
    expect(nearestMajorHubs([['ORD']], airports, { n: 0 })).toEqual([])
  })
})
