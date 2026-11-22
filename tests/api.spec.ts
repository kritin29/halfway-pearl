import { test, expect, loadAllTestAccounts } from 'deepspace/testing'
import { readFileSync } from 'node:fs'
import { bearerFor } from './helpers/auth'
import { act, asClient, openApp, setOwnAirports, testTripName, waitForTrip } from './helpers/trips'

test.describe('API tests', () => {
  test('auth proxy forwards to auth worker', async ({ request }) => {
    const res = await request.get('/api/auth/ok')
    expect(res.ok()).toBeTruthy()
  })

  test('WebSocket endpoint exists', async ({ page }) => {
    // /trips is a dynamic page (under src/pages/(app)/), so mounting it boots
    // the providers and auto-connects the records WebSocket. The static
    // landing at '/' deliberately does neither — see smoke.spec.ts.
    await page.goto('/trips')
    // Wait for the app to connect its WebSocket (it auto-connects on mount)
    await page.waitForSelector('[data-testid="app-navigation"]', { timeout: 15000 })
    // If the app loaded and connected, the WS endpoint works
  })
})

// Tests below sign in as pool accounts. Same skip rule as collab.spec.ts.
const usableTestAccounts = loadAllTestAccounts().length
const NEEDS_ACCOUNTS =
  `Needs 2 usable test accounts, found ${usableTestAccounts}. ` +
  'Create them with `npx deepspace test accounts create`.'

/**
 * SPEC §11 / NOTES C4: paid integrations are server-only. The bodies are
 * deliberately empty (`{}`), which the upstream endpoints reject as invalid,
 * so even a broken guard can't make a billed search or send an email.
 */
test.describe('server-only integrations', () => {
  test.skip(usableTestAccounts < 1, NEEDS_ACCOUNTS)

  for (const endpoint of ['serpapi/flights', 'email/send', 'anthropic/chat-completion']) {
    test(`signed-in POST /api/integrations/${endpoint} is 403`, async ({ users, baseURL }) => {
      const [alice] = await users(1)
      const token = await bearerFor(alice, baseURL!)
      const res = await alice.context.request.post(
        new URL(`/api/integrations/${endpoint}`, baseURL!).toString(),
        { headers: { Authorization: `Bearer ${token}` }, data: {} },
      )
      expect(res.status()).toBe(403)
    })
  }

  test('signed-out POST /api/integrations/serpapi/flights is refused', async ({ request }) => {
    const res = await request.post('/api/integrations/serpapi/flights', { data: {} })
    expect(res.status()).toBe(403)
  })
})

/**
 * Open a room WebSocket from the page and report what happened in ~2.5s:
 * `opened`, the first `auth` payload's canWrite, and whether it failed before opening.
 */
async function probeSocket(
  page: import('@playwright/test').Page,
  path: string,
): Promise<{ opened: boolean; canWrite: boolean | null }> {
  return page.evaluate(
    (p) =>
      new Promise<{ opened: boolean; canWrite: boolean | null }>((resolve) => {
        const ws = new WebSocket(location.origin.replace(/^http/, 'ws') + p)
        const out = { opened: false, canWrite: null as boolean | null }
        const done = () => {
          resolve(out)
          ws.close()
        }
        ws.onopen = () => (out.opened = true)
        ws.onmessage = (m) => {
          const msg = JSON.parse(String(m.data)) as { type?: string; payload?: { canWrite?: boolean } }
          if (msg.type === 'auth') {
            out.canWrite = msg.payload?.canWrite ?? null
            done()
          }
        }
        ws.onclose = done
        setTimeout(done, 2500)
      }),
    path,
  )
}

