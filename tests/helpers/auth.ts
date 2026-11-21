import type { MultiplayerUser } from 'deepspace/testing'

/**
 * A bearer JWT for a signed-in test user, minted the way the browser SDK's
 * `getAuthToken()` does it: POST /api/auth/token with the session cookie.
 */
export async function bearerFor(user: MultiplayerUser, baseURL: string): Promise<string> {
  const res = await user.context.request.post(new URL('/api/auth/token', baseURL).toString(), {
    headers: { 'Content-Type': 'application/json' },
  })
  if (!res.ok()) throw new Error(`token request failed: HTTP ${res.status()}`)
  const body = (await res.json()) as { token?: string }
  if (!body.token) throw new Error('token response had no token')
  return body.token
}
