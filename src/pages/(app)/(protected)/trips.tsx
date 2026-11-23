/**
 * /trips — the trips I'm on, plus "Start a trip" and "Try a demo trip"
 * (SPEC §10, §14).
 * The list is a plain `useQuery('trips')`: RBAC (`read: 'collaborator'`)
 * already limits it to trips whose memberIds include me.
 */
import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth, useMutations, useQuery } from 'deepspace'
import { CalendarDays, ChevronRight, FlaskConical, UserPlus, Users } from 'lucide-react'
import { Badge, Button, Input, Label, Textarea } from '@/components/ui'
import { ErrorState, LoadingState, Retryable } from '@/components/AsyncState'
import { useAction } from '@/hooks/useAction'
import { isRetryable } from '@/lib/actions-client'
import { usageDay } from '@/lib/caps'
import { dateRange, localToday } from '@/lib/format'
import { INPUT_LIMITS } from '@/lib/limits'
import { parseIdList, type TripData } from '@/lib/types'
import { text, tripDates } from '@/lib/validate'
import { StatusBadge } from '@/components/trip/StatusBadge'
import { DemoLabel } from '@/components/trip/DemoLabel'
import { DEMO_EMAILS_OFF, isDemoTrip } from '@/lib/demo'
import { pageTitle } from '@/brand'

export default function TripsPage() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-6 sm:px-6">
      <title>{pageTitle('Your trips')}</title>
      <header>
        <h1 className="font-display text-3xl font-semibold tracking-tight">Your trips</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Find the best place to meet, with everyone entering their own airports and a private budget.
        </p>
      </header>
      <DemoTripOffer />
      <CreateTripForm />
      <Retryable>{(retry) => <MyTrips onRetry={retry} />}</Retryable>
    </div>
  )
}

