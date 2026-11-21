/**
 * The `usage` spend ledger (SPEC §5 `usage`, §8.3). Server-only: clients can
 * neither read nor write the collection. Rows are keyed by
 * `usageRecordId(day, key)` and upserted with `tools.create(…, recordId)`.
 *
 * Fails closed: if the ledger can't be read, these functions throw and the
 * caller refuses the paid call rather than spending blind.
 *
 * Not atomic: an increment is a get followed by an upsert, so two concurrent
 * callers can both read N and write N+1. Caps are therefore soft by ±1; the
 * fare-search job serializes its own increments (SPEC §8.5).
 */
import type { ActionTools } from 'deepspace/worker'
import { usageRecordId } from '../lib/caps'
import { isNotFound, must } from './trip-access'

/** Today's count for `key` (0 when there's no row yet). */
export async function getUsageCount(tools: ActionTools, day: string, key: string): Promise<number> {
  const res = await tools.get('usage', usageRecordId(day, key))
  if (isNotFound(res)) return 0
  const count = must(res, 'read usage').record.data.count
  return typeof count === 'number' && Number.isFinite(count) ? count : 0
}

/** Counts for several keys, in one object keyed by key. */
export async function getUsageCounts(
  tools: ActionTools,
  day: string,
  keys: readonly string[],
): Promise<Record<string, number>> {
  const entries = await Promise.all(keys.map(async (key) => [key, await getUsageCount(tools, day, key)] as const))
  return Object.fromEntries(entries)
}

/** Add `by` (default 1) to today's count for `key`; returns the new count. */
export async function incrementUsage(
  tools: ActionTools,
  day: string,
  key: string,
  by = 1,
): Promise<number> {
  const next = (await getUsageCount(tools, day, key)) + by
  must(await tools.create('usage', { day, key, count: next }, usageRecordId(day, key)), 'write usage')
  return next
}
