import { expect, type MultiplayerUser } from 'deepspace/testing'
import { bearerFor } from './auth'

/** YYYY-MM-DD `daysAhead` days from now (UTC), so test trips are always in the future. */
export function futureDate(daysAhead: number): string {
  return new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 10)
}

/** A unique `__test-` trip name (test trips are exempt from the creation cap in dev/test only). */
export function testTripName(label: string): string {
  return `__test-${label} ${Date.now().toString(36)}`
}

export interface ActionBody<T = Record<string, unknown>> {
  success: boolean
  data?: T
  error?: string
  code?: string
}

/** POST /api/actions/:name as `user` (signed-in JWT). */
export async function act<T = Record<string, unknown>>(
  user: MultiplayerUser,
  baseURL: string,
  name: string,
  params: Record<string, unknown>,
): Promise<ActionBody<T>> {
  const token = await bearerFor(user, baseURL)
  const res = await user.context.request.post(new URL(`/api/actions/${name}`, baseURL).toString(), {
    headers: { Authorization: `Bearer ${token}` },
    data: params,
  })
  expect(res.status(), `${name} HTTP status`).toBe(200)
  return (await res.json()) as ActionBody<T>
}

export async function createTripApi(user: MultiplayerUser, baseURL: string, name: string) {
  const res = await act<{ tripId: string; inviteCode: string }>(user, baseURL, 'createTrip', {
    name,
    outboundDate: futureDate(30),
    returnDate: futureDate(33),
  })
  expect(res, 'createTrip').toMatchObject({ success: true })
  return res.data!
}

/**
 * Open the app so the user's `users` row exists (the agent tool route and
 * resolveAppRole treat a user without one as a non-member; NOTES G4).
 */
export async function openApp(user: MultiplayerUser): Promise<void> {
  await user.page.goto('/trips')
  await expect(user.page.getByTestId('nav-user-name')).toHaveText(/\S/, { timeout: 15_000 })
}

/**
 * Run a record tool as `user` with RBAC ON, through the same agent tool route
 * a browser assistant uses. This is a second client-side read path besides
 * the page's own `useQuery` (NOTES §3).
 */
export async function asClient(
  user: MultiplayerUser,
  baseURL: string,
  tool: 'records_query' | 'records_create',
  input: Record<string, unknown>,
): Promise<{ status: number; body: { ok: boolean; result?: { success: boolean; data?: { records?: Array<{ recordId: string; data: Record<string, unknown> }> } }; error?: string } }> {
  const token = await bearerFor(user, baseURL)
  const res = await user.context.request.post(
    new URL(`/_deepspace/agent/browser/tools/${tool}`, baseURL).toString(),
    { headers: { Authorization: `Bearer ${token}` }, data: { input } },
  )
  return { status: res.status(), body: await res.json() }
}

/** Every WebSocket frame the page receives from now on, as text. */
export function captureSocketFrames(user: MultiplayerUser): string[] {
  const frames: string[] = []
  user.page.on('websocket', (ws) => {
    ws.on('framereceived', (frame) => frames.push(String(frame.payload)))
  })
  return frames
}
