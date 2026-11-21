/**
 * /join/:code — invite landing (SPEC §10). Shows the trip (via the
 * `previewInvite` action, since a non-member can't read the trip row) and a
 * Join button, with clear messages for a wrong code, a full trip and a
 * locked trip.
 */
import { useParams, Link, useNavigate } from 'react-router-dom'
import { useAsyncResource, useMutations } from 'deepspace'
import { CalendarDays, Users } from 'lucide-react'
import { Button } from '@/components/ui'
import { ErrorState, LoadingState } from '@/components/AsyncState'
import { useAction } from '@/hooks/useAction'
import { callAction, isRetryable, type ActionResponse } from '@/lib/actions-client'
import { dateRange } from '@/lib/format'
import { LIMITS } from '@/lib/limits'

interface InvitePreview {
  name: string
  outboundDate: string
  returnDate: string
  travelerCount: number
  maxTravelers: number
  locked: boolean
  full: boolean
  alreadyMember: boolean
  tripId: string | null
}

/** User-facing text for the join refusals (tested by tests/trips.spec.ts). */
const JOIN_MESSAGES: Record<string, { title: string; message: string }> = {
  not_found: {
    title: 'That invite link doesn’t match a trip',
    message: 'Check the link with whoever sent it. Invite codes are case-sensitive.',
  },
  invalid_params: {
    title: 'That invite link doesn’t match a trip',
    message: 'Check the link with whoever sent it. Invite codes are case-sensitive.',
  },
  trip_full: {
    title: 'This trip is full',
    message: `A trip can have up to ${LIMITS.maxTravelers} travelers, and this one has no seats left. Ask the organizer to make room.`,
  },
  trip_locked: {
    title: 'This trip is locked',
    message: 'The group has already picked a destination, so nobody new can join.',
  },
}

export default function JoinPage() {
  const { code = '' } = useParams()
  const preview = useAsyncResource<ActionResponse<InvitePreview>>(
    async () => {
      const res = await callAction<InvitePreview>('previewInvite', { inviteCode: code })
      // Only transient failures are errors (retryable); a wrong code is an answer.
      if (!res.success && isRetryable(res.code)) throw new Error(res.error)
      return res
    },
    [code],
    { retry: 1, retryDelayMs: 500 },
  )

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-6 px-4 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Join a trip</h1>
      {preview.status === 'loading' || (preview.status !== 'error' && !preview.data) ? (
        <LoadingState label="Looking up your invite…" />
      ) : preview.status === 'error' ? (
        <ErrorState title="Could not load this invite" message={preview.error} onRetry={preview.reload} />
      ) : !preview.data!.success ? (
        <JoinRefusal code={preview.data!.code} message={preview.data!.error} />
      ) : (
        <InviteCard code={code} trip={preview.data!.data} />
      )}
    </div>
  )
}

function JoinRefusal({ code, message }: { code: string; message?: string }) {
  const known = JOIN_MESSAGES[code]
  return (
    <div className="flex flex-col gap-4">
      <ErrorState
        testId="join-error"
        title={known?.title ?? 'Could not join this trip'}
        message={known?.message ?? message}
      />
      <Link to="/trips" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
        Go to your trips
      </Link>
    </div>
  )
}

function InviteCard({ code, trip }: { code: string; trip: InvitePreview }) {
  const navigate = useNavigate()
  // The trip page we land on reads from the trips room.
  const { ready } = useMutations('trips')
  const join = useAction<{ tripId: string; alreadyMember: boolean }>('joinTrip')

  async function onJoin() {
    const res = await join.run({ inviteCode: code })
    if (res?.success) navigate(`/t/${res.data.tripId}`)
  }

  // Refused up front (or by the join itself): show why, no Join button.
  const refusal = trip.alreadyMember ? null : trip.locked ? 'trip_locked' : trip.full ? 'trip_full' : null
  const joinRefusal = join.error && JOIN_MESSAGES[join.error.code] ? join.error.code : null

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-lg border border-border bg-card p-5" data-testid="invite-card">
        <p className="text-sm text-muted-foreground">You’re invited to</p>
        <h2 className="mt-1 text-xl font-semibold" data-testid="invite-trip-name">
          {trip.name}
        </h2>
        <div className="mt-3 flex flex-col gap-1 text-sm text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <CalendarDays className="h-4 w-4" aria-hidden />
            {dateRange(trip.outboundDate, trip.returnDate)}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Users className="h-4 w-4" aria-hidden />
            {trip.travelerCount} of {trip.maxTravelers} travelers
          </span>
        </div>
      </section>

      {trip.alreadyMember && trip.tripId ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">You’re already on this trip.</p>
          <Button onClick={() => navigate(`/t/${trip.tripId}`)}>Open trip</Button>
        </div>
      ) : refusal || joinRefusal ? (
        <JoinRefusal code={(joinRefusal ?? refusal)!} />
      ) : (
        <>
          {join.error && (
            <ErrorState
              title="Could not join"
              message={join.error.message}
              onRetry={isRetryable(join.error.code) ? () => void onJoin() : undefined}
            />
          )}
          <Button onClick={() => void onJoin()} loading={join.pending} disabled={!ready || join.pending}>
            {ready ? 'Join trip' : 'Connecting…'}
          </Button>
        </>
      )}
    </div>
  )
}
