import { describe, expect, it } from 'vitest'
import {
  buildResultCards,
  cardPriceLevel,
  clockTime,
  safeBookingUrl,
  sortResultCards,
  stopsLabel,
  usd,
  type BuildInput,
  type CandidateRow,
  type FareRow,
} from './results'

const ME = 'user_me'
const BOB = 'user_bob'
const GHOST = 'ghost:1'
const travelers = [
  { userId: ME, displayName: 'Me' },
  { userId: BOB, displayName: 'Bob' },
  { userId: GHOST, displayName: 'Grandpa' },
]

const okFare = (candidateIata: string, travelerId: string, price: number, extra: Partial<FareRow> = {}): FareRow => ({
  candidateIata,
  travelerId,
  status: 'ok',
  price,
  originIata: 'ORD',
  stops: 0,
  departLocal: '2026-12-11 07:15',
  arriveLocal: '2026-12-11 08:45',
  airline: 'Southwest',
  priceLevel: 'typical',
  bookingUrl: 'https://www.google.com/travel/flights?q=x',
  ...extra,
})

const checked = (iata: string, over: Partial<CandidateRow>): CandidateRow => ({
  iata,
  city: iata,
  country: 'United States',
  complete: 1,
  missingFor: [],
  lastCheckedAt: '2026-11-21T12:00:00Z',
  ...over,
})

function input(over: Partial<BuildInput> = {}): BuildInput {
  return {
    candidates: [
      checked('AUS', { groupTotal: 600, maxFare: 300, arrivalSpreadMin: 200 }),
      checked('BNA', { groupTotal: 650, maxFare: 250, arrivalSpreadMin: 30 }),
      checked('DEN', { complete: 0, groupTotal: null, missingFor: ['Bob'] }),
      { iata: 'MSY', city: 'New Orleans', country: 'United States', complete: 0, lastCheckedAt: null, missingFor: null },
    ],
    fares: [
      okFare('AUS', ME, 250, { priceLevel: 'low' }),
      okFare('AUS', BOB, 300, { priceLevel: 'high' }),
      okFare('AUS', GHOST, 50),
      okFare('BNA', ME, 250),
      okFare('BNA', BOB, 250),
      okFare('BNA', GHOST, 0, { originIata: 'BNA', priceLevel: 'unknown' }),
      okFare('DEN', ME, 199),
      { candidateIata: 'DEN', travelerId: BOB, status: 'filtered_out', price: null },
    ],
    travelers,
    votes: [
      { userId: BOB, candidateIata: 'BNA' },
      { userId: ME, candidateIata: 'BNA' },
      { userId: BOB, candidateIata: 'AUS' },
    ],
    me: ME,
    myBudget: 260,
    ...over,
  }
}

const order = (mode: 'cheapest' | 'fairest' | 'together') =>
  sortResultCards(buildResultCards(input()), mode).map((c) => c.iata)

describe('sortResultCards', () => {
  it('reorders by tab; incomplete next; never-checked last', () => {
    expect(order('cheapest')).toEqual(['AUS', 'BNA', 'DEN', 'MSY'])
    expect(order('fairest')).toEqual(['BNA', 'AUS', 'DEN', 'MSY'])
    expect(order('together')).toEqual(['BNA', 'AUS', 'DEN', 'MSY'])
  })
})

