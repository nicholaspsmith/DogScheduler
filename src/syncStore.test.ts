import { describe, it, expect, vi } from 'vitest'
import { createSyncStore, TOKEN_KEY, QUEUE_KEY, MIGRATED_KEY } from './syncStore'
import { CHECKS_KEY, type StorageLike, type Checks } from './storage'
import { ApiError, type SyncOp } from './api'

function fakeStorage(initial: Record<string, string> = {}): StorageLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k)! : null),
    setItem: (k, v) => void data.set(k, v),
  }
}

// Fake API backed by an in-memory server map with real op semantics.
function fakeApi(serverInit: Checks = {}) {
  let server = { ...serverInit }
  const api = {
    server: () => server,
    failNext: false,
    fetchChecks: vi.fn(async () => {
      if (api.failNext) { api.failNext = false; throw new TypeError('network down') }
      return { ...server }
    }),
    postOps: vi.fn(async (_token: string, ops: SyncOp[]) => {
      if (api.failNext) { api.failNext = false; throw new TypeError('network down') }
      for (const op of ops) {
        if (op.op === 'check') { if (server[op.doseId] === undefined) server[op.doseId] = op.at }
        else delete server[op.doseId]
      }
      return { ...server }
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
    expect(api.fetchChecks).not.toHaveBeenCalled()
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
    expect(api.server()[ID]).toBeDefined()
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
    expect(api.server()[ID]).toBeUndefined()
    await store.sync()                           // network back
    expect(store.status()).toBe('synced')
    expect(api.server()[ID]).toBeDefined()
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
    expect(api.server()[ID]).toBeUndefined()
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
    api.fetchChecks.mockRejectedValueOnce(new ApiError(401))
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
    expect(api.server()[ID]).toBe('2026-07-21T19:00:00.000Z')
    expect(s.data.get(MIGRATED_KEY)).toBe('1')
    // second start must not re-enqueue
    const store2 = createSyncStore(s, api)
    await store2.start()
    expect(api.postOps.mock.calls.filter(([, ops]) => ops.length > 0)).toHaveLength(1)
  })

  it('migration does not overwrite a dose already checked on the server', async () => {
    const s = fakeStorage({
      [TOKEN_KEY]: 'tok',
      [CHECKS_KEY]: JSON.stringify({ [ID]: 'local-time' }),
    })
    const api = fakeApi({ [ID]: 'server-time' })
    const store = createSyncStore(s, api)
    await store.start()
    expect(api.server()[ID]).toBe('server-time') // first check wins
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
    expect(api.fetchChecks).toHaveBeenCalled()
  })
})
