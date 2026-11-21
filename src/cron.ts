/**
 * Cron tasks (SPEC §9), registered into AppCronRoom (worker.ts). The DO
 * alarm calls `runTask(name, env)` on schedule and logs
 * `[cron] <task> ok|failed` for every run (`deepspace logs --search cron`).
 *
 * Tasks run as the app owner with RBAC-off tools from `createAppTools`
 * (not `buildCronContext`, which lacks get/orderBy/upsert; NOTES C8).
 * Cron writes (trigger/pause/resume) are admin-only (realtime-routes.ts).
 */
import type { CronTask } from 'deepspace/worker'
import type { Env } from '../worker'
import { WATCH_TIMEZONE } from './lib/limits'
import { createAppTools } from './server/app-tools'
import { runFareWatchCron } from './server/fare-watch-cron'

export const tasks: CronTask[] = [
  // Every morning: enqueue watch runs for trips with the fare watch on (src/server/fare-watch-cron.ts).
  { name: 'fare-watch', schedule: '0 8 * * *', timezone: WATCH_TIMEZONE },
]

export async function runTask(name: string, env: Env): Promise<void> {
  switch (name) {
    case 'fare-watch':
      await runFareWatchCron(createAppTools(env, env.OWNER_USER_ID), env)
      return
    default:
      throw new Error(`Unknown cron task: ${name}`)
  }
}
