import { createSignal } from 'solid-js'
import { loadChecks, saveChecks, type Checks, type StorageLike } from './storage'
import { ApiError, type ApiState, type SyncOp } from './api'
import { SEED_MEDS, type MedDef } from './schedule'

export const TOKEN_KEY = 'dogscheduler:token:v1'
export const QUEUE_KEY = 'dogscheduler:queue:v1'
export const MIGRATED_KEY = 'dogscheduler:migrated:v1'
export const MEDS_KEY = 'dogscheduler:meds:v1'

export type SyncStatus = 'synced' | 'syncing' | 'offline' | 'no-token'

export interface SyncApi {
  fetchState(token: string): Promise<ApiState>
  postOps(token: string, ops: SyncOp[]): Promise<ApiState>
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
  meds(): MedDef[]
  addMed(med: MedDef): Promise<void>
  deleteMed(medId: string): Promise<void>
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

function loadMeds(storage: StorageLike | null): MedDef[] {
  const raw = getItem(storage, MEDS_KEY)
  if (raw !== null) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.length > 0) return parsed as MedDef[]
    } catch {
      // fall through to seeds
    }
  }
  return SEED_MEDS
}

export function createSyncStore(storage: StorageLike | null, api: SyncApi): SyncStore {
  const [checks, setChecks] = createSignal<Checks>(loadChecks(storage))
  const [queue, setQueue] = createSignal<SyncOp[]>(loadQueue(storage))
  const [meds, setMeds] = createSignal<MedDef[]>(loadMeds(storage))
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

  function persistMeds(next: MedDef[]): void {
    setMeds(next)
    setItem(storage, MEDS_KEY, JSON.stringify(next))
  }

  // Server map + pending local ops = what this device believes.
  function overlay(server: Checks): Checks {
    const merged = { ...server }
    for (const op of queue()) {
      if (op.op === 'check') {
        if (merged[op.doseId] === undefined) merged[op.doseId] = op.at
      } else if (op.op === 'uncheck') {
        delete merged[op.doseId]
      }
      // med ops never enter the queue
    }
    return merged
  }

  function reflected(op: SyncOp, server: Checks): boolean {
    if (op.op === 'check') return server[op.doseId] !== undefined
    if (op.op === 'uncheck') return server[op.doseId] === undefined
    return true // med ops are never queued
  }

  function adopt(state: ApiState): void {
    persistChecks(overlay(state.checks))
    // The server list is only empty pre-seed; never blank the local cache.
    if (state.meds.length > 0) persistMeds(state.meds)
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
      const state = await api.postOps(t, sent)
      // Drop sent ops the server reflects; keep everything else (including
      // ops enqueued while this flush was in flight).
      persistQueue(queue().filter((op) => !(sent.includes(op) && reflected(op, state.checks))))
      adopt(state)
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
      let state = await api.fetchState(t)
      if (state.meds.length === 0) {
        state = await api.postOps(t, SEED_MEDS.map((med) => ({ op: 'add-med' as const, med })))
      }
      adopt(state)
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
      else if (op.op === 'uncheck') delete next[doseId]
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
    meds,
    addMed: async (med) => {
      const t = token()
      if (!t) throw new Error('Not connected')
      adopt(await api.postOps(t, [{ op: 'add-med', med }]))
    },
    deleteMed: async (medId) => {
      const t = token()
      if (!t) throw new Error('Not connected')
      adopt(await api.postOps(t, [{ op: 'delete-med', medId }]))
    },
  }
  return store
}
