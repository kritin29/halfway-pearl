/**
 * Organizer: add or edit a ghost traveler (someone who won't use the app).
 * Writes go through the addGhost / updateGhost actions; clients can't write
 * ghost rows directly.
 */
import { useState } from 'react'
import type { RecordData } from 'deepspace'
import { Button, Input, Label, Modal } from '@/components/ui'
import { ErrorState } from '@/components/AsyncState'
import { useAction } from '@/hooks/useAction'
import { isRetryable } from '@/lib/actions-client'
import { INPUT_LIMITS } from '@/lib/limits'
import type { TravelerData } from '@/lib/types'
import { homeAirports, text } from '@/lib/validate'
import { AirportPicker } from './AirportPicker'
import { ConstraintFields, type Constraints } from './ConstraintFields'

export function GhostDialog({
  tripId,
  ghost,
  open,
  onClose,
  canWrite,
}: {
  tripId: string
  /** null → add a new ghost */
  ghost: RecordData<TravelerData> | null
  open: boolean
  onClose: () => void
  canWrite: boolean
}) {
  const add = useAction<{ ghostId: string }>('addGhost')
  const update = useAction<{ ghostId: string }>('updateGhost')
  const action = ghost ? update : add
  const [name, setName] = useState(ghost?.data.displayName ?? '')
  const [airports, setAirports] = useState<string[]>(ghost?.data.homeAirports ?? [])
  const [constraints, setConstraints] = useState<Constraints>({
    maxStops: ghost?.data.maxStops ?? 2,
    noRedeye: ghost?.data.noRedeye ?? 0,
    earliestDepartHour: ghost?.data.earliestDepartHour ?? 0,
  })
  const [formError, setFormError] = useState<string | null>(null)

  async function submit() {
    setFormError(null)
    const n = text(name, 'Name', { max: INPUT_LIMITS.displayNameMax })
    if (!n.ok) return setFormError(n.error)
    const a = homeAirports(airports)
    if (!a.ok) return setFormError(a.error)
    const params = { tripId, displayName: n.value, homeAirports: a.value, ...constraints }
    const res = ghost
      ? await update.run({ ...params, ghostId: ghost.data.userId })
      : await add.run(params)
    if (res?.success) onClose()
  }

  const error = formError ?? action.error?.message ?? null
  return (
    <Modal open={open} onClose={onClose} size="md">
      <Modal.Header>
        <Modal.Title>{ghost ? `Edit ${ghost.data.displayName}` : 'Add a traveler without the app'}</Modal.Title>
        <Modal.Description>
          For someone who won’t sign in. You enter their airports; they have no private budget.
        </Modal.Description>
      </Modal.Header>
      <form
        className="contents"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <Modal.Body className="flex flex-col gap-5">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ghost-name">Name</Label>
            <Input
              id="ghost-name"
              value={name}
              maxLength={INPUT_LIMITS.displayNameMax}
              placeholder="Grandpa Joe"
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <AirportPicker inputId="ghost-airports" value={airports} onChange={setAirports} />
          <ConstraintFields value={constraints} onChange={setConstraints} />
          {error && (
            <ErrorState
              title={ghost ? 'Could not save changes' : 'Could not add traveler'}
              message={error}
              onRetry={action.error && isRetryable(action.error.code) ? () => void submit() : undefined}
            />
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!canWrite || action.pending} loading={action.pending}>
            {ghost ? 'Save' : 'Add traveler'}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  )
}
