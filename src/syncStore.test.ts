import { describe, it, expect, vi } from 'vitest'
import { createSyncStore, TOKEN_KEY, QUEUE_KEY, MIGRATED_KEY, MEDS_KEY } from './syncStore'
import { CHECKS_KEY, type StorageLike, type Checks } from './storage'
import { ApiError, type SyncOp } from './api'
import { SEED_MEDS, type MedDef } from './schedule'

function fakeStorage(initial: Record<string, string> = {}): StorageLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k)! : null),
    setItem: (k, v) => void data.set(k, v),
  }
}

// Fake API backed by an in-memory server state with real op semantics.
function fakeApi(checksInit: Checks = {}, medsInit: MedDef[] = []) {
  let server = { checks: { ...checksInit }, meds: [...medsInit] }
  const api = {
    server: () => server,
    failNext: false,
    fetchState: vi.fn(async () => {
      if (api.failNext) { api.failNext = false; throw new TypeError('network down') }
      return { checks: { ...server.checks }, meds: [...server.meds] }
    }),
    postOps: vi.fn(async (_token: string, ops: SyncOp[]) => {
      if (api.failNext) { api.failNext = false; throw new TypeError('network down') }
      for (const op of ops) {
        if (op.op === 'check') { if (server.checks[op.doseId] === undefined) server.checks[op.doseId] = op.at }
        else if (op.op === 'uncheck') delete server.checks[op.doseId]
        else if (op.op === 'add-med') { if (!server.meds.some((m) => m.id === op.med.id)) server.meds.push(op.med) }
        else server.meds = server.meds.filter((m) => m.id !== op.medId)
      }
      return { checks: { ...server.checks }, meds: [...server.meds] }
    }),
  }
  return api
}

const ID = 'prednisone:2026-07-21:pm'

describe('no token', () => {
  it('stays local-only with no-token status and never calls the API', () => {
    const api = fakeApi()
    const store = createSyncStore(fakeStorage(), api)
    void store.start()
    store.toggle(ID)
    expect(store.isChecked(ID)).toBe(true)
    expect(store.status()).toBe('no-token')
    expect(api.fetchState).not.toHaveBeenCalled()
    expect(api.postOps).not.toHaveBeenCalled()
  })
})

describe('toggle + flush', () => {
  it('optimistically checks, pushes the op, and lands synced with empty queue', async () => {
    const s = fakeStorage({ [TOKEN_KEY]: 'tok', [MIGRATED_KEY]: '1' })
    const api = fakeApi()
    const store = createSyncStore(s, api)
    await store.start()
    store.toggle(ID)
    expect(store.isChecked(ID)).toBe(true) // before any await: optimistic
    await vi.waitFor(() => expect(store.status()).toBe('synced'))
    expect(api.server().checks[ID]).toBeDefined()
    expect(store.pendingCount()).toBe(0)
    expect(JSON.parse(s.data.get(QUEUE_KEY)!)).toEqual([])
  })

  it('keeps the op queued and goes offline when the POST fails, then retries on sync()', async () => {
    const s = fakeStorage({ [TOKEN_KEY]: 'tok', [MIGRATED_KEY]: '1' })
    const api = fakeApi()
    const store = createSyncStore(s, api)
    await store.start()
    api.failNext = true
    store.toggle(ID)
    await vi.waitFor(() => expect(store.status()).toBe('offline'))
    expect(store.isChecked(ID)).toBe(true)      // still shown locally
    expect(store.pendingCount()).toBe(1)
    expect(api.server().checks[ID]).toBeUndefined()
    await store.sync()                           // network back
    expect(store.status()).toBe('synced')
    expect(api.server().checks[ID]).toBeDefined()
    expect(store.pendingCount()).toBe(0)
  })

  it('uncheck offline then reconnect removes the dose on the server', async () => {
    const s = fakeStorage({ [TOKEN_KEY]: 'tok', [MIGRATED_KEY]: '1' })
    const api = fakeApi({ [ID]: 't0' })
    const store = createSyncStore(s, api)
    await store.start()
    expect(store.isChecked(ID)).toBe(true)       // adopted from server
    api.failNext = true
    store.toggle(ID)                              // uncheck while "offline"
    await vi.waitFor(() => expect(store.pendingCount()).toBe(1))
    expect(store.isChecked(ID)).toBe(false)
    await store.sync()
    expect(api.server().checks[ID]).toBeUndefined()
    expect(store.isChecked(ID)).toBe(false)
  })
})

describe('refresh/adopt', () => {
  it("sync() adopts another device's checks and overlays pending local ops", async () => {
    const s = fakeStorage({ [TOKEN_KEY]: 'tok', [MIGRATED_KEY]: '1' })
    const api = fakeApi({ 'clindamycin:2026-07-22:am': 'tA' }) // from the other device
    const store = createSyncStore(s, api)
    api.failNext = true
    await store.start()                           // initial GET fails -> offline
    store.toggle(ID)                              // flush succeeds (failNext was consumed by the GET)
    await store.sync()
    expect(store.isChecked('clindamycin:2026-07-22:am')).toBe(true)
    expect(store.isChecked(ID)).toBe(true)
  })
})

describe('401 handling', () => {
  it('clears the token and reports no-token', async () => {
    const s = fakeStorage({ [TOKEN_KEY]: 'bad', [MIGRATED_KEY]: '1' })
    const api = fakeApi()
    api.fetchState.mockRejectedValueOnce(new ApiError(401))
    const store = createSyncStore(s, api)
    await store.start()
    expect(store.status()).toBe('no-token')
    expect(store.hasToken()).toBe(false)
  })
})