/** SPEC §9 / NOTES C7: cron and job sockets exist only for the app's own room. */
test.describe('cron and job rooms', () => {
  const appId = /DEEPSPACE_APP_ID\s*=\s*"([^"]+)"/.exec(
    readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8'),
  )?.[1]
  const appRoom = () => encodeURIComponent(`app:${appId}`)

  for (const kind of ['cron', 'jobs']) {
    test(`/ws/${kind}/<other id> is refused, the app room opens`, async ({ page }) => {
      expect(appId).toBeTruthy()
      await page.goto('/')
      for (const id of ['default', 'app:someone-else', `app:${appId}x`]) {
        const res = await page.request.get(`/ws/${kind}/${encodeURIComponent(id)}`)
        expect(res.status(), id).toBe(404)
        expect(await res.text(), id).toBe('Not found')
        expect((await probeSocket(page, `/ws/${kind}/${encodeURIComponent(id)}`)).opened, id).toBe(
          false,
        )
      }
      // Control: the real room accepts the same kind of connection.
      expect((await probeSocket(page, `/ws/${kind}/${appRoom()}`)).opened).toBe(true)
    })
  }

  test('a signed-in member gets no write access to cron or jobs', async ({ users, baseURL }) => {
    test.skip(usableTestAccounts < 1, NEEDS_ACCOUNTS)
    const [alice] = await users(1)
    const token = await bearerFor(alice, baseURL!)
    // Opening the app registers Alice's `users` row, so resolveAppRole gives
    // her 'member'. Without it she'd be a 'viewer' and this test would prove nothing.
    await alice.page.goto('/trips')
    await expect(alice.page.getByTestId('nav-user-name')).toHaveText(/\S/, { timeout: 15_000 })
    for (const kind of ['cron', 'jobs']) {
      const result = await probeSocket(
        alice.page,
        `/ws/${kind}/${appRoom()}?token=${encodeURIComponent(token)}`,
      )
      expect(result, kind).toEqual({ opened: true, canWrite: false })
    }
  })
})

/** Every action in src/actions/index.ts (a unit test keeps the registry to exactly these). */
const ACTIONS = [
  'createTrip',
  'joinTrip',
  'previewInvite',
  'addGhost',
  'updateGhost',
  'removeGhost',
  'addCandidate',
  'removeCandidate',
  'addMidpointHubs',
  'suggestCandidates',
  'startSearch',
  'toggleVote',
  'lockTrip',
  'setWatch',
  'checkFaresNow',
  '__testLockTrip',
]

test.describe('actions require a verified token', () => {
  for (const name of ACTIONS) {
    test(`${name} without a token is 401`, async ({ request }) => {
      const none = await request.post(`/api/actions/${name}`, { data: {} })
      expect(none.status()).toBe(401)
      const forged = await request.post(`/api/actions/${name}`, {
        headers: { Authorization: 'Bearer not-a-real-jwt' },
        data: {},
      })
      expect(forged.status()).toBe(401)
    })
  }
})

/** Dates relative to today, so the trip is always in the future. */
function futureDate(daysAhead: number): string {
  return new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 10)
}

