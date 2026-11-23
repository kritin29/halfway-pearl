/**
 * Book tab (SPEC §3.8, §3.9, §10): the locked destination, the viewer's own
 * fare and booking link, a live group checklist, and the fare watch. Before
 * a lock (status results) it shows only the fare watch for the top of the
 * shortlist.
 *
 * Who can tick what: each member writes `booked` on their OWN travelers row
 * (writableFields, `update: 'own'`); ghost rows can only be changed by the
 * organizer, through the `updateGhost` action. Everyone sees every change
 * live.
 */
import { useState } from 'react'
import { useMutations, useQuery, type RecordData } from 'deepspace'
import { CalendarDays, Check, ExternalLink, Home, LockKeyhole, Mail, PartyPopper, PlaneTakeoff, Users } from 'lucide-react'
import { Badge, Button, buttonVariants, cn, useToast } from '@/components/ui'
import { EmptyNote, ErrorState, LoadingState, Retryable } from '@/components/AsyncState'
import { useAction } from '@/hooks/useAction'
import { googleFlightsUrl, normalizeHomes } from '@/lib/flights'
import { dateRange } from '@/lib/format'
import { formatDuration } from '@/lib/ranking'
import { clockTime, safeBookingUrl, stopsLabel, usd, type FareRow } from '@/lib/results'
import { isGhostId, type CandidateData, type TravelerData, type TripData } from '@/lib/types'
import { DEMO_EMAILS_OFF, isDemoTrip } from '@/lib/demo'
import { DemoLabel } from './DemoLabel'
import { FareWatch } from './FareWatch'
import { PersonAvatar } from './PersonAvatar'

interface LockReport {
  emails: {
    sent: number
    alreadySent: number
    noEmail: number
    capped: number
    failed: number
    mocked: boolean
    /** Demo trip: nothing was sent (SPEC §14). Absent in older responses. */
    emailsOff?: boolean
  } | null
}

/** One sentence for the organizer after a lock or a resend. */
export function emailReportText(emails: LockReport['emails']): string {
  if (!emails) return 'The booking emails couldn’t be sent. Try “Email booking links again” in a minute.'
  if (emails.emailsOff) return `${DEMO_EMAILS_OFF} Everyone’s booking link is on the Book tab.`
  const parts: string[] = []
  if (emails.sent > 0) parts.push(`Booking emails sent to ${emails.sent} ${emails.sent === 1 ? 'traveler' : 'travelers'}.`)
  else if (emails.alreadySent > 0 && emails.failed + emails.capped + emails.noEmail === 0) parts.push('Everyone already has their booking email.')
  if (emails.failed + emails.capped > 0) {
    parts.push(`${emails.failed + emails.capped} couldn’t be sent right now; try “Email booking links again” later.`)
  }
  if (emails.noEmail > 0) parts.push(`${emails.noEmail} ${emails.noEmail === 1 ? 'traveler has' : 'travelers have'} no email address on their account.`)
  return parts.join(' ') || 'No booking emails to send.'
}

export function BookTab({ trip, me }: { trip: RecordData<TripData>; me: string }) {
  return <Retryable>{(retry) => <BookContent trip={trip} me={me} onRetry={retry} />}</Retryable>
}

