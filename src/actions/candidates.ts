/**
 * Destination actions (SPEC §6): addCandidate, removeCandidate,
 * addMidpointHubs, suggestCandidates. RBAC is off inside actions; every check
 * below is the only check.
 *
 * Shared rules:
 * - At most LIMITS.maxCandidates per trip, enforced before writing and again
 *   after (two writers at once can both pass the first check; the newer rows
 *   back out, same as the last-seat guard in joinTrip).
 * - No duplicates: `uniqueOn ['tripId','iata']` refuses them atomically.
 * - Destinations can't change while fares are being checked or after the
 *   trip is locked.
 */
import type { ActionTools } from 'deepspace/worker'
import type { Env } from '../../worker'
import { AIRPORTS, airportByIata, knownHomeAirports } from '../lib/airports'
import { mayCallAi, usageDay, usageKeys } from '../lib/caps'
import { AI_MAX_TOKENS, AI_MODEL, LIMITS } from '../lib/limits'
import { nearestMajorHubs } from '../lib/midpoint'
import type { CandidateSource } from '../lib/types'
import {
  buildSuggestPrompt,
  classifyAiFailure,
  extractResponseText,
  parseSuggestionItems,
  selectSuggestions,
  suggestionCount,
  type PromptAirport,
} from '../lib/suggest'
import { iata, recordId } from '../lib/validate'
import { isTestTrip } from '../server/test-seam'
import {
  defineAction,
  fail,
  isDuplicate,
  loadTrip,
  must,
  ok,
  requireMember,
  requireOrganizer,
  type Failure,
  type Trip,
} from '../server/trip-access'
import { queryTravelers, sameIds } from '../server/trip-rows'
import { getUsageCount, incrementUsage } from '../server/usage'
import { seatOrder } from './trips'

interface NewCandidate {
  iata: string
  city: string
  country: string
  why: string
  source: CandidateSource
}

/** What actions return about each candidate they added. */
export type AddedCandidate = Pick<NewCandidate, 'iata' | 'city' | 'why' | 'source'>

const FULL = `A trip can have up to ${LIMITS.maxCandidates} destinations. Remove one to add another.`

export async function queryCandidates(tools: ActionTools, tripId: string) {
  return must(await tools.query('candidates', { where: { tripId } }), 'query candidates').records
}

/** Locked trips and running searches freeze the list. */
function frozen(trip: Trip): Failure | null {
  if (trip.data.status === 'locked') {
    return fail('trip_locked', 'This trip is locked, so its destinations can’t change.')
  }
  if (trip.data.status === 'searching') {
    return fail('search_running', 'Fares are being checked right now. Try again when the search finishes.')
  }
  return null
}

/** Every traveler's (validated) home airports, travelers without any left out. */
async function travelerHomes(tools: ActionTools, tripId: string): Promise<string[][]> {
  const travelers = await queryTravelers(tools, tripId)
  return travelers.map((t) => knownHomeAirports(t.data.homeAirports)).filter((h) => h.length > 0)
}

/**
 * Insert candidates, then enforce the per-trip maximum against concurrent
 * writers. Returns the ones that stayed. A duplicate (someone else added the
 * same airport a moment ago) is skipped, not an error.
 */
async function insertCandidates(
  tools: ActionTools,
  trip: Trip,
  userId: string,
  items: readonly NewCandidate[],
): Promise<NewCandidate[]> {
  const created: Array<{ recordId: string; item: NewCandidate }> = []
  for (const item of items) {
    const res = await tools.create('candidates', {
      tripId: trip.id,
      memberIds: [...trip.data.memberIds],
      ...item,
      addedBy: userId,
      complete: 0,
    })
    if (res.success) created.push({ recordId: res.data.recordId, item })
    else if (!isDuplicate(res)) must(res, 'create candidate')
  }
  if (created.length === 0) return []

  const after = await queryCandidates(tools, trip.id)
  let kept = created
  if (after.length > LIMITS.maxCandidates) {
    const order = seatOrder(after).map((r) => r.recordId)
    kept = []
    for (const c of created) {
      if (order.indexOf(c.recordId) >= LIMITS.maxCandidates) {
        must(await tools.remove('candidates', c.recordId), 'undo candidate')
      } else {
        kept.push(c)
      }
    }
  }

  // Someone may have joined while we wrote; their joinTrip propagation can
  // miss rows created after it ran, so match the trip's current members.
  const fresh = await loadTrip(tools, trip.id)
  if (fresh.ok && !sameIds(fresh.trip.data.memberIds, trip.data.memberIds)) {
    for (const c of kept) {
      must(
        await tools.update('candidates', c.recordId, { memberIds: [...fresh.trip.data.memberIds] }),
        'update candidate members',
      )
    }
  }
  return kept.map((c) => c.item)
}

