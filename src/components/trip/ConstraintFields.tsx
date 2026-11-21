/** Max stops / no red-eyes / earliest departure, shared by "Your settings" and the ghost dialog. */
import { useId } from 'react'
import { Label, Switch } from '@/components/ui'
import { hourLabel } from '@/lib/format'

export interface Constraints {
  maxStops: number
  noRedeye: number
  earliestDepartHour: number
}

const STOP_OPTIONS = [
  { value: 0, label: 'Nonstop only' },
  { value: 1, label: 'Up to 1 stop' },
  { value: 2, label: 'Any number of stops' },
]

const selectClass =
  'h-10 w-full rounded-md border border-input bg-background px-3 text-base shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm'

export function ConstraintFields({
  value,
  onChange,
  disabled,
}: {
  value: Constraints
  onChange: (next: Constraints) => void
  disabled?: boolean
}) {
  const id = useId()
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-stops`}>Max stops</Label>
        <select
          id={`${id}-stops`}
          className={selectClass}
          disabled={disabled}
          value={value.maxStops}
          onChange={(e) => onChange({ ...value, maxStops: Number(e.target.value) })}
        >
          {STOP_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-hour`}>Earliest departure</Label>
        <select
          id={`${id}-hour`}
          className={selectClass}
          disabled={disabled}
          value={value.earliestDepartHour}
          onChange={(e) => onChange({ ...value, earliestDepartHour: Number(e.target.value) })}
        >
          {Array.from({ length: 24 }, (_, h) => (
            <option key={h} value={h}>
              {h === 0 ? 'Any time' : `${hourLabel(h)} or later`}
            </option>
          ))}
        </select>
      </div>
      <div className="flex items-center justify-between gap-3 sm:col-span-2">
        <Label htmlFor={`${id}-redeye`} className="flex flex-col gap-0.5">
          <span>No red-eyes</span>
          <span className="text-xs font-normal text-muted-foreground">
            Skip flights leaving 9 PM–5 AM or landing the next day
          </span>
        </Label>
        <Switch
          id={`${id}-redeye`}
          disabled={disabled}
          checked={value.noRedeye === 1}
          onCheckedChange={(checked) => onChange({ ...value, noRedeye: checked ? 1 : 0 })}
        />
      </div>
    </div>
  )
}
