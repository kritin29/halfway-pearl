import type { CollectionSchema } from 'deepspace/schema'
import { INPUT_LIMITS } from '../lib/limits'
import { FLAG_COLUMN, TRIP_SCOPE_COLUMNS, memberAndAdmin } from './common'

/**
 * SPEC §5 `travelers`: public per-person constraints.
 *
 * `userId` is NOT userBound (NOTES C1/§6): the runtime would stamp the acting
 * organizer's id onto ghost rows. It is set explicitly by actions (caller id,
 * or `ghost:<uuid>`), immutable, and not in `writableFields`. No client role
 * can create rows, so nobody can claim someone else's id.
 *
 * Clients may update only their own row (`update: 'own'` → `userId === caller`,
 * which never matches a ghost id), and only the constraint columns. Those
 * values are NOT validated by the room: server code must re-validate them
 * before use (e.g. the fare-search job).
 */
export const TRAVELER_WRITABLE_FIELDS = [
  'homeAirports',
  'maxStops',
  'noRedeye',
  'earliestDepartHour',
  'hasBudget',
  'booked',
]

export const travelersSchema: CollectionSchema = {
  name: 'travelers',
  columns: [
    ...TRIP_SCOPE_COLUMNS,
    { name: 'userId', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    FLAG_COLUMN('isGhost'),
    {
      name: 'displayName',
      storage: 'text',
      interpretation: 'plain',
      required: true,
      maxLength: INPUT_LIMITS.displayNameMax,
    },
    { name: 'homeAirports', storage: 'text', interpretation: { kind: 'json' } },
    { name: 'maxStops', storage: 'number', interpretation: 'plain', default: 2 },
    FLAG_COLUMN('noRedeye'),
    { name: 'earliestDepartHour', storage: 'number', interpretation: 'plain', default: 0 },
    FLAG_COLUMN('hasBudget'),
    FLAG_COLUMN('booked'),
  ],
  uniqueOn: ['tripId', 'userId'],
  ownerField: 'userId',
  collaboratorsField: 'memberIds',
  permissions: memberAndAdmin({
    read: 'collaborator',
    create: false,
    update: 'own',
    delete: false,
    writableFields: TRAVELER_WRITABLE_FIELDS,
  }),
}
