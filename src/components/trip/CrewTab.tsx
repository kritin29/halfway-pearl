/**
 * Crew tab (SPEC §10): the member + ghost list with public chips, my own
 * settings and private budget, and the organizer's invite link and ghost
 * management. Everything here is live: other members' edits arrive through
 * `useQuery` without a reload.
 */
import { useState } from 'react'
import { useMutations, useQuery, type RecordData } from 'deepspace'
import { Ghost, Pencil, Plane, Plus, Trash2, Wallet } from 'lucide-react'
import { Badge, Button, ConfirmModal, useToast } from '@/components/ui'
import { EmptyNote, ErrorState, LoadingState, Retryable } from '@/components/AsyncState'
import { useAction } from '@/hooks/useAction'
import { airportByIata } from '@/lib/airports'
import { LIMITS } from '@/lib/limits'
import type { TravelerData, TripData } from '@/lib/types'
import { GhostDialog } from './GhostDialog'
import { InviteLink } from './InviteLink'
import { PersonAvatar } from './PersonAvatar'
import { PrivateBudget } from './PrivateBudget'
import { YourSettings } from './YourSettings'

export function CrewTab({ trip, me }: { trip: RecordData<TripData>; me: string }) {
  return <Retryable>{(retry) => <CrewContent trip={trip} me={me} onRetry={retry} />}</Retryable>
}

function CrewContent({ trip, me, onRetry }: { trip: RecordData<TripData>; me: string; onRetry: () => void }) {
  const tripId = trip.recordId
  const isOrganizer = trip.data.organizerId === me
  const travelers = useQuery<TravelerData>('travelers', { where: { tripId }, limit: 20 })

  if (travelers.status === 'loading') return <LoadingState label="Loading the crew…" />
  if (travelers.status === 'error') {
    return <ErrorState title="Could not load the crew" message={travelers.error} onRetry={onRetry} />
  }

  // Organizer first, then real travelers, then ghosts; each group oldest first.
  const rank = (t: TravelerData) => (t.userId === trip.data.organizerId ? 0 : t.isGhost ? 2 : 1)
  const crew = [...travelers.records].sort(
    (a, b) => rank(a.data) - rank(b.data) || a.createdAt.localeCompare(b.createdAt),
  )
  const myRow = crew.find((t) => t.data.userId === me) ?? null

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="flex flex-col gap-6">
        <CrewList trip={trip} crew={crew} me={me} isOrganizer={isOrganizer} />
        {isOrganizer && <InviteLink inviteCode={trip.data.inviteCode} />}
      </div>
      <div className="flex flex-col gap-6">
        {myRow ? (
          <>
            <YourSettings row={myRow} />
            <PrivateBudget tripId={tripId} myRow={myRow} onRetry={onRetry} />
          </>
        ) : (
          <EmptyNote title="Your traveler details are still loading">
            If this doesn’t clear up, reopen the trip from Your trips.
          </EmptyNote>
        )}
      </div>
    </div>
  )
}

function CrewList({
  trip,
  crew,
  me,
  isOrganizer,
}: {
  trip: RecordData<TripData>
  crew: RecordData<TravelerData>[]
  me: string
  isOrganizer: boolean
}) {
  const { ready } = useMutations('travelers')
  const toast = useToast()
  const remove = useAction<{ ghostId: string }>('removeGhost')
  const [dialog, setDialog] = useState<{ ghost: RecordData<TravelerData> | null } | null>(null)
  const [removing, setRemoving] = useState<RecordData<TravelerData> | null>(null)
  const full = crew.length >= LIMITS.maxTravelers

  async function confirmRemove() {
    if (!removing) return
    const res = await remove.run({ tripId: trip.recordId, ghostId: removing.data.userId })
    if (res?.success) setRemoving(null)
    else if (res) toast.error('Could not remove traveler', res.error)
  }

  return (
    <section aria-labelledby="crew-heading" className="surface p-4 sm:p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 id="crew-heading" className="text-base font-semibold">
          Crew{' '}
          <span className="font-normal text-muted-foreground">
            ({crew.length}/{LIMITS.maxTravelers})
          </span>
        </h2>
        {isOrganizer && (
          <Button
            size="sm"
            variant="outline"
            disabled={!ready || full}
            onClick={() => setDialog({ ghost: null })}
            title={full ? 'The trip is full' : undefined}
          >
            <Plus aria-hidden /> Add traveler
          </Button>
        )}
      </div>

      {crew.length === 0 ? (
        <EmptyNote className="mt-4" title="Nobody here yet" />
      ) : (
        <ul className="mt-4 flex flex-col divide-y divide-border" data-testid="crew-list">
          {crew.map((t) => {
            const airports = Array.isArray(t.data.homeAirports) ? t.data.homeAirports : []
            const isMe = t.data.userId === me
            return (
              <li
                key={t.recordId}
                data-testid="crew-member"
                data-me={isMe ? 'true' : undefined}
                className="-mx-2 flex items-start gap-3 rounded-lg px-2 py-3 transition-colors hover:bg-accent/40"
              >
                <PersonAvatar id={t.data.userId} name={t.data.displayName} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-semibold">{t.data.displayName}</span>
                    {isMe && <span className="text-sm text-muted-foreground">(you)</span>}
                    {t.data.userId === trip.data.organizerId && (
                      <Badge variant="primary" size="sm">
                        Organizer
                      </Badge>
                    )}
                    {t.data.isGhost === 1 && (
                      <Badge variant="secondary" size="sm" title="Added by the organizer; doesn’t use the app">
                        <Ghost aria-hidden /> Ghost
                      </Badge>
                    )}
                  </div>
                  <p className="mt-0.5 truncate text-sm text-muted-foreground">
                    {airports.length > 0
                      ? airports.map((c) => `${c} (${airportByIata(c)?.city ?? c})`).join(', ')
                      : 'No home airports yet'}
                  </p>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {airports.length > 0 ? (
                      <Badge variant="success" size="sm">
                        <Plane aria-hidden />
                        airports set
                      </Badge>
                    ) : (
                      <Badge variant="warning" size="sm">
                        needs airports
                      </Badge>
                    )}
                    {t.data.isGhost !== 1 && t.data.hasBudget === 1 && (
                      <Badge variant="info" size="sm">
                        <Wallet aria-hidden />
                        budget set ✓
                      </Badge>
                    )}
                  </div>
                </div>
                {isOrganizer && t.data.isGhost === 1 && (
                  <div className="flex shrink-0 gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      disabled={!ready}
                      aria-label={`Edit ${t.data.displayName}`}
                      onClick={() => setDialog({ ghost: t })}
                    >
                      <Pencil aria-hidden />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      disabled={!ready}
                      className="hover:bg-destructive/10 hover:text-destructive"
                      aria-label={`Remove ${t.data.displayName}`}
                      onClick={() => setRemoving(t)}
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {dialog && (
        <GhostDialog
          // New key per target, so the form starts from that ghost's values.
          key={dialog.ghost?.recordId ?? 'new'}
          tripId={trip.recordId}
          ghost={dialog.ghost}
          open
          canWrite={ready}
          onClose={() => setDialog(null)}
        />
      )}
      <ConfirmModal
        open={removing !== null}
        onClose={() => setRemoving(null)}
        onConfirm={() => void confirmRemove()}
        loading={remove.pending}
        title={`Remove ${removing?.data.displayName ?? 'traveler'}?`}
        description="They’ll be taken off this trip, along with any fares found for them."
        confirmText="Remove"
      />
    </section>
  )
}
