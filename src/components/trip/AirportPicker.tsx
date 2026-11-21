/**
 * Pick 1–3 home airports with autocomplete over src/data/airports.json.
 * Codes only come from the list, so the value is always valid IATA.
 */
import { useId } from 'react'
import { X } from 'lucide-react'
import { airportByIata } from '@/lib/airports'
import { INPUT_LIMITS } from '@/lib/limits'
import { AirportCombobox } from './AirportCombobox'

export function AirportPicker({
  value,
  onChange,
  disabled,
  label = 'Home airports',
  inputId,
}: {
  value: string[]
  onChange: (codes: string[]) => void
  disabled?: boolean
  label?: string
  inputId?: string
}) {
  const fallbackId = useId()
  const id = inputId ?? fallbackId
  const full = value.length >= INPUT_LIMITS.homeAirportsMax

  function add(code: string) {
    if (value.includes(code) || full) return
    onChange([...value, code])
  }

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-sm font-medium leading-none">
        {label}{' '}
        <span className="font-normal text-muted-foreground">
          ({value.length}/{INPUT_LIMITS.homeAirportsMax})
        </span>
      </label>
      {value.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label="Selected airports">
          {value.map((code) => (
            <li
              key={code}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-secondary px-2.5 py-1 text-sm"
            >
              <span className="font-medium">{code}</span>
              <span className="text-muted-foreground">{airportByIata(code)?.city}</span>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onChange(value.filter((c) => c !== code))}
                aria-label={`Remove ${code}`}
                className="ml-0.5 rounded-full p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      <AirportCombobox
        id={id}
        exclude={value}
        disabled={disabled || full}
        placeholder={full ? 'Up to 3 airports' : undefined}
        onSelect={add}
        onBackspaceEmpty={() => {
          if (value.length > 0 && !disabled) onChange(value.slice(0, -1))
        }}
      />
    </div>
  )
}
