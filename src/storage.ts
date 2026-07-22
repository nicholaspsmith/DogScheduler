export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export const CHECKS_KEY = 'dogscheduler:checks:v1'
export const CORRUPT_KEY = 'dogscheduler:checks:v1:corrupt'

// doseId -> ISO timestamp of when the user checked it off.
export type Checks = Record<string, string>

export function loadChecks(storage: StorageLike | null): Checks {
  if (!storage) return {}
  let raw: string | null
  try {
    raw = storage.getItem(CHECKS_KEY)
  } catch {
    return {}
  }
  if (raw === null) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Checks
    }
  } catch {
    // fall through to corrupt handling
  }
  // Medical history: back up the unreadable value instead of discarding it.
  try {
    storage.setItem(CORRUPT_KEY, raw)
    storage.setItem(CHECKS_KEY, '{}')
  } catch {
    // storage failed mid-recovery; in-memory empty state is all we can do
  }
  return {}
}

export function saveChecks(storage: StorageLike | null, checks: Checks): void {
  if (!storage) return
  try {
    storage.setItem(CHECKS_KEY, JSON.stringify(checks))
  } catch {
    // quota/denied: session continues in memory
  }
}

export function getLocalStorage(): StorageLike | null {
  try {
    const s = window.localStorage
    s.getItem(CHECKS_KEY) // some private modes throw on first access
    return s
  } catch {
    return null
  }
}