function MyTrips({ onRetry }: { onRetry: () => void }) {
  const { userId } = useAuth()
  const { records, status, error } = useQuery<TripData>('trips', { limit: 100 })

  if (status === 'loading') return <LoadingState label="Loading your trips…" />
  if (status === 'error') {
    return <ErrorState title="Could not load your trips" message={error} onRetry={onRetry} />
  }
  if (records.length === 0) {
    return (
      <section
        aria-labelledby="no-trips-heading"
        data-testid="trips-empty"
        className="rounded-lg border border-dashed border-border px-4 py-8 sm:px-8"
      >
        <h2 id="no-trips-heading" className="text-base font-semibold">
          No trips yet
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Start one above, or open an invite link a friend sent you.
        </p>
        <div className="mt-5 rounded-lg bg-muted p-4" data-testid="try-solo">
          <p className="inline-flex items-center gap-2 text-sm font-semibold">
            <UserPlus className="h-4 w-4" aria-hidden /> Try it solo
          </p>
          <ol className="mt-2 flex list-decimal flex-col gap-1 pl-5 text-sm text-muted-foreground">
            <li>Create a trip above.</li>
            <li>
              On its Crew tab, press <span className="font-medium text-foreground">Add traveler</span> twice to add 2
              ghost travelers (people who don’t use the app), each with a home airport in another city.
            </li>
            <li>Add destinations and find fares. You’ll see voting, locking and booking end to end.</li>
          </ol>
          <p className="mt-2 text-sm text-muted-foreground">
            Or press <span className="font-medium text-foreground">Try a demo trip</span> above for a ready-made one.
          </p>
        </div>
      </section>
    )
  }

  const sorted = [...records].sort((a, b) => a.data.outboundDate.localeCompare(b.data.outboundDate))
  return (
    <section aria-labelledby="my-trips-heading">
      <h2 id="my-trips-heading" className="mb-3 text-lg font-semibold">
        Trips you're on
      </h2>
      <ul className="flex flex-col gap-3" data-testid="trip-list">
        {sorted.map((trip) => (
          <li key={trip.recordId}>
            <Link
              to={`/t/${trip.recordId}`}
              data-testid="trip-card"
              className="flex items-center gap-3 rounded-lg border border-border bg-card p-4 transition-colors hover:bg-accent"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate font-medium text-foreground">{trip.data.name}</span>
                  <StatusBadge status={trip.data.status} />
                  {trip.data.organizerId === userId && <Badge variant="outline">Organizer</Badge>}
                </div>
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <CalendarDays className="h-3.5 w-3.5" aria-hidden />
                    {dateRange(trip.data.outboundDate, trip.data.returnDate)}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Users className="h-3.5 w-3.5" aria-hidden />
                    {memberCount(trip.data.memberIds)}
                  </span>
                </div>
                {isDemoTrip(trip.data) && <DemoLabel className="mt-2" />}
              </div>
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}

/**
 * "Try a demo trip" (SPEC §14): a ready-made trip with ghost travelers,
 * destinations and sample fares, for reviewers while live fares are
 * unavailable. Confirmed write: opens the trip only once the server made it.
 */
function DemoTripOffer() {
  const navigate = useNavigate()
  const { ready } = useMutations('trips')
  const demo = useAction<{ tripId: string; searchStarted: boolean }>('createDemoTrip')

  async function start() {
    const res = await demo.run({})
    if (res?.success) navigate(`/t/${res.data.tripId}`)
  }

  return (
    <section
      aria-labelledby="demo-trip-heading"
      data-testid="demo-offer"
      className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5"
    >
      <div className="min-w-0">
        <h2 id="demo-trip-heading" className="inline-flex items-center gap-2 text-base font-semibold">
          <FlaskConical className="h-4 w-4 text-warning" aria-hidden /> Just looking around?
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Open a ready-made trip with two friends in other cities, four destinations and sample prices. You can sort,
          vote, lock and book it alone. {DEMO_EMAILS_OFF}
        </p>
        {demo.error && (
          <ErrorState
            testId="demo-error"
            title="Could not create a demo trip"
            message={demo.error.message}
            onRetry={isRetryable(demo.error.code) ? () => void start() : undefined}
          />
        )}
      </div>
      <Button
        type="button"
        variant="outline"
        onClick={() => void start()}
        loading={demo.pending}
        disabled={!ready || demo.pending}
        className="shrink-0"
        data-testid="try-demo"
      >
        {ready ? 'Try a demo trip' : 'Connecting…'}
      </Button>
    </section>
  )
}

function CreateTripForm() {
  const navigate = useNavigate()
  // Gate on the trips room: the trip page we navigate to reads from it.
  const { ready } = useMutations('trips')
  const create = useAction<{ tripId: string; inviteCode: string }>('createTrip')
  const [name, setName] = useState('')
  const [outboundDate, setOutboundDate] = useState('')
  const [returnDate, setReturnDate] = useState('')
  const [vibe, setVibe] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  async function submit(e?: FormEvent) {
    e?.preventDefault()
    setFormError(null)
    // Same checks as the server, so most mistakes never leave the browser.
    const n = text(name, 'Trip name', { max: INPUT_LIMITS.tripNameMax })
    if (!n.ok) return setFormError(n.error)
    const d = tripDates(outboundDate, returnDate, usageDay(new Date()))
    if (!d.ok) return setFormError(d.error)
    const v = text(vibe, 'Vibe', { max: INPUT_LIMITS.vibeMax, optional: true })
    if (!v.ok) return setFormError(v.error)

    // Confirmed write: navigate only once the server has created the trip.
    const res = await create.run({ name: n.value, ...d.value, vibe: v.value })
    if (res?.success) navigate(`/t/${res.data.tripId}`)
  }

  const error = formError ?? create.error?.message ?? null
  return (
    <section aria-labelledby="create-trip-heading" className="rounded-lg border border-border bg-card p-4 sm:p-6">
      <h2 id="create-trip-heading" className="text-lg font-semibold">
        Start a trip
      </h2>
      <form className="mt-4 flex flex-col gap-4" onSubmit={submit} noValidate data-testid="create-trip-form">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="trip-name">Trip name</Label>
          <Input
            id="trip-name"
            value={name}
            maxLength={INPUT_LIMITS.tripNameMax}
            placeholder="Spring reunion"
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="trip-outbound">Outbound date</Label>
            <Input
              id="trip-outbound"
              type="date"
              min={localToday()}
              value={outboundDate}
              onChange={(e) => setOutboundDate(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="trip-return">Return date</Label>
            <Input
              id="trip-return"
              type="date"
              min={outboundDate || localToday()}
              value={returnDate}
              onChange={(e) => setReturnDate(e.target.value)}
            />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="trip-vibe">
            Vibe <span className="font-normal text-muted-foreground">(optional)</span>
          </Label>
          <Textarea
            id="trip-vibe"
            rows={2}
            value={vibe}
            maxLength={INPUT_LIMITS.vibeMax}
            placeholder="beach, cheap, not Florida"
            onChange={(e) => setVibe(e.target.value)}
          />
        </div>
        {error && (
          <ErrorState
            testId="create-trip-error"
            title="Could not create the trip"
            message={error}
            onRetry={create.error && isRetryable(create.error.code) ? () => void submit() : undefined}
          />
        )}
        <Button type="submit" loading={create.pending} disabled={!ready || create.pending} className="sm:w-fit">
          {ready ? 'Create trip' : 'Connecting…'}
        </Button>
      </form>
    </section>
  )
}

function memberCount(raw: unknown): string {
  const n = parseIdList(raw).length
  return `${n} ${n === 1 ? 'member' : 'members'}`
}
