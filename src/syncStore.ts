import { createSignal } from 'solid-js'
import { loadChecks, saveChecks, type Checks, type StorageLike } from './storage'
import { ApiError, type SyncOp } from './api'

export const TOKEN_KEY = 'dogscheduler:token:v1'
export const QUEUE_KEY = 'dogscheduler:queue:v1'
export const MIGRATED_KEY = 'dogscheduler:migrated:v1'

export type SyncStatus = 'synced' | 'syncing' | 'offline' | 'no-token'

export interface SyncApi {
  fetchChecks(token: string): Promise<Checks>
  postOps(token: string, ops: SyncOp[]): Promise<Checks>
}

export interface SyncStore {
  isChecked(doseId: string): boolean
  toggle(doseId: string): void
  status(): SyncStatus
  pendingCount(): number
  hasToken(): boolean
  setToken(token: string): void
  start(): Promise<void>
  sync(): Promise<void>
}

function getItem(storage: StorageLike | null, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null
  } catch {
    return null
  }
}

function setItem(storage: StorageLike | null, key: string, value: string): void {
  try {
    storage?.setItem(key, value)
  } catch {
    // session continues in memory
  }
}

function loadQueue(storage: StorageLike | null): SyncOp[] {
  const raw = getItem(storage, QUEUE_KEY)
  if (raw === null) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as SyncOp[]) : []
  } catch {
    return []
  }
}

export function createSyncStore(storage: StorageLike | null, api: SyncApi): SyncStore {
  const [checks, setChecks] = createSignal<Checks>(loadChecks(storage))
  const [queue, setQueue] = createSignal<SyncOp[]>(loadQueue(storage))
  const [status, setStatus] = createSignal<SyncStatus>(
    getItem(storage, TOKEN_KEY) ? 'syncing' : 'no-token',
  )
  let flushing = false

  const token = () => getItem(storage, TOKEN_KEY)

  function persistQueue(next: SyncOp[]): void {
    setQueue(next)
    setItem(storage, QUEUE_KEY, JSON.stringify(next))
  }

  function persistChecks(next: Checks): void {
    setChecks(next)
    saveChecks(storage, next)
  }

  // Server map + pending local ops = what this device believes.
  function overlay(server: Checks): Checks {
    const merged = { ...server }
    for (const op of queue()) {
      if (op.op === 'check') {
        if (merged[op.doseId] === undefined) merged[op.doseId] = op.at
      } else {
        delete merged[op.doseId]
      }
    }
    return merged
  }

  function reflected(op: SyncOp, server: Checks): boolean {
    return op.op === 'check'
      ? server[op.doseId] !== undefined
      : server[op.doseId] === undefined
  }

  function handleFailure(e: unknown): void {
    if (e instanceof ApiError && e.status === 401) {
      setItem(storage, TOKEN_KEY, '')
      setStatus('no-token')
    } else {
      setStatus('offline')
    }
  }

  async function flush(): Promise<void> {
    const t = token()
    if (!t || flushing) return
    const sent = queue()
    if (sent.length === 0) {
      setStatus('synced')
      return
    }
    flushing = true
    setStatus('syncing')
    try {
      const server = await api.postOps(t, sent)
      // Drop sent ops the server reflects; keep everything else (including
      // ops enqueued while this flush was in flight).
      persistQueue(queue().filter((op) => !(sent.includes(op) && reflected(op, server))))
      persistChecks(overlay(server))
      flushing = false
      if (queue().some((op) => !sent.includes(op))) {
        await flush() // new taps arrived mid-flight
      } else {
        setStatus(queue().length === 0 ? 'synced' : 'offline')
      }
    } catch (e) {
      flushing = false
      handleFailure(e)
    }
  }

  function migrateIfNeeded(): void {
    if (!token() || getItem(storage, MIGRATED_KEY) === '1') return
    const cached = checks()
    const ops: SyncOp[] = Object.entries(cached).map(([doseId, at]) => ({
      op: 'check',
      doseId,
      at,
    }))
    if (ops.length > 0) persistQueue([...queue(), ...ops])
    // Flag set at enqueue time: the persisted queue guarantees delivery.
    setItem(storage, MIGRATED_KEY, '1')
  }

  async function sync(): Promise<void> {
    const t = token()
    if (!t) {
      setStatus('no-token')
      return
    }
    setStatus('syncing')
    try {
      const server = await api.fetchChecks(t)
      persistChecks(overlay(server))
    } catch (e) {
      handleFailure(e)
      return
    }
    await flush()
  }

  const store: SyncStore = {
    isChecked: (doseId) => checks()[doseId] !== undefined,
    toggle: (doseId) => {
      const current = checks()
      const op: SyncOp =
        current[doseId] !== undefined
          ? { op: 'uncheck', doseId }
          : { op: 'check', doseId, at: new Date().toISOString() }
      const next = { ...current }
      if (op.op === 'check') next[doseId] = op.at
      else delete next[doseId]
      persistChecks(next)
      persistQueue([...queue(), op])
      void flush()
    },
    status,
    pendingCount: () => queue().length,
    hasToken: () => !!token(),
    setToken: (t) => {
      setItem(storage, TOKEN_KEY, t)
      void store.start()
    },
    start: async () => {
      if (!token()) {
        setStatus('no-token')
        return
      }
      migrateIfNeeded()
      await sync()
    },
    sync,
  }
  return store
}
