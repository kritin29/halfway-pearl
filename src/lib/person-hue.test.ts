import { describe, expect, it } from 'vitest'
import { initial, personHue, PERSON_HUES } from './person-hue'

describe('personHue', () => {
  it('is stable for the same id', () => {
    expect(personHue('user_abc')).toBe(personHue('user_abc'))
  })
  it('always returns a known hue, including for an empty id', () => {
    for (const id of ['', 'a', 'ghost_1', 'user_01M7Y1KPVWN9MTNMKE1E76537K', 'ü']) {
      expect(PERSON_HUES).toContain(personHue(id))
    }
  })
  it('spreads ids across more than one hue', () => {
    const hues = new Set(Array.from({ length: 30 }, (_, i) => personHue(`ghost_${i}`)))
    expect(hues.size).toBeGreaterThan(3)
  })
})

describe('initial', () => {
  it('uppercases the first non-space letter', () => {
    expect(initial('  priya')).toBe('P')
  })
  it('falls back to ? for empty or missing names', () => {
    expect(initial('')).toBe('?')
    expect(initial(null)).toBe('?')
    expect(initial(undefined)).toBe('?')
  })
})
