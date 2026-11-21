import type { CollectionSchema } from 'deepspace/schema'
import { NONE } from './common'

/**
 * SPEC §5 `usage`: the server-only spend ledger. Every role, admin included,
 * is refused everything; server tools bypass RBAC (`X-App-Action`). Rows are
 * upserted with `recordId = usageRecordId(day, key)` (src/lib/caps.ts).
 */
export const usageSchema: CollectionSchema = {
  name: 'usage',
  columns: [
    { name: 'day', storage: 'text', interpretation: { kind: 'date' }, required: true },
    { name: 'key', storage: 'text', interpretation: 'plain', required: true, maxLength: 200 },
    { name: 'count', storage: 'number', interpretation: 'plain', default: 0 },
  ],
  uniqueOn: ['day', 'key'],
  permissions: { '*': NONE, viewer: NONE, member: NONE, admin: NONE },
}
