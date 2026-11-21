/**
 * Permission matrix for every Halfway collection (SPEC §5, NOTES §3), checked
 * with the SDK's own runtime predicates — the same ones the RecordRoom uses
 * before it sends a row over the socket or accepts a client write.
 */
import { describe, expect, it } from 'vitest'
import {
  canCreate,
  canDelete,
  canRead,
  canUpdate,
  checkFieldPermissions,
  lintSchemas,
} from 'deepspace/worker'
import type { CollectionSchema } from 'deepspace/schema'
import { schemas } from '../schemas'
import { budgetsSchema } from './budgets-schema'
import { candidatesSchema } from './candidates-schema'
import { fareSnapshotsSchema } from './fare-snapshots-schema'
import { faresSchema } from './fares-schema'
import { travelersSchema, TRAVELER_WRITABLE_FIELDS } from './travelers-schema'
import { tripsSchema } from './trips-schema'
import { usageSchema } from './usage-schema'
import { fareCacheSchema } from './fare-cache-schema'
import { emailLogSchema } from './email-log-schema'
import { usersSchema } from './users-schema'
import { votesSchema } from './votes-schema'

const ALICE = 'user_alice'
const BOB = 'user_bob'
const OUTSIDER = 'user_mallory'
const ROLES = ['*', 'viewer', 'member', 'admin'] as const

const rec = (data: Record<string, unknown>, createdBy = ALICE) => ({ data, createdBy })

function readableBy(schema: CollectionSchema, record: ReturnType<typeof rec>, userId: string) {
  return Object.fromEntries(ROLES.map((role) => [role, canRead(schema, role, record, userId)]))
}

describe('schema set', () => {
  it('registers every SPEC §5 collection', () => {
    expect(schemas.map((s) => s.name).sort()).toEqual(
      [
        'budgets',
        'candidates',
        'emailLog',
        'fareCache',
        'fareSnapshots',
        'fares',
        'settings',
        'travelers',
        'trips',
        'usage',
        'users',
        'votes',
      ].sort(),
    )
  })

  it('lintSchemas reports no warnings', () => {
    expect(lintSchemas(schemas)).toEqual([])
  })

  it('control: lintSchemas does warn when a client can create travelers without userBound', () => {
    const bad: CollectionSchema = {
      ...travelersSchema,
      permissions: { ...travelersSchema.permissions, member: { ...travelersSchema.permissions.member, create: true } },
    }
    expect(lintSchemas([bad]).length).toBeGreaterThan(0)
  })

  it('users roster only lists rows the caller may read', () => {
    expect(usersSchema.roster).toBe('read-policy')
    expect(usersSchema.permissions.member.read).toBe('own')
  })
})

describe('budgets (PRIVATE)', () => {
  const aliceBudget = rec({ tripId: 't1', userId: ALICE, maxUsd: 300 })

  it('only the owner can read, admin included', () => {
    expect(readableBy(budgetsSchema, aliceBudget, ALICE)).toEqual({
      '*': false,
      viewer: false,
      member: true,
      admin: true,
    })
    // Bob shares the trip, but budgets have no memberIds: nobody else reads it.
    expect(readableBy(budgetsSchema, aliceBudget, BOB)).toEqual({
      '*': false,
      viewer: false,
      member: false,
      admin: false,
    })
  })

  it('ownership is the userBound userId, not createdBy', () => {
    // A row Bob somehow created but stamped for Alice belongs to Alice.
    const row = rec({ tripId: 't1', userId: ALICE, maxUsd: 300 }, BOB)
    expect(canRead(budgetsSchema, 'member', row, BOB)).toBe(false)
    expect(canRead(budgetsSchema, 'member', row, ALICE)).toBe(true)
  })

  it('only the owner can update or delete', () => {
    for (const role of ['member', 'admin']) {
      expect(canUpdate(budgetsSchema, role, aliceBudget, ALICE)).toBe(true)
      expect(canDelete(budgetsSchema, role, aliceBudget, ALICE)).toBe(true)
      expect(canUpdate(budgetsSchema, role, aliceBudget, BOB)).toBe(false)
      expect(canDelete(budgetsSchema, role, aliceBudget, BOB)).toBe(false)
    }
    expect(canUpdate(budgetsSchema, 'viewer', aliceBudget, ALICE)).toBe(false)
  })

  it('signed-in members create their own; viewers and anonymous cannot', () => {
    expect(canCreate(budgetsSchema, 'member')).toBe(true)
    expect(canCreate(budgetsSchema, 'admin')).toBe(true)
    expect(canCreate(budgetsSchema, 'viewer')).toBe(false)
    expect(canCreate(budgetsSchema, '*')).toBe(false)
  })

  it('clients may write only tripId and maxUsd (userId is stamped by the room)', () => {
    expect(checkFieldPermissions(budgetsSchema, 'member', { tripId: 't1', maxUsd: 250 })).toBeNull()
    expect(checkFieldPermissions(budgetsSchema, 'member', { userId: BOB, maxUsd: 250 })).not.toBeNull()
    const userId = budgetsSchema.columns.find((c) => c.name === 'userId')
    expect(userId).toMatchObject({ userBound: true, immutable: true })
  })
})

