import { describe, expect, it } from 'vitest'
import {
  aggregateCandidate,
  arrivalBadge,
  formatDuration,
  ownFit,
  parseLocalMinutes,
  sortCandidates,
  type RankFare,
  type RankTraveler,
  type RankedCandidate,
} from './ranking'

const T: RankTraveler[] = [
  { id: 'u-alice', displayName: 'Alice' },
  { id: 'u-bob', displayName: 'Bob' },
  { id: 'ghost:carol', displayName: 'Carol' },
]

function ok(travelerId: string, price: number, arriveLocal = '2026-12-11 12:00'): RankFare {
  return { travelerId, status: 'ok', price, arriveLocal }
}

const noBudgets = new Map<string, number>()

describe('aggregateCandidate', () => {
  it('computes totals, min/max and arrival spread when every traveler has an ok fare', () => {
    const agg = aggregateCandidate(
      T,
      [
        ok('u-alice', 200, '2026-12-11 09:10'),
        ok('u-bob', 310.5, '2026-12-11 10:50'),
        ok('ghost:carol', 150, '2026-12-11 09:30'),
      ],
      noBudgets,
    )
    expect(agg).toEqual({
      complete: true,
      groupTotal: 660.5,
      maxFare: 310.5,
      minFare: 150,
      arrivalSpreadMin: 100,
      fitsAll: null,
      missingFor: [],
    })
  })

  it('measures arrival spread across midnight', () => {
    const agg = aggregateCandidate(
      T.slice(0, 2),
      [ok('u-alice', 100, '2026-12-11 23:30'), ok('u-bob', 100, '2026-12-12 01:00')],
      noBudgets,
    )
    expect(agg.arrivalSpreadMin).toBe(90)
  })

  it('is incomplete, with nulls and names, when a traveler has no ok fare', () => {
    const agg = aggregateCandidate(
      T,
      [ok('u-alice', 200), { travelerId: 'u-bob', status: 'filtered_out', price: null, arriveLocal: null }],
      noBudgets,
    )
    expect(agg.complete).toBe(false)
    expect(agg.groupTotal).toBeNull()
    expect(agg.maxFare).toBeNull()
    expect(agg.arrivalSpreadMin).toBeNull()
    expect(agg.fitsAll).toBeNull()
    expect(agg.missingFor).toEqual(['Bob', 'Carol'])
  })

  it('counts a home fare (price 0) in totals but not in the arrival spread', () => {
    const agg = aggregateCandidate(
      T,
      [
        ok('u-alice', 200, '2026-12-11 09:10'),
        { travelerId: 'u-bob', status: 'ok', price: 0, arriveLocal: null, home: true },
        ok('ghost:carol', 150, '2026-12-11 09:40'),
      ],
      noBudgets,
    )
    expect(agg.complete).toBe(true)
    expect(agg.groupTotal).toBe(350)
    expect(agg.minFare).toBe(0)
    expect(agg.arrivalSpreadMin).toBe(30)
  })

  it('gives a spread of 0 when nobody has to fly', () => {
    const home = (id: string): RankFare => ({ travelerId: id, status: 'ok', price: 0, arriveLocal: null, home: true })
    expect(aggregateCandidate(T.slice(0, 2), [home('u-alice'), home('u-bob')], noBudgets).arrivalSpreadMin).toBe(0)
  })

  it('treats a trip with no travelers as incomplete', () => {
    expect(aggregateCandidate([], [], noBudgets).complete).toBe(false)
  })

  it('leaves arrival spread null when a time is missing but still totals prices', () => {
    const agg = aggregateCandidate(
      T.slice(0, 2),
      [ok('u-alice', 100), { travelerId: 'u-bob', status: 'ok', price: 120, arriveLocal: null }],
      noBudgets,
    )
    expect(agg.groupTotal).toBe(220)
    expect(agg.arrivalSpreadMin).toBeNull()
  })
})

describe('fitsAll privacy guard', () => {
  const fares = [ok('u-alice', 200), ok('u-bob', 300), ok('ghost:carol', 150)]

  it('is hidden (null) with fewer than 3 budgets, even when someone does not fit', () => {
    const twoBudgets = new Map([
      ['u-alice', 100], // Alice doesn't fit; with 2 budgets this must not be revealed
      ['u-bob', 500],
    ])
    expect(aggregateCandidate(T, fares, twoBudgets).fitsAll).toBeNull()
  })

  it('is 1 with 3 budgets when everyone fits (price equal to budget fits)', () => {
    const budgets = new Map([
      ['u-alice', 200],
      ['u-bob', 400],
      ['ghost:carol', 150],
    ])
    expect(aggregateCandidate(T, fares, budgets).fitsAll).toBe(1)
  })

  it('is 0 with 3 budgets when anyone does not fit', () => {
    const budgets = new Map([
      ['u-alice', 199.99],
      ['u-bob', 400],
      ['ghost:carol', 150],
    ])
    expect(aggregateCandidate(T, fares, budgets).fitsAll).toBe(0)
  })

  it('ignores budgets for ids that are not travelers on the trip', () => {
    const budgets = new Map([
      ['u-alice', 500],
      ['u-bob', 500],
      ['u-stranger', 1],
    ])
    expect(aggregateCandidate(T, fares, budgets).fitsAll).toBeNull()
  })

  it('only checks travelers who have a budget', () => {
    const four = [...T, { id: 'u-dan', displayName: 'Dan' }]
    const budgets = new Map([
      ['u-alice', 500],
      ['u-bob', 500],
      ['ghost:carol', 500],
    ])
    const agg = aggregateCandidate(four, [...fares, ok('u-dan', 9999)], budgets)
    expect(agg.fitsAll).toBe(1)
  })

  it('does not count a budgeted traveler who lives at the destination ($0 always fits)', () => {
    // Carol lives here. Alice knows her own fare fits, so a "0" would point straight at Bob.
    const homeFares = [ok('u-alice', 200), ok('u-bob', 450), ok('ghost:carol', 0)]
    const budgets = new Map([
      ['u-alice', 300],
      ['u-bob', 400],
      ['ghost:carol', 100],
    ])
    expect(aggregateCandidate(T, homeFares, budgets).fitsAll).toBeNull()
  })

  it('still shows with 3 budgeted travelers above $0 when a 4th lives there', () => {
    const four = [...T, { id: 'u-dan', displayName: 'Dan' }]
    const budgets = new Map([
      ['u-alice', 300],
      ['u-bob', 400],
      ['ghost:carol', 100],
      ['u-dan', 50],
    ])
    const agg = aggregateCandidate(four, [ok('u-alice', 200), ok('u-bob', 450), ok('ghost:carol', 90), ok('u-dan', 0)], budgets)
    expect(agg.fitsAll).toBe(0)
  })
})