describe('buildResultCards', () => {
  const cards = buildResultCards(input())
  const card = (iata: string) => cards.find((c) => c.iata === iata)!

  it('one row per traveler with their fare (or null while it hasn’t arrived)', () => {
    expect(card('AUS').people.map((p) => [p.displayName, p.fare?.price])).toEqual([
      ['Me', 250],
      ['Bob', 300],
      ['Grandpa', 50],
    ])
    expect(card('MSY').people.every((p) => p.fare === null)).toBe(true)
    expect(card('BNA').people[2]).toMatchObject({ isGhost: true, fare: { home: true, price: 0 } })
    expect(card('DEN').people[1].fare).toMatchObject({ status: 'filtered_out', price: null })
  })

  it('the viewer’s private line uses only their own fare and budget', () => {
    expect(card('AUS').own).toEqual({ price: 250, budget: 260, fits: true, diff: 10 })
    expect(card('DEN').own).toEqual({ price: 199, budget: 260, fits: true, diff: 61 })
    expect(buildResultCards(input({ myBudget: 200 }))[0].own).toEqual({ price: 250, budget: 200, fits: false, diff: -50 })
    expect(buildResultCards(input({ myBudget: null }))[0].own).toBeNull()
    // Someone with no fare on the card gets no line.
    expect(card('MSY').own).toBeNull()
  })

  it('votes: count, whether I voted, and who', () => {
    expect(card('BNA').votes).toEqual({ count: 2, mine: true, voters: ['Bob', 'You'] })
    expect(card('AUS').votes).toEqual({ count: 1, mine: false, voters: ['Bob'] })
    expect(card('DEN').votes).toEqual({ count: 0, mine: false, voters: [] })
  })

  it('badges: fitsAll only as stored, arrival only when complete and ≤ 3h, price level summarized', () => {
    expect(card('AUS').fitsAll).toBeNull()
    expect(buildResultCards(input({ candidates: [checked('AUS', { fitsAll: 1 })] }))[0].fitsAll).toBe(1)
    expect(buildResultCards(input({ candidates: [checked('AUS', { fitsAll: 0 })] }))[0].fitsAll).toBe(0)
    expect(card('BNA').arrival).toBe('Everyone lands within 30m')
    expect(card('AUS').arrival).toBeNull()
    expect(card('AUS').priceLevel).toBe('high')
    // The home fare's "unknown" doesn't count.
    expect(card('BNA').priceLevel).toBe('typical')
    expect(card('DEN').missingFor).toEqual(['Bob'])
  })

  it('a card saved as complete is incomplete again when someone joined after the search', () => {
    const cards = buildResultCards(
      input({
        travelers: [...travelers, { userId: 'user_carol', displayName: 'Carol' }],
      }),
    )
    const bna = cards.find((c) => c.iata === 'BNA')!
    expect(bna.complete).toBe(false)
    expect(bna.missingFor).toEqual(['Carol'])
    expect(bna.arrival).toBeNull()
  })
})

describe('helpers', () => {
  it('cardPriceLevel', () => {
    expect(cardPriceLevel([])).toBe('unknown')
    expect(cardPriceLevel(['unknown', 'unknown'])).toBe('unknown')
    expect(cardPriceLevel(['low', 'low', 'unknown'])).toBe('low')
    expect(cardPriceLevel(['low', 'typical'])).toBe('typical')
    expect(cardPriceLevel(['low', 'high'])).toBe('high')
  })

  it('clockTime, stopsLabel, usd', () => {
    expect(clockTime('2026-12-11 07:15')).toBe('7:15 AM')
    expect(clockTime('2026-12-11 00:05')).toBe('12:05 AM')
    expect(clockTime('2026-12-11 12:30')).toBe('12:30 PM')
    expect(clockTime('2026-12-11 23:59')).toBe('11:59 PM')
    expect(clockTime(null)).toBeNull()
    expect(stopsLabel(0)).toBe('Nonstop')
    expect(stopsLabel(1)).toBe('1 stop')
    expect(stopsLabel(2)).toBe('2 stops')
    expect(usd(1234.5)).toBe('$1,235')
    expect(usd(null)).toBe('—')
  })

  it('safeBookingUrl renders only https google.com links', () => {
    expect(safeBookingUrl('https://www.google.com/travel/flights?q=x')).toBe('https://www.google.com/travel/flights?q=x')
    expect(safeBookingUrl('javascript:alert(1)')).toBeNull()
    expect(safeBookingUrl('http://www.google.com/travel/flights')).toBeNull()
    expect(safeBookingUrl('https://evil.example/google.com')).toBeNull()
    expect(safeBookingUrl('https://google.com.evil.example/')).toBeNull()
    expect(safeBookingUrl(null)).toBeNull()
  })
})
