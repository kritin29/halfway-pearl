import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActionHandler, ActionResult, ActionTools } from 'deepspace/worker'
import type { Env } from '../../worker'
import { AIRPORTS, knownHomeAirports } from '../lib/airports'
import { usageKeys, usageRecordId } from '../lib/caps'
import { AI_MAX_TOKENS, AI_MODEL, LIMITS } from '../lib/limits'
import { nearestMajorHubs } from '../lib/midpoint'
import { AI_ERROR_MESSAGE, AI_UNAVAILABLE_MESSAGE } from '../lib/suggest'
import { createFakeStore, type FakeStore } from '../server/testing/fake-tools'
import { addCandidate, addMidpointHubs, removeCandidate, suggestCandidates } from './candidates'
import { addGhost } from './ghosts'
import { createTrip, joinTrip } from './trips'

const ALICE = 'user_alice'
const BOB = 'user_bob'
const CAROL = 'user_carol'
const DAY = '2026-11-20'

let store: FakeStore

function call(
  action: ActionHandler<Env>,
  userId: string,
  params: Record<string, unknown>,
  env: Partial<Env> = {},
  tools: ActionTools = store.toolsFor(userId),
) {
  return action({ userId, params, tools, env: env as Env, callerJwt: 'jwt' }) as Promise<
    ActionResult<Record<string, unknown>>
  >
}

function data<T = Record<string, unknown>>(res: ActionResult<unknown>): T {
  if (!res.success) throw new Error(`expected success, got ${res.code}: ${res.error}`)
  return res.data as T
}

const candidatesOf = (tripId: string) => store.rows('candidates').filter((r) => r.data.tripId === tripId)
const iatasOf = (tripId: string) => candidatesOf(tripId).map((r) => r.data.iata)
const usageCount = (key: string) =>
  store.rows('usage').find((r) => r.recordId === usageRecordId(DAY, key))?.data.count ?? 0

/** Alice's trip with Bob on it; Carol is an outsider. */
async function setup(name = 'Spring break') {
  const { tripId, inviteCode } = data<{ tripId: string; inviteCode: string }>(
    await call(createTrip, ALICE, { name, outboundDate: '2026-12-11', returnDate: '2026-12-13', vibe: 'beach, cheap' }),
  )
  data(await call(joinTrip, BOB, { inviteCode }))
  return { tripId, inviteCode }
}

async function setHomes(tripId: string, userId: string, homeAirports: unknown) {
  const row = store.rows('travelers').find((r) => r.data.tripId === tripId && r.data.userId === userId)!
  data(await store.toolsFor('server').update('travelers', row.recordId, { homeAirports }))
}

async function fill(tripId: string, codes: string[]) {
  for (const iata of codes) data(await call(addCandidate, ALICE, { tripId, iata }))
}

