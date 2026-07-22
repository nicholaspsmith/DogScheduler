import { describe, it, expect } from 'vitest'
import { parseOps, applyOps } from './ops'

describe('applyOps', () => {
  it('check sets the timestamp when absent', () => {
    expect(applyOps({}, [{ op: 'check', doseId: 'a', at: 't1' }])).toEqual({ a: 't1' })
  })
  it('check does not overwrite an existing timestamp (first check wins)', () => {
    expect(applyOps({ a: 't1' }, [{ op: 'check', doseId: 'a', at: 't2' }])).toEqual({ a: 't1' })
  })
  it('uncheck deletes; unchecking absent is a no-op', () => {
    expect(applyOps({ a: 't1' }, [{ op: 'uncheck', doseId: 'a' }])).toEqual({})
    expect(applyOps({}, [{ op: 'uncheck', doseId: 'a' }])).toEqual({})
  })
  it('applies in order: check then uncheck nets to absent, uncheck then check nets to present', () => {
    expect(applyOps({}, [
      { op: 'check', doseId: 'a', at: 't1' },
      { op: 'uncheck', doseId: 'a' },
    ])).toEqual({})
    expect(applyOps({ a: 't1' }, [
      { op: 'uncheck', doseId: 'a' },
      { op: 'check', doseId: 'a', at: 't2' },
    ])).toEqual({ a: 't2' })
  })
  it('is pure — does not mutate the input map', () => {
    const input = { a: 't1' }
    applyOps(input, [{ op: 'uncheck', doseId: 'a' }])
    expect(input).toEqual({ a: 't1' })
  })
  it('replaying the same ops is idempotent', () => {
    const ops = [
      { op: 'check', doseId: 'a', at: 't1' },
      { op: 'check', doseId: 'b', at: 't2' },
    ] as const
    const once = applyOps({}, [...ops])
    expect(applyOps(once, [...ops])).toEqual(once)
  })
})

describe('parseOps', () => {
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
