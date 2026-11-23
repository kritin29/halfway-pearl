/**
 * "Next step" guide at the top of the trip page: a six-stop progress line
 * (airports → destinations → fares → vote → lock → book) and one card saying
 * what the viewer can do now, with a button that switches tab. The decision
 * lives in src/lib/next-step.ts (unit-tested); this only gathers the inputs.
 *
 * It reads the same trip-scoped rows the tabs do. While those load, or if
 * they fail, it renders nothing: each tab already shows its own loading and
 * error-with-retry states, and a guide that guesses would mislead.
 */
import type { RecordData } from 'deepspace'
import { useQuery } from 'deepspace'
import { ArrowRight, Check } from 'lucide-react'
import { Button, cn } from '@/components/ui'
import { nextStep, STAGES, type TripTab } from '@/lib/next-step'
import type { CandidateData, TravelerData, TripData, VoteData } from '@/lib/types'
import { isDemoTrip } from '@/lib/demo'

function hasAirports(row: RecordData<TravelerData>): boolean {
  return Array.isArray(row.data.homeAirports) && row.data.homeAirports.length > 0
}

export function NextStepGuide({
  trip,
  me,
  onGoTo,
}: {
  trip: RecordData<TripData>
  me: string
  onGoTo: (tab: TripTab) => void
}) {
  const tripId = trip.recordId
  const travelers = useQuery<TravelerData>('travelers', { where: { tripId }, limit: 20 })
  const candidates = useQuery<CandidateData>('candidates', { where: { tripId }, limit: 20 })
  const votes = useQuery<VoteData>('votes', { where: { tripId }, limit: 200 })

  if ([travelers, candidates, votes].some((q) => q.status !== 'ready')) return null

  const mine = travelers.records.find((r) => r.data.userId === me)
  const step = nextStep({
    status: trip.data.status,
    isOrganizer: trip.data.organizerId === me,
    iHaveAirports: mine ? hasAirports(mine) : false,
    travelersWithAirports: travelers.records.filter(hasAirports).length,
    candidateCount: candidates.records.length,
    iVoted: votes.records.some((v) => v.data.userId === me),
    iBooked: mine?.data.booked === 1,
    bookedCount: travelers.records.filter((r) => r.data.booked === 1).length,
    travelerCount: travelers.records.length,
    isDemo: isDemoTrip(trip.data),
  })

  return (
    <section
      aria-labelledby="next-step-heading"
      data-testid="next-step"
      data-stage={step.stage}
      className={cn(
        'surface relative overflow-hidden p-4 sm:p-5',
        step.done ? 'border-success/40 bg-gradient-to-br from-success/10 to-card' : 'border-primary/30',
      )}
    >
      <span
        aria-hidden
        className={cn('absolute inset-y-0 left-0 w-1', step.done ? 'bg-success' : 'bg-gradient-to-b from-primary to-coral')}
      />
      <ol className="flex items-center" aria-label={`Step ${step.index + 1} of ${STAGES.length}: ${STAGES[step.index].label}`}>
        {STAGES.map((s, i) => {
          const past = i < step.index || (i === step.index && step.done)
          const current = i === step.index && !step.done
          return (
            <li key={s.key} className={cn('flex items-center', i < STAGES.length - 1 && 'flex-1')} aria-hidden>
              <span className="flex flex-col items-center gap-1">
                <span
                  className={cn(
                    'flex h-6 w-6 items-center justify-center rounded-full border-2 text-[11px] font-bold transition-colors',
                    past && 'border-success bg-success text-success-foreground',
                    current && 'pulse-ring border-primary bg-primary text-primary-foreground',
                    !past && !current && 'border-border bg-card text-muted-foreground',
                  )}
                >
                  {past ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : i + 1}
                </span>
                <span
                  className={cn(
                    'hidden text-[11px] sm:block',
                    current
                      ? 'font-semibold text-accent-foreground'
                      : past
                        ? 'font-medium text-success-ink'
                        : 'text-muted-foreground',
                  )}
                >
                  {s.label}
                </span>
              </span>
              {i < STAGES.length - 1 && (
                <span
                  className={cn(
                    'mx-1 h-0 flex-1 border-t-2 sm:mb-5',
                    i < step.index || (i === step.index && step.done) ? 'border-success' : 'border-dashed border-border',
                  )}
                />
              )}
            </li>
          )
        })}
      </ol>

      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p
            className={cn(
              'font-mono text-[11px] font-medium uppercase tracking-wider',
              step.done ? 'text-success-ink' : 'text-accent-foreground',
            )}
          >
            {step.done ? 'All set' : `Next · step ${step.index + 1} of ${STAGES.length}`}
          </p>
          <h2 id="next-step-heading" className="mt-0.5 font-display text-lg font-bold" data-testid="next-step-title">
            {step.title}
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">{step.body}</p>
        </div>
        {step.action && (
          <Button
            variant={step.done ? 'outline' : 'default'}
            className="group w-full shrink-0 sm:w-fit"
            onClick={() => onGoTo(step.action!.tab)}
          >
            {step.action.label}{' '}
            <ArrowRight aria-hidden className="transition-transform motion-safe:group-hover:translate-x-0.5" />
          </Button>
        )}
      </div>
    </section>
  )
}
