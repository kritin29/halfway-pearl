/**
 * "Your settings": the caller edits their OWN travelers row directly (SPEC §5:
 * `update: 'own'`, writableFields = the constraint columns). Values are
 * validated here for a good UX; server code re-validates before using them
 * (NOTES G1).
 */
import { useEffect, useState } from 'react'
import { useMutations, type RecordData } from 'deepspace'
import { Check } from 'lucide-react'
import { Button } from '@/components/ui'
import { ErrorState } from '@/components/AsyncState'
import type { TravelerData } from '@/lib/types'
import { departHour, homeAirports, maxStops } from '@/lib/validate'
import { AirportPicker } from './AirportPicker'
import { ConstraintFields, type Constraints } from './ConstraintFields'

type Editable = Constraints & { homeAirports: string[] }

function fromRow(row: TravelerData): Editable {
  return {
    homeAirports: Array.isArray(row.homeAirports) ? row.homeAirports : [],
    maxStops: row.maxStops ?? 2,
    noRedeye: row.noRedeye ?? 0,
    earliestDepartHour: row.earliestDepartHour ?? 0,
  }
}

const same = (a: Editable, b: Editable) => JSON.stringify(a) === JSON.stringify(b)

export function YourSettings({ row }: { row: RecordData<TravelerData> }) {
  const { ready, putConfirmed } = useMutations<TravelerData>('travelers')
  const saved = fromRow(row.data)
  const [form, setForm] = useState<Editable>(saved)
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)
  const dirty = !same(form, saved)

  // Another device changed my row: follow it unless I have unsaved edits.
  const savedKey = JSON.stringify(saved)
  useEffect(() => {
    if (!dirty) setForm(JSON.parse(savedKey) as Editable)
  }, [savedKey])

  async function save() {
    const airports = homeAirports(form.homeAirports)
    const stops = maxStops(form.maxStops)
    const hour = departHour(form.earliestDepartHour)
    const invalid = [airports, stops, hour].find((v) => !v.ok)
    if (invalid && !invalid.ok) {
      setStatus('error')
      setError(invalid.error)
      return
    }
    setStatus('saving')
    setError(null)
    try {
      await putConfirmed(row.recordId, {
        homeAirports: form.homeAirports,
        maxStops: form.maxStops,
        noRedeye: form.noRedeye,
        earliestDepartHour: form.earliestDepartHour,
      })
      setStatus('saved')
    } catch (e) {
      setStatus('error')
      setError(e instanceof Error ? e.message : 'Your settings were not saved.')
    }
  }

  return (
    <section
      aria-labelledby="your-settings-heading"
      className="surface p-4 sm:p-5"
      data-testid="your-settings"
    >
      <h2 id="your-settings-heading" className="text-base font-semibold">
        Your settings
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">Everyone on the trip can see these.</p>
      <form
        className="mt-4 flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <AirportPicker
          inputId="your-airports"
          value={form.homeAirports}
          disabled={!ready || status === 'saving'}
          onChange={(homeAirports) => {
            setForm({ ...form, homeAirports })
            setStatus('idle')
          }}
        />
        <ConstraintFields
          value={form}
          disabled={!ready || status === 'saving'}
          onChange={(c) => {
            setForm({ ...form, ...c })
            setStatus('idle')
          }}
        />
        {status === 'error' && (
          <ErrorState title="Your settings were not saved" message={error} onRetry={() => void save()} />
        )}
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={!ready || !dirty || status === 'saving'} loading={status === 'saving'}>
            {ready ? 'Save settings' : 'Connecting…'}
          </Button>
          {status === 'saved' && !dirty && (
            <span role="status" className="inline-flex items-center gap-1 text-sm text-success">
              <Check className="h-4 w-4" aria-hidden /> Saved
            </span>
          )}
        </div>
      </form>
    </section>
  )
}
