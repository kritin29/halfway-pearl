/**
 * "Your private budget 🔒": the caller's OWN budgets row (SPEC §5 budgets:
 * read/update/delete 'own', admin included). The room never sends anyone
 * else's row, so `useQuery('budgets')` here can only ever contain mine.
 * Saving also sets `hasBudget = 1` on my traveler row, which is all the rest
 * of the crew sees ("budget set ✓"), never the amount.
 */
import { useState } from 'react'
import { useMutations, useQuery, type RecordData } from 'deepspace'
import { Lock } from 'lucide-react'
import { Button, Input, Label } from '@/components/ui'
import { ErrorState, LoadingState } from '@/components/AsyncState'
import type { BudgetData, TravelerData } from '@/lib/types'

const MAX_BUDGET_USD = 100_000

export function PrivateBudget({
  tripId,
  myRow,
  onRetry,
}: {
  tripId: string
  myRow: RecordData<TravelerData>
  onRetry: () => void
}) {
  const budgets = useQuery<BudgetData>('budgets', { where: { tripId }, limit: 5 })
  const budgetWrites = useMutations<{ tripId: string; maxUsd: number }>('budgets')
  const travelerWrites = useMutations<TravelerData>('travelers')
  const ready = budgetWrites.ready && travelerWrites.ready

  const mine = budgets.records.find((r) => r.data.userId === myRow.data.userId) ?? null
  const [draft, setDraft] = useState('')
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)

  async function save() {
    const amount = Number(draft)
    if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount < 1 || amount > MAX_BUDGET_USD) {
      setStatus('error')
      setError(`Enter a whole number of dollars from 1 to ${MAX_BUDGET_USD.toLocaleString()}.`)
      return
    }
    setStatus('saving')
    setError(null)
    try {
      if (mine) await budgetWrites.putConfirmed(mine.recordId, { maxUsd: amount })
      else await budgetWrites.createConfirmed({ tripId, maxUsd: amount })
      if (myRow.data.hasBudget !== 1) await travelerWrites.putConfirmed(myRow.recordId, { hasBudget: 1 })
      setStatus('saved')
      setEditing(false)
      setDraft('')
    } catch (e) {
      setStatus('error')
      setError(e instanceof Error ? e.message : 'Your budget was not saved.')
    }
  }

  async function clear() {
    if (!mine) return
    setStatus('saving')
    setError(null)
    try {
      await budgetWrites.removeConfirmed(mine.recordId)
      await travelerWrites.putConfirmed(myRow.recordId, { hasBudget: 0 })
      setStatus('idle')
    } catch (e) {
      setStatus('error')
      setError(e instanceof Error ? e.message : 'Your budget was not removed.')
    }
  }

  return (
    <section
      aria-labelledby="budget-heading"
      className="rounded-lg border border-border bg-card p-4 sm:p-5"
      data-testid="budget-panel"
      // How many budget rows this browser received: only ever my own (0 or 1).
      // tests/trips.spec.ts reads it to prove another member's budget never arrives.
      data-budget-rows={budgets.status === 'ready' ? budgets.records.length : undefined}
    >
      <h2 id="budget-heading" className="flex items-center gap-2 text-base font-semibold">
        Your private budget <Lock className="h-4 w-4" aria-label="private" />
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Only you can see this. Others see “budget set ✓”, never the amount.
      </p>

      <div className="mt-4">
        {budgets.status === 'loading' ? (
          <LoadingState label="Loading your budget…" />
        ) : budgets.status === 'error' ? (
          <ErrorState title="Could not load your budget" message={budgets.error} onRetry={onRetry} />
        ) : mine && !editing ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm">
              Max round-trip fare:{' '}
              <span className="font-semibold" data-testid="my-budget-amount">
                ${mine.data.maxUsd.toLocaleString()}
              </span>
            </p>
            <Button
              variant="outline"
              size="sm"
              disabled={!ready || status === 'saving'}
              onClick={() => {
                setDraft(String(mine.data.maxUsd))
                setEditing(true)
                setStatus('idle')
              }}
            >
              Change
            </Button>
            <Button variant="ghost" size="sm" disabled={!ready || status === 'saving'} onClick={() => void clear()}>
              Remove
            </Button>
          </div>
        ) : (
          <form
            className="flex flex-col gap-3 sm:flex-row sm:items-end"
            onSubmit={(e) => {
              e.preventDefault()
              void save()
            }}
          >
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="budget-input">Max round-trip fare (USD)</Label>
              <Input
                id="budget-input"
                type="number"
                inputMode="numeric"
                min={1}
                max={MAX_BUDGET_USD}
                step={1}
                placeholder="e.g. 300"
                value={draft}
                disabled={!ready || status === 'saving'}
                onChange={(e) => {
                  setDraft(e.target.value)
                  setStatus('idle')
                }}
              />
            </div>
            <div className="flex gap-2">
              <Button type="submit" disabled={!ready || !draft || status === 'saving'} loading={status === 'saving'}>
                {ready ? 'Save budget' : 'Connecting…'}
              </Button>
              {editing && (
                <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              )}
            </div>
          </form>
        )}
        {status === 'error' && (
          <ErrorState
            className="mt-3"
            title="Your budget was not saved"
            message={error}
            onRetry={draft ? () => void save() : undefined}
          />
        )}
        {status === 'saved' && (
          <p role="status" className="mt-2 text-sm text-success">
            Saved. Only you can see the amount.
          </p>
        )}
      </div>
    </section>
  )
}
