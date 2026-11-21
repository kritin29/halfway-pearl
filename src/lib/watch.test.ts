import { describe, expect, it } from 'vitest'
import { LIMITS } from './limits'
import {
  dateInZone,
  daysBetween,
  detectGroupDrop,
  dropThreshold,
  findBudgetCrossings,
  isWatchPending,
  isWatchWindowOpen,
  selectShortlist,
  selectWatchTrips,
  type WatchFare,
} from './watch'

describe('dropThreshold: max($50, 5%)', () => {
  it('uses $50 for totals up to $1000', () => {
    expect(dropThreshold(400)).toBe(50)
    expect(dropThreshold(1000)).toBe(50)
  })
  it('uses 5% above $1000', () => {
    expect(dropThreshold(1200)).toBe(60)
    expect(dropThreshold(2500)).toBe(125)
  })
})

describe('detectGroupDrop', () => {
  it('fires when the drop equals the threshold', () => {
    expect(detectGroupDrop({ groupTotal: 800 }, { groupTotal: 750 })).toEqual({
      previousTotal: 800,
      currentTotal: 750,
      amount: 50,
      threshold: 50,
    })
  })

  it('does not fire just under the threshold', () => {
    expect(detectGroupDrop({ groupTotal: 800 }, { groupTotal: 750.01 })).toBeNull()
  })

  it('uses 5% for large totals', () => {
    expect(detectGroupDrop({ groupTotal: 2000 }, { groupTotal: 1940 })).toBeNull() // 60 < 100
    expect(detectGroupDrop({ groupTotal: 2000 }, { groupTotal: 1900 })?.amount).toBe(100)
  })

  it('does not fire on a price rise', () => {
    expect(detectGroupDrop({ groupTotal: 800 }, { groupTotal: 900 })).toBeNull()
  })

  it('needs both a previous snapshot and complete totals', () => {
    expect(detectGroupDrop(null, { groupTotal: 100 })).toBeNull()
    expect(detectGroupDrop(undefined, { groupTotal: 100 })).toBeNull()
    expect(detectGroupDrop({ groupTotal: null }, { groupTotal: 100 })).toBeNull()
    expect(detectGroupDrop({ groupTotal: 800 }, { groupTotal: null })).toBeNull()
  })
})

describe('findBudgetCrossings', () => {
  const budgets = new Map([
    ['u-alice', 300],
    ['u-bob', 250],
  ])
  const f = (travelerId: string, candidateIata: string, price: number | null): WatchFare => ({
    travelerId,
    candidateIata,
    price,
  })

  it('reports a fare going from above to at-or-below the budget', () => {
    const out = findBudgetCrossings([f('u-alice', 'BNA', 340)], [f('u-alice', 'BNA', 300)], budgets)
    expect(out).toEqual([{ travelerId: 'u-alice', candidateIata: 'BNA', previousPrice: 340, price: 300, budget: 300 }])
  })

  it('stays quiet when the fare was already under budget (no repeat emails)', () => {
    expect(findBudgetCrossings([f('u-alice', 'BNA', 280)], [f('u-alice', 'BNA', 260)], budgets)).toEqual([])
  })

  it('stays quiet when the fare is still above budget', () => {
    expect(findBudgetCrossings([f('u-alice', 'BNA', 400)], [f('u-alice', 'BNA', 350)], budgets)).toEqual([])
  })

  it('re-arms after going back above budget', () => {
    const day2 = findBudgetCrossings([f('u-alice', 'BNA', 290)], [f('u-alice', 'BNA', 320)], budgets)
    const day3 = findBudgetCrossings([f('u-alice', 'BNA', 320)], [f('u-alice', 'BNA', 295)], budgets)
    expect(day2).toEqual([])
    expect(day3).toHaveLength(1)
  })

  it('needs a previous price, a current price and a budget', () => {
    expect(findBudgetCrossings([], [f('u-alice', 'BNA', 200)], budgets)).toEqual([])
    expect(findBudgetCrossings([f('u-alice', 'BNA', null)], [f('u-alice', 'BNA', 200)], budgets)).toEqual([])
    expect(findBudgetCrossings([f('u-alice', 'BNA', 400)], [f('u-alice', 'BNA', null)], budgets)).toEqual([])
    expect(findBudgetCrossings([f('ghost:c', 'BNA', 400)], [f('ghost:c', 'BNA', 100)], budgets)).toEqual([])
  })

  it('matches fares per traveler AND candidate', () => {
    const out = findBudgetCrossings(
      [f('u-bob', 'BNA', 300), f('u-bob', 'AUS', 200)],
      [f('u-bob', 'BNA', 240), f('u-bob', 'AUS', 240)],
      budgets,
    )
    expect(out.map((c) => c.candidateIata)).toEqual(['BNA'])
  })
})

