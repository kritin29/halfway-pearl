/** Max stops / no red-eyes / earliest departure, shared by "Your settings" and the ghost dialog. */
import { useId } from 'react'
import { Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch } from '@/components/ui'
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

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, h) => ({
  value: h,
  label: h === 0 ? 'Any time' : `${hourLabel(h)} or later`,
}))

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
        <Label id={`${id}-stops-label`} htmlFor={`${id}-stops`}>
          Max stops
        </Label>
        <Select
          value={String(value.maxStops)}
          disabled={disabled}
          onValueChange={(v) => onChange({ ...value, maxStops: Number(v) })}
        >
          <SelectTrigger id={`${id}-stops`} aria-labelledby={`${id}-stops-label`} className="bg-background">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STOP_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={String(o.value)}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label id={`${id}-hour-label`} htmlFor={`${id}-hour`}>
          Earliest departure
        </Label>
        <Select
          value={String(value.earliestDepartHour)}
          disabled={disabled}
          onValueChange={(v) => onChange({ ...value, earliestDepartHour: Number(v) })}
        >
          <SelectTrigger id={`${id}-hour`} aria-labelledby={`${id}-hour-label`} className="bg-background">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {HOUR_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={String(o.value)}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
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
