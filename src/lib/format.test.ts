import { describe, expect, it } from 'vitest'
import { dateRange, hourLabel, localToday, shortDate } from './format'

describe('format', () => {
  it('shortDate reads the calendar date without timezone shifts', () => {
    expect(shortDate('2026-12-01')).toBe('Dec 1')
    expect(shortDate('nope')).toBe('nope')
  })

  it('dateRange collapses the shared month and year', () => {
    expect(dateRange('2026-12-11', '2026-12-13')).toBe('Dec 11 – 13, 2026')
    expect(dateRange('2026-11-28', '2026-12-02')).toBe('Nov 28 – Dec 2, 2026')
    expect(dateRange('2026-12-30', '2027-01-02')).toBe('Dec 30, 2026 – Jan 2, 2027')
  })

  it('hourLabel', () => {
    expect([0, 6, 12, 21].map(hourLabel)).toEqual(['12 AM', '6 AM', '12 PM', '9 PM'])
  })

  it('localToday pads month and day', () => {
    expect(localToday(new Date(2026, 0, 5))).toBe('2026-01-05')
  })
})
