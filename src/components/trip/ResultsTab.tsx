/**
 * Results tab (SPEC §3.6, §3.7, §7, §10): ranked destination cards with the
 * Cheapest / Fairest / Together tabs, each traveler's fare, badges, the
 * viewer's private budget line, booking links and approval votes.
 *
 * Everything is live: fare rows fill in while a search runs, aggregates land
 * when it finishes, votes update for everyone. The only budget this page ever
 * receives is the viewer's own row (`budgets` is read: 'own').
 */
import { useState, type ReactNode } from 'react'
import { useMutations, useQuery, type RecordData } from 'deepspace'
import { ExternalLink, Home, Lock, LockKeyhole, ThumbsUp } from 'lucide-react'
import { Badge, Button, ConfirmModal, Tabs, TabsList, TabsTrigger, cn, useToast } from '@/components/ui'
import { EmptyNote, ErrorState, LoadingState, Retryable } from '@/components/AsyncState'
import { useAction } from '@/hooks/useAction'
import type { PriceLevel } from '@/lib/flights'
import { formatDuration, type SortMode } from '@/lib/ranking'
import {
  buildResultCards,
  clockTime,
  sortResultCards,
  stopsLabel,
  usd,
  type ResultCard as Card,
  type ResultPerson,
} from '@/lib/results'
import type { BudgetData, CandidateData, TravelerData, TripData } from '@/lib/types'
import { DEMO_EMAILS_OFF, isDemoTrip } from '@/lib/demo'
import { emailReportText } from './BookTab'
import { DemoLabel } from './DemoLabel'
import { SearchStatus } from './SearchStatus'

interface FareData {
  candidateIata: string
  travelerId: string
  originIata: string | null
  price: number | null
  priceLevel: string | null
  stops: number | null
  durationMin: number | null
  departLocal: string | null
  arriveLocal: string | null
  airline: string | null
  bookingUrl: string | null
  status: string | null
}
interface VoteData {
  userId: string
  candidateIata: string
}

const MODES: Array<{ value: SortMode; label: string; hint: string }> = [
  { value: 'cheapest', label: 'Cheapest', hint: 'Lowest group total first.' },
  { value: 'fairest', label: 'Fairest', hint: 'Lowest highest fare first, so nobody pays far more than the rest.' },
  { value: 'together', label: 'Together', hint: 'Smallest gap between the first and last arrival first.' },
]

export function ResultsTab({
  trip,
  me,
  onGoToDestinations,
  onLocked,
}: {
  trip: RecordData<TripData>
  me: string
  onGoToDestinations: () => void
  onLocked: () => void
}) {
  return (
    <Retryable>
      {(retry) => (
        <ResultsContent trip={trip} me={me} onRetry={retry} onGoToDestinations={onGoToDestinations} onLocked={onLocked} />
      )}
    </Retryable>
  )
}

