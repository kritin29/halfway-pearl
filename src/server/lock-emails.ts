/**
 * Booking emails after a trip is locked (SPEC §3.8, §6 lockTrip).
 *
 * - One email per REAL member (ghosts have no account and no address), with
 *   only their own fare and booking link (src/lib/email.ts).
 * - No double-send and caps: each email goes through `deliverOnce`
 *   (src/server/email-delivery.ts): an `emailLog` claim per (trip,
 *   destination, person) before the send, per-trip and global caps checked
 *   per email, mocked sends (dev/test seam) not counted.
 * - Addresses are read from `users` and passed straight to the builder;
 *   they're never stored, logged or returned.
 * - Demo trips send nothing and report `emailsOff` (SPEC §14).
 */
import type { ActionTools } from 'deepspace/worker'
import { isDemoTrip } from '../lib/demo'
import { appUrlFor, buildLockEmail, lockEmailKey } from '../lib/email'
import type { FareRow } from '../lib/results'
import { deliverOnce, emptyCounts, realMemberRows, type DeliveryCounts, type DeliveryDeps, type DeliveryEnv } from './email-delivery'
import { emailIsMocked } from './email-source'
import { must, type Trip } from './trip-access'
import { queryTravelers } from './trip-rows'

export { STALE_CLAIM_MS } from './email-delivery'

export interface LockEmailReport extends DeliveryCounts {
  /** True when the dev/test seam answered instead of email/send. */
  mocked: boolean
  /** True on a demo trip: nothing was built, claimed or sent (SPEC §14). */
  emailsOff: boolean
}

export type LockEmailDeps = DeliveryDeps

export async function sendLockEmails(
  tools: ActionTools,
  env: DeliveryEnv,
  trip: Trip,
  destination: { iata: string; city: string; country: string },
  deps: LockEmailDeps = {},
): Promise<LockEmailReport> {
  const tripId = trip.id
  if (isDemoTrip(trip.data)) return { ...emptyCounts(), mocked: false, emailsOff: true }
  const report: LockEmailReport = { ...emptyCounts(), mocked: emailIsMocked(env, trip.data.name), emailsOff: false }

  const travelers = await queryTravelers(tools, tripId)
  const organizerName = String(travelers.find((t) => t.data.userId === trip.data.organizerId)?.data.displayName ?? '')
  const { records: fareRows } = must(
    await tools.query('fares', { where: { tripId, candidateIata: destination.iata } }),
    'query locked fares',
  )
  const fareFor = new Map(fareRows.map((r) => [String(r.data.travelerId), r.data as unknown as FareRow]))

  for (const t of realMemberRows(trip, travelers)) {
    const userId = String(t.data.userId)
    const outcome = await deliverOnce(
      tools,
      env,
      trip,
      { key: lockEmailKey(tripId, destination.iata, userId), kind: 'lock', userId, iata: destination.iata },
      (email) =>
        buildLockEmail({
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
        }),
      deps,
    )
    report[outcome]++
  }
  return report
}
