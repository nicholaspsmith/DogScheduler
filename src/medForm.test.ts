import { describe, it, expect } from 'vitest'
import { buildMedDef, deriveDoseText, slugId } from './medForm'

const fixedRand = () => 0 // suffix "0000"

describe('deriveDoseText', () => {
  it.each([
    [2, 'tablets', '2 tablets by mouth'],
    [3, 'capsules', '3 capsules by mouth'],
    [0.7, 'mL', '0.7 mL'],
    [1, 'dose', '1 dose'],
    [2, 'dose', '2 doses'],
  ] as const)('%s %s -> %s', (amount, unit, expected) => {
    expect(deriveDoseText(amount, unit)).toBe(expected)
  })
})

describe('slugId', () => {
  it('slugifies and suffixes', () => {
    expect(slugId('Gabapentin 100mg!', fixedRand)).toBe('gabapentin-100mg-0000')
  })
  it('falls back for all-symbol names', () => {
    expect(slugId('★★★', fixedRand)).toBe('med-0000')
  })
})

describe('buildMedDef', () => {
  const base = {
    name: 'Gabapentin',
    amount: 2,
    unit: 'capsules' as const,
    startDate: '2026-07-24',
    startSlot: 'am' as const,
    rows: [{ kind: 'once-daily' as const, days: 3 }],
  }
  it('builds a countable med with units and phases', () => {
    expect(buildMedDef(base, fixedRand)).toEqual({
      id: 'gabapentin-0000',
      name: 'Gabapentin',
      doseText: '2 capsules by mouth',
      unitsPerDose: 2,
      unitLabel: 'capsules',
      phases: [{ start: '2026-07-24', startSlot: 'am', intervalSlots: 2, count: 3 }],
    })
  })
  it('omits unit fields for mL and non-integer amounts', () => {
    expect(buildMedDef({ ...base, unit: 'mL', amount: 0.7 }, fixedRand).unitsPerDose).toBeUndefined()
    expect(buildMedDef({ ...base, amount: 2.5 }, fixedRand).unitsPerDose).toBeUndefined()
  })
  it('rejects empty name and non-positive amount', () => {
    expect(() => buildMedDef({ ...base, name: '  ' }, fixedRand)).toThrow('Name')
    expect(() => buildMedDef({ ...base, amount: 0 }, fixedRand)).toThrow('Amount')
  })
})