const added = (items: readonly NewCandidate[]): AddedCandidate[] =>
  items.map(({ iata: code, city, why, source }) => ({ iata: code, city, why, source }))

/** Delete every row matching `where`, a page at a time. */
async function deleteAll(tools: ActionTools, collection: string, where: Record<string, unknown>) {
  const page = 500
  for (;;) {
    const { deleted } = must(await tools.deleteWhere(collection, where, page), `delete ${collection}`)
    if (deleted < page) return
  }
}

export const addCandidate = defineAction<Env>('addCandidate', async ({ userId, params, tools }) => {
  const tripId = recordId(params.tripId, 'Trip')
  if (!tripId.ok) return fail('invalid_params', tripId.error)
  const access = await requireMember(tools, tripId.value, userId)
  if (!access.ok) return access.result
  const code = iata(params.iata, 'Destination')
  if (!code.ok) return fail('invalid_params', code.error)
  const blocked = frozen(access.trip)
  if (blocked) return blocked

  const duplicate = () => fail('duplicate', `${code.value} is already on the list.`)
  const existing = await queryCandidates(tools, tripId.value)
  if (existing.some((c) => c.data.iata === code.value)) return duplicate()
  if (existing.length >= LIMITS.maxCandidates) return fail('candidates_full', FULL)

  const airport = airportByIata(code.value)!
  const [stayed] = await insertCandidates(tools, access.trip, userId, [
    { iata: code.value, city: airport.city, country: airport.country, why: '', source: 'manual' },
  ])
  if (!stayed) {
    // Lost a race: either the same airport or the last slot went to someone else.
    const now = await queryCandidates(tools, tripId.value)
    return now.some((c) => c.data.iata === code.value) ? duplicate() : fail('candidates_full', FULL)
  }
  return ok({ added: added([stayed]) })
})

export const removeCandidate = defineAction<Env>('removeCandidate', async ({ userId, params, tools }) => {
  const tripId = recordId(params.tripId, 'Trip')
  if (!tripId.ok) return fail('invalid_params', tripId.error)
  const access = await requireOrganizer(tools, tripId.value, userId)
  if (!access.ok) return access.result
  // Format only: a code that left airports.json must still be removable.
  const code = iata(params.iata, 'Destination', () => true)
  if (!code.ok) return fail('invalid_params', code.error)
  const blocked = frozen(access.trip)
  if (blocked) return blocked

  const { records } = must(
    await tools.query('candidates', { where: { tripId: tripId.value, iata: code.value }, limit: 1 }),
    'find candidate',
  )
  const row = records[0]
  if (!row) return fail('not_found', `${code.value} isn’t on the list.`)

  // Dependents first: if a delete fails, the candidate is still there and a retry finishes the job.
  const where = { tripId: tripId.value, candidateIata: code.value }
  await deleteAll(tools, 'fares', where)
  await deleteAll(tools, 'votes', where)
  // Old snapshots would otherwise come back as price history (and drop alerts) if it's re-added.
  await deleteAll(tools, 'fareSnapshots', where)
  must(await tools.remove('candidates', row.recordId), 'remove candidate')
  return ok({ iata: code.value })
})

/** Miles, for the "why" line (fares are in USD; most users think in miles). */
const KM_PER_MILE = 1.609344

