import type { CollectionSchema } from 'deepspace/schema'
import { memberAndAdmin } from './common'

/**
 * SPEC §5 `budgets` — PRIVATE. Only the owner (and server code) can read a row;
 * admin gets the same `'own'` rules, so even the app owner sees only their own.
 * No `memberIds`. A user may create a row for any `tripId` (only they can see
 * it); server code reads budgets with `where: { tripId }` and ignores userIds
 * that aren't travelers on the trip.
 */
export const budgetsSchema: CollectionSchema = {
  name: 'budgets',
  columns: [
    { name: 'tripId', storage: 'text', interpretation: 'plain', required: true, immutable: true, maxLength: 64 },
    // userBound: the client creating its own budget is always the subject.
    { name: 'userId', storage: 'text', interpretation: 'plain', userBound: true, immutable: true },
    { name: 'maxUsd', storage: 'number', interpretation: { kind: 'currency', symbol: '$', decimals: 0 }, required: true },
  ],
  uniqueOn: ['tripId', 'userId'],
  ownerField: 'userId',
  permissions: memberAndAdmin({
    read: 'own',
    create: true,
    update: 'own',
    delete: 'own',
    writableFields: ['tripId', 'maxUsd'],
  }),
}