test.describe('trip actions across two accounts', () => {
  test.skip(usableTestAccounts < 2, NEEDS_ACCOUNTS)

  test('a non-member cannot act on someone else’s trip', async ({ users, baseURL }) => {
    const [alice, bob] = await users(2)
    const [aliceToken, bobToken] = await Promise.all([bearerFor(alice, baseURL!), bearerFor(bob, baseURL!)])
    const act = async (token: string, name: string, params: unknown) => {
      const res = await alice.context.request.post(new URL(`/api/actions/${name}`, baseURL!).toString(), {
        headers: { Authorization: `Bearer ${token}` },
        data: params as Record<string, unknown>,
      })
      expect(res.status(), name).toBe(200)
      return (await res.json()) as { success: boolean; data?: Record<string, string>; code?: string }
    }

    // Sanity: the token is accepted (unknown action → 404, not 401).
    const unknown = await alice.context.request.post(new URL('/api/actions/noSuchAction', baseURL!).toString(), {
      headers: { Authorization: `Bearer ${aliceToken}` },
      data: {},
    })
    expect(unknown.status()).toBe(404)

    const created = await act(aliceToken, 'createTrip', {
      name: '__test-api trip',
      outboundDate: futureDate(20),
      returnDate: futureDate(23),
    })
    expect(created.success).toBe(true)
    const { tripId, inviteCode } = created.data!
    const ghost = await act(aliceToken, 'addGhost', { tripId, displayName: 'Grandpa', homeAirports: ['ORD'] })
    expect(ghost.success).toBe(true)
    const ghostId = ghost.data!.ghostId

    // Bob is not a member: same answer as a trip that doesn't exist.
    const outsider = [
      ['addGhost', { tripId, displayName: 'Intruder', homeAirports: ['BNA'] }],
      ['updateGhost', { tripId, ghostId, displayName: 'Hijacked' }],
      ['removeGhost', { tripId, ghostId }],
    ] as const
    for (const [name, params] of outsider) {
      expect(await act(bobToken, name, params), name).toMatchObject({ success: false, code: 'not_found' })
    }
    expect(await act(bobToken, 'joinTrip', { inviteCode: 'WrongCode123' })).toMatchObject({
      success: false,
      code: 'not_found',
    })

    // Bob joins with the real code (twice: idempotent), and is then a member but not the organizer.
    expect(await act(bobToken, 'joinTrip', { inviteCode })).toMatchObject({
      success: true,
      data: { tripId, alreadyMember: false },
    })
    expect(await act(bobToken, 'joinTrip', { inviteCode })).toMatchObject({
      success: true,
      data: { tripId, alreadyMember: true },
    })
    for (const [name, params] of outsider) {
      expect(await act(bobToken, name, params), name).toMatchObject({ success: false, code: 'forbidden' })
    }

    // The ghost survived every attempt; the organizer can still remove it.
    expect(await act(aliceToken, 'removeGhost', { tripId, ghostId })).toMatchObject({ success: true })
  })

  test('a malformed body is a 400, not a crash', async ({ users, baseURL }) => {
    const [alice] = await users(1)
    const token = await bearerFor(alice, baseURL!)
    const res = await alice.context.request.post(new URL('/api/actions/createTrip', baseURL!).toString(), {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: Buffer.from('{not json'),
    })
    expect(res.status()).toBe(400)
    expect(await res.json()).toMatchObject({ success: false, code: 'invalid_params' })
  })
})

/**
 * The ONE real AI call per test run (CLAUDE.md: at most one real call per
 * integration endpoint per run). suggestCandidates → anthropic/chat-completion
 * with claude-haiku-5-5 / max_tokens 3000. Asserts our envelope and the
 * validated rows, not the model's exact words. The trip is `__test-`, so the
 * 5/day AI cap doesn't lock the pool account out after a few local runs
 * (exempt only when ALLOW_DEBUG_ROUTES === 'true'; unit-tested).
 */
test.describe('AI destination suggestions (one real call)', () => {
  test.skip(usableTestAccounts < 1, NEEDS_ACCOUNTS)

  test('suggestCandidates makes one real anthropic call and adds only validated destinations', async ({
    users,
    baseURL,
  }) => {
    test.setTimeout(120_000)
    const [alice] = await users(1)
    const created = await act<{ tripId: string }>(alice, baseURL!, 'createTrip', {
      name: testTripName('ai'),
      outboundDate: futureDate(40),
      returnDate: futureDate(43),
      vibe: 'warm, walkable, great food, not too pricey',
    })
    expect(created).toMatchObject({ success: true })
    const tripId = created.data!.tripId
    for (const [displayName, homeAirports] of [
      ['Chicago friend', ['ORD', 'MDW']],
      ['Boston friend', ['BOS']],
      ['Denver friend', ['DEN']],
    ] as const) {
      expect(await act(alice, baseURL!, 'addGhost', { tripId, displayName, homeAirports })).toMatchObject({
        success: true,
      })
    }
    expect(await act(alice, baseURL!, 'addCandidate', { tripId, iata: 'BNA' })).toMatchObject({ success: true })

    const res = await act<{
      added: Array<{ iata: string; city: string; why: string; source: string }>
      dropped: number
      debug?: { prompt: { system: string; user: string }; raw: unknown }
    }>(alice, baseURL!, 'suggestCandidates', { tripId })
    // Printed for the phase summary: the exact prompt and the model's raw reply.
    console.log(`AI PROMPT (system):\n${res.data?.debug?.prompt.system}`)
    console.log(`AI PROMPT (user):\n${res.data?.debug?.prompt.user}`)
    console.log(`AI RAW RESPONSE:\n${JSON.stringify(res.data?.debug?.raw ?? res, null, 2)}`)
    console.log(`AI RESULT:\n${JSON.stringify({ added: res.data?.added, dropped: res.data?.dropped }, null, 2)}`)

    expect(res, 'suggestCandidates').toMatchObject({ success: true })
    const added = res.data!.added
    expect(added.length).toBeGreaterThanOrEqual(1)
    expect(added.length).toBeLessThanOrEqual(5) // 6 max, BNA already there
    for (const a of added) {
      expect(a.source).toBe('ai')
      expect(a.iata).toMatch(/^[A-Z]{3}$/)
      expect(a.iata).not.toBe('BNA')
      expect(a.why.length).toBeLessThanOrEqual(140)
    }
    expect(new Set(added.map((a) => a.iata)).size).toBe(added.length)

    // The rows are really there, readable by the member (RBAC on).
    await openApp(alice)
    const rows = await asClient(alice, baseURL!, 'records_query', { collection: 'candidates', where: { tripId } })
    const stored = rows.body.result?.data?.records ?? []
    expect(stored.map((r) => r.data.iata).sort()).toEqual(['BNA', ...added.map((a) => a.iata)].sort())
    for (const r of stored.filter((r) => r.data.source === 'ai')) {
      expect(String(r.data.why).length).toBeLessThanOrEqual(140)
    }
  })
})

