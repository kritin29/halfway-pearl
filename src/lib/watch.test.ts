import { describe, expect, it } from 'vitest'
import { detectGroupDrop, dropThreshold, findBudgetCrossings, type WatchFare } from './watch'

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
