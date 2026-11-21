import type { CollectionSchema } from 'deepspace/schema'
import { IATA_COLUMN, MEMBERS_READ_ONLY, TRIP_SCOPE_COLUMNS, memberAndAdmin } from './common'

/** SPEC §5 `fareSnapshots`: one row per candidate per check; drives the sparkline and drop detection. */
export const fareSnapshotsSchema: CollectionSchema = {
  name: 'fareSnapshots',
  columns: [
    ...TRIP_SCOPE_COLUMNS,
    IATA_COLUMN('candidateIata'),
    { name: 'groupTotal', storage: 'number', interpretation: 'plain' },
    { name: 'maxFare', storage: 'number', interpretation: 'plain' },
    { name: 'checkedAt', storage: 'text', interpretation: { kind: 'datetime' } },
  ],
  collaboratorsField: 'memberIds',
  permissions: memberAndAdmin(MEMBERS_READ_ONLY),
}
