/** Display formatting shared by the trip screens. Pure. */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Dec 11" from "2026-12-11" (read as a calendar date, so no timezone shift). */
export function shortDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return iso
  return `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${Number(m[3])}`
}

/** "Dec 11 – 13, 2026", "Dec 30, 2026 – Jan 2, 2027", "Nov 28 – Dec 2, 2026". */
export function dateRange(outbound: string, ret: string): string {
  const a = /^(\d{4})-(\d{2})-(\d{2})$/.exec(outbound)
  const b = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ret)
  if (!a || !b) return `${outbound} – ${ret}`
  if (a[1] !== b[1]) return `${shortDate(outbound)}, ${a[1]} – ${shortDate(ret)}, ${b[1]}`
  if (a[2] === b[2]) return `${shortDate(outbound)} – ${Number(b[3])}, ${a[1]}`
  return `${shortDate(outbound)} – ${shortDate(ret)}, ${a[1]}`
}

/** "12 AM", "6 AM", "12 PM", "9 PM" for an hour 0..23. */
export function hourLabel(hour: number): string {
  const h = ((hour % 24) + 24) % 24
  const suffix = h < 12 ? 'AM' : 'PM'
  const twelve = h % 12 === 0 ? 12 : h % 12
  return `${twelve} ${suffix}`
}

/** Today's date as YYYY-MM-DD in the browser's local timezone (for date inputs). */
export function localToday(now: Date = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}
