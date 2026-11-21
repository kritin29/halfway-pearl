/**
 * Test-only behaviour, behind two gates (the same pattern as the approved
 * fare-fixture seam, SPEC §8 / NOTES C12):
 *
 * 1. `env.ALLOW_DEBUG_ROUTES === 'true'` — set only by `deepspace dev start`
 *    and `deepspace test run`, never in production; and
 * 2. the trip's name starts with `__test-`.
 *
 * Both must hold. In production the first gate is never true, so nothing
 * here changes behaviour there (unit-tested with an empty env).
 */
export const TEST_TRIP_PREFIX = '__test-'

export function isTestTrip(env: { ALLOW_DEBUG_ROUTES?: string }, tripName: unknown): boolean {
  return (
    env.ALLOW_DEBUG_ROUTES === 'true' &&
    typeof tripName === 'string' &&
    tripName.startsWith(TEST_TRIP_PREFIX)
  )
}
