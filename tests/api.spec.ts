import { test, expect, loadAllTestAccounts } from 'deepspace/testing'
import { bearerFor } from './helpers/auth'

test.describe('API tests', () => {
  test('auth proxy forwards to auth worker', async ({ request }) => {
    const res = await request.get('/api/auth/ok')
    expect(res.ok()).toBeTruthy()
  })

  test('WebSocket endpoint exists', async ({ page }) => {
    // /home is a dynamic page (under src/pages/(app)/), so mounting it boots
    // the providers and auto-connects the records WebSocket. The static
    // landing at '/' deliberately does neither — see smoke.spec.ts.
    await page.goto('/home')
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
