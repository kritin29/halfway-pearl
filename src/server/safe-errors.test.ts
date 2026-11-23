/**
 * NOTES D3 ruling: cron and job error text never contains user data (trip
 * names, emails, budgets, user ids). The CronRoom history (readable by
 * anyone) and the JobRoom row store the thrown error's message, and both
 * log it. So the real `runTask` / `runJob` entry points are run here against
 * a storage stub whose errors echo all four kinds of user data. Neither the
 * thrown error nor anything logged along the way may contain them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Job, JobContext } from 'deepspace/worker'
import type { Env } from '../../worker'
import { runTask } from '../cron'
import { runJob } from '../jobs'
import { genericFailure, safeErrorText } from '../lib/safe-error'
import { ToolError } from './trip-access'

const USER_ID = 'user_secret_8f3a'
const EMAIL = 'alice.private@example.com'
const BUDGET = '4321'
const TRIP_NAME = 'Alice’s 40th surprise'
const SECRETS = [USER_ID, EMAIL, BUDGET, TRIP_NAME, 'Alice']
/** What a storage refusal can look like: it echoes the values it refused. */
const LEAKY = `Duplicate: a record with key=lock|trip_1|BNA|${USER_ID} already exists (${EMAIL}, maxUsd=${BUDGET}, name="${TRIP_NAME}")`

let logged: string[]
beforeEach(() => {
  logged = []
  for (const level of ['error', 'warn', 'log', 'info', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack ?? ''} ${String(a.cause ?? '')}` : String(a))).join(' '))
    })
  }
})
afterEach(() => vi.restoreAllMocks())

/** An Env whose record room answers `records.get` for the trip (if given) and fails everything else with LEAKY. */
function leakyEnv(trip?: Record<string, unknown>): Env {
  const stub = {
    fetch: async (req: Request) => {
      const { tool, params } = (await req.json()) as { tool: string; params: Record<string, unknown> }
      if (trip && tool === 'records.get' && params.collection === 'trips') {
        const now = new Date().toISOString()
        return Response.json({
          success: true,
          data: { record: { recordId: 'trip_1', data: trip, createdBy: USER_ID, createdAt: now, updatedAt: now } },
        })
      }
      return Response.json({ success: false, error: LEAKY })
    },
  }
  return {
    RECORD_ROOMS: { idFromName: () => 'id', get: () => stub },
    JOB_ROOMS: { idFromName: () => 'id', get: () => stub },
    DEEPSPACE_APP_ID: 'app123',
    OWNER_USER_ID: 'owner',
  } as unknown as Env
}

const ctx: JobContext = { progress: () => {}, continue: () => {}, signal: new AbortController().signal }
const job = (over: Partial<Job> = {}): Job =>
  ({
    id: 'job_1',
    type: 'fare-search',
    status: 'running',
    payload: { tripId: 'trip_1', mode: 'full' },
    attempts: 2,
    maxAttempts: 2,
    enqueuedAt: new Date().toISOString(),
    ...over,
  }) as Job

async function thrown(p: Promise<unknown>): Promise<Error> {
  try {
    await p
  } catch (err) {
    return err as Error
  }
  throw new Error('expected a failure')
}

function expectClean(err: Error) {
  expect(err.cause).toBeUndefined()
  for (const text of [err.message, ...logged]) {
    for (const secret of SECRETS) expect(text, `leaked "${secret}"`).not.toContain(secret)
  }
}

describe('cron and job error text is generic', () => {
  it('the fare-watch cron task: storage failure → generic message, nothing leaked in logs', async () => {
    const err = await thrown(runTask('fare-watch', leakyEnv()))
    expect(err.message).toBe('fare-watch failed: storage error at "query watched trips"')
    expectClean(err)
  })

  it('the fare-search job, failing before its own error handling (loading the trip)', async () => {
    const err = await thrown(runJob(job(), ctx, leakyEnv()))
    expect(err.message).toBe('fare-search failed: storage error at "load trip"')
    expectClean(err)
  })

  it('the fare-search job, failing inside the search: its own logs and the give-up path stay generic too', async () => {
    const trip = { name: TRIP_NAME, organizerId: USER_ID, memberIds: [USER_ID], status: 'searching', searchJobId: 'job_1', outboundDate: '2026-12-11', returnDate: '2026-12-13' }
    const err = await thrown(runJob(job(), ctx, leakyEnv(trip)))
    expect(err.message).toBe('fare-search failed: storage error at "query travelers"')
    expect(logged.some((l) => l.includes('[fare-search]') && l.includes('storage error at "query travelers"'))).toBe(true)
    expect(logged.some((l) => l.includes('could not record the failure: storage error'))).toBe(true)
    expectClean(err)
  })

  it('unknown task / job type names aren’t echoed either', async () => {
    expect((await thrown(runTask(TRIP_NAME, leakyEnv()))).message).toBe('Unknown cron task')
    expect((await thrown(runJob(job({ type: EMAIL }), ctx, leakyEnv()))).message).toBe('Unknown job type')
  })
})

describe('safeErrorText', () => {
  it('keeps only a plain lowercase step label, never the message', () => {
    expect(safeErrorText(new ToolError('load trip', LEAKY))).toBe('storage error at "load trip"')
    // Labels built from data are dropped.
    expect(safeErrorText(new ToolError(`write fare cache ORD>BNA|2026-12-11`, LEAKY))).toBe('storage error')
    expect(safeErrorText(new ToolError(`find ${USER_ID}`, LEAKY))).toBe('storage error')
    expect(safeErrorText(new Error(LEAKY))).toBe('unexpected error')
    expect(safeErrorText(LEAKY)).toBe('unexpected error')
    expect(safeErrorText(null)).toBe('unexpected error')
  })
  it('genericFailure has no cause and no original text', () => {
    const err = genericFailure('fare-watch', new Error(LEAKY, { cause: new Error(EMAIL) }))
    expect(err.message).toBe('fare-watch failed: unexpected error')
    expect(err.cause).toBeUndefined()
  })
})
