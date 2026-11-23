/**
 * /t/:tripId — the trip (SPEC §10): Crew, Destinations, Results, and Book
 * (enabled once there are results: the fare watch lives there, and booking
 * once a destination is locked).
 *
 * Not-found: the room only sends trips whose memberIds include me, so a
 * trip I'm not on looks exactly like one that doesn't exist.
 */
import { useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAuth, useQuery } from 'deepspace'
import { ArrowLeft, CalendarDays, MapPinned, Sparkles, Ticket, Trophy, Users, type LucideIcon } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger, cn } from '@/components/ui'
import { EmptyNote, ErrorState, LoadingState, Retryable } from '@/components/AsyncState'
import { CrewTab } from '@/components/trip/CrewTab'
import { DestinationsTab } from '@/components/trip/DestinationsTab'
import { BookTab } from '@/components/trip/BookTab'
import { ResultsTab } from '@/components/trip/ResultsTab'
import { StatusBadge } from '@/components/trip/StatusBadge'
import { NextStepGuide } from '@/components/trip/NextStepGuide'
import { DemoBanner } from '@/components/trip/DemoLabel'
import { isDemoTrip } from '@/lib/demo'
import { pageTitle } from '@/brand'
import { dateRange } from '@/lib/format'
import type { TripData } from '@/lib/types'
import type { TripTab } from '@/lib/next-step'
import { recordId } from '@/lib/validate'

/**
 * Each section has its own icon and hue (themes.css), used on its tab and
 * the sliding indicator, so where you are is obvious at a glance.
 */
const SECTIONS: Array<{ value: TripTab; label: string; Icon: LucideIcon; active: string; indicator: string }> = [
  { value: 'crew', label: 'Crew', Icon: Users, active: 'data-[active]:text-info-ink', indicator: 'ring-info/35' },
  {
    value: 'destinations',
    label: 'Destinations',
    Icon: MapPinned,
    active: 'data-[active]:text-warning-ink',
    indicator: 'ring-sun/60',
  },
  { value: 'results', label: 'Results', Icon: Trophy, active: 'data-[active]:text-coral-ink', indicator: 'ring-coral/45' },
  { value: 'book', label: 'Book', Icon: Ticket, active: 'data-[active]:text-success-ink', indicator: 'ring-success/35' },
]

export default function TripPage() {
  const { tripId = '' } = useParams()
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6 sm:px-6">
      <Link
        to="/trips"
        className="group -ml-2 inline-flex w-fit items-center gap-1.5 rounded-lg px-2 py-1 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
      >
        <ArrowLeft className="h-4 w-4 transition-transform motion-safe:group-hover:-translate-x-0.5" aria-hidden /> Your
        trips
      </Link>
      {recordId(tripId, 'Trip').ok ? (
        <Retryable>{(retry) => <Trip tripId={tripId} onRetry={retry} />}</Retryable>
      ) : (
        <TripNotFound />
      )}
    </div>
  )
}