describe('usage (server-only ledger)', () => {
  const row = rec({ day: '2026-11-20', key: 'serpapi:global', count: 3 })

  it('is unreadable and unwritable by every role, admin included', () => {
    for (const role of [...ROLES, 'some-new-role']) {
      for (const userId of [ALICE, OUTSIDER]) {
        expect(canRead(usageSchema, role, row, userId), `${role} read`).toBe(false)
        expect(canUpdate(usageSchema, role, row, userId), `${role} update`).toBe(false)
        expect(canDelete(usageSchema, role, row, userId), `${role} delete`).toBe(false)
      }
      expect(canCreate(usageSchema, role), `${role} create`).toBe(false)
    }
  })

  it('lists all four roles explicitly', () => {
    expect(Object.keys(usageSchema.permissions).sort()).toEqual(['*', 'admin', 'member', 'viewer'])
    expect(usageSchema.uniqueOn).toEqual(['day', 'key'])
  })
})

describe('fareCache (server-only, written by the fare-search job)', () => {
  const row = rec({ key: 'ORD|BNA|2026-12-11|2026-12-13', itineraries: [], fetchedAt: '2026-11-21T00:00:00Z' })

  it('is unreadable and unwritable by every role, admin included', () => {
    for (const role of [...ROLES, 'some-new-role']) {
      for (const userId of [ALICE, OUTSIDER]) {
        expect(canRead(fareCacheSchema, role, row, userId), `${role} read`).toBe(false)
        expect(canUpdate(fareCacheSchema, role, row, userId), `${role} update`).toBe(false)
        expect(canDelete(fareCacheSchema, role, row, userId), `${role} delete`).toBe(false)
      }
      expect(canCreate(fareCacheSchema, role), `${role} create`).toBe(false)
    }
    expect(Object.keys(fareCacheSchema.permissions).sort()).toEqual(['*', 'admin', 'member', 'viewer'])
    expect(fareCacheSchema.uniqueOn).toEqual(['key'])
  })
})

describe('emailLog (server-only, written by lockTrip / the watch job)', () => {
  const row = rec({ key: 'lock|t1|BNA|' + ALICE, kind: 'lock', tripId: 't1', userId: ALICE, status: 'sent' })

  it('is unreadable and unwritable by every role, admin included, even for the recipient', () => {
    for (const role of [...ROLES, 'some-new-role']) {
      for (const userId of [ALICE, OUTSIDER]) {
        expect(canRead(emailLogSchema, role, row, userId), `${role} read`).toBe(false)
        expect(canUpdate(emailLogSchema, role, row, userId), `${role} update`).toBe(false)
        expect(canDelete(emailLogSchema, role, row, userId), `${role} delete`).toBe(false)
      }
      expect(canCreate(emailLogSchema, role), `${role} create`).toBe(false)
    }
    expect(Object.keys(emailLogSchema.permissions).sort()).toEqual(['*', 'admin', 'member', 'viewer'])
    expect(emailLogSchema.uniqueOn).toEqual(['key'])
  })

  it('stores no address or name column', () => {
    const names = emailLogSchema.columns.map((c) => c.name)
    expect(names).not.toContain('email')
    expect(names).not.toContain('to')
    expect(names).not.toContain('displayName')
  })
})

