/**
 * Results-tab view models (SPEC §3.6, §7). Pure, client-side, unit-tested.
 *
 * Totals, spread and fitsAll come from the aggregates the fare-search job
 * stored on each candidate (the job is the only code that sees budgets).
 * Per-person rows come from the live `fares` rows, so they fill in while a
 * search runs. The only budget here is the viewer's OWN row, for the private
 * "your fare vs your budget" line.
 */
import type { PriceLevel } from './flights'
import { arrivalBadge, ownFit, sortCandidates, type FareStatus, type RankedCandidate, type SortMode } from './ranking'
import { isGhostId } from './types'

export interface FareRow {
  candidateIata: string
  travelerId: string
  originIata?: string | null
  price?: number | null
  priceLevel?: string | null
  stops?: number | null
  durationMin?: number | null
  departLocal?: string | null
  arriveLocal?: string | null
  airline?: string | null
  bookingUrl?: string | null
  status?: string | null
}

export interface CandidateRow {
  iata: string
  city?: string | null
  country?: string | null
  complete?: number | null
  groupTotal?: number | null
  maxFare?: number | null
  minFare?: number | null
  arrivalSpreadMin?: number | null
  fitsAll?: number | null
  missingFor?: unknown
  lastCheckedAt?: string | null
}

export interface TravelerRow {
  userId: string
  displayName: string
}

export interface VoteRow {
  userId: string
  candidateIata: string
}

export interface PersonFare {
  status: FareStatus
  price: number | null
  originIata: string | null
  stops: number | null
  durationMin: number | null
  departLocal: string | null
  arriveLocal: string | null
  airline: string | null
  bookingUrl: string | null
  priceLevel: PriceLevel
  /** Lives at this destination: $0, no flight. */
  home: boolean
}

export interface ResultPerson {
  travelerId: string
  displayName: string
  isMe: boolean
  isGhost: boolean
  /** Null while this person's fare hasn't arrived (or they have no home airport). */
  fare: PersonFare | null
}

export interface ResultCard extends RankedCandidate {
  city: string
  country: string
  /** The job has aggregated this destination at least once. */
  checked: boolean
  people: ResultPerson[]
  priceLevel: PriceLevel
  /** "Everyone lands within 1h 40m", or null. */
  arrival: string | null
  votes: { count: number; mine: boolean; voters: string[] }
  /** The viewer's own fare vs their own budget; null without both. */
  own: { price: number; budget: number; fits: boolean; diff: number } | null
}

export interface BuildInput {
  candidates: readonly CandidateRow[]
  fares: readonly FareRow[]
  travelers: readonly TravelerRow[]
  votes: readonly VoteRow[]
  me: string
  /** The viewer's own budget (their own `budgets` row), or null. */
  myBudget: number | null
}

const FARE_STATUSES: readonly FareStatus[] = ['ok', 'no_results', 'filtered_out', 'error']
const LEVELS: readonly PriceLevel[] = ['low', 'typical', 'high', 'unknown']