function Trip({ tripId, onRetry }: { tripId: string; onRetry: () => void }) {
  const { userId } = useAuth()
  const { records, status, error } = useQuery<TripData>('trips', { where: { recordId: tripId }, limit: 1 })
  const trip = records[0]
  // Opens on Book once locked, on Results once a trip has them; "Find fares" and "Lock" switch too.
  const [tab, setTab] = useState<string | null>(null)
  const tabsRef = useRef<HTMLDivElement>(null)

  /** Switch section and bring it into view, so the button visibly does something even on the current tab. */
  function goTo(t: TripTab) {
    setTab(t)
    requestAnimationFrame(() => {
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      tabsRef.current?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })
    })
  }

  if (status === 'loading') return <LoadingState label="Loading trip…" />
  if (status === 'error') {
    return (
      <>
        <title>{pageTitle('Trip')}</title>
        <ErrorState title="Could not load this trip" message={error} onRetry={onRetry} />
      </>
    )
  }
  if (!trip || !userId) return <TripNotFound />
  const tripStatus = trip.data.status
  const locked = tripStatus === 'locked'
  const bookOpen = locked || tripStatus === 'results'
  const defaultTab = locked ? 'book' : tripStatus === 'results' || tripStatus === 'searching' ? 'results' : 'crew'
  // A 'book' choice can't outlive results (e.g. a new search started), so fall back.
  const current = tab === 'book' && !bookOpen ? defaultTab : (tab ?? defaultTab)

  return (
    <>
      <title>{pageTitle(trip.data.name)}</title>
      <header className="relative isolate overflow-hidden rounded-xl border-b-4 border-coral bg-primary px-5 py-6 text-nav-foreground shadow-[0_6px_18px_-10px_rgba(28,39,51,0.5)] sm:px-7 sm:py-7">
        <HeaderRoutes />
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="font-display text-3xl font-bold tracking-tight sm:text-4xl" data-testid="trip-name">
            {trip.data.name}
          </h1>
          <StatusBadge status={trip.data.status} className="bg-white/15 text-white ring-white/25" />
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-white/85">
          <span className="inline-flex items-center gap-1.5">
            <CalendarDays className="h-4 w-4" aria-hidden />
            {dateRange(trip.data.outboundDate, trip.data.returnDate)}
          </span>
          {trip.data.vibe && (
            <span className="inline-flex items-center gap-1.5">
              <Sparkles className="h-4 w-4 text-sun" aria-hidden />“{trip.data.vibe}”
            </span>
          )}
        </div>
      </header>

      {isDemoTrip(trip.data) && <DemoBanner />}

      <NextStepGuide trip={trip} me={userId} onGoTo={goTo} />

      <div ref={tabsRef} className="scroll-mt-4">
        <Tabs value={current} onValueChange={(v) => setTab(String(v))}>
          <TabsList
            className="grid h-auto w-full grid-cols-4 sm:inline-flex sm:h-12 sm:w-fit"
            indicatorClassName={cn('ring-2', SECTIONS.find((s) => s.value === current)?.indicator)}
            aria-label="Trip sections"
          >
            {SECTIONS.map(({ value, label, Icon, active }) => {
              const disabled = value === 'book' && !bookOpen
              return (
                <TabsTrigger
                  key={value}
                  value={value}
                  disabled={disabled}
                  title={disabled ? 'Opens once there are fare results' : undefined}
                  className={cn('h-14 flex-col gap-0.5 px-1 text-xs sm:h-full sm:flex-row sm:gap-2 sm:px-4 sm:text-sm', active)}
                >
                  <Icon aria-hidden className="size-[18px]" />
                  {label}
                </TabsTrigger>
              )
            })}
          </TabsList>
          <TabsContent value="crew" className="pt-4">
            <CrewTab trip={trip} me={userId} />
          </TabsContent>
          <TabsContent value="destinations" className="pt-4">
            <DestinationsTab trip={trip} me={userId} onSearchStarted={() => setTab('results')} />
          </TabsContent>
          <TabsContent value="results" className="pt-4">
            <ResultsTab
              trip={trip}
              me={userId}
              onGoToDestinations={() => setTab('destinations')}
              onLocked={() => setTab('book')}
            />
          </TabsContent>
          <TabsContent value="book" className="pt-4">
            <BookTab trip={trip} me={userId} />
          </TabsContent>
        </Tabs>
      </div>
    </>
  )
}

/** Two dashed routes meeting at a coral pin, faint behind the header text. */
function HeaderRoutes() {
  return (
    <svg
      viewBox="0 0 320 120"
      className="pointer-events-none absolute -top-2 right-4 -z-10 hidden h-[150%] w-auto sm:block"
      aria-hidden
    >
      <path d="M10 110 Q90 20 200 52" fill="none" stroke="white" strokeOpacity={0.35} strokeWidth={2} strokeDasharray="5 7" />
      <path d="M310 112 Q260 40 200 52" fill="none" stroke="white" strokeOpacity={0.35} strokeWidth={2} strokeDasharray="5 7" />
      <circle cx={200} cy={44} r={11} className="fill-coral" />
      <circle cx={200} cy={44} r={4} className="fill-primary" />
    </svg>
  )
}

function TripNotFound() {
  return (
    <div data-testid="trip-not-found">
      <title>{pageTitle('Trip not found')}</title>
      <EmptyNote title="Trip not found">
        It may not exist, or you’re not on it. Ask the organizer for an invite link.{' '}
        <Link to="/trips" className="underline underline-offset-4">
          Go to your trips
        </Link>
      </EmptyNote>
    </div>
  )
}
