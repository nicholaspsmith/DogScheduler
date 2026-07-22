import { describe, it, expect } from 'vitest'
import { toDateStr, parseDateStr, addDays, daysInMonth, firstWeekday } from './dates'

describe('toDateStr / parseDateStr', () => {
  it('zero-pads month and day', () => {
    expect(toDateStr(2026, 7, 4)).toBe('2026-07-04')
  })
  it('round-trips', () => {
    expect(parseDateStr('2026-07-21')).toEqual({ y: 2026, m: 7, d: 21 })
  })
})

describe('addDays', () => {
  it('adds within a month', () => {
    expect(addDays('2026-07-21', 1)).toBe('2026-07-22')
  })
  it('crosses a month boundary', () => {
    expect(addDays('2026-07-31', 1)).toBe('2026-08-01')
  })
  it('crosses a year boundary', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
  })
  it('handles zero and negative offsets', () => {
    expect(addDays('2026-07-21', 0)).toBe('2026-07-21')
    expect(addDays('2026-08-01', -1)).toBe('2026-07-31')
  })
})

describe('month helpers', () => {
  it('daysInMonth handles ordinary and leap years', () => {
    expect(daysInMonth(2026, 7)).toBe(31)
    expect(daysInMonth(2026, 2)).toBe(28)
    expect(daysInMonth(2028, 2)).toBe(29)
  })
  it('firstWeekday: July 2026 starts on a Wednesday', () => {
    expect(firstWeekday(2026, 7)).toBe(3)
  })
})
