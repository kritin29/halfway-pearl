/**
 * In-memory stand-in for the RBAC-off `ActionTools` (unit tests only — never
 * imported by worker code). It mirrors the RecordRoom behaviours our server
 * code depends on, as read from deepspace@0.44.2 `putRecord`:
 * defaults and `userBound` stamping on create, `required`, `immutable`,
 * `uniqueOn` ("Duplicate: …"), create-with-recordId merging into an existing
 * row, update refusing a missing row, and `RECORD_NOT_FOUND` on get.
 */
import { RECORD_NOT_FOUND } from 'deepspace/worker'
import type { ActionResult, ActionTools } from 'deepspace/worker'
import type { CollectionSchema } from 'deepspace/schema'
import { schemas as appSchemas } from '../../schemas'

interface Row {
  recordId: string
  data: Record<string, unknown>
  createdBy: string
  createdAt: string
  updatedAt: string
}

export interface FakeStore {
  toolsFor(actingUserId: string): ActionTools
  rows(collection: string): Row[]
  seed(collection: string, recordId: string, data: Record<string, unknown>, createdBy?: string): void
  /** Every integration call any tools instance made. */
  integrationCalls: Array<{ endpoint: string; data: unknown }>
}

const fail = <T>(error: string): ActionResult<T> => ({ success: false, error })

export function createFakeStore(schemas: CollectionSchema[] = appSchemas): FakeStore {
  const tables = new Map<string, Map<string, Row>>()
  const integrationCalls: FakeStore['integrationCalls'] = []
  let nextId = 1

  const schemaOf = (collection: string) => schemas.find((s) => s.name === collection)
  const table = (collection: string) => {
    let t = tables.get(collection)
    if (!t) tables.set(collection, (t = new Map()))
    return t
  }
  const clone = <T>(v: T): T => structuredClone(v)

  function put(
    collection: string,
    recordId: string,
    data: Record<string, unknown>,
    userId: string,
    updateOnly: boolean,
  ): ActionResult<{ recordId: string }> {
    const schema = schemaOf(collection)
    if (!schema) return fail(`Schema not registered for collection: ${collection}`)
    const t = table(collection)
    const existing = t.get(recordId)
    if (updateOnly && !existing) {
      return fail(`records.update: no record "${recordId}" in ${collection}`)
    }
    const merged = existing ? { ...existing.data, ...clone(data) } : clone(data)
    for (const col of schema.columns) {
      if (!existing) {
        if (col.default !== undefined && merged[col.name] === undefined) merged[col.name] = col.default
        if (col.userBound) merged[col.name] = userId
        if (col.required && (merged[col.name] === undefined || merged[col.name] === null || merged[col.name] === '')) {
          return fail(`Required field '${col.name}' is missing`)
        }
      } else {
        if (col.immutable && data[col.name] !== undefined && data[col.name] !== existing.data[col.name]) {
          return fail(`Cannot modify immutable field '${col.name}'`)
        }
        if (col.userBound && data[col.name] !== undefined) merged[col.name] = existing.data[col.name]
      }
      if (
        col.maxLength !== undefined &&
        typeof merged[col.name] === 'string' &&
        (merged[col.name] as string).length > col.maxLength
      ) {
        return fail(`Field '${col.name}' must be text of at most ${col.maxLength} characters`)
      }
    }
    if (schema.uniqueOn?.length) {
      const key = (d: Record<string, unknown>) => JSON.stringify(schema.uniqueOn!.map((f) => d[f] ?? null))
      for (const row of t.values()) {
        if (row.recordId !== recordId && key(row.data) === key(merged)) {
          const fields = schema.uniqueOn.map((f) => `${f}=${merged[f] ?? 'null'}`).join(', ')
          return fail(`Duplicate: a record with ${fields} already exists in ${collection}`)
        }
      }
    }
    const now = new Date().toISOString()
    t.set(recordId, {
      recordId,
      data: merged,
      createdBy: existing?.createdBy ?? userId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    })
    return { success: true, data: { recordId } }
  }

  const matches = (row: Row, where: Record<string, unknown> = {}) =>
    Object.entries(where).every(([k, v]) =>
      k === 'recordId' ? row.recordId === v : k === 'createdBy' ? row.createdBy === v : row.data[k] === v,
    )

  function toolsFor(actingUserId: string): ActionTools {
    return {
      async create(collection, data, recordId) {
        return put(collection, recordId ?? `${Date.now()}_${(nextId++).toString(36)}`, data, actingUserId, false)
      },
      async update(collection, recordId, data) {
        return put(collection, recordId, data as Record<string, unknown>, actingUserId, true)
      },
      async remove(collection, recordId) {
        if (!table(collection).delete(recordId)) return fail(RECORD_NOT_FOUND)
        return { success: true, data: { recordId } }
      },
      async deleteWhere(collection, where, limit = 100) {
        if (!Object.keys(where).length) return fail('deleteWhere requires a non-empty where')
        const t = table(collection)
        let deleted = 0
        for (const row of [...t.values()]) {
          if (deleted >= limit) break
          if (matches(row, where)) {
            t.delete(row.recordId)
            deleted++
          }
        }
        return { success: true, data: { deleted } }
      },
      async get(collection, recordId) {
        if (!schemaOf(collection)) return fail(`Schema not registered for collection: ${collection}`)
        const row = table(collection).get(recordId)
        if (!row) return fail(RECORD_NOT_FOUND)
        return { success: true, data: { record: clone(row) as never } }
      },
      async query(collection, options = {}) {
        if (!schemaOf(collection)) return fail(`Schema not registered for collection: ${collection}`)
        let records = [...table(collection).values()].filter((r) => matches(r, options.where))
        if (options.limit !== undefined) records = records.slice(0, options.limit)
        return { success: true, data: { records: clone(records) as never, count: records.length } }
      },
      async integration(endpoint, data) {
        integrationCalls.push({ endpoint, data })
        return fail('integrations are not available in unit tests')
      },
      async registerUser() {
        return fail('registerUser is not available in unit tests')
      },
    }
  }

  return {
    toolsFor,
    rows: (collection) => clone([...table(collection).values()]),
    seed(collection, recordId, data, createdBy = 'seed') {
      const now = new Date().toISOString()
      table(collection).set(recordId, { recordId, data: clone(data), createdBy, createdAt: now, updatedAt: now })
    },
    integrationCalls,
  }
}