describe('sortCandidates', () => {
  function c(iata: string, p: Partial<RankedCandidate>): RankedCandidate {
    return {
      iata,
      complete: true,
      groupTotal: 0,
      maxFare: 0,
      minFare: 0,
      arrivalSpreadMin: 0,
      fitsAll: null,
      missingFor: [],
      ...p,
    }
  }
  const list = [
    c('AAA', { groupTotal: 900, maxFare: 320, arrivalSpreadMin: 300 }),
    c('BBB', { groupTotal: 800, maxFare: 500, arrivalSpreadMin: 30 }),
    c('CCC', { groupTotal: 850, maxFare: 300, arrivalSpreadMin: 30 }),
    c('DDD', { complete: false, groupTotal: null, maxFare: null, arrivalSpreadMin: null, missingFor: ['Bob'] }),
    c('EEE', { groupTotal: 700, maxFare: 290, arrivalSpreadMin: null }),
  ]
  const order = (mode: Parameters<typeof sortCandidates>[1]) => sortCandidates(list, mode).map((x) => x.iata)

  it('cheapest: group total ascending, incomplete last', () => {
    expect(order('cheapest')).toEqual(['EEE', 'BBB', 'CCC', 'AAA', 'DDD'])
  })

  it('fairest: lowest max fare first (protects the worst-off person)', () => {
    expect(order('fairest')).toEqual(['EEE', 'CCC', 'AAA', 'BBB', 'DDD'])
  })

  it('fairest: ties on max fare break by group total', () => {
    const tie = [c('XXX', { maxFare: 300, groupTotal: 950 }), c('YYY', { maxFare: 300, groupTotal: 900 })]
    expect(sortCandidates(tie, 'fairest').map((x) => x.iata)).toEqual(['YYY', 'XXX'])
  })

  it('together: smallest arrival spread first, ties by group total, unknown spread after known', () => {
    expect(order('together')).toEqual(['BBB', 'CCC', 'AAA', 'EEE', 'DDD'])
  })

  it('orders incomplete candidates by fewest missing fares', () => {
    const inc = [
      c('ZZZ', { complete: false, missingFor: ['A', 'B'] }),
      c('YYY', { complete: false, missingFor: ['A'] }),
    ]
    expect(sortCandidates(inc, 'cheapest').map((x) => x.iata)).toEqual(['YYY', 'ZZZ'])
  })

  it('does not mutate its input', () => {
    const before = list.map((x) => x.iata)
    sortCandidates(list, 'fairest')
    expect(list.map((x) => x.iata)).toEqual(before)
  })
})

describe('badges and helpers', () => {
  it('arrivalBadge shows up to 3h and hides above', () => {
    expect(arrivalBadge(100)).toBe('Everyone lands within 1h 40m')
    expect(arrivalBadge(180)).toBe('Everyone lands within 3h')
    expect(arrivalBadge(181)).toBeNull()
    expect(arrivalBadge(null)).toBeNull()
  })

  it('formatDuration', () => {
    expect(formatDuration(0)).toBe('0m')
    expect(formatDuration(45)).toBe('45m')
    expect(formatDuration(120)).toBe('2h')
    expect(formatDuration(135)).toBe('2h 15m')
  })

  it('ownFit compares the viewer’s fare with their own budget', () => {
    expect(ownFit(250, 300)).toEqual({ fits: true, diff: 50 })
    expect(ownFit(300, 300)).toEqual({ fits: true, diff: 0 })
    expect(ownFit(320.5, 300)).toEqual({ fits: false, diff: -20.5 })
    expect(ownFit(null, 300)).toBeNull()
    expect(ownFit(250, null)).toBeNull()
  })

  it('parseLocalMinutes accepts space or T separators and rejects junk', () => {
    expect(parseLocalMinutes('2026-12-11 9:05')).toBe(parseLocalMinutes('2026-12-11T09:05'))
    expect(parseLocalMinutes('soon')).toBeNull()
    expect(parseLocalMinutes(null)).toBeNull()
  })
})
