import type { CollectionSchema } from 'deepspace/schema'
import { IATA_COLUMN, MEMBERS_READ_ONLY, TRIP_SCOPE_COLUMNS, memberAndAdmin } from './common'

/**
 * SPEC §5 `candidates`. Written by candidate actions; aggregates by the job.
 * No `ownerField`, so `'collaborator'` also passes `createdBy` (SPEC §5 known limitation).
 */
export const candidatesSchema: CollectionSchema = {
  name: 'candidates',
  columns: [
    ...TRIP_SCOPE_COLUMNS,
    IATA_COLUMN('iata'),
    { name: 'city', storage: 'text', interpretation: 'plain', maxLength: 80 },
    { name: 'country', storage: 'text', interpretation: 'plain', maxLength: 80 },
    { name: 'why', storage: 'text', interpretation: 'plain', maxLength: 300 },
    {
      name: 'source',
      storage: 'text',
      interpretation: { kind: 'select', options: ['ai', 'midpoint', 'manual'] },
    },
    { name: 'addedBy', storage: 'text', interpretation: 'plain' },
    // Aggregates written by the fare-search job (null while incomplete).
    { name: 'complete', storage: 'number', interpretation: { kind: 'boolean' }, default: 0 },
    { name: 'groupTotal', storage: 'number', interpretation: 'plain' },
    { name: 'maxFare', storage: 'number', interpretation: 'plain' },
    { name: 'minFare', storage: 'number', interpretation: 'plain' },
    { name: 'arrivalSpreadMin', storage: 'number', interpretation: 'plain' },
    // 0/1, or null when hidden by the < 3 budgets privacy guard (SPEC §7).
    { name: 'fitsAll', storage: 'number', interpretation: 'plain' },
    { name: 'missingFor', storage: 'text', interpretation: { kind: 'json' } },
    { name: 'lastCheckedAt', storage: 'text', interpretation: { kind: 'datetime' } },
  ],
  uniqueOn: ['tripId', 'iata'],
  collaboratorsField: 'memberIds',
  permissions: memberAndAdmin(MEMBERS_READ_ONLY),
}
