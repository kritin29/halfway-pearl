import { describe, expect, it } from 'vitest'
import { nextStep, STAGES, type NextStepInput } from './next-step'

const base: NextStepInput = {
  status: 'gathering',
  isOrganizer: true,
  iHaveAirports: true,
  travelersWithAirports: 3,
  candidateCount: 2,
  iVoted: false,
  iBooked: false,
  bookedCount: 0,
  travelerCount: 3,
}

const at = (over: Partial<NextStepInput>) => nextStep({ ...base, ...over })

describe('nextStep: the six stages in order', () => {
  it('walks airports → destinations → fares → vote → lock → book', () => {
    const path = [
      at({ iHaveAirports: false, travelersWithAirports: 0, candidateCount: 0 }),
      at({ candidateCount: 0 }),
      at({}),
      at({ status: 'results' }),
      at({ status: 'results', iVoted: true }),
      at({ status: 'locked', iVoted: true }),
    ]
    expect(path.map((s) => s.stage)).toEqual(STAGES.map((s) => s.key))
    expect(path.map((s) => s.index)).toEqual([0, 1, 2, 3, 4, 5])
  })
})

describe('nextStep: gathering', () => {
  it('asks me for my own airports first, whoever I am', () => {
    for (const isOrganizer of [true, false]) {
      const s = at({ isOrganizer, iHaveAirports: false })
      expect(s.stage).toBe('airports')
      expect(s.title).toBe('Add your home airports')
      expect(s.action?.tab).toBe('crew')
    }
  })

  it('organizer alone: suggests the invite link or ghost travelers (the solo path)', () => {
    const s = at({ travelersWithAirports: 1 })
    expect(s.stage).toBe('airports')
    expect(s.body).toMatch(/ghost travelers/)
  })

  it('member with airports waits for a second traveler (same threshold as startSearch)', () => {
    const s = at({ isOrganizer: false, travelersWithAirports: 1 })
    expect(s.title).toBe('Waiting for the others')
    expect(at({ isOrganizer: false, travelersWithAirports: 2 }).stage).not.toBe('airports')
  })

  it('no destinations yet → destinations, with organizer-only tools named only to the organizer', () => {
    expect(at({ candidateCount: 0 }).body).toMatch(/Ask AI/)
    expect(at({ candidateCount: 0, isOrganizer: false }).body).toMatch(/organizer can also add AI ideas/)
  })

  it('ready to search: organizer gets "Find fares", members wait', () => {
    expect(at({}).title).toBe('Find fares')
    expect(at({ isOrganizer: false }).title).toBe('Waiting for the organizer to find fares')
  })

  it('a search that ended in a provider outage (back to gathering) points at Find fares again', () => {
    expect(at({ status: 'gathering' }).stage).toBe('fares')
  })
})

describe('nextStep: searching, results, locked', () => {
  it('searching → watch results come in', () => {
    const s = at({ status: 'searching' })
    expect(s.stage).toBe('fares')
    expect(s.action?.tab).toBe('results')
  })

  it('results: someone who joined after the search adds airports first', () => {
    const s = at({ status: 'results', iHaveAirports: false, isOrganizer: false })
    expect(s.stage).toBe('airports')
    expect(s.action?.tab).toBe('crew')
  })

  it('results: vote first, then lock (organizer) or wait (member)', () => {
    expect(at({ status: 'results' }).stage).toBe('vote')
    expect(at({ status: 'results', iVoted: true }).title).toBe('Lock the destination')
    expect(at({ status: 'results', iVoted: true, isOrganizer: false }).title).toMatch(/Waiting for the organizer/)
  })

  it('demo trips: the lock step doesn’t promise an email', () => {
    expect(at({ status: 'results', iVoted: true }).body).toMatch(/gets an email/)
    const demo = at({ status: 'results', iVoted: true, isDemo: true })
    expect(demo.title).toBe('Lock the destination')
    expect(demo.body).not.toMatch(/gets an email/)
    expect(demo.body).toMatch(/Emails are off in demo trips\./)
  })

  it('locked: book, then a done state with the live count', () => {
    expect(at({ status: 'locked' }).title).toBe('Book your flight')
    const mine = at({ status: 'locked', iBooked: true, bookedCount: 1, travelerCount: 3 })
    expect(mine.done).toBe(true)
    expect(mine.body).toMatch(/1 of 3 booked/)
    expect(at({ status: 'locked', iBooked: true, bookedCount: 3, travelerCount: 3 }).title).toBe('Everyone is booked')
  })

  it('never mentions money amounts (the guide is shown to everyone)', () => {
    const all = [
      at({}),
      at({ status: 'results' }),
      at({ status: 'results', iVoted: true }),
      at({ status: 'locked', iBooked: true, bookedCount: 1 }),
    ]
    for (const s of all) expect(`${s.title} ${s.body}`).not.toMatch(/\$\d/)
  })
})