const setStatus = (tripId: string, status: string) =>
  store.toolsFor('server').update('trips', tripId, { status })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(`${DAY}T12:00:00Z`))
  store = createFakeStore()
  store.seed('users', ALICE, { name: 'Alice A.', email: 'alice@example.test' }, ALICE)
  store.seed('users', BOB, { name: 'Bob', email: 'bob@example.test' }, BOB)
  store.seed('users', CAROL, { name: 'Carol', email: 'carol@example.test' }, CAROL)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('addCandidate (any member)', () => {
  afterEach(() => expect(store.integrationCalls).toEqual([]))

  it('a member adds a manual candidate with city/country from airports.json', async () => {
    const { tripId } = await setup()
    expect(data(await call(addCandidate, BOB, { tripId, iata: 'bna' }))).toEqual({
      added: [{ iata: 'BNA', city: 'Nashville', why: '', source: 'manual' }],
    })
    const [row] = candidatesOf(tripId)
    expect(row.data).toMatchObject({
      tripId,
      memberIds: [ALICE, BOB],
      iata: 'BNA',
      city: 'Nashville',
      country: 'United States',
      why: '',
      source: 'manual',
      addedBy: BOB,
      complete: 0,
    })
  })

  it('outsiders get not_found; bad and unknown codes are invalid; nothing is written', async () => {
    const { tripId } = await setup()
    expect(await call(addCandidate, CAROL, { tripId, iata: 'BNA' })).toMatchObject({ code: 'not_found' })
    for (const iata of ['ZZZ', 'BN', 'BNAX', 42, undefined, '']) {
      expect(await call(addCandidate, BOB, { tripId, iata }), String(iata)).toMatchObject({ code: 'invalid_params' })
    }
    expect(await call(addCandidate, BOB, { tripId: '../x', iata: 'BNA' })).toMatchObject({ code: 'invalid_params' })
    expect(candidatesOf(tripId)).toEqual([])
  })

  it('refuses duplicates', async () => {
    const { tripId } = await setup()
    await fill(tripId, ['BNA'])
    expect(await call(addCandidate, BOB, { tripId, iata: 'bna' })).toMatchObject({
      success: false,
      code: 'duplicate',
    })
    expect(iatasOf(tripId)).toEqual(['BNA'])
  })

  it(`allows at most ${LIMITS.maxCandidates}; the 7th is refused`, async () => {
    const { tripId } = await setup()
    await fill(tripId, ['BNA', 'AUS', 'DEN', 'MSY', 'MIA', 'SEA'])
    expect(await call(addCandidate, BOB, { tripId, iata: 'SAN' })).toMatchObject({
      success: false,
      code: 'candidates_full',
    })
    expect(candidatesOf(tripId)).toHaveLength(6)
  })

  it('two writers at once: the newer row backs out when the trip would go over the max', async () => {
    const { tripId } = await setup()
    await fill(tripId, ['BNA', 'AUS', 'DEN', 'MSY', 'MIA'])
    // Bob's insert happens while Alice's action is between its check and its write.
    const tools = store.toolsFor(ALICE)
    const racing: ActionTools = {
      ...tools,
      async create(collection, row, id) {
        if (collection === 'candidates' && row.iata === 'SEA') {
          data(await call(addCandidate, BOB, { tripId, iata: 'SAN' }))
        }
        return tools.create(collection, row, id)
      },
    }
    expect(await call(addCandidate, ALICE, { tripId, iata: 'SEA' }, {}, racing)).toMatchObject({
      code: 'candidates_full',
    })
    expect(iatasOf(tripId).sort()).toEqual(['AUS', 'BNA', 'DEN', 'MIA', 'MSY', 'SAN'])
  })

  it('a join that lands mid-write still ends up in the new row’s memberIds', async () => {
    const { tripId, inviteCode } = await setup()
    const tools = store.toolsFor(ALICE)
    const racing: ActionTools = {
      ...tools,
      async create(collection, row, id) {
        if (collection === 'candidates') data(await call(joinTrip, CAROL, { inviteCode }))
        return tools.create(collection, row, id)
      },
    }
    data(await call(addCandidate, ALICE, { tripId, iata: 'BNA' }, {}, racing))
    expect(candidatesOf(tripId)[0].data.memberIds).toEqual([ALICE, BOB, CAROL])
  })

  it('locked trips and running searches freeze the list', async () => {
    const { tripId } = await setup()
    await setStatus(tripId, 'searching')
    expect(await call(addCandidate, BOB, { tripId, iata: 'BNA' })).toMatchObject({ code: 'search_running' })
    await setStatus(tripId, 'locked')
    expect(await call(addCandidate, BOB, { tripId, iata: 'BNA' })).toMatchObject({ code: 'trip_locked' })
    await setStatus(tripId, 'results')
    data(await call(addCandidate, BOB, { tripId, iata: 'BNA' }))
  })
})

