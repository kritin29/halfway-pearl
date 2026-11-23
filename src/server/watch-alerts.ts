/**
 * Fare-watch emails (SPEC §3.9, §8.7), sent at the end of a watch run.
 *
 * - Group drop: every real member gets their own copy (one `to` each) listing
 *   the shortlisted destinations whose group total dropped, with their OWN
 *   fare. Never a budget: the builder takes none. Keyed per run and person
 *   (`dropEmailKey`), so a retry of the same run never resends.
 * - Private: one email to the traveler whose fare crossed under their budget,
 *   keyed per (trip, destination, person) with no date (`underBudgetEmailKey`),
 *   so only the first crossing is ever emailed.
 * - Every send goes through `deliverOnce`: claim first, caps per email,
 *   mocked in dev/test for `__test-` trips.
 * - Demo trips send nothing and report `emailsOff` (SPEC §14).
 */
import type { ActionTools } from 'deepspace/worker'
import { isDemoTrip } from '../lib/demo'
import { appUrlFor, buildDropEmail, buildUnderBudgetEmail, dropEmailKey, underBudgetEmailKey } from '../lib/email'
import type { FareRow } from '../lib/results'
import type { BudgetCrossing, GroupDrop } from '../lib/watch'
import { deliverOnce, emptyCounts, realMemberRows, type DeliveryCounts, type DeliveryDeps, type DeliveryEnv } from './email-delivery'
import { emailIsMocked } from './email-source'
import type { Trip } from './trip-access'
import { queryTravelers } from './trip-rows'

export interface WatchEmailReport {
  group: DeliveryCounts
  private: DeliveryCounts
  mocked: boolean
  /** True on a demo trip: no alert was built, claimed or sent (SPEC §14). */
  emailsOff: boolean
}

export interface DestinationDrop {
  iata: string
  city: string
  drop: GroupDrop
}

export interface WatchAlerts {
  jobId: string
  drops: readonly DestinationDrop[]
  crossings: readonly BudgetCrossing[]
  /** Current fare rows, keyed `${travelerId}|${iata}`. */
  fares: ReadonlyMap<string, FareRow>
  /** IATA → city, for the private email. */
  cities: ReadonlyMap<string, string>
}

export const fareMapKey = (travelerId: string, iata: string) => `${travelerId}|${iata}`

export async function sendWatchEmails(
  tools: ActionTools,
  env: DeliveryEnv,
  trip: Trip,
  alerts: WatchAlerts,
  deps: DeliveryDeps = {},
): Promise<WatchEmailReport> {
  if (isDemoTrip(trip.data)) return { group: emptyCounts(), private: emptyCounts(), mocked: false, emailsOff: true }
  const report: WatchEmailReport = {
    group: emptyCounts(),
    private: emptyCounts(),
    mocked: emailIsMocked(env, trip.data.name),
    emailsOff: false,
  }
  if (alerts.drops.length === 0 && alerts.crossings.length === 0) return report

  const tripId = trip.id
  const appUrl = appUrlFor(env.APP_NAME)
  const members = realMemberRows(trip, await queryTravelers(tools, tripId))
  const base = {
    appUrl,
    tripId,
    tripName: trip.data.name,
    outboundDate: trip.data.outboundDate,
    returnDate: trip.data.returnDate,
  }

  if (alerts.drops.length > 0) {
    for (const t of members) {
      const userId = String(t.data.userId)
      const outcome = await deliverOnce(
        tools,
        env,
        trip,
        { key: dropEmailKey(tripId, alerts.jobId, userId), kind: 'drop', userId },
        (email) =>
          buildDropEmail({
            ...base,
            recipient: { displayName: String(t.data.displayName ?? ''), email },
            drops: alerts.drops.map((d) => {
              const own = alerts.fares.get(fareMapKey(userId, d.iata))
              return {
                iata: d.iata,
                city: d.city,
                previousTotal: d.drop.previousTotal,
                currentTotal: d.drop.currentTotal,
                yourFare: own && own.status === 'ok' && typeof own.price === 'number' ? own.price : null,
              }
            }),
          }),
        deps,
      )
      report.group[outcome]++
    }
  }

  for (const crossing of alerts.crossings) {
    const t = members.find((m) => m.data.userId === crossing.travelerId)
    const fare = alerts.fares.get(fareMapKey(crossing.travelerId, crossing.candidateIata))
    if (!t || !fare) continue
    const outcome = await deliverOnce(
      tools,
      env,
      trip,
      {
        key: underBudgetEmailKey(tripId, crossing.candidateIata, crossing.travelerId),
        kind: 'under_budget',
        userId: crossing.travelerId,
        iata: crossing.candidateIata,
      },
      (email) =>
        buildUnderBudgetEmail({
          ...base,
          destination: { iata: crossing.candidateIata, city: alerts.cities.get(crossing.candidateIata) ?? crossing.candidateIata },
          recipient: {
            displayName: String(t.data.displayName ?? ''),
            email,
            homeAirports: Array.isArray(t.data.homeAirports) ? (t.data.homeAirports as string[]) : [],
          },
          fare,
        }),
      deps,
    )
    report.private[outcome]++
  }
  return report
}
