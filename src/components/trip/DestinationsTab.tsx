/**
 * Destinations tab (SPEC §3.4, §10): the candidate list (live for every
 * member), add-by-search for any member, and the organizer's "Suggest with
 * AI", "Add geographic middle" and remove controls. Every write goes through
 * a server action (candidates are server-written only); the list updates from
 * `useQuery`, so other members' changes show up without a reload.
 */
import { useId, useState } from 'react'
import { useMutations, useQuery, type RecordData } from 'deepspace'
import { Compass, Plane, Sparkles, Trash2 } from 'lucide-react'
import { Badge, Button, ConfirmModal, useToast } from '@/components/ui'
import { EmptyNote, ErrorState, LoadingState, Retryable } from '@/components/AsyncState'
import { useAction, type ActionError } from '@/hooks/useAction'
import { isRetryable } from '@/lib/actions-client'
import { knownHomeAirports } from '@/lib/airports'
import { LIMITS } from '@/lib/limits'
import type { CandidateData, CandidateSource, TravelerData, TripData } from '@/lib/types'
import { AirportCombobox } from './AirportCombobox'

interface Added {
  added: Array<{ iata: string; city: string; why: string; source: CandidateSource }>
}

export function DestinationsTab({ trip, me }: { trip: RecordData<TripData>; me: string }) {
  return <Retryable>{(retry) => <DestinationsContent trip={trip} me={me} onRetry={retry} />}</Retryable>
}

function DestinationsContent({
  trip,
  me,
  onRetry,
}: {
  trip: RecordData<TripData>
  me: string
  onRetry: () => void
}) {
  const tripId = trip.recordId
  const isOrganizer = trip.data.organizerId === me
  const candidates = useQuery<CandidateData>('candidates', { where: { tripId }, limit: 20 })
  const travelers = useQuery<TravelerData>('travelers', { where: { tripId }, limit: 20 })
  const { ready } = useMutations('candidates')

  if (candidates.status === 'loading' || travelers.status === 'loading') {
    return <LoadingState label="Loading destinations…" />
  }
  if (candidates.status === 'error' || travelers.status === 'error') {
    return (
      <ErrorState
        title="Could not load destinations"
        message={candidates.error ?? travelers.error}
        onRetry={onRetry}
      />
    )
  }

  const list = [...candidates.records].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const codes = list.map((c) => c.data.iata)
  const full = list.length >= LIMITS.maxCandidates
  const names = new Map(travelers.records.map((t) => [t.data.userId, t.data.displayName]))
  const withAirports = travelers.records.filter((t) => knownHomeAirports(t.data.homeAirports).length > 0).length
  const frozen =
    trip.data.status === 'locked'
      ? 'This trip is locked, so its destinations can’t change.'
      : trip.data.status === 'searching'
        ? 'Fares are being checked right now. Destinations can change again when the search finishes.'
        : null
  const canWrite = ready && !frozen

  return (
    <div className="flex flex-col gap-6">
      <section
        aria-labelledby="destinations-heading"
        className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4 sm:p-5"
      >
        <div className="flex items-baseline justify-between gap-3">
          <h2 id="destinations-heading" className="text-base font-semibold">
            Destinations{' '}
            <span className="font-normal text-muted-foreground" data-testid="candidate-count">
              ({list.length}/{LIMITS.maxCandidates})
            </span>
          </h2>
        </div>

        {frozen && <p className="text-sm text-muted-foreground">{frozen}</p>}

        {isOrganizer && (
          <OrganizerTools
            tripId={tripId}
            canWrite={canWrite}
            full={full}
            travelersWithAirports={withAirports}
          />
        )}

        <AddDestination tripId={tripId} exclude={codes} disabled={!canWrite} full={full} />

        {list.length === 0 ? (
          <div data-testid="destinations-empty">
            <EmptyNote title="No destinations yet">
              {isOrganizer
                ? `Search for a city above, ask AI for ideas that fit your vibe, or add the geographic middle of everyone’s home airports. Up to ${LIMITS.maxCandidates}.`
                : `Search for a city above to put it on the list (up to ${LIMITS.maxCandidates}). The organizer can also ask AI for ideas or add the geographic middle.`}
            </EmptyNote>
          </div>
        ) : (
          <CandidateList
            tripId={tripId}
            list={list}
            names={names}
            me={me}
            canRemove={isOrganizer && canWrite}
          />
        )}
      </section>

      <FindFares />
    </div>
  )
}

