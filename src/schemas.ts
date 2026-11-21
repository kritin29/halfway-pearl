/**
 * Collection Schemas
 *
 * All collections with columns and RBAC permissions.
 * Single source of truth — imported by both worker and frontend.
 *
 * Add schemas by creating a file in src/schemas/ and importing it here.
 */

import type { CollectionSchema } from 'deepspace/schema'
import { usersSchema } from './schemas/users-schema'
import { settingsSchema } from './schemas/admin-schema'
import { tripsSchema } from './schemas/trips-schema'
import { travelersSchema } from './schemas/travelers-schema'
import { budgetsSchema } from './schemas/budgets-schema'
import { candidatesSchema } from './schemas/candidates-schema'
import { faresSchema } from './schemas/fares-schema'
import { votesSchema } from './schemas/votes-schema'
import { fareSnapshotsSchema } from './schemas/fare-snapshots-schema'
import { usageSchema } from './schemas/usage-schema'
import { fareCacheSchema } from './schemas/fare-cache-schema'
import { emailLogSchema } from './schemas/email-log-schema'

export const schemas: CollectionSchema[] = [
  usersSchema,
  settingsSchema,
  tripsSchema,
  travelersSchema,
  budgetsSchema,
  candidatesSchema,
  faresSchema,
  votesSchema,
  fareSnapshotsSchema,
  usageSchema,
  fareCacheSchema,
  emailLogSchema,
]