describe('removeCandidate (organizer)', () => {
  afterEach(() => expect(store.integrationCalls).toEqual([]))

  async function withDependents() {
    const { tripId } = await setup()
    const other = (await setup('Other trip')).tripId
    await fill(tripId, ['BNA', 'AUS'])
    await fill(other, ['BNA'])
    const server = store.toolsFor('server')
    for (const t of [tripId, other]) {
      for (const iata of ['BNA', 'AUS']) {
        for (const travelerId of [ALICE, BOB]) {
          data(await server.create('fares', { tripId: t, memberIds: [], candidateIata: iata, travelerId, price: 100 }))
        }
        data(await server.create('fareSnapshots', { tripId: t, memberIds: [], candidateIata: iata, groupTotal: 200 }))
      }
      data(await store.toolsFor(BOB).create('votes', { tripId: t, memberIds: [], userId: BOB, candidateIata: 'BNA' }))
      data(await store.toolsFor(BOB).create('votes', { tripId: t, memberIds: [], userId: BOB, candidateIata: 'AUS' }))
    }
    return { tripId, other }
  }

  const left = (collection: string, tripId: string) =>
    store
      .rows(collection)
      .filter((r) => r.data.tripId === tripId)
      .map((r) => r.data.candidateIata)
      .sort()

  it('deletes the candidate and its fares, votes and snapshots; nothing else', async () => {
    const { tripId, other } = await withDependents()
    expect(data(await call(removeCandidate, ALICE, { tripId, iata: 'bna' }))).toEqual({ iata: 'BNA' })
    expect(iatasOf(tripId)).toEqual(['AUS'])
    expect(left('fares', tripId)).toEqual(['AUS', 'AUS'])
    expect(left('votes', tripId)).toEqual(['AUS'])
    expect(left('fareSnapshots', tripId)).toEqual(['AUS'])
    // The other trip's BNA is untouched.
    expect(iatasOf(other)).toEqual(['BNA'])
    expect(left('fares', other)).toEqual(['AUS', 'AUS', 'BNA', 'BNA'])
    expect(left('votes', other)).toEqual(['AUS', 'BNA'])
  })

  it('members are forbidden, outsiders get not_found; nothing is deleted', async () => {
    const { tripId } = await withDependents()
    expect(await call(removeCandidate, BOB, { tripId, iata: 'BNA' })).toMatchObject({ code: 'forbidden' })
    expect(await call(removeCandidate, CAROL, { tripId, iata: 'BNA' })).toMatchObject({ code: 'not_found' })
    expect(iatasOf(tripId).sort()).toEqual(['AUS', 'BNA'])
    expect(left('fares', tripId)).toHaveLength(4)
  })

  it('a code that is not on the list is not_found; a malformed code is invalid', async () => {
    const { tripId } = await setup()
    expect(await call(removeCandidate, ALICE, { tripId, iata: 'DEN' })).toMatchObject({ code: 'not_found' })
    expect(await call(removeCandidate, ALICE, { tripId, iata: 'D3N' })).toMatchObject({ code: 'invalid_params' })
  })

  it('is refused on a locked trip', async () => {
    const { tripId } = await setup()
    await fill(tripId, ['BNA'])
    await setStatus(tripId, 'locked')
    expect(await call(removeCandidate, ALICE, { tripId, iata: 'BNA' })).toMatchObject({ code: 'trip_locked' })
    expect(iatasOf(tripId)).toEqual(['BNA'])
  })
})

