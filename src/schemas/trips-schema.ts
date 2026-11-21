import type { CollectionSchema } from 'deepspace/schema'
import { INPUT_LIMITS } from '../lib/limits'
import { TRIP_STATUSES } from '../lib/types'
import { FLAG_COLUMN, MEMBERS_READ_ONLY, memberAndAdmin } from './common'

/** SPEC §5 `trips`. Every write goes through actions/jobs. */
export const tripsSchema: CollectionSchema = {
  name: 'trips',
  columns: [
    { name: 'name', storage: 'text', interpretation: 'plain', required: true, maxLength: INPUT_LIMITS.tripNameMax },
    // userBound: createTrip's caller is always the organizer. The job/cron never create trips.
    { name: 'organizerId', storage: 'text', interpretation: 'plain', userBound: true, immutable: true },
    { name: 'memberIds', storage: 'text', interpretation: { kind: 'json' } },
    { name: 'inviteCode', storage: 'text', interpretation: 'plain', required: true, immutable: true, maxLength: 32 },
    {
      name: 'status',
      storage: 'text',
      interpretation: { kind: 'select', options: [...TRIP_STATUSES] },
      default: 'gathering',
    },
    { name: 'outboundDate', storage: 'text', interpretation: { kind: 'date' }, required: true },
    { name: 'returnDate', storage: 'text', interpretation: { kind: 'date' }, required: true },
    { name: 'vibe', storage: 'text', interpretation: 'plain', maxLength: INPUT_LIMITS.vibeMax },
    { name: 'lockedIata', storage: 'text', interpretation: 'plain', maxLength: 3 },
    FLAG_COLUMN('watchEnabled', 1),
    { name: 'lastSearchAt', storage: 'text', interpretation: { kind: 'datetime' } },
    { name: 'searchJobId', storage: 'text', interpretation: 'plain' },
    { name: 'searchProgress', storage: 'number', interpretation: 'plain' },
    { name: 'searchMessage', storage: 'text', interpretation: 'plain', maxLength: 200 },
    { name: 'searchError', storage: 'text', interpretation: 'plain', maxLength: 300 },
    // Fare watch (SPEC §8 mode 'watch'): set when a watch run is enqueued
    // (checkFaresNow or the cron), cleared by the job when it finishes.
    { name: 'watchQueuedAt', storage: 'text', interpretation: { kind: 'datetime' } },
    // Why the last watch run couldn't check everything; null when it did. Never contains budgets.
    { name: 'watchError', storage: 'text', interpretation: 'plain', maxLength: 300 },
  ],
  uniqueOn: ['inviteCode'],
  ownerField: 'organizerId',
  collaboratorsField: 'memberIds',
  permissions: memberAndAdmin(MEMBERS_READ_ONLY),
}
