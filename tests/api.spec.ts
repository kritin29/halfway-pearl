import { test, expect, loadAllTestAccounts } from 'deepspace/testing'
import { readFileSync } from 'node:fs'
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
    await alice.page.goto('/home')
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
