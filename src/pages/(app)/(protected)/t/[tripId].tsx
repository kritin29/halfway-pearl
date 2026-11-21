/**
 * /t/:tripId — the trip (SPEC §10). Crew and Destinations exist; Results and
 * Book are disabled placeholders.
 *
 * Not-found: the room only sends trips whose memberIds include me, so a
 * trip I'm not on looks exactly like one that doesn't exist.
 */
import { Link, useParams } from 'react-router-dom'
import { useAuth, useQuery } from 'deepspace'
import { ArrowLeft, CalendarDays } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui'
import { EmptyNote, ErrorState, LoadingState, Retryable } from '@/components/AsyncState'
import { CrewTab } from '@/components/trip/CrewTab'
import { DestinationsTab } from '@/components/trip/DestinationsTab'
import { StatusBadge } from '@/components/trip/StatusBadge'
import { dateRange } from '@/lib/format'
import type { TripData } from '@/lib/types'
import { recordId } from '@/lib/validate'

export default function TripPage() {
  const { tripId = '' } = useParams()
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6 sm:px-6">
      <Link
        to="/trips"
        className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden /> Your trips
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

  if (status === 'loading') return <LoadingState label="Loading trip…" />
  if (status === 'error') return <ErrorState title="Could not load this trip" message={error} onRetry={onRetry} />
  if (!trip || !userId) return <TripNotFound />

  return (
    <>
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight" data-testid="trip-name">
            {trip.data.name}
          </h1>
          <StatusBadge status={trip.data.status} />
        </div>
        <p className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
          <CalendarDays className="h-4 w-4" aria-hidden />
          {dateRange(trip.data.outboundDate, trip.data.returnDate)}
        </p>
        {trip.data.vibe && <p className="text-sm text-muted-foreground">“{trip.data.vibe}”</p>}
      </header>

      <Tabs defaultValue="crew">
        <TabsList className="w-full sm:w-fit">
          <TabsTrigger value="crew">Crew</TabsTrigger>
          <TabsTrigger value="destinations">Destinations</TabsTrigger>
          <TabsTrigger value="results" disabled title="Coming soon">
            Results
          </TabsTrigger>
          <TabsTrigger value="book" disabled title="Coming soon">
            Book
          </TabsTrigger>
        </TabsList>
        <TabsContent value="crew" className="pt-4">
          <CrewTab trip={trip} me={userId} />
        </TabsContent>
        <TabsContent value="destinations" className="pt-4">
          <DestinationsTab trip={trip} me={userId} />
        </TabsContent>
      </Tabs>
    </>
  )
}

function TripNotFound() {
  return (
    <div data-testid="trip-not-found">
      <EmptyNote title="Trip not found">
        It may not exist, or you’re not on it. Ask the organizer for an invite link.{' '}
        <Link to="/trips" className="underline underline-offset-4">
          Go to your trips
        </Link>
      </EmptyNote>
    </div>
  )
}