function BookContent({ trip, me, onRetry }: { trip: RecordData<TripData>; me: string; onRetry: () => void }) {
  const tripId = trip.recordId
  const iata = trip.data.lockedIata ?? ''
  const travelers = useQuery<TravelerData>('travelers', { where: { tripId }, limit: 20 })
  const candidates = useQuery<CandidateData>('candidates', { where: { tripId, iata }, limit: 1 })
  const fares = useQuery<FareRow>('fares', { where: { tripId, candidateIata: iata }, limit: 20 })

  if (trip.data.status !== 'locked' || !iata) {
    return (
      <div className="flex flex-col gap-4" data-testid="book">
        <EmptyNote title="No destination locked yet">
          When the organizer locks a destination on the Results tab, everyone books here.
        </EmptyNote>
        {trip.data.status === 'results' && <FareWatch trip={trip} me={me} />}
      </div>
    )
  }
  const all = [travelers, candidates, fares]
  if (all.some((q) => q.status === 'loading')) return <LoadingState label="Loading booking…" />
  const failed = all.find((q) => q.status === 'error')
  if (failed) return <ErrorState title="Could not load booking" message={failed.error} onRetry={onRetry} />

  const destination = candidates.records[0]?.data
  const city = destination?.city ?? iata
  const rows = [...travelers.records].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const mine = rows.find((r) => r.data.userId === me)
  const myFare = fares.records.find((f) => f.data.travelerId === me)?.data ?? null
  const isOrganizer = trip.data.organizerId === me
  const demo = isDemoTrip(trip.data)

  return (
    <div className="flex flex-col gap-4" data-testid="book">
      <section
        className="relative isolate overflow-hidden rounded-2xl bg-gradient-to-br from-[#06513a] via-success to-info p-5 text-white shadow-[0_18px_40px_-20px_rgba(6,81,58,0.8)] sm:p-6"
        data-testid="locked-destination"
        data-iata={iata}
      >
        {demo && <DemoLabel className="mb-3 flex" />}
        <p className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-white/85">
          <LockKeyhole className="h-3.5 w-3.5" aria-hidden /> Locked · You’re all going to
        </p>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div className="min-w-0">
            <h2 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">{city}</h2>
            {destination?.country && <p className="text-sm text-white/85">{destination.country}</p>}
          </div>
          <span className="font-mono text-5xl font-bold leading-none tracking-tight text-white/90 sm:text-6xl" aria-hidden>
            {iata}
          </span>
          <span className="sr-only">{iata}</span>
        </div>
        <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1 border-t border-dashed border-white/35 pt-3 text-sm text-white/90">
          <span className="inline-flex items-center gap-1.5">
            <CalendarDays className="h-4 w-4" aria-hidden />
            {dateRange(trip.data.outboundDate, trip.data.returnDate)}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Users className="h-4 w-4" aria-hidden />
            {rows.length} {rows.length === 1 ? 'traveler' : 'travelers'}
          </span>
        </div>
      </section>

      {mine && (
        <YourFlight
          fare={myFare}
          iata={iata}
          city={city}
          homeAirports={Array.isArray(mine.data.homeAirports) ? mine.data.homeAirports : []}
          outboundDate={trip.data.outboundDate}
          returnDate={trip.data.returnDate}
          demo={demo}
        />
      )}

      <Checklist tripId={tripId} rows={rows} me={me} isOrganizer={isOrganizer} demo={demo} />

      <FareWatch trip={trip} me={me} />

      {isOrganizer && <OrganizerTools trip={trip} iata={iata} demo={demo} />}
    </div>
  )
}

