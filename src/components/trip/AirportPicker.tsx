/**
 * Pick 1–3 home airports with autocomplete over src/data/airports.json.
 * Codes only come from the list, so the value is always valid IATA.
 */
import { useId, useState, type KeyboardEvent } from 'react'
import { X } from 'lucide-react'
import { Input } from '@/components/ui'
import { airportByIata, searchAirports } from '@/lib/airports'
import { INPUT_LIMITS } from '@/lib/limits'

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
  const listId = `${id}-options`
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const full = value.length >= INPUT_LIMITS.homeAirportsMax
  const options = full ? [] : searchAirports(query, value)

  function add(code: string) {
    if (value.includes(code) || full) return
    onChange([...value, code])
    setQuery('')
    setActive(0)
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => Math.min(i + 1, options.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' && options[active]) {
      e.preventDefault()
      add(options[active].iata)
    } else if (e.key === 'Backspace' && !query && value.length > 0) {
      onChange(value.slice(0, -1))
    }
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
      <div className="relative">
        <Input
          id={id}
          role="combobox"
          aria-expanded={options.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          autoComplete="off"
          disabled={disabled || full}
          placeholder={full ? 'Up to 3 airports' : 'Search by city or code, e.g. Chicago or ORD'}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(0)
          }}
          onKeyDown={onKeyDown}
        />
        {options.length > 0 && (
          <ul
            id={listId}
            role="listbox"
            className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-md border border-border bg-popover p-1 shadow-md"
          >
            {options.map((a, i) => (
              <li
                key={a.iata}
                role="option"
                aria-selected={i === active}
                // mousedown, not click: keeps the input from blurring first.
                onMouseDown={(e) => {
                  e.preventDefault()
                  add(a.iata)
                }}
                onMouseEnter={() => setActive(i)}
                className={`flex cursor-pointer items-baseline gap-2 rounded-sm px-2 py-2 text-sm ${
                  i === active ? 'bg-accent text-accent-foreground' : ''
                }`}
              >
                <span className="w-10 font-semibold">{a.iata}</span>
                <span className="truncate">
                  {a.city}, {a.country}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
