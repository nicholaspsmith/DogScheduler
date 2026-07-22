import { describe, it, expect } from 'vitest'
import { createChecksStore } from './store'
import { CHECKS_KEY, type StorageLike } from './storage'

function fakeStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k)! : null),
    setItem: (k, v) => void data.set(k, v),
  }
}

describe('createChecksStore', () => {
  const ID = 'prednisone:2026-07-21:pm'

  it('toggle checks a dose and writes through to storage', () => {
    const s = fakeStorage()
    const store = createChecksStore(s)
    expect(store.isChecked(ID)).toBe(false)
    store.toggle(ID)
    expect(store.isChecked(ID)).toBe(true)
    expect(Object.keys(JSON.parse(s.data.get(CHECKS_KEY)!))).toEqual([ID])
  })

  it('a fresh store over the same storage sees the check (reload survival)', () => {
    const s = fakeStorage()
    createChecksStore(s).toggle(ID)
    expect(createChecksStore(s).isChecked(ID)).toBe(true)
  })

  it('toggling again unchecks and removes the entry', () => {
    const s = fakeStorage()
    const store = createChecksStore(s)
    store.toggle(ID)
    store.toggle(ID)
    expect(store.isChecked(ID)).toBe(false)
    expect(JSON.parse(s.data.get(CHECKS_KEY)!)).toEqual({})
  })

  it('works with null storage (in-memory only)', () => {
    const store = createChecksStore(null)
    store.toggle(ID)
    expect(store.isChecked(ID)).toBe(true)
  })
})