export function buildResultCards(input: BuildInput): ResultCard[] {
  const names = new Map(input.travelers.map((t) => [t.userId, t.displayName]))
  return input.candidates.map((c) => {
    const fares = new Map(input.fares.filter((f) => f.candidateIata === c.iata).map((f) => [f.travelerId, f]))
    const people: ResultPerson[] = input.travelers.map((t) => {
      const row = fares.get(t.userId)
      return {
        travelerId: t.userId,
        displayName: t.displayName,
        isMe: t.userId === input.me,
        isGhost: isGhostId(t.userId),
        fare: row ? toPersonFare(row, c.iata) : null,
      }
    })
    const voters = input.votes.filter((v) => v.candidateIata === c.iata).map((v) => v.userId)
    const own = ownLine(people.find((p) => p.isMe)?.fare ?? null, input.myBudget)
    // The saved aggregate predates anyone who joined (or was added) after the
    // last search: they have no fare row, so the card isn't complete any more.
    const unpriced = people.filter((p) => !p.fare).map((p) => p.displayName)
    const complete = c.complete === 1 && unpriced.length === 0
    const savedMissing = Array.isArray(c.missingFor) ? c.missingFor.filter((n): n is string => typeof n === 'string') : []
    return {
      iata: c.iata,
      city: c.city ?? c.iata,
      country: c.country ?? '',
      checked: typeof c.lastCheckedAt === 'string' && c.lastCheckedAt.length > 0,
      complete,
      groupTotal: num(c.groupTotal),
      maxFare: num(c.maxFare),
      minFare: num(c.minFare),
      arrivalSpreadMin: num(c.arrivalSpreadMin),
      fitsAll: c.fitsAll === 1 ? 1 : c.fitsAll === 0 ? 0 : null,
      missingFor: c.complete === 1 ? unpriced : savedMissing,
      people,
      priceLevel: cardPriceLevel(people.map((p) => (p.fare?.status === 'ok' && !p.fare.home ? p.fare.priceLevel : 'unknown'))),
      arrival: complete ? arrivalBadge(num(c.arrivalSpreadMin)) : null,
      votes: {
        count: voters.length,
        mine: voters.includes(input.me),
        voters: voters.map((id) => (id === input.me ? 'You' : (names.get(id) ?? 'A traveler'))),
      },
      own,
    }
  })
}

/**
 * One badge for the card: "high" if anyone's route is priced high, "low" if
 * every known route is low, otherwise "typical"; "unknown" with no data.
 */
export function cardPriceLevel(levels: readonly PriceLevel[]): PriceLevel {
  const known = levels.filter((l) => l !== 'unknown')
  if (known.length === 0) return 'unknown'
  if (known.includes('high')) return 'high'
  if (known.every((l) => l === 'low')) return 'low'
  return 'typical'
}

/** Checked destinations in the tab's order (SPEC §7), then the ones never checked. */
export function sortResultCards(cards: readonly ResultCard[], mode: SortMode): ResultCard[] {
  return [...sortCandidates(cards.filter((c) => c.checked), mode), ...cards.filter((c) => !c.checked)]
}

/** "2026-12-11 07:15" → "7:15 AM" (local wall time, no timezone math). */
export function clockTime(local: string | null | undefined): string | null {
  const m = /^\d{4}-\d{2}-\d{2} (\d{2}):(\d{2})$/.exec(local ?? '')
  if (!m) return null
  const h = Number(m[1])
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`
}

/** 0 → "Nonstop", 1 → "1 stop", 2 → "2 stops". */
export function stopsLabel(stops: number | null): string | null {
  if (stops === null) return null
  return stops === 0 ? 'Nonstop' : `${stops} stop${stops === 1 ? '' : 's'}`
}

/** Whole dollars: 1234.5 → "$1,235". */
export function usd(amount: number | null): string {
  return amount === null ? '—' : `$${Math.round(amount).toLocaleString('en-US')}`
}

function ownLine(fare: PersonFare | null, budget: number | null): ResultCard['own'] {
  if (!fare || fare.status !== 'ok' || fare.price === null || budget === null) return null
  const fit = ownFit(fare.price, budget)
  return fit ? { price: fare.price, budget, ...fit } : null
}

function toPersonFare(row: FareRow, iata: string): PersonFare {
  const status = FARE_STATUSES.includes(row.status as FareStatus) ? (row.status as FareStatus) : 'error'
  const price = num(row.price)
  return {
    status,
    price,
    originIata: row.originIata ?? null,
    stops: num(row.stops),
    durationMin: num(row.durationMin),
    departLocal: row.departLocal ?? null,
    arriveLocal: row.arriveLocal ?? null,
    airline: row.airline ?? null,
    bookingUrl: safeBookingUrl(row.bookingUrl),
    priceLevel: LEVELS.includes(row.priceLevel as PriceLevel) ? (row.priceLevel as PriceLevel) : 'unknown',
    home: status === 'ok' && price === 0 && row.originIata === iata,
  }
}

/** Only https Google Flights links are rendered as links. */
export function safeBookingUrl(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && /(^|\.)google\.com$/.test(u.hostname) ? u.toString() : null
  } catch {
    return null
  }
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}