/** "Suggest with AI" and "Add geographic middle" (organizer only). */
function OrganizerTools({
  tripId,
  canWrite,
  full,
  travelersWithAirports,
}: {
  tripId: string
  canWrite: boolean
  full: boolean
  travelersWithAirports: number
}) {
  const toast = useToast()
  const suggest = useAction<Added & { dropped: number }>('suggestCandidates')
  const middle = useAction<Added>('addMidpointHubs')
  const busy = suggest.pending || middle.pending
  const aiBlocked = travelersWithAirports < 1
  const middleBlocked = travelersWithAirports < 2

  async function runSuggest() {
    middle.reset()
    const res = await suggest.run({ tripId })
    if (!res?.success) return
    const n = res.data.added.length
    if (n > 0) toast.success(`Added ${n} AI suggestion${n === 1 ? '' : 's'}`)
    else toast.info('No new suggestions', 'The AI didn’t come up with usable airports this time. Try again, or add one by hand.')
  }

  async function runMiddle() {
    suggest.reset()
    const res = await middle.run({ tripId })
    if (!res?.success) return
    const n = res.data.added.length
    if (n > 0) toast.success(`Added ${n} geographic middle ${n === 1 ? 'hub' : 'hubs'}`)
    else toast.info('No new hubs', 'The nearest major airports to the middle are already on the list.')
  }

  const hint = full
    ? `The list is full. Remove a destination to add more.`
    : middleBlocked
      ? aiBlocked
        ? 'AI ideas need at least one traveler’s home airports, and the geographic middle needs two. Set them in the Crew tab.'
        : 'The geographic middle needs home airports for at least 2 travelers (set them in the Crew tab).'
      : null

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap">
        <Button
          type="button"
          onClick={() => void runSuggest()}
          loading={suggest.pending}
          disabled={!canWrite || full || aiBlocked || busy}
        >
          {!suggest.pending && <Sparkles aria-hidden />}
          {suggest.pending ? 'Asking AI…' : 'Suggest with AI'}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => void runMiddle()}
          loading={middle.pending}
          disabled={!canWrite || full || middleBlocked || busy}
        >
          {!middle.pending && <Compass aria-hidden />}
          {middle.pending ? 'Finding the middle…' : 'Add geographic middle'}
        </Button>
      </div>
      {hint && (
        <p className="text-sm text-muted-foreground" data-testid="organizer-tools-hint">
          {hint}
        </p>
      )}
      <ActionErrorNote
        title="Could not get AI suggestions"
        error={suggest.error}
        onRetry={() => void runSuggest()}
        testId="suggest-error"
      />
      <ActionErrorNote
        title="Could not add the geographic middle"
        error={middle.error}
        onRetry={() => void runMiddle()}
        testId="middle-error"
      />
    </div>
  )
}

/** Inline error; "Try again" only when the same request might succeed. */
function ActionErrorNote({
  title,
  error,
  onRetry,
  testId,
}: {
  title: string
  error: ActionError | null
  onRetry: () => void
  testId: string
}) {
  if (!error) return null
  const retryable = isRetryable(error.code) || error.code === 'ai_error'
  return <ErrorState title={title} message={error.message} onRetry={retryable ? onRetry : undefined} testId={testId} />
}

/** Search-and-add, for any member. Picking an airport adds it right away. */
function AddDestination({
  tripId,
  exclude,
  disabled,
  full,
}: {
  tripId: string
  exclude: string[]
  disabled: boolean
  full: boolean
}) {
  const id = useId()
  const toast = useToast()
  const add = useAction<Added>('addCandidate')
  const [last, setLast] = useState<string | null>(null)

  async function addCode(code: string) {
    setLast(code)
    const res = await add.run({ tripId, iata: code })
    if (res?.success) toast.success(`Added ${res.data.added[0]?.city ?? code}`)
  }

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-sm font-medium leading-none">
        Add a destination
      </label>
      <AirportCombobox
        id={id}
        exclude={exclude}
        disabled={disabled || full || add.pending}
        placeholder={full ? `The list is full (${LIMITS.maxCandidates} max)` : 'City or code, e.g. Austin or AUS'}
        onSelect={(code) => void addCode(code)}
      />
      {add.pending && (
        <p role="status" className="text-sm text-muted-foreground">
          Adding {last}…
        </p>
      )}
      <ActionErrorNote
        title={`Could not add ${last ?? 'that destination'}`}
        error={add.error}
        onRetry={() => last && void addCode(last)}
        testId="add-error"
      />
    </div>
  )
}

