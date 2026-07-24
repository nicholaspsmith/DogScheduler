import { describe, it, expect } from 'vitest'
import { scheduleSummary } from './summary'
import { SEED_MEDS } from './schedule'

const med = (id: string) => SEED_MEDS.find((m) => m.id === id)!

describe('scheduleSummary', () => {
  it('summarizes a finite multi-phase taper with its end date', () => {
    expect(scheduleSummary(med('prednisone'))).toBe(
      'twice daily ×10, then daily ×5, then every other day ×5 · ends Aug 10, 2026',
    )
  })
  it('summarizes a monthly-only med as ongoing', () => {
    expect(scheduleSummary(med('heartworm'))).toBe('monthly on the 14th, ongoing')
  })
  it('summarizes phases + monthly tail', () => {
    expect(scheduleSummary(med('adequan'))).toBe('weekly ×4, then monthly on the 11th, ongoing')
  })
  it('uses correct ordinals', () => {
    expect(scheduleSummary({ id: 'x', name: 'X', doseText: 'x', monthly: { dayOfMonth: 21, slot: 'am', start: '2026-08-21' } }))
      .toBe('monthly on the 21st, ongoing')
    expect(scheduleSummary({ id: 'x', name: 'X', doseText: 'x', monthly: { dayOfMonth: 12, slot: 'am', start: '2026-08-12' } }))
      .toBe('monthly on the 12th, ongoing')
  })
})
