/**
 * Booking emails after a trip is locked (SPEC §3.8, §6 lockTrip).
 *
 * - One email per REAL member (ghosts have no account and no address), with
 *   only their own fare and booking link (src/lib/email.ts).
 * - No double-send: before sending, a claim row is created in the
 *   server-only `emailLog` collection; `uniqueOn ['key']` refuses a second
 *   claim for the same (trip, destination, person), so a retry or a second
 *   concurrent call skips anyone already emailed. A failed send deletes its
 *   claim so the next retry can try again.
 * - Caps: each real send first checks today's per-trip and global email
 *   counts (`emailsAllowed`) and is counted afterwards, one at a time.
 *   Mocked sends (dev/test seam) spend nothing and aren't counted.
 * - Addresses are read from `users` here and passed straight to the send;
 *   they're never stored, logged or returned.
 */
import type { ActionTools } from 'deepspace/worker'
import { emailsAllowed, usageDay, usageKeys } from '../lib/caps'
import { appUrlFor, buildLockEmail, isEmailAddress, lockEmailKey } from '../lib/email'
import { LIMITS, type Limits } from '../lib/limits'
import type { FareRow } from '../lib/results'
import { isGhostId } from '../lib/types'
import { emailIsMocked, sendEmail } from './email-source'
import { isDuplicate, must, type Trip } from './trip-access'
import { queryTravelers } from './trip-rows'
import { getUsageCounts, incrementUsage } from './usage'

/** A 'sending' claim older than this is treated as abandoned (the worker died mid-send). */
export const STALE_CLAIM_MS = 10 * 60 * 1000

export interface LockEmailReport {
  /** Emails sent (or, in dev/test on `__test-` trips, built and mocked) by this call. */
  sent: number
  /** Real members who already had this email (a retry or a concurrent call). */
  alreadySent: number
  /** Real members with no usable address on their account. */
  noEmail: number
  /** Skipped because today's email cap is reached; a later retry sends them. */
  capped: number
  /** email/send failed; a later retry sends them. */
  failed: number
  /** True when the dev/test seam answered instead of email/send. */
  mocked: boolean
}

export interface LockEmailDeps {
  now?: () => Date
  limits?: Limits
  send?: typeof sendEmail
}

export async function sendLockEmails(
  tools: ActionTools,
  env: { ALLOW_DEBUG_ROUTES?: string; APP_NAME: string },
  trip: Trip,
  destination: { iata: string; city: string; country: string },
  deps: LockEmailDeps = {},
): Promise<LockEmailReport> {
  const now = deps.now ?? (() => new Date())
  const limits = deps.limits ?? LIMITS
  const send = deps.send ?? sendEmail
  const tripId = trip.id
  const mocked = emailIsMocked(env, trip.data.name)
  const report: LockEmailReport = { sent: 0, alreadySent: 0, noEmail: 0, capped: 0, failed: 0, mocked }

  const travelers = [...(await queryTravelers(tools, tripId))].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const organizerName = String(travelers.find((t) => t.data.userId === trip.data.organizerId)?.data.displayName ?? '')
  // Real members only: not ghosts, and still on the trip.
  const recipients = travelers.filter((t) => {
    const id = t.data.userId
    return typeof id === 'string' && !isGhostId(id) && t.data.isGhost !== 1 && trip.data.memberIds.includes(id)
  })
  const { records: fareRows } = must(
    await tools.query('fares', { where: { tripId, candidateIata: destination.iata } }),
    'query locked fares',
  )
  const fareFor = new Map(fareRows.map((r) => [String(r.data.travelerId), r.data as unknown as FareRow]))
  const day = usageDay(now())
  const tripKey = usageKeys.emailTrip(tripId)
  const globalKey = usageKeys.emailGlobal()

  for (const t of recipients) {
    const userId = String(t.data.userId)
    const key = lockEmailKey(tripId, destination.iata, userId)

    const { records: claims } = must(await tools.query('emailLog', { where: { key }, limit: 1 }), 'read email log')
    const claim = claims[0]
    if (claim) {
      const claimedAt = Date.parse(String(claim.data.claimedAt ?? ''))
      const stale = claim.data.status !== 'sent' && !(now().getTime() - claimedAt < STALE_CLAIM_MS)
      if (!stale) {
        report.alreadySent++
        continue
      }
      must(await tools.remove('emailLog', claim.recordId), 'drop stale email claim')
    }

    const user = await tools.get('users', userId)
    const email = user.success ? user.data.record.data.email : undefined
    if (!isEmailAddress(email)) {
      report.noEmail++
      continue
    }

    if (!mocked) {
      const counts = await getUsageCounts(tools, day, [tripKey, globalKey])
      if (emailsAllowed(1, counts[tripKey], counts[globalKey], limits) < 1) {
        report.capped++
        continue
      }
    }

    const created = await tools.create('emailLog', {
      key,
      kind: 'lock',
      tripId,
      userId,
      iata: destination.iata,
      status: 'sending',
      mocked: mocked ? 1 : 0,
      claimedAt: now().toISOString(),
    })
    if (isDuplicate(created)) {
      report.alreadySent++
      continue
    }
    const { recordId: claimId } = must(created, 'claim email')

    const message = buildLockEmail({
      appUrl: appUrlFor(env.APP_NAME),
      tripId,
      tripName: trip.data.name,
      outboundDate: trip.data.outboundDate,
      returnDate: trip.data.returnDate,
      destination,
      organizerName,
      recipient: {
        displayName: String(t.data.displayName ?? ''),
        email,
        homeAirports: Array.isArray(t.data.homeAirports) ? (t.data.homeAirports as string[]) : [],
      },
      fare: fareFor.get(userId) ?? null,
    })
    const outcome = await send(tools, env, trip.data.name, message)

    if (!outcome.mocked && (outcome.ok || outcome.billed)) {
      await incrementUsage(tools, day, tripKey)
      await incrementUsage(tools, day, globalKey)
    }
    if (outcome.ok) {
      must(await tools.update('emailLog', claimId, { status: 'sent', sentAt: now().toISOString() }), 'mark email sent')
      report.sent++
    } else {
      must(await tools.remove('emailLog', claimId), 'release email claim')
      report.failed++
      console.warn(`[email] lock email failed for trip ${tripId}: ${outcome.reason}`)
    }
  }
  return report
}
