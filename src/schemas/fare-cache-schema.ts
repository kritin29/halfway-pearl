import type { CollectionSchema } from 'deepspace/schema'
import { NONE } from './common'

/**
 * Server-only cache of parsed SerpApi results (SPEC §8.4). One row per
 * search key (`fareCacheKey`: origin set | destination | dates), so every
 * traveler flying from the same airports reuses one call for 6 hours and
 * applies their OWN constraints to it. Caching the chosen fare per traveler
 * instead would serve stale picks after someone changes their constraints.
 *
 * Like `usage`, every role (admin included) is refused everything; only the
 * fare-search job reads and writes it. Rows hold flight options only: no
 * user ids, names or budgets. recordId = the key (`fixture|…` in fixture mode,
 * so test data never answers a real search).
 */
export const fareCacheSchema: CollectionSchema = {
  name: 'fareCache',
  columns: [
    { name: 'key', storage: 'text', interpretation: 'plain', required: true, maxLength: 200 },
    // Parsed itineraries (src/lib/flights.ts `Itinerary[]`) plus the price context.
    { name: 'itineraries', storage: 'text', interpretation: { kind: 'json' } },
    { name: 'priceLevel', storage: 'text', interpretation: 'plain', maxLength: 10 },
    { name: 'typicalLow', storage: 'number', interpretation: 'plain' },
    { name: 'typicalHigh', storage: 'number', interpretation: 'plain' },
    { name: 'bookingUrl', storage: 'text', interpretation: 'plain', maxLength: 2000 },
    { name: 'fetchedAt', storage: 'text', interpretation: { kind: 'datetime' }, required: true },
  ],
  uniqueOn: ['key'],
  permissions: { '*': NONE, viewer: NONE, member: NONE, admin: NONE },
}
