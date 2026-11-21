import { describe, expect, it } from 'vitest'
import { airportByIata, isKnownIata, searchAirports } from './airports'

describe('airports', () => {
  it('looks up codes', () => {
    expect(airportByIata('ORD')?.city).toBe('Chicago')
    expect(isKnownIata('ZZZ')).toBe(false)
  })

  it('searchAirports: exact code first, then prefixes, then cities', () => {
    expect(searchAirports('bna')[0].iata).toBe('BNA')
    const chicago = searchAirports('chicago').map((a) => a.iata)
    expect(chicago).toEqual(expect.arrayContaining(['ORD', 'MDW']))
    expect(chicago[0]).toBe('ORD') // major hub breaks the tie
  })

  it('searchAirports: excludes picked codes, respects the limit, ignores blanks', () => {
    expect(searchAirports('chicago', ['ORD']).map((a) => a.iata)).not.toContain('ORD')
    expect(searchAirports('a', [], 3)).toHaveLength(3)
    expect(searchAirports('   ')).toEqual([])
  })
})
