/**
 * The trip page's "next step" guide: which of the six stages a trip is at
 * and what the viewer can do about it. Pure, so the copy for each state is
 * unit-tested (src/lib/next-step.test.ts). Display only; the actions still
 * enforce every rule server-side.
 *
 * Stages: add airports → add destinations → find fares → vote → lock → book.
 */
import { DEMO_EMAILS_OFF } from './demo'
import type { TripStatus } from './types'

export const STAGES = [
  { key: 'airports', label: 'Airports' },
  { key: 'destinations', label: 'Destinations' },
  { key: 'fares', label: 'Fares' },
  { key: 'vote', label: 'Vote' },
  { key: 'lock', label: 'Lock' },
  { key: 'book', label: 'Book' },
] as const

export type StageKey = (typeof STAGES)[number]['key']
export type TripTab = 'crew' | 'destinations' | 'results' | 'book'

export interface NextStepInput {
  status: TripStatus
  isOrganizer: boolean
  /** My own traveler row has at least one home airport. */
  iHaveAirports: boolean
  /** Travelers (me, friends, ghosts) with at least one home airport. */
  travelersWithAirports: number
  candidateCount: number
  /** I've approved at least one destination. */
  iVoted: boolean
  /** Locked trips: have I ticked "booked"? */
  iBooked: boolean
  /** Locked trips: travelers ticked booked / all travelers. */
  bookedCount: number
  travelerCount: number
  /** Demo trip (src/lib/demo.ts): no emails, so the lock copy doesn't promise one. */
  isDemo?: boolean
}

export interface NextStep {
  stage: StageKey
  /** Index in STAGES, for the progress line. */
  index: number
  title: string
  body: string
  /** Where the button goes; null when there's nothing to click (waiting). */
  action: { label: string; tab: TripTab } | null
  /** True once the whole flow is done for this viewer. */
  done?: boolean
}

/** Same threshold as startSearch's `needs_airports` (SPEC §6). */
export const MIN_TRAVELERS_WITH_AIRPORTS = 2

function step(stage: StageKey, rest: Omit<NextStep, 'stage' | 'index'>): NextStep {
  return { stage, index: STAGES.findIndex((s) => s.key === stage), ...rest }
}

export function nextStep(t: NextStepInput): NextStep {
  if (t.status === 'locked') {
    if (t.iBooked) {
      const all = t.travelerCount > 0 && t.bookedCount >= t.travelerCount
      return step('book', {
        title: all ? 'Everyone is booked' : 'You’re booked',
        body: all
          ? 'The whole group has booked. Enjoy the trip.'
          : `${t.bookedCount} of ${t.travelerCount} booked so far. The checklist updates as people tick themselves off.`,
        action: { label: 'See the checklist', tab: 'book' },
        done: true,
      })
    }
    return step('book', {
      title: 'Book your flight',
      body: 'Use your Google Flights link, then tick “booked” so the group knows.',
      action: { label: 'Go to Book', tab: 'book' },
    })
  }

  if (t.status === 'searching') {
    return step('fares', {
      title: 'Fares are coming in',
      body: 'Each person’s fare appears as it’s found. Totals and rankings land when the search finishes.',
      action: { label: 'Watch results', tab: 'results' },
    })
  }

  if (t.status === 'results') {
    // Joined after the search: without home airports nobody can price them.
    if (!t.iHaveAirports) {
      return step('airports', {
        title: 'Add your home airports',
        body: 'You joined after fares were checked. Add your airports, then the organizer can find fares again with you in them.',
        action: { label: 'Go to Crew', tab: 'crew' },
      })
    }
    if (!t.iVoted) {
      return step('vote', {
        title: 'Vote for the places you’d go',
        body: 'Approve as many destinations as you like. Everyone sees the tally live.',
        action: { label: 'Go to Results', tab: 'results' },
      })
    }
    if (t.isOrganizer) {
      return step('lock', {
        title: 'Lock the destination',
        body: t.isDemo
          ? `When the group agrees, lock it. Everyone’s booking link is on the Book tab. ${DEMO_EMAILS_OFF}`
          : 'When the group agrees, lock it. Everyone gets an email with their own booking link.',
        action: { label: 'Go to Results', tab: 'results' },
      })
    }
    return step('lock', {
      title: 'Waiting for the organizer to lock a destination',
      body: 'Your vote is in. You can still change it until the trip is locked.',
      action: { label: 'See the votes', tab: 'results' },
    })
  }

  // gathering
  if (!t.iHaveAirports) {
    return step('airports', {
      title: 'Add your home airports',
      body: 'Pick the airports you’d fly from, plus any rules like nonstop only. A private budget is optional.',
      action: { label: 'Go to Crew', tab: 'crew' },
    })
  }
  if (t.travelersWithAirports < MIN_TRAVELERS_WITH_AIRPORTS) {
    return t.isOrganizer
      ? step('airports', {
          title: 'Bring in the group',
          body: 'Share the invite link, or use Add traveler to add ghost travelers for friends who won’t use the app.',
          action: { label: 'Go to Crew', tab: 'crew' },
        })
      : step('airports', {
          title: 'Waiting for the others',
          body: 'Fares can be checked once at least two people have home airports.',
          action: { label: 'See the crew', tab: 'crew' },
        })
  }
  if (t.candidateCount === 0) {
    return step('destinations', {
      title: 'Add destinations',
      body: t.isOrganizer
        ? 'Ask AI for ideas, add the geographic middle, or search for a city.'
        : 'Search for a city to add it. The organizer can also add AI ideas.',
      action: { label: 'Go to Destinations', tab: 'destinations' },
    })
  }
  return t.isOrganizer
    ? step('fares', {
        title: 'Find fares',
        body: 'Check every traveler’s fare to every destination at once.',
        action: { label: 'Go to Destinations', tab: 'destinations' },
      })
    : step('fares', {
        title: 'Waiting for the organizer to find fares',
        body: 'You can still add destinations or change your own settings.',
        action: { label: 'Go to Destinations', tab: 'destinations' },
      })
}