/**
 * The ONE real email/send call per test run (CLAUDE.md). The trip is named
 * `__test-real-email-…`: like every `__test-` trip it gets fixture fares (no
 * SerpApi call), but the email seam lets this prefix send for real
 * (src/server/email-source.ts). Alice is the only real member (the other
 * traveler is a ghost, who never gets email), so lockTrip makes exactly one
 * email/send call, to her test-account address. The retry proves no second
 * call is made.
 */
test.describe('lock booking email (one real call)', () => {
  test.skip(usableTestAccounts < 1, NEEDS_ACCOUNTS)
  test.describe.configure({ timeout: 120_000 })

  test('lockTrip sends one real booking email to the only real member; the retry sends none', async ({ users, baseURL }) => {
    const [alice] = await users(1)
    await openApp(alice) // her users row (and its email) exists from here on
    const created = await act<{ tripId: string }>(alice, baseURL!, 'createTrip', {
      name: `__test-real-email-${Date.now().toString(36)}`,
      outboundDate: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10),
      returnDate: new Date(Date.now() + 33 * 86_400_000).toISOString().slice(0, 10),
    })
    expect(created, 'createTrip').toMatchObject({ success: true })
    const tripId = created.data!.tripId
    await setOwnAirports(alice, baseURL!, tripId, ['ORD'])
    expect(await act(alice, baseURL!, 'addGhost', { tripId, displayName: 'Ghost', homeAirports: ['DEN'] })).toMatchObject({
      success: true,
    })
    expect(await act(alice, baseURL!, 'addCandidate', { tripId, iata: 'BNA' })).toMatchObject({ success: true })
    expect(await act(alice, baseURL!, 'startSearch', { tripId })).toMatchObject({ success: true })
    await waitForTrip(alice, baseURL!, tripId, (t) => t.status === 'results')

    const lock = await act<{ emails: Record<string, unknown> }>(alice, baseURL!, 'lockTrip', { tripId, iata: 'BNA' })
    // Printed for the phase summary (counts only; no address or body).
    console.log(`REAL EMAIL RESULT: ${JSON.stringify(lock)}`)
    expect(lock, 'lockTrip').toMatchObject({ success: true, data: { iata: 'BNA', alreadyLocked: false } })
    expect(lock.data!.emails).toEqual({ sent: 1, alreadySent: 0, noEmail: 0, capped: 0, failed: 0, mocked: false })

    const retry = await act<{ emails: Record<string, unknown> }>(alice, baseURL!, 'lockTrip', { tripId, iata: 'BNA' })
    expect(retry.data!.emails).toMatchObject({ sent: 0, alreadySent: 1, failed: 0 })
  })
})
