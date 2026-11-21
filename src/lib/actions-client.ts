/**
 * Browser-side caller for server actions (POST /api/actions/:name with the
 * signed-in user's JWT). Never throws: every outcome is an envelope, so UI
 * code can branch on `code` (server codes from src/server/trip-access.ts,
 * plus 'network' and 'unauthorized' from here).
 */
import { getAuthToken } from 'deepspace'

export type ActionResponse<T> =
  | { success: true; data: T }
  | { success: false; error: string; code: string }

export async function callAction<T>(name: string, params: Record<string, unknown>): Promise<ActionResponse<T>> {
  const token = await getAuthToken()
  if (!token) return { success: false, code: 'unauthorized', error: 'Please sign in again.' }

  let res: Response
  try {
    res = await fetch(`/api/actions/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(params),
    })
  } catch {
    return {
      success: false,
      code: 'network',
      error: 'Could not reach Halfway. Check your connection and try again.',
    }
  }
  if (res.status === 401) return { success: false, code: 'unauthorized', error: 'Please sign in again.' }

  const body = (await res.json().catch(() => null)) as
    | { success?: unknown; data?: T; error?: unknown; code?: unknown }
    | null
  if (!body || typeof body.success !== 'boolean') {
    return { success: false, code: 'server_error', error: `Something went wrong (HTTP ${res.status}).` }
  }
  if (body.success) return { success: true, data: body.data as T }
  return {
    success: false,
    code: typeof body.code === 'string' ? body.code : 'server_error',
    error: typeof body.error === 'string' ? body.error : 'Something went wrong.',
  }
}

/** Codes worth a "Try again" button (the same request may succeed later). */
export function isRetryable(code: string): boolean {
  return code === 'network' || code === 'server_error' || code === 'conflict'
}
