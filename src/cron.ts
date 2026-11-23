/**
 * Cron tasks (SPEC §9), registered into AppCronRoom (worker.ts). The DO
 * alarm calls `runTask(name, env)` on schedule and logs
 * `[cron] <task> ok|failed` for every run (`deepspace logs --search cron`).
 *
 * Tasks run as the app owner with RBAC-off tools from `createAppTools`
 * (not `buildCronContext`, which lacks get/orderBy/upsert; NOTES C8).
 * Cron writes (trigger/pause/resume) are admin-only (realtime-routes.ts).
 *
 * The run history is readable by anyone (NOTES D3), so a failure crosses
 * this boundary only as generic text (`genericFailure`): never a trip name,
 * email, budget or user id.
 */
import type { CronTask } from 'deepspace/worker'
import type { Env } from '../worker'
import { WATCH_TIMEZONE } from './lib/limits'
import { genericFailure } from './lib/safe-error'
import { createAppTools } from './server/app-tools'
import { runFareWatchCron } from './server/fare-watch-cron'

export const tasks: CronTask[] = [
  // Every morning: enqueue watch runs for trips with the fare watch on (src/server/fare-watch-cron.ts).
  { name: 'fare-watch', schedule: '0 8 * * *', timezone: WATCH_TIMEZONE },
]

export async function runTask(name: string, env: Env): Promise<void> {
  if (name !== 'fare-watch') throw new Error('Unknown cron task')
  try {
    await runFareWatchCron(createAppTools(env, env.OWNER_USER_ID), env)
  } catch (err) {
    throw genericFailure('fare-watch', err)
  }
}
