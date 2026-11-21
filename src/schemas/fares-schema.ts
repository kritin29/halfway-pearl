import type { CollectionSchema } from 'deepspace/schema'
import { IATA_COLUMN, MEMBERS_READ_ONLY, TRIP_SCOPE_COLUMNS, memberAndAdmin } from './common'

/** SPEC §5 `fares`: one row per traveler × candidate, written by the fare-search job. */
export const faresSchema: CollectionSchema = {
  name: 'fares',
  columns: [
    ...TRIP_SCOPE_COLUMNS,
    IATA_COLUMN('candidateIata'),
    // userId or ghost:<uuid>
    { name: 'travelerId', storage: 'text', interpretation: 'plain', required: true },
    IATA_COLUMN('originIata', false),
    { name: 'price', storage: 'number', interpretation: 'plain' },
    {
      name: 'priceLevel',
      storage: 'text',
      interpretation: { kind: 'select', options: ['low', 'typical', 'high', 'unknown'] },
    },
    { name: 'typicalLow', storage: 'number', interpretation: 'plain' },
    { name: 'typicalHigh', storage: 'number', interpretation: 'plain' },
    { name: 'stops', storage: 'number', interpretation: 'plain' },
    { name: 'durationMin', storage: 'number', interpretation: 'plain' },
    { name: 'departLocal', storage: 'text', interpretation: 'plain' },
    { name: 'arriveLocal', storage: 'text', interpretation: 'plain' },
    { name: 'airline', storage: 'text', interpretation: 'plain', maxLength: 120 },
    { name: 'bookingUrl', storage: 'text', interpretation: { kind: 'url' }, maxLength: 2000 },
    {
      name: 'status',
      storage: 'text',
      interpretation: { kind: 'select', options: ['ok', 'no_results', 'filtered_out', 'error'] },
    },
    { name: 'fetchedAt', storage: 'text', interpretation: { kind: 'datetime' } },
  ],
  uniqueOn: ['tripId', 'candidateIata', 'travelerId'],
  collaboratorsField: 'memberIds',
  permissions: memberAndAdmin(MEMBERS_READ_ONLY),
}