const SOURCE_BADGE: Record<CandidateSource, { label: string; variant: 'info' | 'secondary' | 'outline'; title: string }> = {
  ai: { label: 'AI', variant: 'info', title: 'Suggested by AI from the vibe and everyone’s home airports' },
  midpoint: { label: 'Middle', variant: 'secondary', title: 'Near the geographic middle of everyone’s home airports' },
  manual: { label: 'Manual', variant: 'outline', title: 'Added by a traveler' },
}

function CandidateList({
  tripId,
  list,
  names,
  me,
  canRemove,
}: {
  tripId: string
  list: RecordData<CandidateData>[]
  names: Map<string, string>
  me: string
  canRemove: boolean
}) {
  const toast = useToast()
  const remove = useAction<{ iata: string }>('removeCandidate')
  const [removing, setRemoving] = useState<RecordData<CandidateData> | null>(null)

  async function confirmRemove() {
    if (!removing) return
    const res = await remove.run({ tripId, iata: removing.data.iata })
    if (res?.success) setRemoving(null)
    else if (res) toast.error(`Could not remove ${removing.data.iata}`, res.error)
  }

  return (
    <>
      <ul className="flex flex-col divide-y divide-border" data-testid="candidate-list">
        {list.map((c) => {
          const badge = SOURCE_BADGE[c.data.source] ?? SOURCE_BADGE.manual
          const by = c.data.addedBy === me ? 'you' : names.get(c.data.addedBy)
          return (
            <li key={c.recordId} data-testid="candidate" data-iata={c.data.iata} className="flex items-start gap-3 py-3">
              <div className="flex h-10 w-12 shrink-0 items-center justify-center rounded-md bg-secondary font-mono text-sm font-semibold">
                {c.data.iata}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                  <span className="font-medium">{c.data.city}</span>
                  <span className="text-sm text-muted-foreground">{c.data.country}</span>
                  <Badge variant={badge.variant} size="sm" title={badge.title} data-testid="candidate-source">
                    {badge.label}
                  </Badge>
                </div>
                {c.data.why && (
                  <p className="mt-1 text-sm text-foreground/80" data-testid="candidate-why">
                    {c.data.why}
                  </p>
                )}
                {by && <p className="mt-1 text-xs text-muted-foreground">Added by {by}</p>}
              </div>
              {canRemove && (
                <Button
                  size="icon"
                  variant="ghost"
                  className="shrink-0"
                  aria-label={`Remove ${c.data.iata}`}
                  onClick={() => setRemoving(c)}
                >
                  <Trash2 aria-hidden />
                </Button>
              )}
            </li>
          )
        })}
      </ul>
      <ConfirmModal
        open={removing !== null}
        onClose={() => setRemoving(null)}
        onConfirm={() => void confirmRemove()}
        loading={remove.pending}
        title={`Remove ${removing ? `${removing.data.city} (${removing.data.iata})` : 'destination'}?`}
        description="It comes off the list for everyone, along with any fares and votes for it."
        confirmText="Remove"
      />
    </>
  )
}

/** Placeholder until fare search ships (Phase 5). */
function FindFares() {
  return (
    <section aria-labelledby="fares-heading" className="rounded-lg border border-dashed border-border p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 id="fares-heading" className="text-base font-semibold">
            Fares
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Coming next: check round-trip fares for every traveler to every destination.
          </p>
        </div>
        <Button type="button" disabled className="w-full sm:w-auto" title="Coming next">
          <Plane aria-hidden /> Find fares
          <span className="rounded bg-background/20 px-1.5 py-px text-[10px] uppercase tracking-wide">coming next</span>
        </Button>
      </div>
    </section>
  )
}
