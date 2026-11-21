/**
 * Email templates (SPEC §3.8, §6 lockTrip). Pure, unit-tested.
 *
 * Privacy by construction: the builders take ONE recipient and that
 * recipient's own fare. There is no budget parameter and no list of other
 * people, so a message can't carry anyone's budget or another member's
 * address. Each message has exactly one `to` and no cc/bcc/reply_to.
 *
 * The platform ignores `from` (mail comes from DeepSpace Apps
 * <notifications@updates.app.space>, NOTES C5), so "Halfway" goes in the
 * subject and the body.
 *
 * Everything user-written (trip name, display names) is stripped of control
 * characters and HTML-escaped before it goes into the HTML part.
 */
import { googleFlightsUrl, normalizeHomes } from './flights'
import { dateRange, shortDate } from './format'
import { formatDuration } from './ranking'
import { clockTime, safeBookingUrl, stopsLabel, usd, type FareRow } from './results'

export const BRAND = 'Halfway'

export interface EmailMessage {
  to: string
  subject: string
  html: string
  text: string
}

export interface LockEmailInput {
  /** `https://<app>.app.space`, no trailing slash. */
  appUrl: string
  tripId: string
  tripName: string
  outboundDate: string
  returnDate: string
  destination: { iata: string; city: string; country: string }
  organizerName: string
  recipient: { displayName: string; email: string; homeAirports: readonly string[] }
  /** The recipient's own fare row for the locked destination, or null if there is none. */
  fare: FareRow | null
}

/** `https://halfway-pearl.app.space` from the worker's APP_NAME. */
export function appUrlFor(appName: string): string {
  return `https://${appName}.app.space`
}

export function tripUrl(appUrl: string, tripId: string): string {
  return `${appUrl.replace(/\/+$/, '')}/t/${encodeURIComponent(tripId)}`
}

/** Dedupe key for one lock email (one per trip, destination and recipient). */
export function lockEmailKey(tripId: string, iata: string, userId: string): string {
  return `lock|${tripId}|${iata}|${userId}`
}

/** A single plain address: no spaces, commas, angle brackets or line breaks. */
export function isEmailAddress(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 254 &&
    /^[^\s@<>,;"'()[\]\\]+@[^\s@<>,;"'()[\]\\]+\.[^\s@<>,;"'()[\]\\]+$/.test(value)
  )
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** User text on one line: control and bidi characters removed, whitespace collapsed, cut to `max`. */
export function oneLine(value: string, max = 80): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, ' ')
  const collapsed = cleaned.replace(/\s+/g, ' ').trim()
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed
}

/** What the recipient's own flight section says, as plain lines plus a link. */
export interface FareSummary {
  kind: 'flight' | 'home' | 'missing'
  headline: string
  details: string[]
  link: { label: string; url: string } | null
}

export function summarizeFare(input: LockEmailInput): FareSummary {
  const { fare, destination, recipient, outboundDate, returnDate } = input
  const iata = destination.iata

  if (fare && fare.status === 'ok' && fare.price === 0 && fare.originIata === iata) {
    return {
      kind: 'home',
      headline: `You live in ${destination.city}, so there’s no flight to book.`,
      details: [],
      link: null,
    }
  }

  if (fare && fare.status === 'ok' && typeof fare.price === 'number' && fare.price > 0) {
    const origin = fare.originIata ?? normalizeHomes(recipient.homeAirports).join('/')
    const dep = clockTime(fare.departLocal)
    const arr = clockTime(fare.arriveLocal)
    const details = [
      stopsLabel(typeof fare.stops === 'number' ? fare.stops : null),
      dep && arr ? `Departs ${dep}, arrives ${arr} (${shortDate(outboundDate)})` : null,
      typeof fare.durationMin === 'number' && fare.durationMin > 0 ? formatDuration(fare.durationMin) : null,
      fare.airline ? oneLine(fare.airline, 60) : null,
    ].filter((d): d is string => Boolean(d))
    const url =
      safeBookingUrl(fare.bookingUrl) ??
      googleFlightsUrl({ homeAirports: fare.originIata ? [fare.originIata] : recipient.homeAirports, candidateIata: iata, outboundDate, returnDate })
    return {
      kind: 'flight',
      headline: `${usd(fare.price)} round trip from ${origin} to ${iata}`,
      details,
      link: { label: 'Book your flight on Google Flights', url },
    }
  }

  const homes = normalizeHomes(recipient.homeAirports)
  return {
    kind: 'missing',
    headline: 'Halfway doesn’t have a saved fare for you to this destination.',
    details: [],
    link: homes.length
      ? {
          label: 'Search flights on Google Flights',
          url: googleFlightsUrl({ homeAirports: homes, candidateIata: iata, outboundDate, returnDate }),
        }
      : null,
  }
}

