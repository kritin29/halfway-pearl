/**
 * Book tab (SPEC §3.8, §10): the locked destination, the viewer's own fare
 * and booking link, and a live group checklist.
 *
 * Who can tick what: each member writes `booked` on their OWN travelers row
 * (writableFields, `update: 'own'`); ghost rows can only be changed by the
 * organizer, through the `updateGhost` action. Everyone sees every change
 * live.
 */
import { useState } from 'react'
import { useMutations, useQuery, type RecordData } from 'deepspace'
import { Check, ExternalLink, Home, Mail, PlaneTakeoff } from 'lucide-react'
import { Badge, Button, Label, Switch, cn, useToast } from '@/components/ui'
import { EmptyNote, ErrorState, LoadingState, Retryable } from '@/components/AsyncState'
import { useAction } from '@/hooks/useAction'
import { googleFlightsUrl, normalizeHomes } from '@/lib/flights'
import { dateRange } from '@/lib/format'
import { formatDuration } from '@/lib/ranking'
import { clockTime, safeBookingUrl, stopsLabel, usd, type FareRow } from '@/lib/results'
import { isGhostId, type CandidateData, type TravelerData, type TripData } from '@/lib/types'

interface LockReport {
  emails: { sent: number; alreadySent: number; noEmail: number; capped: number; failed: number; mocked: boolean } | null
}

/** One sentence for the organizer after a lock or a resend. */
export function emailReportText(emails: LockReport['emails']): string {
  if (!emails) return 'The booking emails couldn’t be sent. Try “Email booking links again” in a minute.'
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
      <EmptyNote title="No destination locked yet">
        When the organizer locks a destination on the Results tab, everyone books here.
      </EmptyNote>
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

  return (
    <div className="flex flex-col gap-4" data-testid="book">
      <section className="rounded-lg border border-border bg-card p-4 sm:p-5" data-testid="locked-destination" data-iata={iata}>
        <p className="text-sm text-muted-foreground">You’re all going to</p>
        <div className="mt-1 flex flex-wrap items-baseline gap-x-2">
          <h2 className="text-2xl font-semibold tracking-tight">{city}</h2>
          <span className="font-mono text-sm text-muted-foreground">{iata}</span>
          {destination?.country && <span className="text-sm text-muted-foreground">{destination.country}</span>}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">{dateRange(trip.data.outboundDate, trip.data.returnDate)}</p>
      </section>

      {mine && (
        <YourFlight
          fare={myFare}
          iata={iata}
          city={city}
          homeAirports={Array.isArray(mine.data.homeAirports) ? mine.data.homeAirports : []}
          outboundDate={trip.data.outboundDate}
          returnDate={trip.data.returnDate}
        />
      )}

      <Checklist tripId={tripId} rows={rows} me={me} isOrganizer={isOrganizer} />

      {isOrganizer && <OrganizerTools trip={trip} iata={iata} />}
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
}: {
  fare: FareRow | null
  iata: string
  city: string
  homeAirports: string[]
  outboundDate: string
  returnDate: string
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
    <section className="rounded-lg border border-border bg-card p-4 sm:p-5" data-testid="your-flight">
      <h2 className="flex items-center gap-2 text-base font-semibold">
        <PlaneTakeoff className="h-4 w-4" aria-hidden /> Your flight
      </h2>
      {home ? (
        <p className="mt-2 inline-flex items-center gap-1.5 text-sm text-muted-foreground">
          <Home className="h-4 w-4" aria-hidden /> You live in {city}, so there’s no flight to book.
        </p>
      ) : hasFare ? (
        <>
          <p className="mt-2 text-lg font-semibold tabular-nums" data-testid="your-fare">
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
          className="mt-3 inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
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
}: {
  tripId: string
  rows: RecordData<TravelerData>[]
  me: string
  isOrganizer: boolean
}) {
  const booked = rows.filter((r) => r.data.booked === 1).length
  return (
    <section className="rounded-lg border border-border bg-card p-4 sm:p-5" aria-labelledby="checklist-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="checklist-heading" className="text-base font-semibold">
          Who’s booked
        </h2>
        <p
          className="text-sm font-medium tabular-nums"
          data-testid="booked-count"
          data-booked={booked}
          data-total={rows.length}
          aria-live="polite"
        >
          {booked} of {rows.length} booked
        </p>
      </div>
      <div
        className="mt-2 h-2 overflow-hidden rounded-full bg-secondary"
        role="progressbar"
        aria-label="Travelers booked"
        aria-valuemin={0}
        aria-valuemax={rows.length}
        aria-valuenow={booked}
      >
        <div
          className="h-full rounded-full bg-success transition-[width] duration-500"
          style={{ width: `${rows.length ? (booked / rows.length) * 100 : 0}%` }}
        />
      </div>
      <ul className="mt-3 flex flex-col divide-y divide-border" data-testid="booking-checklist">
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
      } catch (e) {
        toast.error('Could not update your booking status', e instanceof Error ? e.message : undefined)
      } finally {
        setSaving(false)
      }
    } else {
      const res = await ghostAction.run({ tripId, ghostId: row.data.userId, booked: next === 1 })
      if (res && !res.success) toast.error(`Could not update ${row.data.displayName}`, res.error)
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
      className="flex flex-wrap items-center gap-3 py-2.5"
      data-testid="checklist-row"
      data-traveler={row.data.displayName}
      data-booked={done ? '1' : '0'}
    >
      <span
        className={cn(
          'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border',
          done ? 'border-success bg-success text-success-foreground' : 'border-border text-transparent',
        )}
        aria-hidden
      >
        <Check className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">
          {name}{' '}
          {ghost && (
            <Badge variant="outline" size="sm">
              Not on the app
            </Badge>
          )}
        </p>
        <p className="text-xs text-muted-foreground" data-testid="checklist-status">
          {done ? 'Booked' : 'Not yet'}
        </p>
      </div>
      {canToggle && (
        <Button
          type="button"
          size="sm"
          variant={done ? 'outline' : 'default'}
          aria-pressed={done}
          onClick={() => void toggle()}
          loading={pending}
          disabled={pending || (isMe && !ready)}
          className="w-full sm:w-auto"
        >
          {label}
        </Button>
      )}
    </li>
  )
}

function OrganizerTools({ trip, iata }: { trip: RecordData<TripData>; iata: string }) {
  const toast = useToast()
  const resend = useAction<LockReport>('lockTrip')

  async function resendEmails() {
    const res = await resend.run({ tripId: trip.recordId, iata })
    if (!res) return
    if (res.success) toast.success('Booking emails', emailReportText(res.data.emails))
    else toast.error('Could not send the booking emails', res.error)
  }

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4 sm:p-5" aria-label="Organizer tools">
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
      <div className="flex items-start gap-3 border-t border-border pt-4" data-testid="watch-toggle">
        <Switch
          id="watch-switch"
          checked={trip.data.watchEnabled === 1}
          disabled
          aria-describedby="watch-hint"
          className="data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50"
        />
        <div>
          <Label htmlFor="watch-switch" className="text-sm font-medium">
            Daily fare watch: coming next
          </Label>
          <p id="watch-hint" className="text-xs text-muted-foreground">
            A daily price check that emails the group when fares drop.
          </p>
        </div>
      </div>
    </section>
  )
}