describe('migration', () => {
  it('enqueues existing cached checks once, with original timestamps', async () => {
    const s = fakeStorage({
      [TOKEN_KEY]: 'tok',
      [CHECKS_KEY]: JSON.stringify({ [ID]: '2026-07-21T19:00:00.000Z' }),
    })
    const api = fakeApi()
    const store = createSyncStore(s, api)
    await store.start()
    expect(api.server().checks[ID]).toBe('2026-07-21T19:00:00.000Z')
    expect(s.data.get(MIGRATED_KEY)).toBe('1')
    // second start must not re-enqueue
    const store2 = createSyncStore(s, api)
    await store2.start()
    expect(api.postOps.mock.calls.filter(([, ops]) => ops.some((o) => o.op === 'check'))).toHaveLength(1)
  })

  it('migration does not overwrite a dose already checked on the server', async () => {
    const s = fakeStorage({
      [TOKEN_KEY]: 'tok',
      [CHECKS_KEY]: JSON.stringify({ [ID]: 'local-time' }),
    })
    const api = fakeApi({ [ID]: 'server-time' })
    const store = createSyncStore(s, api)
    await store.start()
    expect(api.server().checks[ID]).toBe('server-time') // first check wins
  })
})

describe('setToken', () => {
  it('persists the token and starts syncing', async () => {
    const s = fakeStorage()
    const api = fakeApi()
    const store = createSyncStore(s, api)
    await store.start()
    expect(store.status()).toBe('no-token')
    store.setToken('tok')
    await vi.waitFor(() => expect(store.status()).toBe('synced'))
    expect(s.data.get(TOKEN_KEY)).toBe('tok')
    expect(api.fetchState).toHaveBeenCalled()
  })
})

const GABA: MedDef = {
  id: 'gabapentin-0000',
  name: 'Gabapentin',
  doseText: '2 capsules by mouth',
  phases: [{ start: '2026-07-24', startSlot: 'am', intervalSlots: 2, count: 3 }],
}

describe('meds seeding and adoption', () => {
  it('seeds SEED_MEDS when the server med list is empty', async () => {
    const s = fakeStorage({ [TOKEN_KEY]: 'tok', [MIGRATED_KEY]: '1' })
    const api = fakeApi()
    const store = createSyncStore(s, api)
    await store.start()
    expect(api.server().meds.map((m) => m.id)).toEqual(SEED_MEDS.map((m) => m.id))
    expect(store.meds().map((m) => m.id)).toEqual(SEED_MEDS.map((m) => m.id))
    expect(JSON.parse(s.data.get(MEDS_KEY)!)).toHaveLength(SEED_MEDS.length)
  })
  it('does not seed when the server already has meds, and adopts them', async () => {
    const s = fakeStorage({ [TOKEN_KEY]: 'tok', [MIGRATED_KEY]: '1' })
    const api = fakeApi({}, [GABA])
    const store = createSyncStore(s, api)
    await store.start()
    expect(api.server().meds).toEqual([GABA])
    expect(store.meds()).toEqual([GABA])
  })
  it('two devices racing to seed converge to one list', async () => {
    const api = fakeApi()
    const a = createSyncStore(fakeStorage({ [TOKEN_KEY]: 'tok', [MIGRATED_KEY]: '1' }), api)
    const b = createSyncStore(fakeStorage({ [TOKEN_KEY]: 'tok', [MIGRATED_KEY]: '1' }), api)
    await Promise.all([a.start(), b.start()])
    expect(api.server().meds.map((m) => m.id)).toEqual(SEED_MEDS.map((m) => m.id))
  })
  it('falls back to SEED_MEDS when the meds cache is corrupt and there is no token', () => {
    const s = fakeStorage({ [MEDS_KEY]: 'not json{{{' })
    const store = createSyncStore(s, fakeApi())
    expect(store.meds().map((m) => m.id)).toEqual(SEED_MEDS.map((m) => m.id))
  })
})

describe('addMed / deleteMed (online-only)', () => {
  it('addMed posts immediately and adopts the result', async () => {
    const s = fakeStorage({ [TOKEN_KEY]: 'tok', [MIGRATED_KEY]: '1' })
    const api = fakeApi({}, [...SEED_MEDS])
    const store = createSyncStore(s, api)
    await store.start()
    await store.addMed(GABA)
    expect(store.meds().some((m) => m.id === GABA.id)).toBe(true)
    expect(store.pendingCount()).toBe(0) // never queued
  })
  it('deleteMed removes on server and locally, leaving checks alone', async () => {
    const s = fakeStorage({ [TOKEN_KEY]: 'tok', [MIGRATED_KEY]: '1' })
    const api = fakeApi({ [ID]: 't0' }, [...SEED_MEDS, GABA])
    const store = createSyncStore(s, api)
    await store.start()
    await store.deleteMed(GABA.id)
    expect(store.meds().some((m) => m.id === GABA.id)).toBe(false)
    expect(store.isChecked(ID)).toBe(true)
  })
  it('failure changes nothing locally and rethrows', async () => {
    const s = fakeStorage({ [TOKEN_KEY]: 'tok', [MIGRATED_KEY]: '1' })
    const api = fakeApi({}, [...SEED_MEDS])
    const store = createSyncStore(s, api)
    await store.start()
    api.failNext = true
    await expect(store.addMed(GABA)).rejects.toThrow()
    expect(store.meds().some((m) => m.id === GABA.id)).toBe(false)
    expect(store.pendingCount()).toBe(0)
  })
  it('throws without a token', async () => {
    const store = createSyncStore(fakeStorage(), fakeApi())
    await expect(store.addMed(GABA)).rejects.toThrow('Not connected')
  })
})