describe('addMidpointHubs (organizer)', () => {
  afterEach(() => expect(store.integrationCalls).toEqual([]))

  it('adds the 2 nearest major hubs to the travelers’ center, source midpoint', async () => {
    const { tripId } = await setup()
    await setHomes(tripId, ALICE, ['ORD', 'MDW'])
    data(await call(addGhost, ALICE, { tripId, displayName: 'Grandpa', homeAirports: ['BOS'] }))
    const expected = nearestMajorHubs([['ORD', 'MDW'], ['BOS']], AIRPORTS, { n: 2 }).map((h) => h.airport.iata)
    expect(expected).toHaveLength(2)

    const res = data<{ added: Array<{ iata: string; source: string; why: string }> }>(
      await call(addMidpointHubs, ALICE, { tripId }),
    )
    expect(res.added.map((a) => a.iata)).toEqual(expected)
    for (const row of candidatesOf(tripId)) {
      expect(row.data).toMatchObject({ source: 'midpoint', addedBy: ALICE, memberIds: [ALICE, BOB] })
      expect(row.data.why).toMatch(/^Near the middle of everyone’s home airports: about \d+ mi \(\d+ km\)/)
      expect(String(row.data.why).length).toBeLessThanOrEqual(300)
      expect(['ORD', 'MDW', 'BOS']).not.toContain(row.data.iata)
    }
  })

  it('skips existing candidates and fills only the free slots', async () => {
    const { tripId } = await setup()
    await setHomes(tripId, ALICE, ['ORD'])
    await setHomes(tripId, BOB, ['BOS'])
    const [first, second] = nearestMajorHubs([['ORD'], ['BOS']], AIRPORTS, { n: 2 }).map((h) => h.airport.iata)
    const fillers = ['BNA', 'AUS', 'DEN', 'MSY', 'SEA'].filter((c) => c !== first && c !== second).slice(0, 4)
    await fill(tripId, [first, ...fillers])
    const res = data<{ added: Array<{ iata: string }> }>(await call(addMidpointHubs, ALICE, { tripId }))
    expect(res.added).toHaveLength(1)
    expect(res.added[0].iata).not.toBe(first)
    expect(candidatesOf(tripId)).toHaveLength(6)
    expect(await call(addMidpointHubs, ALICE, { tripId })).toMatchObject({ code: 'candidates_full' })
  })

  it('needs at least 2 travelers with (valid) home airports', async () => {
    const { tripId } = await setup()
    expect(await call(addMidpointHubs, ALICE, { tripId })).toMatchObject({ code: 'needs_airports' })
    await setHomes(tripId, ALICE, ['ORD'])
    // Bob's client-written row holds junk: it doesn't count.
    await setHomes(tripId, BOB, ['ZZZ', 42, 'x'])
    expect(await call(addMidpointHubs, ALICE, { tripId })).toMatchObject({ code: 'needs_airports' })
    expect(candidatesOf(tripId)).toEqual([])
  })

  it('members are forbidden, outsiders get not_found', async () => {
    const { tripId } = await setup()
    expect(await call(addMidpointHubs, BOB, { tripId })).toMatchObject({ code: 'forbidden' })
    expect(await call(addMidpointHubs, CAROL, { tripId })).toMatchObject({ code: 'not_found' })
  })

  it('knownHomeAirports keeps known codes only, upper-cased, deduped, at most 3', () => {
    expect(knownHomeAirports(['ord', 'ORD', 'ZZZ', 7, 'BOS', 'LAX', 'SFO'])).toEqual(['ORD', 'BOS', 'LAX'])
    expect(knownHomeAirports('ORD')).toEqual([])
  })
})

