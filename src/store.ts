import { createSignal } from 'solid-js'
import { loadChecks, saveChecks, type StorageLike } from './storage'

export interface ChecksStore {
  isChecked(doseId: string): boolean
  toggle(doseId: string): void
}

export function createChecksStore(storage: StorageLike | null): ChecksStore {
  const [checks, setChecks] = createSignal(loadChecks(storage))
  return {
    isChecked: (doseId) => checks()[doseId] !== undefined,
    toggle: (doseId) => {
      const next = { ...checks() }
      if (next[doseId] !== undefined) {
        delete next[doseId]
      } else {
        next[doseId] = new Date().toISOString()
      }
      setChecks(next)
      saveChecks(storage, next)
    },
  }
}
