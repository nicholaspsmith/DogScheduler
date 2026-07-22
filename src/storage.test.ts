import { describe, it, expect } from 'vitest'
import { loadChecks, saveChecks, CHECKS_KEY, CORRUPT_KEY, type StorageLike } from './storage'

function fakeStorage(initial: Record<string, string> = {}): StorageLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k)! : null),
    setItem: (k, v) => void data.set(k, v),
  }
}

describe('loadChecks / saveChecks', () => {
  it('round-trips through storage', () => {
    const s = fakeStorage()
    saveChecks(s, { 'prednisone:2026-07-21:pm': '2026-07-21T19:00:00.000Z' })
    expect(loadChecks(s)).toEqual({ 'prednisone:2026-07-21:pm': '2026-07-21T19:00:00.000Z' })
  })
  it('returns empty map when nothing is stored', () => {
    expect(loadChecks(fakeStorage())).toEqual({})
  })
  it('returns empty map and does not throw with null storage', () => {
    expect(loadChecks(null)).toEqual({})
    expect(() => saveChecks(null, { x: 'y' })).not.toThrow()
  })
})

describe('corrupt data handling', () => {
  it('backs up unparseable JSON before resetting — never silently discards', () => {
    const s = fakeStorage({ [CHECKS_KEY]: 'not json{{{' })
    expect(loadChecks(s)).toEqual({})
    expect(s.data.get(CORRUPT_KEY)).toBe('not json{{{')
    expect(s.data.get(CHECKS_KEY)).toBe('{}')
  })
  it('treats parseable-but-wrong-shape values (array) as corrupt', () => {
    const s = fakeStorage({ [CHECKS_KEY]: '[1,2]' })
    expect(loadChecks(s)).toEqual({})
    expect(s.data.get(CORRUPT_KEY)).toBe('[1,2]')
  })
  it('survives a storage that throws', () => {
    const throwing: StorageLike = {
      getItem: () => { throw new Error('denied') },
      setItem: () => { throw new Error('denied') },
    }
    expect(loadChecks(throwing)).toEqual({})
    expect(() => saveChecks(throwing, { x: 'y' })).not.toThrow()
  })
})