function ResultsContent({
  trip,
  me,
  onRetry,
  onGoToDestinations,
  onLocked,
}: {
  trip: RecordData<TripData>
  me: string
  onRetry: () => void
  onGoToDestinations: () => void
  onLocked: () => void
}) {
  const toast = useToast()
  const lock = useAction<{ emails: Parameters<typeof emailReportText>[0] }>('lockTrip')
  const [locking, setLocking] = useState<Card | null>(null)
  const tripId = trip.recordId
  const candidates = useQuery<CandidateData>('candidates', { where: { tripId }, limit: 20 })
  // ≤ 6 destinations × ≤ 8 travelers = 48 fares / votes per trip.
  const fares = useQuery<FareData>('fares', { where: { tripId }, limit: 100 })
  const votes = useQuery<VoteData>('votes', { where: { tripId }, limit: 100 })
  const travelers = useQuery<TravelerData>('travelers', { where: { tripId }, limit: 20 })
  // read: 'own' — the room only ever sends my own row.
  const budgets = useQuery<BudgetData>('budgets', { where: { tripId }, limit: 5 })
  const [mode, setMode] = useState<SortMode>('cheapest')

  const all = [candidates, fares, votes, travelers, budgets]
  if (all.some((q) => q.status === 'loading')) return <LoadingState label="Loading results…" />
  const failed = all.find((q) => q.status === 'error')
  if (failed) return <ErrorState title="Could not load results" message={failed.error} onRetry={onRetry} />

  const myBudget = budgets.records.find((b) => b.data.userId === me)?.data.maxUsd
  const cards = buildResultCards({
    candidates: [...candidates.records].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((r) => r.data),
    fares: fares.records.map((r) => r.data),
    travelers: [...travelers.records]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((r) => ({ userId: r.data.userId, displayName: r.data.displayName })),
    votes: votes.records.map((r) => r.data),
    me,
    myBudget: typeof myBudget === 'number' && myBudget > 0 ? myBudget : null,
  })
  const searching = trip.data.status === 'searching'
  // During a search, cards show up right away and fill in as fare rows arrive.
  const show = cards.some((c) => c.checked) || (searching && cards.length > 0)
  const isOrganizer = trip.data.organizerId === me
  const sorted = sortResultCards(cards, mode)
  const locked = trip.data.status === 'locked'
  // Lockable: organizer, results are in, and everyone has a fare there.
  const canLock = isOrganizer && trip.data.status === 'results'
  const demo = isDemoTrip(trip.data)

  async function confirmLock() {
    if (!locking) return
    const res = await lock.run({ tripId, iata: locking.iata })
    if (!res) return
    if (res.success) {
      toast.success(`Locked ${locking.city}`, emailReportText(res.data.emails))
      setLocking(null)
      onLocked()
    } else {
      toast.error(`Could not lock ${locking.city}`, res.error)
    }
  }

  return (
    <div className="flex flex-col gap-4" data-testid="results">
      <SearchStatus trip={trip} />

      {!show ? (
        searching ? null : (
          <div data-testid="results-empty">
            <EmptyNote title="No fares yet">
              {isOrganizer ? (
                <>
                  Add destinations, then press <strong>Find fares</strong> to compare everyone’s round-trip fares.{' '}
                  <button type="button" className="underline underline-offset-4" onClick={onGoToDestinations}>
                    Go to Destinations
                  </button>
                </>
              ) : (
                'When the organizer runs Find fares, ranked destinations show up here for everyone.'
              )}
            </EmptyNote>
          </div>
        )
      ) : (
        <>
          <Tabs value={mode} onValueChange={(v) => setMode(v as SortMode)}>
            <TabsList className="w-full sm:w-fit" aria-label="Sort destinations">
              {MODES.map((m) => (
                <TabsTrigger key={m.value} value={m.value}>
                  {m.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <p className="text-sm text-muted-foreground">{MODES.find((m) => m.value === mode)?.hint}</p>
          <ol className="flex flex-col gap-3" data-testid="result-list" data-mode={mode}>
            {sorted.map((card, i) => (
              <ResultCard
                key={card.iata}
                card={card}
                rank={card.checked && card.complete ? i + 1 : null}
                tripId={tripId}
                locked={locked}
                lockedHere={locked && trip.data.lockedIata === card.iata}
                searching={searching}
                demo={demo}
                onLock={canLock && card.checked && card.complete ? () => setLocking(card) : null}
              />
            ))}
          </ol>
        </>
      )}
      <ConfirmModal
        open={locking !== null}
        onClose={() => setLocking(null)}
        onConfirm={() => void confirmLock()}
        loading={lock.pending}
        variant="default"
        title={`Lock ${locking ? `${locking.city} (${locking.iata})` : 'this destination'}?`}
        description={
          demo
            ? `Voting closes, nobody new can join, and everyone’s booking link moves to the Book tab. ${DEMO_EMAILS_OFF} This can’t be undone.`
            : 'Everyone on the app gets an email with their own booking link, voting closes, and nobody new can join. This can’t be undone.'
        }
        confirmText={demo ? 'Lock destination' : 'Lock and email everyone'}
      />
    </div>
  )
}

const LEVEL_BADGE: Record<Exclude<PriceLevel, 'unknown'>, { label: string; variant: 'success' | 'secondary' | 'warning'; title: string }> = {
  low: { label: 'Low prices', variant: 'success', title: 'Below Google Flights’ typical range for these routes' },
  typical: { label: 'Typical prices', variant: 'secondary', title: 'Within Google Flights’ typical range' },
  high: { label: 'High prices', variant: 'warning', title: 'At least one route is above its typical range' },
}

function ResultCard({
  card,
  rank,
  tripId,
  locked,
  lockedHere,
  searching,
  demo,
  onLock,
}: {
  card: Card
  rank: number | null
  tripId: string
  locked: boolean
  lockedHere: boolean
  searching: boolean
  demo: boolean
  onLock: (() => void) | null
}) {
  const level = card.priceLevel === 'unknown' ? null : LEVEL_BADGE[card.priceLevel]
  return (
    <li
      className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 sm:p-5"
      data-testid="result-card"
      data-iata={card.iata}
      data-complete={card.complete ? '1' : '0'}
      data-total={card.groupTotal ?? ''}
      data-maxfare={card.maxFare ?? ''}
      data-spread={card.arrivalSpreadMin ?? ''}
    >
      {demo && <DemoLabel />}
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-12 shrink-0 items-center justify-center rounded-md bg-secondary font-mono text-sm font-semibold">
          {card.iata}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-1.5">
            {rank !== null && <span className="text-sm text-muted-foreground">#{rank}</span>}
            <h3 className="font-semibold">{card.city}</h3>
            <span className="text-sm text-muted-foreground">{card.country}</span>
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {lockedHere && (
              <Badge variant="default" size="sm" data-testid="locked-badge">
                <LockKeyhole className="h-3 w-3" aria-hidden /> Locked
              </Badge>
            )}
            {level && (
              <Badge variant={level.variant} size="sm" title={level.title} data-testid="price-level-badge">
                {level.label}
              </Badge>
            )}
            {card.fitsAll === 1 && (
              <Badge variant="success" size="sm" data-testid="fits-all-badge">
                Fits everyone’s budget
              </Badge>
            )}
            {card.fitsAll === 0 && (
              <Badge variant="outline" size="sm" data-testid="fits-all-badge">
                Over someone’s budget
              </Badge>
            )}
            {card.arrival && (
              <Badge variant="info" size="sm" data-testid="arrival-badge">
                {card.arrival}
              </Badge>
            )}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-lg font-semibold tabular-nums" data-testid="group-total">
            {card.complete ? usd(card.groupTotal) : '—'}
          </p>
          <p className="text-xs text-muted-foreground">group total</p>
        </div>
      </div>

      {!card.checked ? (
        <p className="text-sm text-muted-foreground" data-testid="not-checked">
          {searching
            ? 'Fares are coming in. The total and ranking appear when the search finishes.'
            : 'Added after the last search. Run Find fares again to price it.'}
        </p>
      ) : (
        !card.complete &&
        card.missingFor.length > 0 && (
          <p className="text-sm text-muted-foreground" data-testid="missing-fares">
            Missing fares for {card.missingFor.join(', ')}
          </p>
        )
      )}

      <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
        {card.people.map((p) => (
          <PersonRow key={p.travelerId} person={p} />
        ))}
      </ul>

      {card.own && (
        <p className="flex items-start gap-1.5 text-sm" data-testid="own-fit">
          <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span>
            <span className="text-muted-foreground">Only you see this: </span>
            your {usd(card.own.price)} fare is{' '}
            <span className={cn('font-medium', card.own.fits ? 'text-success' : 'text-destructive')}>
              {card.own.diff === 0 ? 'exactly' : `${usd(Math.abs(card.own.diff))} ${card.own.fits ? 'under' : 'over'}`}
            </span>{' '}
            your {usd(card.own.budget)} budget.
          </span>
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <VoteButton tripId={tripId} card={card} locked={locked} />
        {onLock && (
          <Button type="button" size="sm" variant="outline" onClick={onLock} data-testid="lock-button">
            <LockKeyhole aria-hidden />
            Lock this destination
          </Button>
        )}
      </div>
    </li>
  )
}

const STATUS_TEXT: Record<string, string> = {
  no_results: 'No flights found',
  filtered_out: 'No flights match their settings',
  error: 'Couldn’t check this fare',
}

function PersonRow({ person }: { person: ResultPerson }) {
  const f = person.fare
  const name = person.isMe ? `${person.displayName} (you)` : person.displayName
  let detail: ReactNode
  if (!f) detail = <span className="text-muted-foreground">Waiting for a fare…</span>
  else if (f.home)
    detail = (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <Home className="h-3.5 w-3.5" aria-hidden /> Lives here, no flight needed
      </span>
    )
  else if (f.status !== 'ok') detail = <span className="text-muted-foreground">{STATUS_TEXT[f.status] ?? STATUS_TEXT.error}</span>
  else {
    const dep = clockTime(f.departLocal)
    const arr = clockTime(f.arriveLocal)
    detail = (
      <span className="text-muted-foreground">
        {[
          f.originIata && `From ${f.originIata}`,
          stopsLabel(f.stops),
          dep && arr && `${dep} → ${arr}`,
          f.durationMin ? formatDuration(f.durationMin) : null,
          f.airline,
        ]
          .filter(Boolean)
          .join(' · ')}
      </span>
    )
  }
  return (
    <li className="flex items-start gap-3 px-3 py-2.5 text-sm" data-testid="result-person" data-traveler={person.displayName}>
      <div className="min-w-0 flex-1">
        <p className="font-medium">{name}</p>
        <p className="mt-0.5 break-words text-xs">{detail}</p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <span className="font-semibold tabular-nums" data-testid="person-price">
          {f?.status === 'ok' ? usd(f.price) : '—'}
        </span>
        {f?.status === 'ok' && !f.home && f.bookingUrl && (
          <a
            href={f.bookingUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 text-xs text-primary underline-offset-4 hover:underline"
            aria-label={`Book ${person.isMe ? 'your' : `${person.displayName}’s`} flight on Google Flights`}
          >
            Book <ExternalLink className="h-3 w-3" aria-hidden />
          </a>
        )}
      </div>
    </li>
  )
}

function VoteButton({ tripId, card, locked }: { tripId: string; card: Card; locked: boolean }) {
  const toast = useToast()
  const vote = useAction<{ voted: boolean }>('toggleVote')
  const { ready } = useMutations('votes')
  const { count, mine, voters } = card.votes

  async function toggle() {
    const res = await vote.run({ tripId, iata: card.iata })
    if (res && !res.success) toast.error(`Could not update your vote for ${card.iata}`, res.error)
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button
        type="button"
        size="sm"
        variant={mine ? 'default' : 'outline'}
        aria-pressed={mine}
        aria-label={`${mine ? 'Remove your vote for' : 'Vote for'} ${card.city}`}
        onClick={() => void toggle()}
        loading={vote.pending}
        disabled={!ready || locked || vote.pending}
        data-testid="vote-button"
      >
        {!vote.pending && <ThumbsUp aria-hidden />}
        {mine ? 'Voted' : 'Vote'}
      </Button>
      <span className="text-sm text-muted-foreground" data-testid="vote-count" data-count={count}>
        {count === 0 ? 'No votes yet' : `${count} ${count === 1 ? 'vote' : 'votes'}: ${voters.join(', ')}`}
      </span>
    </div>
  )
}
