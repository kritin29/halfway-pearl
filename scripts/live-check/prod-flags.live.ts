/**
 * Production must not have the dev/test seam on (src/server/test-seam.ts).
 * Makes NO app-data writes: no trips, no budgets, no usage. Signing Alice in
 * creates an auth session only.
 *
 * What it shows:
 * 1. Alice's token is accepted (unknown action → 404 "Action not found", not 401).
 * 2. __testLockTrip is deployed but refuses: { success:false, code:'not_found' }.
 *    Its FIRST line is `if (env.ALLOW_DEBUG_ROUTES !== 'true') return not_found`,
 *    so no trip is needed and nothing is read or written.
 * 3. /api/debug/* is 404: that route returns notFound() whenever
 *    ALLOW_DEBUG_ROUTES !== 'true' (before any auth check).
 * The cap exemption for `__test-` trips is `isTestTrip()`, which requires the
 * same ALLOW_DEBUG_ROUTES === 'true', so (2) and (3) show it is off.
 */
import { test, expect } from 'deepspace/testing'

test('production has the test seam off (Alice)', async ({ users, baseURL }) => {
  const [alice] = await users(['Alice'])
  const req = alice.context.request
  const url = (p: string) => new URL(p, baseURL!).toString()

  const tokenRes = await req.post(url('/api/auth/token'), { headers: { 'Content-Type': 'application/json' } })
  expect(tokenRes.ok()).toBe(true)
  const { token } = (await tokenRes.json()) as { token: string }
  const auth = { Authorization: `Bearer ${token}` }

  const show = async (label: string, res: import('@playwright/test').APIResponse) => {
    const body = await res.text()
    console.log(`LIVE ${label} -> HTTP ${res.status()} ${body.slice(0, 200)}`)
    return { status: res.status(), body }
  }

  // 1. token accepted
  const unknown = await show('POST /api/actions/noSuchAction {}', await req.post(url('/api/actions/noSuchAction'), { headers: auth, data: {} }))
  expect(unknown.status).toBe(404)
  expect(JSON.parse(unknown.body)).toEqual({ error: 'Action not found' })

  // 2. test lock refused (empty params and a made-up id: both stop at the flag check)
  for (const params of [{}, { tripId: '0_livecheck' }]) {
    const lock = await show(`POST /api/actions/__testLockTrip ${JSON.stringify(params)}`, await req.post(url('/api/actions/__testLockTrip'), { headers: auth, data: params }))
    expect(lock.status).toBe(200)
    expect(JSON.parse(lock.body)).toEqual({ success: false, error: 'Not available.', code: 'not_found' })
  }

  // 3. debug routes off
  const debug = await show('GET /api/debug/records', await req.get(url('/api/debug/records'), { headers: auth }))
  expect(debug.status).toBe(404)
})
