/**
 * Send one email at most once (SPEC §5 `emailLog`, §6 lockTrip, §8.7).
 * Shared by the lock emails and the fare-watch emails.
 *
 * - No double-send: a claim row is created in the server-only `emailLog`
 *   collection BEFORE the send; `uniqueOn ['key']` refuses a second claim for
 *   the same key, so a retry or a concurrent call skips it. A failed send
 *   deletes its claim so the next retry can try again. A 'sending' claim
 *   older than STALE_CLAIM_MS is treated as abandoned (the worker died).
 * - Caps: each real send first checks today's per-trip and global email
 *   counts (`emailsAllowed`) and is counted afterwards. Mocked sends (the
 *   dev/test seam) spend nothing and aren't counted. A failed send counts
 *   unless the platform says billing was released.
 * - The address is read from the recipient's `users` row here and handed
 *   straight to the message builder; it's never stored, logged or returned.
 * - Demo trips never send (SPEC §14). The callers skip them before getting
 *   here; this refuses them too, as a backstop.
 */
import type { ActionTools } from 'deepspace/worker'
import { emailsAllowed, usageDay, usageKeys } from '../lib/caps'
import { isDemoTrip } from '../lib/demo'
import { isEmailAddress, type EmailMessage } from '../lib/email'
import { LIMITS, type Limits } from '../lib/limits'
import { isGhostId } from '../lib/types'
import { emailIsMocked, sendEmail } from './email-source'
import { isDuplicate, must, type Trip } from './trip-access'
import { getUsageCounts, incrementUsage } from './usage'

/** A 'sending' claim older than this is treated as abandoned (the worker died mid-send). */
export const STALE_CLAIM_MS = 10 * 60 * 1000

export type DeliveryOutcome = 'sent' | 'alreadySent' | 'noEmail' | 'capped' | 'failed'

export interface DeliveryCounts {
  /** Sent (or, in dev/test on `__test-` trips, built and mocked) by this call. */
  sent: number
  /** Already sent earlier (a retry, a repeat run or a concurrent call). */
  alreadySent: number
  /** No usable address on the recipient's account. */
  noEmail: number
  /** Skipped because today's email cap is reached; a later retry may send it. */
  capped: number
  /** email/send failed; a later retry may send it. */
  failed: number
}

export const emptyCounts = (): DeliveryCounts => ({ sent: 0, alreadySent: 0, noEmail: 0, capped: 0, failed: 0 })

export interface DeliveryDeps {
  now?: () => Date
  limits?: Limits
  send?: typeof sendEmail
}

export interface DeliveryEnv {
  ALLOW_DEBUG_ROUTES?: string
  APP_NAME: string
}

export interface EmailClaim {
  key: string
  /** 'lock', 'drop' or 'under_budget' (emailLog.kind, ≤ 20 chars). */
  kind: string
  userId: string
  iata?: string | null
}

/**
 * Real members only: not ghosts, and still in the trip's memberIds. Rows are
 * returned in join order.
 */
export function realMemberRows<T extends { createdAt: string; data: Record<string, unknown> }>(
  trip: Trip,
  travelers: readonly T[],
): T[] {
  return [...travelers]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .filter((t) => {
      const id = t.data.userId
      return typeof id === 'string' && !isGhostId(id) && t.data.isGhost !== 1 && trip.data.memberIds.includes(id)
    })
}

export async function deliverOnce(
  tools: ActionTools,
  env: DeliveryEnv,
  trip: Trip,
  claim: EmailClaim,
  build: (address: string) => EmailMessage,
  deps: DeliveryDeps = {},
): Promise<DeliveryOutcome> {
  const now = deps.now ?? (() => new Date())
  const limits = deps.limits ?? LIMITS
  const send = deps.send ?? sendEmail
  const tripId = trip.id
  if (isDemoTrip(trip.data)) throw new Error('deliverOnce: emails are off in demo trips')
  const mocked = emailIsMocked(env, trip.data.name)

  const { records: claims } = must(await tools.query('emailLog', { where: { key: claim.key }, limit: 1 }), 'read email log')
  const existing = claims[0]
  if (existing) {
    const claimedAt = Date.parse(String(existing.data.claimedAt ?? ''))
    const stale = existing.data.status !== 'sent' && !(now().getTime() - claimedAt < STALE_CLAIM_MS)
    if (!stale) return 'alreadySent'
    must(await tools.remove('emailLog', existing.recordId), 'drop stale email claim')
  }

  const user = await tools.get('users', claim.userId)
  const address = user.success ? user.data.record.data.email : undefined
  if (!isEmailAddress(address)) return 'noEmail'

  const day = usageDay(now())
  const tripKey = usageKeys.emailTrip(tripId)
  const globalKey = usageKeys.emailGlobal()
  if (!mocked) {
    const counts = await getUsageCounts(tools, day, [tripKey, globalKey])
    if (emailsAllowed(1, counts[tripKey], counts[globalKey], limits) < 1) return 'capped'
  }

  const created = await tools.create('emailLog', {
    key: claim.key,
    kind: claim.kind,
    tripId,
    userId: claim.userId,
    iata: claim.iata ?? null,
    status: 'sending',
    mocked: mocked ? 1 : 0,
    claimedAt: now().toISOString(),
  })
  if (isDuplicate(created)) return 'alreadySent'
  const { recordId: claimId } = must(created, 'claim email')

  let message: EmailMessage
  try {
    message = build(address)
  } catch (err) {
    must(await tools.remove('emailLog', claimId), 'release email claim')
    throw err
  }
  const outcome = await send(tools, env, trip.data.name, message)

  if (!outcome.mocked && (outcome.ok || outcome.billed)) {
    await incrementUsage(tools, day, tripKey)
    await incrementUsage(tools, day, globalKey)
  }
  if (outcome.ok) {
    must(await tools.update('emailLog', claimId, { status: 'sent', sentAt: now().toISOString() }), 'mark email sent')
    return 'sent'
  }
  must(await tools.remove('emailLog', claimId), 'release email claim')
  console.warn(`[email] ${claim.kind} email failed for trip ${tripId}: ${outcome.reason}`)
  return 'failed'
}
