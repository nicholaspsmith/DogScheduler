import { describe, it, expect } from 'vitest'
import { parseOps, applyState, type MedDef } from './ops'

describe('applyState: check ops', () => {
  it('check sets the timestamp when absent', () => {
    expect(applyState({ checks: {}, meds: [] }, [{ op: 'check', doseId: 'a', at: 't1' }]).checks)
      .toEqual({ a: 't1' })
  })
  it('check does not overwrite an existing timestamp (first check wins)', () => {
    expect(applyState({ checks: { a: 't1' }, meds: [] }, [{ op: 'check', doseId: 'a', at: 't2' }]).checks)
      .toEqual({ a: 't1' })
  })
  it('uncheck deletes; unchecking absent is a no-op', () => {
    expect(applyState({ checks: { a: 't1' }, meds: [] }, [{ op: 'uncheck', doseId: 'a' }]).checks).toEqual({})
    expect(applyState({ checks: {}, meds: [] }, [{ op: 'uncheck', doseId: 'a' }]).checks).toEqual({})
  })
  it('applies in order: check then uncheck nets to absent, uncheck then check nets to present', () => {
    expect(applyState({ checks: {}, meds: [] }, [
      { op: 'check', doseId: 'a', at: 't1' },
      { op: 'uncheck', doseId: 'a' },
    ]).checks).toEqual({})
    expect(applyState({ checks: { a: 't1' }, meds: [] }, [
      { op: 'uncheck', doseId: 'a' },
      { op: 'check', doseId: 'a', at: 't2' },
    ]).checks).toEqual({ a: 't2' })
  })
  it('is pure — does not mutate the input state', () => {
    const checks = { a: 't1' }
    applyState({ checks, meds: [] }, [{ op: 'uncheck', doseId: 'a' }])
    expect(checks).toEqual({ a: 't1' })
  })
  it('replaying the same ops is idempotent', () => {
    const ops = [
      { op: 'check', doseId: 'a', at: 't1' },
      { op: 'check', doseId: 'b', at: 't2' },
    ] as const
    const once = applyState({ checks: {}, meds: [] }, [...ops]).checks
    expect(applyState({ checks: once, meds: [] }, [...ops]).checks).toEqual(once)
  })
})

describe('parseOps: check ops', () => {
  it('accepts a valid mixed batch', () => {
    expect(parseOps({ ops: [
      { op: 'check', doseId: 'a', at: 't1' },
      { op: 'uncheck', doseId: 'b' },
    ] })).toEqual([
      { op: 'check', doseId: 'a', at: 't1' },
      { op: 'uncheck', doseId: 'b' },
    ])
  })
  it('accepts an empty batch', () => {
    expect(parseOps({ ops: [] })).toEqual([])
  })
  it.each([
    ['non-object body', 'nope'],
    ['null body', null],
    ['missing ops', {}],
    ['ops not an array', { ops: 'x' }],
    ['unknown op kind', { ops: [{ op: 'frob', doseId: 'a' }] }],
    ['check without at', { ops: [{ op: 'check', doseId: 'a' }] }],
    ['non-string doseId', { ops: [{ op: 'uncheck', doseId: 5 }] }],
    ['one bad op poisons the batch', { ops: [{ op: 'uncheck', doseId: 'a' }, { op: 'bad' }] }],
  ])('rejects %s with null', (_name, body) => {
    expect(parseOps(body)).toBeNull()
  })
})

const GABA: MedDef = {
  id: 'gabapentin-x7k2',
  name: 'Gabapentin',
  doseText: '2 capsules by mouth',
  unitsPerDose: 2,
  unitLabel: 'capsules',
  phases: [{ start: '2026-07-24', startSlot: 'am', intervalSlots: 2, count: 3 }],
}

describe('med ops', () => {
  it('add-med appends; second add with same id is ignored', () => {
    const once = applyState({ checks: {}, meds: [] }, [{ op: 'add-med', med: GABA }])
    expect(once.meds).toEqual([GABA])
    const twice = applyState(once, [{ op: 'add-med', med: { ...GABA, name: 'Impostor' } }])
    expect(twice.meds).toEqual([GABA])
  })
  it('delete-med removes; deleting a missing id is a no-op', () => {
    const state = { checks: {}, meds: [GABA] }
    expect(applyState(state, [{ op: 'delete-med', medId: GABA.id }]).meds).toEqual([])
    expect(applyState(state, [{ op: 'delete-med', medId: 'nope' }]).meds).toEqual([GABA])
  })
  it('a med-op batch leaves checks untouched (preservation)', () => {
    const checks = { 'prednisone:2026-07-21:pm': 't0' }
    const out = applyState({ checks, meds: [] }, [
      { op: 'add-med', med: GABA },
      { op: 'delete-med', medId: GABA.id },
    ])
    expect(out.checks).toEqual(checks)
  })
  it('mixed batch applies in order', () => {
    const out = applyState({ checks: {}, meds: [] }, [
      { op: 'add-med', med: GABA },
      { op: 'check', doseId: 'gabapentin-x7k2:2026-07-24:am', at: 't1' },
    ])
    expect(out.meds).toHaveLength(1)
    expect(out.checks['gabapentin-x7k2:2026-07-24:am']).toBe('t1')
  })
})

describe('parseOps med validation', () => {
  it('accepts valid add-med and delete-med', () => {
    expect(parseOps({ ops: [{ op: 'add-med', med: GABA }] })).toHaveLength(1)
    expect(parseOps({ ops: [{ op: 'delete-med', medId: 'x' }] })).toHaveLength(1)
  })
  it('accepts a monthly-only med', () => {
    const med = { id: 'h', name: 'H', doseText: '1 dose', monthly: { dayOfMonth: 14, slot: 'pm', start: '2026-08-14' } }
    expect(parseOps({ ops: [{ op: 'add-med', med }] })).toHaveLength(1)
  })
  it.each([
    ['missing name', { ...GABA, name: undefined }],
    ['empty name', { ...GABA, name: '  ' }],
    ['no phases and no monthly', { id: 'x', name: 'X', doseText: 'x' }],
    ['empty phases array', { ...GABA, phases: [] }],
    ['bad slot', { ...GABA, phases: [{ ...GABA.phases![0], startSlot: 'noon' }] }],
    ['non-integer count', { ...GABA, phases: [{ ...GABA.phases![0], count: 1.5 }] }],
    ['bad phase date', { ...GABA, phases: [{ ...GABA.phases![0], start: '24/07/2026' }] }],
    ['dayOfMonth 32', { id: 'x', name: 'X', doseText: 'x', monthly: { dayOfMonth: 32, slot: 'pm', start: '2026-08-01' } }],
    ['unitsPerDose without unitLabel', { ...GABA, unitLabel: undefined }],
    ['negative unitsPerDose', { ...GABA, unitsPerDose: -1 }],
  ])('rejects add-med with %s (whole batch null)', (_n, med) => {
    expect(parseOps({ ops: [{ op: 'uncheck', doseId: 'ok' }, { op: 'add-med', med }] })).toBeNull()
  })
  it('rejects delete-med without string medId', () => {
    expect(parseOps({ ops: [{ op: 'delete-med', medId: 5 }] })).toBeNull()
  })
})