describe('suggestCandidates (organizer, one AI call)', () => {
  /** An Anthropic Messages-shaped success, as the integration returns it. */
  const reply = (text: string) => ({
    success: true as const,
    data: { content: [{ type: 'text', text }], stop_reason: 'end_turn' },
  })
  const SUGGESTIONS = [
    '```json',
    JSON.stringify([
      { iata: 'MSY', city: 'New Orleans', country: 'United States', why: 'Easy from Chicago and Boston.' },
      { iata: 'ZZZ', city: 'Nowhere', country: 'Nowhere', why: 'Invented.' },
      { iata: 'BNA', city: 'Nashville', country: 'United States', why: 'Already listed.' },
      { iata: 'AUS', city: 'Austin', country: 'United States', why: 'Warm, with nonstops.' },
      { iata: 'msy', why: 'Repeat.' },
    ]),
    '```',
  ].join('\n')

  async function ready() {
    const trip = await setup()
    await setHomes(trip.tripId, ALICE, ['ORD', 'MDW'])
    await setHomes(trip.tripId, BOB, ['BOS'])
    await fill(trip.tripId, ['BNA'])
    return trip
  }

  it('calls Haiku with the 2048-token budget, adds only valid new codes as source ai, counts one call', async () => {
    const { tripId } = await ready()
    store.onIntegration(() => reply(SUGGESTIONS))
    const res = data<{ added: unknown[]; dropped: number; debug?: unknown }>(
      await call(suggestCandidates, ALICE, { tripId }),
    )
    expect(res).toEqual({
      added: [
        { iata: 'MSY', city: 'New Orleans', why: 'Easy from Chicago and Boston.', source: 'ai' },
        { iata: 'AUS', city: 'Austin', why: 'Warm, with nonstops.', source: 'ai' },
      ],
      dropped: 3,
    })
    expect(iatasOf(tripId)).toEqual(['BNA', 'MSY', 'AUS'])
    expect(candidatesOf(tripId).find((r) => r.data.iata === 'AUS')!.data).toMatchObject({
      source: 'ai',
      addedBy: ALICE,
      country: 'United States',
      memberIds: [ALICE, BOB],
    })

    expect(store.integrationCalls).toHaveLength(1)
    const [{ endpoint, data: body }] = store.integrationCalls as Array<{ endpoint: string; data: Record<string, unknown> }>
    expect(endpoint).toBe('anthropic/chat-completion')
    expect(body).toMatchObject({ model: AI_MODEL, max_tokens: AI_MAX_TOKENS })
    expect(AI_MODEL).toBe('claude-haiku-5-5')
    expect(AI_MAX_TOKENS).toBe(2048)
    expect(Object.keys(body).sort()).toEqual(['max_tokens', 'messages', 'model', 'system'])
    const user = (body.messages as Array<{ role: string; content: string }>)[0]
    expect(user.role).toBe('user')
    expect(user.content).toContain('- Traveler 1: ORD (Chicago, United States), MDW (Chicago, United States)')
    expect(user.content).toContain('- Traveler 2: BOS (Boston, United States)')
    expect(user.content).toContain('Dates: depart 2026-12-11, return 2026-12-13')
    expect(user.content).toContain('Vibe: "beach, cheap"')
    expect(user.content).toContain('Already on the list (do not repeat): BNA (Nashville)')
    expect(user.content).toContain('Suggest 6 destinations') // 5 free + 2 spare, capped at 6
    // No names, emails or user ids reach the model.
    expect(JSON.stringify(body)).not.toMatch(/Alice|Bob|example\.test|user_/)

    expect(usageCount(usageKeys.aiUser(ALICE))).toBe(1)
  })

  it('fills only the free slots', async () => {
    const { tripId } = await ready()
    await fill(tripId, ['DEN', 'SEA', 'MIA', 'SAN']) // 5 of 6
    store.onIntegration(() => reply(SUGGESTIONS))
    const res = data<{ added: Array<{ iata: string }> }>(await call(suggestCandidates, ALICE, { tripId }))
    expect(res.added.map((a) => a.iata)).toEqual(['MSY'])
    expect(candidatesOf(tripId)).toHaveLength(6)
    const body = store.integrationCalls[0].data as { messages: Array<{ content: string }> }
    expect(body.messages[0].content).toContain('Suggest 3 destinations')
  })

  it('junk from the model: success with nothing added, still counted', async () => {
    const { tripId } = await ready()
    store.onIntegration(() => reply('Sorry, I can only chat about the weather.'))
    expect(data(await call(suggestCandidates, ALICE, { tripId }))).toEqual({ added: [], dropped: 0 })
    expect(iatasOf(tripId)).toEqual(['BNA'])
    expect(usageCount(usageKeys.aiUser(ALICE))).toBe(1)
  })

  it('refuses for free (no AI call): member, outsider, full list, no airports, frozen trip', async () => {
    const { tripId } = await setup()
    store.onIntegration(() => reply(SUGGESTIONS))
    expect(await call(suggestCandidates, BOB, { tripId })).toMatchObject({ code: 'forbidden' })
    expect(await call(suggestCandidates, CAROL, { tripId })).toMatchObject({ code: 'not_found' })
    expect(await call(suggestCandidates, ALICE, { tripId })).toMatchObject({ code: 'needs_airports' })
    await setHomes(tripId, BOB, ['BOS'])
    await setStatus(tripId, 'locked')
    expect(await call(suggestCandidates, ALICE, { tripId })).toMatchObject({ code: 'trip_locked' })
    await setStatus(tripId, 'gathering')
    await fill(tripId, ['BNA', 'AUS', 'DEN', 'MSY', 'MIA', 'SEA'])
    expect(await call(suggestCandidates, ALICE, { tripId })).toMatchObject({ code: 'candidates_full' })
    expect(store.integrationCalls).toEqual([])
  })

  it(`caps AI calls at ${LIMITS.maxAiCallsPerUserPerDay} per user per day, before calling`, async () => {
    const { tripId } = await ready()
    store.onIntegration(() => reply('[]'))
    for (let i = 0; i < LIMITS.maxAiCallsPerUserPerDay; i++) data(await call(suggestCandidates, ALICE, { tripId }))
    expect(await call(suggestCandidates, ALICE, { tripId })).toMatchObject({ code: 'cap_reached' })
    expect(store.integrationCalls).toHaveLength(LIMITS.maxAiCallsPerUserPerDay)
    // A new UTC day starts a new count.
    vi.setSystemTime(new Date('2026-11-21T00:00:01Z'))
    data(await call(suggestCandidates, ALICE, { tripId }))
  })

  it('provider quota / 429 → provider_unavailable, not counted; other failures → ai_error, counted', async () => {
    const { tripId } = await ready()
    store.onIntegration(() => ({ success: false, error: 'anthropic (429): rate limited', status: 429 }) as never)
    expect(await call(suggestCandidates, ALICE, { tripId })).toEqual({
      success: false,
      code: 'provider_unavailable',
      error: AI_UNAVAILABLE_MESSAGE,
    })
    expect(usageCount(usageKeys.aiUser(ALICE))).toBe(0)

    store.onIntegration(() => ({ success: false, error: 'secret upstream detail', status: 502 }) as never)
    const res = await call(suggestCandidates, ALICE, { tripId })
    expect(res).toEqual({ success: false, code: 'ai_error', error: AI_ERROR_MESSAGE })
    expect(JSON.stringify(res)).not.toContain('secret upstream detail')
    expect(usageCount(usageKeys.aiUser(ALICE))).toBe(1)
    expect(iatasOf(tripId)).toEqual(['BNA'])
  })

  it('returns the prompt and raw reply only when ALLOW_DEBUG_ROUTES is "true"', async () => {
    const { tripId } = await ready()
    store.onIntegration(() => reply('[]'))
    expect(data(await call(suggestCandidates, ALICE, { tripId }))).not.toHaveProperty('debug')
    expect(data(await call(suggestCandidates, ALICE, { tripId }, { ALLOW_DEBUG_ROUTES: 'false' }))).not.toHaveProperty(
      'debug',
    )
    const dev = data<{ debug: { prompt: { system: string; user: string }; raw: unknown } }>(
      await call(suggestCandidates, ALICE, { tripId }, { ALLOW_DEBUG_ROUTES: 'true' }),
    )
    expect(dev.debug.prompt.user).toContain('Traveler 1')
    expect(dev.debug.raw).toEqual(reply('[]').data)
  })

  it('__test- trips skip the AI cap only when ALLOW_DEBUG_ROUTES is "true"', async () => {
    const { tripId } = await setup('__test-ai')
    await setHomes(tripId, ALICE, ['ORD'])
    store.onIntegration(() => reply('[]'))
    data(await call(suggestCandidates, ALICE, { tripId }, { ALLOW_DEBUG_ROUTES: 'true' }))
    expect(usageCount(usageKeys.aiUser(ALICE))).toBe(0)
    data(await call(suggestCandidates, ALICE, { tripId }))
    expect(usageCount(usageKeys.aiUser(ALICE))).toBe(1)
  })
})
