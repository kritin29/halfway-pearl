/**
 * Airport autocomplete over src/data/airports.json: type a city or code, pick
 * with the mouse or arrow keys + Enter. Codes only come from the list, so a
 * picked value is always a known IATA code. Used by AirportPicker (home
 * airports) and the Destinations tab (add a candidate).
 */
import { useState, type KeyboardEvent } from 'react'
import { Input } from '@/components/ui'
import { searchAirports } from '@/lib/airports'

export function AirportCombobox({
  id,
  onSelect,
  exclude = [],
  disabled,
  placeholder = 'Search by city or code, e.g. Chicago or ORD',
  onBackspaceEmpty,
  'aria-label': ariaLabel,
}: {
  id: string
  onSelect: (code: string) => void
  exclude?: readonly string[]
  disabled?: boolean
  placeholder?: string
  /** Backspace in an empty input (AirportPicker removes the last chip). */
  onBackspaceEmpty?: () => void
  'aria-label'?: string
}) {
  const listId = `${id}-options`
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const options = disabled ? [] : searchAirports(query, exclude)

  function pick(code: string) {
    onSelect(code)
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
      pick(options[active].iata)
    } else if (e.key === 'Escape') {
      setQuery('')
    } else if (e.key === 'Backspace' && !query) {
      onBackspaceEmpty?.()
    }
  }

  return (
    <div className="relative">
      <Input
        id={id}
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={options.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        autoComplete="off"
        disabled={disabled}
        placeholder={placeholder}
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
                pick(a.iata)
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
  )
}