function YourFlight({
  fare,
  iata,
  city,
  homeAirports,
  outboundDate,
  returnDate,
  demo,
}: {
  fare: FareRow | null
  iata: string
  city: string
  homeAirports: string[]
  outboundDate: string
  returnDate: string
  demo: boolean
}) {
  const home = fare?.status === 'ok' && fare.price === 0 && fare.originIata === iata
  const hasFare = fare?.status === 'ok' && typeof fare.price === 'number' && fare.price > 0
  const homes = normalizeHomes(homeAirports)
  const url = hasFare
    ? (safeBookingUrl(fare.bookingUrl) ??
      googleFlightsUrl({ homeAirports: fare.originIata ? [fare.originIata] : homes, candidateIata: iata, outboundDate, returnDate }))
    : homes.length
      ? googleFlightsUrl({ homeAirports: homes, candidateIata: iata, outboundDate, returnDate })
      : null
  const dep = clockTime(fare?.departLocal)
  const arr = clockTime(fare?.arriveLocal)
  const stops = typeof fare?.stops === 'number' ? fare.stops : null

  return (
    <section className="surface p-4 sm:p-5" data-testid="your-flight">
      {demo && <DemoLabel className="mb-3" />}
      <h2 className="flex items-center gap-2 text-base font-semibold">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent text-accent-foreground">
          <PlaneTakeoff className="h-4 w-4" aria-hidden />
        </span>
        Your flight
      </h2>
      {home ? (
        <p className="mt-2 inline-flex items-center gap-1.5 text-sm text-muted-foreground">
          <Home className="h-4 w-4" aria-hidden /> You live in {city}, so there’s no flight to book.
        </p>
      ) : hasFare ? (
        <>
          <p className="mt-3 font-display text-3xl font-bold tabular-nums" data-testid="your-fare">
            {usd(fare.price ?? null)} <span className="text-sm font-normal text-muted-foreground">round trip</span>
          </p>
          <p className="mt-0.5 break-words text-sm text-muted-foreground">
            {[
              fare.originIata && `From ${fare.originIata}`,
              stopsLabel(stops),
              dep && arr && `${dep} → ${arr}`,
              typeof fare.durationMin === 'number' && fare.durationMin > 0 ? formatDuration(fare.durationMin) : null,
              fare.airline,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">Prices change quickly; this is the fare from the last check.</p>
        </>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">There’s no saved fare for you to {city}.</p>
      )}
      {url && (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(buttonVariants({ size: 'lg' }), 'mt-4 w-full sm:w-auto')}
          data-testid="your-booking-link"
        >
          {hasFare ? 'Book on Google Flights' : 'Search Google Flights'} <ExternalLink className="h-4 w-4" aria-hidden />
        </a>
      )}
    </section>
  )
}

function Checklist({
  tripId,
  rows,
  me,
  isOrganizer,
  demo,
}: {
  tripId: string
  rows: RecordData<TravelerData>[]
  me: string
  isOrganizer: boolean
  demo: boolean
}) {
  const booked = rows.filter((r) => r.data.booked === 1).length
  const everyone = rows.length > 0 && booked === rows.length
  return (
    <section
      className={cn('surface p-4 transition-colors sm:p-5', everyone && 'border-success/50 bg-success/5')}
      aria-labelledby="checklist-heading"
      id="booking-checklist"
    >
      {demo && <DemoLabel className="mb-3" />}
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="checklist-heading" className="text-base font-semibold">
          Who’s booked
        </h2>
        <p
          className={cn('text-sm font-semibold tabular-nums', everyone ? 'text-success-ink' : 'text-foreground')}
          data-testid="booked-count"
          data-booked={booked}
          data-total={rows.length}
          aria-live="polite"
        >
          {booked} of {rows.length} booked
        </p>
      </div>
      <div
        className="mt-2 h-2.5 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label="Travelers booked"
        aria-valuemin={0}
        aria-valuemax={rows.length}
        aria-valuenow={booked}
      >
        <div
          className="h-full rounded-full bg-gradient-to-r from-success to-[#16a37a] transition-[width] duration-500"
          style={{ width: `${rows.length ? (booked / rows.length) * 100 : 0}%` }}
        />
      </div>
      {everyone && (
        <p role="status" className="pop mt-3 inline-flex items-center gap-2 text-sm font-semibold text-success-ink">
          <PartyPopper className="h-4 w-4" aria-hidden /> Everyone’s booked. Enjoy the trip!
        </p>
      )}
      <ul className="mt-3 flex flex-col gap-2" data-testid="booking-checklist">
        {rows.map((row) => (
          <ChecklistRow key={row.recordId} tripId={tripId} row={row} me={me} isOrganizer={isOrganizer} />
        ))}
      </ul>
    </section>
  )
}

function ChecklistRow({
  tripId,
  row,
  me,
  isOrganizer,
}: {
  tripId: string
  row: RecordData<TravelerData>
  me: string
  isOrganizer: boolean
}) {
  const toast = useToast()
  const { ready, putConfirmed } = useMutations<TravelerData>('travelers')
  const ghostAction = useAction<{ ghostId: string }>('updateGhost')
  const [saving, setSaving] = useState(false)
  const isMe = row.data.userId === me
  const ghost = isGhostId(row.data.userId)
  const done = row.data.booked === 1
  const canToggle = isMe || (ghost && isOrganizer)
  const name = isMe ? `${row.data.displayName} (you)` : row.data.displayName

  async function toggle() {
    const next = done ? 0 : 1
    if (isMe) {
      setSaving(true)
      try {
        await putConfirmed(row.recordId, { booked: next })
        if (next === 1) toast.success('You’re marked as booked', 'Everyone on the trip sees it now.')
      } catch (e) {
        toast.error('Could not update your booking status', e instanceof Error ? e.message : undefined)
      } finally {
        setSaving(false)
      }
    } else {
      const res = await ghostAction.run({ tripId, ghostId: row.data.userId, booked: next === 1 })
      if (res && !res.success) toast.error(`Could not update ${row.data.displayName}`, res.error)
      else if (res?.success && next === 1) toast.success(`${row.data.displayName} is marked as booked`)
    }
  }

  const pending = saving || ghostAction.pending
  const label = isMe
    ? done
      ? 'Mark me as not booked'
      : 'I’ve booked my flight'
    : done
      ? `Mark ${row.data.displayName} as not booked`
      : `Mark ${row.data.displayName} as booked`

  return (
    <li
      className={cn(
        'flex flex-wrap items-center gap-3 rounded-xl border px-3 py-2.5 transition-colors duration-300',
        done ? 'border-success/30 bg-success/8' : 'border-border bg-card',
        isMe && !done && 'border-primary/40 bg-accent/40',
      )}
      data-testid="checklist-row"
      data-traveler={row.data.displayName}
      data-booked={done ? '1' : '0'}
    >
      <span className="relative shrink-0" aria-hidden>
        <PersonAvatar id={row.data.userId} name={row.data.displayName} />
        {done && (
          <span className="pop absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-success text-success-foreground ring-2 ring-card">
            <Check className="h-3 w-3" strokeWidth={3} />
          </span>
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">
          {name}{' '}
          {ghost && (
            <Badge variant="outline" size="sm">
              Not on the app
            </Badge>
          )}
        </p>
        <p
          className={cn('text-xs', done ? 'font-semibold text-success-ink' : 'text-muted-foreground')}
          data-testid="checklist-status"
        >
          {done ? 'Booked' : 'Not yet'}
        </p>
      </div>
      {canToggle && (
        <Button
          type="button"
          size="sm"
          variant={done ? 'ghost' : isMe ? 'success' : 'outline'}
          aria-pressed={done}
          onClick={() => void toggle()}
          loading={pending}
          disabled={pending || (isMe && !ready)}
          className="w-full sm:w-auto"
        >
          {!done && !pending && <Check aria-hidden />}
          {label}
        </Button>
      )}
    </li>
  )
}

function OrganizerTools({ trip, iata, demo }: { trip: RecordData<TripData>; iata: string; demo: boolean }) {
  const toast = useToast()
  const resend = useAction<LockReport>('lockTrip')

  if (demo) {
    return (
      <section className="surface p-4 sm:p-5" aria-label="Organizer tools" data-testid="demo-emails-off">
        <p className="inline-flex items-center gap-2 text-sm text-muted-foreground">
          <Mail className="h-4 w-4 shrink-0" aria-hidden />
          {DEMO_EMAILS_OFF} In a real trip, everyone gets their own booking link by email when you lock.
        </p>
      </section>
    )
  }

  async function resendEmails() {
    const res = await resend.run({ tripId: trip.recordId, iata })
    if (!res) return
    if (res.success) toast.success('Booking emails', emailReportText(res.data.emails))
    else toast.error('Could not send the booking emails', res.error)
  }

  return (
    <section className="surface p-4 sm:p-5" aria-label="Organizer tools">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          Everyone got an email with their own booking link when you locked. Resending only emails people who didn’t get one.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void resendEmails()}
          loading={resend.pending}
          disabled={resend.pending}
          className="shrink-0"
        >
          {!resend.pending && <Mail aria-hidden />}
          Email booking links again
        </Button>
      </div>
    </section>
  )
}
