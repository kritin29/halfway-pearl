import type { CollectionSchema } from 'deepspace/schema'
import { NONE } from './common'

/**
 * Server-only record of emails Halfway has sent or is sending (SPEC §5
 * `emailLog`, §6 lockTrip, §8.7). One row per (kind, trip, destination,
 * recipient) `key`, e.g. `lock|<tripId>|BNA|<userId>`, so a retried lock
 * never emails the same person twice.
 *
 * The row is created as a claim BEFORE the send (`status: 'sending'`, random
 * recordId); `uniqueOn ['key']` makes a second claim fail with "Duplicate", so
 * two lockTrip calls at once can't both send. Success flips it to 'sent'; a
 * failed send deletes the claim so a retry can try again.
 *
 * No addresses, names or budgets are stored. Like `usage`, every role (admin
 * included) is refused everything; only server code reads and writes it.
 */
export const emailLogSchema: CollectionSchema = {
  name: 'emailLog',
  columns: [
    { name: 'key', storage: 'text', interpretation: 'plain', required: true, maxLength: 200 },
    { name: 'kind', storage: 'text', interpretation: 'plain', required: true, maxLength: 20 },
    { name: 'tripId', storage: 'text', interpretation: 'plain', required: true, maxLength: 100 },
    { name: 'userId', storage: 'text', interpretation: 'plain', required: true, maxLength: 100 },
    { name: 'iata', storage: 'text', interpretation: 'plain', maxLength: 3 },
    { name: 'status', storage: 'text', interpretation: 'plain', required: true, maxLength: 10 },
    // 1 when the dev/test seam answered instead of email/send (src/server/email-source.ts).
    { name: 'mocked', storage: 'number', interpretation: 'plain', default: 0 },
    { name: 'claimedAt', storage: 'text', interpretation: { kind: 'datetime' }, required: true },
    { name: 'sentAt', storage: 'text', interpretation: { kind: 'datetime' } },
  ],
  uniqueOn: ['key'],
  permissions: { '*': NONE, viewer: NONE, member: NONE, admin: NONE },
}
