/**
 * The one place server code sends email (SPEC §6 lockTrip, §8.7).
 *
 * Dev/test seam, the same double gate as the fare fixture (NOTES C12):
 * Playwright can't intercept worker-side integration calls, so when
 * `ALLOW_DEBUG_ROUTES === 'true'` (only `deepspace dev` / `test run`) AND the
 * trip name starts with `__test-`, the message is built and validated but NOT
 * sent, and the call reports `mocked: true`. Mocked sends cost nothing, so
 * they don't touch the `usage` ledger.
 *
 * `__test-real-email-` trips opt back into the real call in dev/test, for the
 * single api test that proves the integration works. In production the first
 * gate is never true, so every send is real.
 */
import type { ActionTools } from 'deepspace/worker'
import { emailSendBody, type EmailMessage } from '../lib/email'
import { isTestTrip } from './test-seam'

export const REAL_EMAIL_TEST_PREFIX = '__test-real-email-'

export function emailIsMocked(env: { ALLOW_DEBUG_ROUTES?: string }, tripName: unknown): boolean {
  return isTestTrip(env, tripName) && !(tripName as string).startsWith(REAL_EMAIL_TEST_PREFIX)
}

export type SendOutcome =
  | { ok: true; mocked: boolean }
  /** `billed: false` only when the platform says it released billing for the failed call. */
  | { ok: false; mocked: false; billed: boolean; reason: string }

export async function sendEmail(
  tools: ActionTools,
  env: { ALLOW_DEBUG_ROUTES?: string },
  tripName: unknown,
  message: EmailMessage,
): Promise<SendOutcome> {
  const body = emailSendBody(message)
  if (emailIsMocked(env, tripName)) return { ok: true, mocked: true }

  const res = await tools.integration('email/send', body)
  if (res.success) return { ok: true, mocked: false }
  const envelope = res as unknown as { code?: unknown; billing?: unknown; status?: unknown }
  return {
    ok: false,
    mocked: false,
    billed: envelope.billing !== 'released',
    // Code/status only: provider text can echo the recipient's address.
    reason: [envelope.code, envelope.status].filter((v) => typeof v === 'string' || typeof v === 'number').join(' ') || 'error',
  }
}