describe('trip-scoped collections', () => {
  const tripScoped: Array<[CollectionSchema, Record<string, unknown>]> = [
    [tripsSchema, { name: 'Trip', organizerId: ALICE, memberIds: [ALICE, BOB], inviteCode: 'abcdefghij' }],
    [travelersSchema, { tripId: 't1', memberIds: [ALICE, BOB], userId: ALICE }],
    [candidatesSchema, { tripId: 't1', memberIds: [ALICE, BOB], iata: 'BNA' }],
    [faresSchema, { tripId: 't1', memberIds: [ALICE, BOB], candidateIata: 'BNA', travelerId: ALICE }],
    [votesSchema, { tripId: 't1', memberIds: [ALICE, BOB], userId: ALICE, candidateIata: 'BNA' }],
    [fareSnapshotsSchema, { tripId: 't1', memberIds: [ALICE, BOB], candidateIata: 'BNA' }],
  ]

  for (const [schema, data] of tripScoped) {
    describe(schema.name, () => {
      it('admin has exactly the member rules; viewer has none', () => {
        expect(schema.permissions.admin).toEqual(schema.permissions.member)
        expect(schema.permissions.viewer).toEqual({
          read: false,
          create: false,
          update: false,
          delete: false,
        })
      })

      it('members read, outsiders (admin included) do not', () => {
        const row = rec(data)
        for (const userId of [ALICE, BOB]) {
          expect(canRead(schema, 'member', row, userId)).toBe(true)
          expect(canRead(schema, 'admin', row, userId)).toBe(true)
        }
        expect(readableBy(schema, row, OUTSIDER)).toEqual({
          '*': false,
          viewer: false,
          member: false,
          admin: false,
        })
      })

      it('memberIds is also accepted as a JSON string', () => {
        const row = rec({ ...data, memberIds: JSON.stringify([ALICE, BOB]) }, OUTSIDER)
        expect(canRead(schema, 'member', row, BOB)).toBe(true)
      })

      it('no client role can create', () => {
        for (const role of ROLES) expect(canCreate(schema, role)).toBe(false)
      })
    })
  }

  for (const schema of [tripsSchema, candidatesSchema, faresSchema, votesSchema, fareSnapshotsSchema]) {
    it(`${schema.name}: no client role can update or delete, even its owner`, () => {
      const row = rec({ tripId: 't1', organizerId: ALICE, userId: ALICE, memberIds: [ALICE] })
      for (const role of ROLES) {
        expect(canUpdate(schema, role, row, ALICE)).toBe(false)
        expect(canDelete(schema, role, row, ALICE)).toBe(false)
      }
    })
  }
})

describe('travelers', () => {
  const aliceRow = rec({ tripId: 't1', memberIds: [ALICE, BOB], userId: ALICE }, ALICE)
  // Ghost rows are created by the organizer's action, so createdBy is the organizer.
  const ghostRow = rec(
    { tripId: 't1', memberIds: [ALICE, BOB], userId: 'ghost:0f8fad5b-d9cb-469f-a165-70867728950e', isGhost: 1 },
    ALICE,
  )

  it('a traveler updates only their own row', () => {
    expect(canUpdate(travelersSchema, 'member', aliceRow, ALICE)).toBe(true)
    expect(canUpdate(travelersSchema, 'member', aliceRow, BOB)).toBe(false)
    expect(canUpdate(travelersSchema, 'admin', aliceRow, BOB)).toBe(false)
  })

  it('nobody updates a ghost row from the client, not even the organizer who created it', () => {
    for (const role of ROLES) {
      expect(canUpdate(travelersSchema, role, ghostRow, ALICE)).toBe(false)
    }
  })

  it('nobody deletes traveler rows from the client', () => {
    for (const role of ROLES) expect(canDelete(travelersSchema, role, aliceRow, ALICE)).toBe(false)
  })

  it('only constraint columns are client-writable', () => {
    expect(
      checkFieldPermissions(travelersSchema, 'member', { homeAirports: ['ORD'], maxStops: 1, booked: 1 }),
    ).toBeNull()
    for (const field of ['userId', 'memberIds', 'tripId', 'isGhost', 'displayName']) {
      expect(checkFieldPermissions(travelersSchema, 'member', { [field]: 'x' }), field).not.toBeNull()
    }
    expect(TRAVELER_WRITABLE_FIELDS).not.toContain('userId')
  })

  it('userId is not userBound (ghost ids would be overwritten), but is immutable', () => {
    const userId = travelersSchema.columns.find((c) => c.name === 'userId')
    expect(userId?.userBound).toBeFalsy()
    expect(userId).toMatchObject({ immutable: true, required: true })
    expect(travelersSchema.uniqueOn).toEqual(['tripId', 'userId'])
  })
})
