/**
 * Read the DEPLOYED app's cron state and run history (SPEC §9, NOTES D1).
 *
 *   node scripts/live-check/cron-history.mjs
 *
 * Read-only. It opens one WebSocket to /ws/cron/app:<DEEPSPACE_APP_ID> with NO
 * token, so the CronRoom treats it as a viewer: it can read, and any write
 * (trigger/pause/resume) would be refused. This script sends nothing; it
 * prints what the room sends on connect and exits:
 *   - cron.tasks:   each task's schedule, paused, lastRunAt, nextRunAt
 *   - cron.history: the last 50 finished runs (startedAt, success, durationMs, error)
 *
 * The app id and name come from wrangler.toml (both are public: the app id is
 * committed and the name is the subdomain). Override with
 *   CRON_URL=wss://<host>/ws/cron/app:<id> node scripts/live-check/cron-history.mjs
 * Needs Node 22+ (global WebSocket). No secrets, no credentials.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

function defaultUrl() {
  const toml = readFileSync(fileURLToPath(new URL('../../wrangler.toml', import.meta.url)), 'utf8')
  const appId = /^DEEPSPACE_APP_ID\s*=\s*"([^"]+)"/m.exec(toml)?.[1]
  const appName = /^APP_NAME\s*=\s*"([^"]+)"/m.exec(toml)?.[1]
  if (!appId || !appName) throw new Error('DEEPSPACE_APP_ID / APP_NAME not found in wrangler.toml')
  return `wss://${appName}.app.space/ws/cron/${encodeURIComponent(`app:${appId}`)}`
}

const url = process.env.CRON_URL ?? defaultUrl()
console.log(`Connecting (read-only, no token) to ${url}\n`)

const ws = new WebSocket(url)
const seen = new Set()
ws.onmessage = async (event) => {
  const text = typeof event.data === 'string' ? event.data : Buffer.from(await event.data.arrayBuffer()).toString()
  const msg = JSON.parse(text)
  seen.add(msg.type)
  console.log(JSON.stringify(msg, null, 2))
  if (seen.has('cron.tasks') && seen.has('cron.history')) finish(0)
}
ws.onerror = (event) => {
  console.error('WebSocket error:', event.message ?? event.type)
  finish(1)
}

function finish(code) {
  try {
    ws.close()
  } catch {
    // already closed
  }
  process.exit(code)
}

// The room sends both messages right after connecting; give up after 10 s.
setTimeout(() => {
  console.error(`Timed out; received: ${[...seen].join(', ') || 'nothing'}`)
  finish(1)
}, 10_000)
