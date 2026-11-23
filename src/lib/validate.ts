/**
 * Param validation for server actions. Pure: no storage, no clock (callers
 * pass `today`). Every validator returns `{ ok: true, value }` with a cleaned
 * value or `{ ok: false, error }` with a message safe to show the user.
 */
import { isKnownIata } from './airports'
import { INPUT_LIMITS } from './limits'

export type Valid<T> = { ok: true; value: T } | { ok: false; error: string }

const ok = <T>(value: T): Valid<T> => ({ ok: true, value })
const bad = <T>(error: string): Valid<T> => ({ ok: false, error })

/** Action params must be a plain object (not null, not an array). */
export function asParams(raw: unknown): Record<string, unknown> | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  return raw as Record<string, unknown>
}

// Control characters (C0, DEL, C1) and bidi overrides/isolates, which can
// disguise a name in someone else's UI.
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g

/** Remove control/bidi characters, collapse whitespace, trim. No length rule. */
export function cleanText(value: string): string {
  return value.replace(UNSAFE_CHARS, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Free text: trims, removes control/bidi characters, collapses whitespace.
 * `optional` text may be missing/empty and then becomes ''.
 */
export function text(
  value: unknown,
  field: string,
  opts: { max: number; optional?: boolean },
): Valid<string> {
  if (value === undefined || value === null) {
    return opts.optional ? ok('') : bad(`${field} is required.`)
  }
  if (typeof value !== 'string') return bad(`${field} must be text.`)
  // Line breaks and tabs become spaces ("Sam\nSmith" -> "Sam Smith"); the
  // other control and bidi characters are removed.
  const cleaned = value
    .replace(/[\t\n\v\f\r]/g, ' ')
    .replace(UNSAFE_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return opts.optional ? ok('') : bad(`${field} is required.`)
  if (cleaned.length > opts.max) return bad(`${field} must be at most ${opts.max} characters.`)
  return ok(cleaned)
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

/** A real calendar date written `YYYY-MM-DD`. */
export function isoDate(value: unknown, field: string): Valid<string> {
  if (typeof value !== 'string') return bad(`${field} must be a date (YYYY-MM-DD).`)
  const m = ISO_DATE.exec(value)
  if (!m) return bad(`${field} must be a date (YYYY-MM-DD).`)
  const d = new Date(`${value}T00:00:00Z`)
  if (
    Number.isNaN(d.getTime()) ||
    d.getUTCFullYear() !== Number(m[1]) ||
    d.getUTCMonth() + 1 !== Number(m[2]) ||
    d.getUTCDate() !== Number(m[3])
  ) {
    return bad(`${field} is not a real date.`)
  }
  return ok(value)
}

/** Whole days from `a` to `b` (both valid ISO dates). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000)
}

/**
 * Outbound/return pair: outbound from today (UTC) up to `outboundDaysAheadMax`
 * days ahead, return strictly after outbound and at most `tripDaysMax` days later.
 */
export function tripDates(
  outbound: unknown,
  ret: unknown,
  today: string,
): Valid<{ outboundDate: string; returnDate: string }> {
  const o = isoDate(outbound, 'Outbound date')
  if (!o.ok) return o
  const r = isoDate(ret, 'Return date')
  if (!r.ok) return r
  const ahead = daysBetween(today, o.value)
  if (ahead < 0) return bad('Outbound date is in the past.')
  if (ahead > INPUT_LIMITS.outboundDaysAheadMax) {
    return bad(`Outbound date must be within ${INPUT_LIMITS.outboundDaysAheadMax} days.`)
  }
  const length = daysBetween(o.value, r.value)
  if (length <= 0) return bad('Return date must be after the outbound date.')
  if (length > INPUT_LIMITS.tripDaysMax) {
    return bad(`Trips can be at most ${INPUT_LIMITS.tripDaysMax} days long.`)
  }
  return ok({ outboundDate: o.value, returnDate: r.value })
}

/** A known airport code. Lower case is accepted and upper-cased. */
export function iata(
  value: unknown,
  field: string,
  known: (code: string) => boolean = isKnownIata,
): Valid<string> {
  if (typeof value !== 'string') return bad(`${field} must be an airport code.`)
  const code = value.trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(code)) return bad(`${field} must be a 3-letter airport code.`)
  if (!known(code)) return bad(`${field}: we don't know the airport ${code}.`)
  return ok(code)
}

/** 1..3 distinct known airport codes. */
export function homeAirports(
  value: unknown,
  known: (code: string) => boolean = isKnownIata,
): Valid<string[]> {
  if (!Array.isArray(value)) return bad('Home airports must be a list of airport codes.')
  if (value.length < 1) return bad('Add at least one home airport.')
  if (value.length > INPUT_LIMITS.homeAirportsMax) {
    return bad(`At most ${INPUT_LIMITS.homeAirportsMax} home airports.`)
  }
  const codes: string[] = []
  for (const item of value) {
    const code = iata(item, 'Home airport', known)
    if (!code.ok) return code
    if (codes.includes(code.value)) return bad(`Home airport ${code.value} is listed twice.`)
    codes.push(code.value)
  }
  return ok(codes)
}

function intIn(value: unknown, field: string, min: number, max: number): Valid<number> {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    return bad(`${field} must be a whole number from ${min} to ${max}.`)
  }
  return ok(value)
}

/** 0, 1, or 2 (2 = any number of stops). */
export const maxStops = (value: unknown): Valid<number> => intIn(value, 'Max stops', 0, 2)
/** 0..23 local hour. */
export const departHour = (value: unknown): Valid<number> =>
  intIn(value, 'Earliest departure hour', 0, 23)

/** A 0/1 flag; booleans are accepted and converted. */
export function flag(value: unknown, field: string): Valid<number> {
  if (value === true || value === 1) return ok(1)
  if (value === false || value === 0) return ok(0)
  return bad(`${field} must be true or false.`)
}

/** A record id as the RecordRoom generates them (`<ms>_<base36>`), or similar safe ids. */
export function recordId(value: unknown, field: string): Valid<string> {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
    return bad(`${field} is not a valid id.`)
  }
  return ok(value)
}

/** A ghost traveler id: `ghost:<uuid>`. */
export function ghostId(value: unknown): Valid<string> {
  if (
    typeof value !== 'string' ||
    !/^ghost:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
  ) {
    return bad('Not a valid ghost traveler id.')
  }
  return ok(value)
}

/** Invite codes are generated alphanumeric strings; accept 10..32 chars. */
export function inviteCode(value: unknown): Valid<string> {
  if (typeof value !== 'string') return bad('Invite code is required.')
  const code = value.trim()
  if (!/^[A-Za-z0-9]{10,32}$/.test(code)) return bad('That invite code is not valid.')
  return ok(code)
}
