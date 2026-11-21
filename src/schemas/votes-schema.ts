import type { CollectionSchema } from 'deepspace/schema'
import { IATA_COLUMN, MEMBERS_READ_ONLY, TRIP_SCOPE_COLUMNS, memberAndAdmin } from './common'

/** SPEC §5 `votes`: approval votes, written only by the `toggleVote` action (caller = subject). */
export const votesSchema: CollectionSchema = {
  name: 'votes',
  columns: [
    ...TRIP_SCOPE_COLUMNS,
    { name: 'userId', storage: 'text', interpretation: 'plain', userBound: true, immutable: true },
    IATA_COLUMN('candidateIata'),
  ],
  uniqueOn: ['tripId', 'userId', 'candidateIata'],
  ownerField: 'userId',
  collaboratorsField: 'memberIds',
  permissions: memberAndAdmin(MEMBERS_READ_ONLY),
}
