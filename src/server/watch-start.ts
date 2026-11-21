/**
 * Start one watch run (SPEC §6 checkFaresNow, §9 cron). Shared by the
 * organizer's "Check fares now" and the daily cron, after each has done its
 * own checks:
 *
 *   count the check (and any extra marker) → mark the trip `watchQueuedAt`
 *   → enqueue `fare-search` {mode:'watch'}.
 *
 * `watchQueuedAt` is written BEFORE enqueueing, so the job (which clears it
 * when done) can never finish before the mark lands. If enqueueing throws,
 * the trip fields and the counters go back to how they were.
 */
import { enqueueJob } from 'deepspace/worker'
import type { ActionTools } from 'deepspace/worker'
import type { Env } from '../../worker'
import { usageKeys } from '../lib/caps'
import { must, type Trip } from './trip-access'
import { incrementUsage } from './usage'

export type Enqueue = typeof enqueueJob

export async function enqueueWatchRun(
  tools: ActionTools,
  env: Pick<Env, 'JOB_ROOMS' | 'DEEPSPACE_APP_ID'>,
  trip: Trip,
  opts: { day: string; now: Date; enqueuedBy: string; extraKeys?: readonly string[]; enqueue?: Enqueue },
): Promise<{ ok: true; jobId: string } | { ok: false }> {
  const enqueue = opts.enqueue ?? enqueueJob
  const keys = [usageKeys.watchTrip(trip.id), ...(opts.extraKeys ?? [])]
  for (const key of keys) await incrementUsage(tools, opts.day, key)
  const before = { watchQueuedAt: trip.data.watchQueuedAt ?? null, watchError: trip.data.watchError ?? null }
  must(await tools.update('trips', trip.id, { watchQueuedAt: opts.now.toISOString(), watchError: null }), 'mark watch queued')

  try {
    const jobId = await enqueue(
      env.JOB_ROOMS,
      `app:${env.DEEPSPACE_APP_ID}`,
      'fare-search',
      { tripId: trip.id, mode: 'watch', countedOn: opts.day },
      { maxAttempts: 2, enqueuedBy: opts.enqueuedBy },
    )
    return { ok: true, jobId }
  } catch (err) {
    console.error(`[watch] enqueue failed for trip ${trip.id}: ${err instanceof Error ? err.message : String(err)}`)
    must(await tools.update('trips', trip.id, before), 'roll back watch')
    for (const key of keys) await incrementUsage(tools, opts.day, key, -1)
    return { ok: false }
  }
}