describe('selectShortlist: the locked destination, else the top 3 by votes', () => {
  const c = (iata: string, groupTotal: number | null) => ({ iata, groupTotal })
  const v = (...iatas: string[]) => iatas.map((candidateIata) => ({ candidateIata }))
  const candidates = [c('AUS', 900), c('BNA', 700), c('DEN', 800), c('MIA', 600), c('SAN', null)]

  it('a locked trip watches only the locked destination, whatever the votes', () => {
    expect(selectShortlist({ status: 'locked', lockedIata: 'DEN' }, candidates, v('AUS', 'AUS', 'BNA'))).toEqual(['DEN'])
  })

  it('a locked destination that is no longer a candidate gives an empty shortlist', () => {
    expect(selectShortlist({ status: 'locked', lockedIata: 'ORD' }, candidates, [])).toEqual([])
  })

  it('takes the 3 with the most votes', () => {
    expect(selectShortlist({ status: 'results' }, candidates, v('AUS', 'AUS', 'AUS', 'SAN', 'SAN', 'DEN'))).toEqual(['AUS', 'SAN', 'DEN'])
  })

  it('breaks vote ties by the cheaper group total, incomplete last, then IATA', () => {
    // AUS and BNA tie on 1 vote → BNA ($700) first; the rest tie on 0 → MIA ($600), DEN ($800)…
    expect(selectShortlist({ status: 'results' }, candidates, v('AUS', 'BNA'))).toEqual(['BNA', 'AUS', 'MIA'])
    // SAN (incomplete) loses a tie to any complete total.
    expect(selectShortlist({ status: 'results' }, [c('SAN', null), c('AUS', 5000)], v('SAN', 'AUS'), 1)).toEqual(['AUS'])
    // Equal totals → alphabetical, so the order never flickers.
    expect(selectShortlist({ status: 'results' }, [c('MIA', 500), c('AUS', 500)], [], 2)).toEqual(['AUS', 'MIA'])
  })

  it('with no votes at all, the cheapest destinations fill the shortlist', () => {
    expect(selectShortlist({ status: 'results' }, candidates, [])).toEqual(['MIA', 'BNA', 'DEN'])
  })

  it('ignores votes for destinations that are gone and returns fewer than 3 when there are fewer', () => {
    expect(selectShortlist({ status: 'results' }, [c('AUS', 900), c('BNA', 700)], v('ORD', 'ORD', 'AUS'))).toEqual(['AUS', 'BNA'])
  })
})

describe('the watch window: stops once departure is ≤ 1 day away', () => {
  it('counts calendar days', () => {
    expect(daysBetween('2026-11-21', '2026-11-23')).toBe(2)
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1)
    expect(daysBetween('2026-11-21', 'soon')).toBeNull()
  })

  it('is open 2+ days out and closed 1 day out, on the day, and after', () => {
    expect(isWatchWindowOpen('2026-11-23', '2026-11-21')).toBe(true)
    expect(isWatchWindowOpen('2026-11-22', '2026-11-21')).toBe(false)
    expect(isWatchWindowOpen('2026-11-21', '2026-11-21')).toBe(false)
    expect(isWatchWindowOpen('2026-11-01', '2026-11-21')).toBe(false)
    expect(isWatchWindowOpen('not-a-date', '2026-11-21')).toBe(false)
  })

  it('"today" is the Chicago calendar date, the cron’s timezone', () => {
    // 03:00 UTC on Nov 22 is still the evening of Nov 21 in Chicago.
    expect(dateInZone(new Date('2026-11-22T03:00:00Z'))).toBe('2026-11-21')
    expect(dateInZone(new Date('2026-11-22T14:00:00Z'))).toBe('2026-11-22')
  })
})

describe('isWatchPending', () => {
  const now = new Date('2026-11-21T12:00:00Z')
  it('is pending while queued, and not once cleared', () => {
    expect(isWatchPending('2026-11-21T11:59:00Z', now)).toBe(true)
    expect(isWatchPending(null, now)).toBe(false)
    expect(isWatchPending('', now)).toBe(false)
  })
  it('a run queued longer ago than staleWatchMs counts as lost', () => {
    const old = new Date(now.getTime() - LIMITS.staleWatchMs).toISOString()
    expect(isWatchPending(old, now)).toBe(false)
  })
})

describe('selectWatchTrips: the cron’s trip filter', () => {
  const today = '2026-11-21'
  const t = (id: string, over: Partial<{ watchEnabled: unknown; status: unknown; outboundDate: unknown }> = {}) => ({
    id,
    watchEnabled: 1,
    status: 'results',
    outboundDate: '2026-12-11',
    ...over,
  })

  it('keeps watch-on trips with results or locked and departure more than a day away', () => {
    const trips = [
      t('ok-results'),
      t('ok-locked', { status: 'locked' }),
      t('watch-off', { watchEnabled: 0 }),
      t('gathering', { status: 'gathering' }),
      t('searching', { status: 'searching' }),
      t('tomorrow', { outboundDate: '2026-11-22' }),
      t('today', { outboundDate: '2026-11-21' }),
      t('two-days', { outboundDate: '2026-11-23' }),
      t('bad-date', { outboundDate: null }),
    ]
    const { selected, eligible } = selectWatchTrips(trips, today)
    expect(selected.map((x) => x.id).sort()).toEqual(['ok-locked', 'ok-results', 'two-days'])
    expect(eligible).toBe(3)
  })

  it('takes at most 10 per run, soonest departure first', () => {
    const trips = Array.from({ length: 13 }, (_, i) => t(`trip-${String(i).padStart(2, '0')}`, { outboundDate: `2026-12-${String(20 - i).padStart(2, '0')}` }))
    const { selected, eligible } = selectWatchTrips(trips, today)
    expect(eligible).toBe(13)
    expect(selected).toHaveLength(LIMITS.maxWatchTripsPerCronRun)
    expect(selected[0].id).toBe('trip-12') // Dec 8, the soonest
    expect(selected.map((x) => x.id)).not.toContain('trip-00') // Dec 20, the latest
  })
})
