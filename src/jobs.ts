/**
 * Background-job handler, invoked by AppJobRoom (worker.ts) for every job
 * picked up from the queue. Dispatch on `job.type`; return a result (stored
 * as `job.result`) or throw to fail (retried up to `maxAttempts`).
 *
 * Jobs run as the app owner with RBAC-off tools (SPEC §8, NOTES §2), so each
 * handler scopes itself to the ids in its payload. The JobRoom is admin-only
 * (worker.ts); clients see progress on the trip row, never through `useJobs`.
 *
 * A failure crosses this boundary only as generic text (`genericFailure`,
 * NOTES D3): the JobRoom stores and logs the message, and storage errors can
 * echo stored values.
 */
import type { Job, JobContext } from 'deepspace/worker'
import type { Env } from '../worker'
import { genericFailure } from './lib/safe-error'
import { createAppTools } from './server/app-tools'
import { runFareSearch } from './server/fare-search'

export async function runJob(job: Job, ctx: JobContext, env: Env): Promise<unknown> {
  if (job.type !== 'fare-search') throw new Error('Unknown job type')
  try {
    return await runFareSearch(job, ctx, { tools: createAppTools(env, env.OWNER_USER_ID), env })
  } catch (err) {
    throw genericFailure('fare-search', err)
  }
}