/**
 * "Your trip is locked" email for one real member: where, when, their own
 * fare (origin, stops, times) and their own booking link.
 */
export function buildLockEmail(input: LockEmailInput): EmailMessage {
  if (!isEmailAddress(input.recipient.email)) throw new Error('buildLockEmail: invalid recipient address')
  const tripName = oneLine(input.tripName, 80) || 'your trip'
  const name = oneLine(input.recipient.displayName, 40) || 'there'
  const organizer = oneLine(input.organizerName, 40) || 'The organizer'
  const city = oneLine(input.destination.city, 60) || input.destination.iata
  const place = `${city} (${input.destination.iata})`
  const when = dateRange(input.outboundDate, input.returnDate)
  const fare = summarizeFare(input)
  const tripLink = tripUrl(input.appUrl, input.tripId)

  const subject = oneLine(`${BRAND}: ${tripName} is going to ${city}`, 120)

  const text = [
    `Hi ${name},`,
    '',
    `${organizer} locked the destination for ${tripName}: you’re meeting in ${place}, ${when}.`,
    '',
    'Your flight',
    fare.headline,
    ...fare.details.map((d) => `- ${d}`),
    ...(fare.link ? [`${fare.link.label}: ${fare.link.url}`] : []),
    ...(fare.kind === 'flight' ? ['Prices change quickly. This is the fare Halfway found on its last check.'] : []),
    '',
    `Once you’ve booked, mark yourself booked in ${BRAND} so the group knows:`,
    tripLink,
    '',
    `— ${BRAND}`,
    `You’re getting this because you’re on ${tripName} in ${BRAND}.`,
  ].join('\n')

  const p = (inner: string, style = '') => `<p style="margin:0 0 12px;${style}">${inner}</p>`
  const link = (label: string, url: string) =>
    `<a href="${escapeHtml(url)}" style="color:#2563eb">${escapeHtml(label)}</a>`
  const html = [
    '<!doctype html><html><body style="margin:0;padding:24px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827;line-height:1.5">',
    `<div style="max-width:520px;margin:0 auto">`,
    p(`<strong style="font-size:18px">${BRAND}</strong>`),
    p(`Hi ${escapeHtml(name)},`),
    p(
      `${escapeHtml(organizer)} locked the destination for <strong>${escapeHtml(tripName)}</strong>: you’re meeting in <strong>${escapeHtml(place)}</strong>, ${escapeHtml(when)}.`,
    ),
    `<div style="border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin:0 0 12px">`,
    p('<strong>Your flight</strong>', 'margin-bottom:4px'),
    p(escapeHtml(fare.headline), fare.details.length ? 'margin-bottom:4px' : ''),
    fare.details.length
      ? `<ul style="margin:0 0 12px;padding-left:20px;color:#4b5563">${fare.details.map((d) => `<li>${escapeHtml(d)}</li>`).join('')}</ul>`
      : '',
    fare.link ? p(link(fare.link.label, fare.link.url), 'margin-bottom:0') : '',
    '</div>',
    fare.kind === 'flight'
      ? p('Prices change quickly. This is the fare Halfway found on its last check.', 'color:#6b7280;font-size:13px')
      : '',
    p(`Once you’ve booked, ${link(`mark yourself booked in ${BRAND}`, tripLink)} so the group knows.`),
    p(`— ${BRAND}<br>You’re getting this because you’re on ${escapeHtml(tripName)} in ${BRAND}.`, 'color:#6b7280;font-size:13px'),
    '</div></body></html>',
  ].join('')

  return { to: input.recipient.email, subject, html, text }
}

/** The exact `email/send` body: one recipient, no cc/bcc/reply_to/from (SPEC §4, NOTES C5). */
export function emailSendBody(message: EmailMessage): { to: string; subject: string; html: string; text: string } {
  return { to: message.to, subject: message.subject, html: message.html, text: message.text }
}
