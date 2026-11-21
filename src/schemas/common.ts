/**
 * Shared pieces of the trip-scoped schemas (SPEC §5).
 *
 * Roles: the app owner is always `admin`, and a role missing from a
 * permissions block falls back to `'*'`, then to all-false. So every
 * trip-scoped collection gives `admin` exactly the `member` rules, and
 * `viewer` (and `'*'` by fallback) gets nothing. Server code bypasses RBAC.
 */
import type { ColumnDefinition, RolePermissions } from 'deepspace/schema'

/** All four operations refused. */
export const NONE: RolePermissions = { read: false, create: false, update: false, delete: false }

/** Readable by trip members (`memberIds`) and the row's owner; written only by server code. */
export const MEMBERS_READ_ONLY: RolePermissions = {
  read: 'collaborator',
  create: false,
  update: false,
  delete: false,
}

/** `member` and `admin` get the same rules; `viewer` gets none. */
export function memberAndAdmin(rules: RolePermissions): Record<string, RolePermissions> {
  return { viewer: NONE, member: rules, admin: rules }
}

/** `tripId` + `memberIds` (the collaborators list, a JSON array of user ids; ghosts never in it). */
export const TRIP_SCOPE_COLUMNS: ColumnDefinition[] = [
  { name: 'tripId', storage: 'text', interpretation: 'plain', required: true, immutable: true },
  { name: 'memberIds', storage: 'text', interpretation: { kind: 'json' } },
]

export const IATA_COLUMN = (name: string, required = true): ColumnDefinition => ({
  name,
  storage: 'text',
  interpretation: 'plain',
  maxLength: 3,
  required,
})

export const FLAG_COLUMN = (name: string, defaultValue: 0 | 1 = 0): ColumnDefinition => ({
  name,
  storage: 'number',
  interpretation: { kind: 'boolean' },
  default: defaultValue,
})