export const addMidpointHubs = defineAction<Env>('addMidpointHubs', async ({ userId, params, tools }) => {
  const tripId = recordId(params.tripId, 'Trip')
  if (!tripId.ok) return fail('invalid_params', tripId.error)
  const access = await requireOrganizer(tools, tripId.value, userId)
  if (!access.ok) return access.result
  const blocked = frozen(access.trip)
  if (blocked) return blocked

  const homes = await travelerHomes(tools, tripId.value)
  if (homes.length < 2) {
    return fail('needs_airports', 'At least 2 travelers need home airports before there’s a middle to find.')
  }
  const existing = await queryCandidates(tools, tripId.value)
  const free = LIMITS.maxCandidates - existing.length
  if (free <= 0) return fail('candidates_full', FULL)

  const hubs = nearestMajorHubs(homes, AIRPORTS, {
    n: Math.min(2, free),
    exclude: existing.map((c) => String(c.data.iata)),
  })
  const items: NewCandidate[] = hubs.map(({ airport, distanceKm }) => {
    const km = Math.round(distanceKm / 10) * 10
    const mi = Math.round(distanceKm / KM_PER_MILE / 10) * 10
    return {
      iata: airport.iata,
      city: airport.city,
      country: airport.country,
      why: `Near the middle of everyone’s home airports: about ${mi} mi (${km} km) from the group’s center point.`,
      source: 'midpoint',
    }
  })
  const stayed = await insertCandidates(tools, access.trip, userId, items)
  return ok({ added: added(stayed) })
})

export const suggestCandidates = defineAction<Env>('suggestCandidates', async ({ userId, params, tools, env }) => {
  const tripId = recordId(params.tripId, 'Trip')
  if (!tripId.ok) return fail('invalid_params', tripId.error)
  const access = await requireOrganizer(tools, tripId.value, userId)
  if (!access.ok) return access.result
  const trip = access.trip
  const blocked = frozen(trip)
  if (blocked) return blocked

  // Everything that can refuse for free happens before the paid call.
  const existing = await queryCandidates(tools, tripId.value)
  const free = LIMITS.maxCandidates - existing.length
  if (free <= 0) return fail('candidates_full', FULL)

  const homes = await travelerHomes(tools, tripId.value)
  if (homes.length === 0) {
    return fail('needs_airports', 'Add at least one home airport in the Crew tab first.')
  }

  // 5 calls per user per UTC day (usage ledger; reading it fails closed).
  // `__test-` trips are exempt only when ALLOW_DEBUG_ROUTES === 'true' (src/server/test-seam.ts).
  const day = usageDay(new Date())
  const capKey = usageKeys.aiUser(userId)
  const exempt = isTestTrip(env, trip.data.name)
  if (!exempt && !mayCallAi(await getUsageCount(tools, day, capKey))) {
    return fail(
      'cap_reached',
      `You can ask for AI suggestions ${LIMITS.maxAiCallsPerUserPerDay} times per day. Try again tomorrow.`,
    )
  }

  const origins: PromptAirport[][] = homes.map((codes) =>
    codes.map((code) => {
      const a = airportByIata(code)!
      return { iata: a.iata, city: a.city, country: a.country }
    }),
  )
  const prompt = buildSuggestPrompt({
    origins,
    outboundDate: trip.data.outboundDate,
    returnDate: trip.data.returnDate,
    vibe: typeof trip.data.vibe === 'string' ? trip.data.vibe : '',
    existing: existing.map((c) => ({ iata: String(c.data.iata), city: String(c.data.city ?? '') })),
    count: suggestionCount(free),
  })

  // Always name the model and a small output budget: the endpoint defaults to Opus / 4096.
  const res = await tools.integration('anthropic/chat-completion', {
    model: AI_MODEL,
    max_tokens: AI_MAX_TOKENS,
    system: prompt.system,
    messages: [{ role: 'user', content: prompt.user }],
  })
  if (!res.success) {
    const failure = classifyAiFailure(res)
    console.error(`[action] suggestCandidates: provider ${failure.code}: ${failure.detail.slice(0, 300)}`)
    if (failure.code === 'provider_unavailable') return fail('provider_unavailable', failure.message)
    // We can't know a failed call wasn't billed, so it counts.
    if (!exempt) await incrementUsage(tools, day, capKey)
    return fail('ai_error', failure.message)
  }
  if (!exempt) await incrementUsage(tools, day, capKey)

  const text = extractResponseText(res.data) ?? ''
  const selection = selectSuggestions(parseSuggestionItems(text), {
    existing: existing.map((c) => String(c.data.iata)),
    freeSlots: free,
  })
  const stayed = await insertCandidates(
    tools,
    trip,
    userId,
    selection.accepted.map((s) => ({ ...s, source: 'ai' as const })),
  )
  return ok({
    added: added(stayed),
    dropped: selection.dropped.length,
    // Dev/test only: the exact prompt and the integration's raw reply, so the
    // one real API test can show them. Never in production (flag unset there).
    ...(env.ALLOW_DEBUG_ROUTES === 'true' ? { debug: { prompt, raw: res.data } } : {}),
  })
})
