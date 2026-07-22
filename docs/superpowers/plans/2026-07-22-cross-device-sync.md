# Cross-Device Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Checked doses sync between devices through a Cloudflare Worker + KV backend, with offline-tolerant queueing, a one-time sync-token setup per device, and minimal PWA installability.

**Architecture:** A `worker/` directory holds a small Cloudflare Worker (bearer-token auth, two endpoints, op-log semantics over one KV JSON map). The frontend gains `src/api.ts` (fetch wrapper), `src/syncStore.ts` (optimistic toggle + persisted op queue + migration; same `{isChecked, toggle}` interface as the old store so grid/detail components are untouched), a token setup screen, a sync status chip, and PWA manifest/icons. Spec: `docs/superpowers/specs/2026-07-22-cross-device-sync-design.md`.

**Tech Stack:** Existing SolidJS + Vite + Vitest. Cloudflare Workers + KV via the globally installed `wrangler` (4.x, already logged in). `@cloudflare/workers-types` as the only new devDependency.

## Global Constraints

- No new runtime dependencies. `@cloudflare/workers-types` is devDependency-only.
- localStorage keys exactly: `dogscheduler:checks:v1` (existing cache), `dogscheduler:queue:v1`, `dogscheduler:token:v1`, `dogscheduler:migrated:v1`.
- KV: binding `KV`, key `checks:v1`, value = JSON map `{ doseId: ISO timestamp }`.
- Auth header exactly `Authorization: Bearer <SYNC_TOKEN>`; secret name `SYNC_TOKEN`; never committed.
- CORS allowed origins exactly: `https://nicholaspsmith.github.io` and `http://localhost:5173`.
- `check` op sets the timestamp only if the dose is absent; `uncheck` deletes. Malformed ops → 400 with nothing applied.
- The app must remain fully usable with no token (local-only, `no-token` status) and must never block a toggle on the network.
- `npm test` and `npm run build` must pass at the end of every task. Work on branch `sync-backend`.
- Worker deploys are manual via wrangler; no Cloudflare credentials in GitHub Actions.

---

### Task 1: Worker op logic (pure)

**Files:**
- Create: `worker/ops.ts`
- Test: `worker/ops.test.ts`

**Interfaces:**
- Consumes: nothing (zero imports; must stay framework-free).
- Produces: `type Checks = Record<string, string>`; `type Op = { op: 'check'; doseId: string; at: string } | { op: 'uncheck'; doseId: string }`; `parseOps(body: unknown): Op[] | null` (null = reject whole request); `applyOps(checks: Checks, ops: Op[]): Checks` (pure, returns new map).

- [ ] **Step 1: Write the failing tests**

Create `worker/ops.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module './ops'`. (Vitest's default include picks up `worker/**/*.test.ts` automatically.)

- [ ] **Step 3: Implement `worker/ops.ts`**

```ts
// Pure op-log semantics over the checks map. Shared vocabulary with the
// frontend: doseId -> ISO timestamp when checked.
export type Checks = Record<string, string>

export type Op =
  | { op: 'check'; doseId: string; at: string }
  | { op: 'uncheck'; doseId: string }

// Returns null if the body is malformed in any way; nothing is applied.
export function parseOps(body: unknown): Op[] | null {
  if (typeof body !== 'object' || body === null) return null
  const ops = (body as { ops?: unknown }).ops
  if (!Array.isArray(ops)) return null
  const parsed: Op[] = []
  for (const raw of ops) {
    if (typeof raw !== 'object' || raw === null) return null
    const o = raw as Record<string, unknown>
    if (o.op === 'check' && typeof o.doseId === 'string' && typeof o.at === 'string') {
      parsed.push({ op: 'check', doseId: o.doseId, at: o.at })
    } else if (o.op === 'uncheck' && typeof o.doseId === 'string') {
      parsed.push({ op: 'uncheck', doseId: o.doseId })
    } else {
      return null
    }
  }
  return parsed
}

export function applyOps(checks: Checks, ops: Op[]): Checks {
  const next = { ...checks }
  for (const op of ops) {
    if (op.op === 'check') {
      // First check wins: keeps replays and migration idempotent.
      if (next[op.doseId] === undefined) next[op.doseId] = op.at
    } else {
      delete next[op.doseId]
    }
  }
  return next
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — full suite green (32 existing + 13 new).

- [ ] **Step 5: Commit**

```bash
git add worker/ops.ts worker/ops.test.ts
git commit -m "feat: pure op-log semantics for sync worker"
```

---

### Task 2: Worker entry, wrangler config, typecheck wiring

**Files:**
- Create: `worker/index.ts`
- Create: `worker/wrangler.toml`
- Create: `tsconfig.worker.json`
- Modify: `tsconfig.json` (add reference)
- Modify: `package.json` (add `@cloudflare/workers-types` devDependency)

**Interfaces:**
- Consumes: `parseOps`, `applyOps`, `Checks` from `worker/ops.ts` (Task 1).
- Produces: deployed-shape Worker with `GET /checks` → `{checks}`, `POST /ops` → `{checks}`, 401/400/404 behavior, CORS for the two allowed origins. `Env` = `{ KV: KVNamespace; SYNC_TOKEN: string }`.

No unit test: the entry is thin glue over Task 1's tested logic; it is verified by `tsc` here and by the live smoke test in Task 3.

- [ ] **Step 1: Install workers types**

```bash
npm install -D @cloudflare/workers-types
```

- [ ] **Step 2: Implement `worker/index.ts`**

```ts
import { applyOps, parseOps, type Checks } from './ops'

export interface Env {
  KV: KVNamespace
  SYNC_TOKEN: string
}

const ALLOWED_ORIGINS = new Set([
  'https://nicholaspsmith.github.io',
  'http://localhost:5173',
])

const CHECKS_KEY = 'checks:v1'

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('Origin') ?? ''
  if (!ALLOWED_ORIGINS.has(origin)) return {}
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  }
}

function json(status: number, body: unknown, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(request)
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors })
    }

    const auth = request.headers.get('Authorization') ?? ''
    if (auth !== `Bearer ${env.SYNC_TOKEN}`) {
      return json(401, { error: 'unauthorized' }, cors)
    }

    const url = new URL(request.url)
    const load = async (): Promise<Checks> =>
      (await env.KV.get(CHECKS_KEY, 'json')) ?? {}

    if (request.method === 'GET' && url.pathname === '/checks') {
      return json(200, { checks: await load() }, cors)
    }

    if (request.method === 'POST' && url.pathname === '/ops') {
      let body: unknown
      try {
        body = await request.json()
      } catch {
        return json(400, { error: 'invalid JSON' }, cors)
      }
      const ops = parseOps(body)
      if (ops === null) {
        return json(400, { error: 'invalid ops' }, cors)
      }
      const next = applyOps(await load(), ops)
      await env.KV.put(CHECKS_KEY, JSON.stringify(next))
      return json(200, { checks: next }, cors)
    }

    return json(404, { error: 'not found' }, cors)
  },
}
```

- [ ] **Step 3: Create `worker/wrangler.toml`**

The `id` is a placeholder replaced with the real namespace id in Task 3.

```toml
name = "dogscheduler-sync"
main = "index.ts"
compatibility_date = "2026-07-22"

[[kv_namespaces]]
binding = "KV"
id = "REPLACED_IN_PROVISIONING"
```

- [ ] **Step 4: Wire the worker into `tsc -b`**

Create `tsconfig.worker.json` (mirrors `tsconfig.app.json`'s bundler-mode options, minus DOM/JSX, plus workers types and strict):

```json
{
  "compilerOptions": {
    "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.worker.tsbuildinfo",
    "target": "es2023",
    "module": "esnext",
    "lib": ["ES2023"],
    "types": ["@cloudflare/workers-types"],
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "moduleDetection": "force",
    "noEmit": true,
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "erasableSyntaxOnly": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["worker"]
}
```

In `tsconfig.json`, add the reference:

```json
{
  "files": [],
  "references": [
    { "path": "./tsconfig.app.json" },
    { "path": "./tsconfig.node.json" },
    { "path": "./tsconfig.worker.json" }
  ]
}
```

- [ ] **Step 5: Verify typecheck and tests**

Run: `npm run build`
Expected: succeeds (worker code typechecks against workers-types; `ops.test.ts` imports only vitest so it passes the worker project's type rules).
Run: `npm test`
Expected: PASS — no regressions.

- [ ] **Step 6: Commit**

```bash
git add worker/index.ts worker/wrangler.toml tsconfig.worker.json tsconfig.json package.json package-lock.json
git commit -m "feat: sync worker entry with auth, CORS, and KV persistence"
```

---

### Task 3: Provision, deploy, smoke-test the Worker

Wrangler is already logged in (`wrangler login` completed 2026-07-22). Everything here runs from the repo root on this machine.

**Files:**
- Modify: `worker/wrangler.toml` (real KV namespace id)

**Interfaces:**
- Consumes: Task 2's worker.
- Produces: live Worker URL (e.g. `https://dogscheduler-sync.<subdomain>.workers.dev`) — needed by Task 4's `src/config.ts`; `SYNC_TOKEN` secret set; token printed once for the user.

- [ ] **Step 1: Create the KV namespace and record its id**

```bash
cd worker && wrangler kv namespace create KV
```

Expected output includes `id = "<32-hex>"`. Edit `worker/wrangler.toml`, replacing `REPLACED_IN_PROVISIONING` with that id.

- [ ] **Step 2: Deploy**

```bash
cd worker && wrangler deploy
```

Expected: `Deployed dogscheduler-sync ... https://dogscheduler-sync.<subdomain>.workers.dev`. Record the URL for Task 4.

- [ ] **Step 3: Generate and set the sync token**

```bash
TOKEN=$(openssl rand -base64 32)
cd worker && echo "$TOKEN" | wrangler secret put SYNC_TOKEN
echo "SYNC TOKEN (user: save this in a password manager; paste into each device): $TOKEN"
```

Note: `wrangler secret put` triggers a new deployment automatically. Show the token to the user exactly once; it is recoverable only by setting a new one.

- [ ] **Step 4: Smoke-test the live API**

Using the recorded URL and token (dose id `smoke:2026-01-01:am` cannot collide with real dose ids — real med ids are `prednisone|clindamycin|heartworm|adequan`):

```bash
U=https://dogscheduler-sync.<subdomain>.workers.dev
# 1. No token -> 401
curl -s -o /dev/null -w '%{http_code}\n' $U/checks                      # expect 401
# 2. With token -> empty map
curl -s -H "Authorization: Bearer $TOKEN" $U/checks                     # expect {"checks":{}}
# 3. Check op applies
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"ops":[{"op":"check","doseId":"smoke:2026-01-01:am","at":"2026-01-01T08:00:00.000Z"}]}' \
  $U/ops                                                                # expect map containing the dose
# 4. GET reflects it
curl -s -H "Authorization: Bearer $TOKEN" $U/checks                     # expect same map
# 5. Malformed -> 400
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "Authorization: Bearer $TOKEN" \
  -d '{"ops":[{"op":"bad"}]}' $U/ops                                    # expect 400
# 6. Uncheck cleans up
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"ops":[{"op":"uncheck","doseId":"smoke:2026-01-01:am"}]}' $U/ops # expect {"checks":{}}
```

All six must behave as annotated before proceeding.

- [ ] **Step 5: Commit**

```bash
git add worker/wrangler.toml
git commit -m "chore: provision KV namespace for sync worker"
```

---

### Task 4: Frontend API client

**Files:**
- Create: `src/config.ts`
- Create: `src/api.ts`
- Test: `src/api.test.ts`

**Interfaces:**
- Consumes: `Checks` type from `src/storage.ts`; Worker URL from Task 3.
- Produces: `WORKER_URL: string` (config); `type SyncOp = { op: 'check'; doseId: string; at: string } | { op: 'uncheck'; doseId: string }`; `class ApiError extends Error { status: number }`; `fetchChecks(token: string): Promise<Checks>`; `postOps(token: string, ops: SyncOp[]): Promise<Checks>`. Network failures reject with `fetch`'s own `TypeError`; HTTP failures reject with `ApiError`.

- [ ] **Step 1: Write the failing tests**

Create `src/api.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchChecks, postOps, ApiError } from './api'
import { WORKER_URL } from './config'

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchChecks', () => {
  it('GETs /checks with the bearer token and returns the map', async () => {
    const spy = vi.fn(async () => okResponse({ checks: { a: 't1' } }))
    vi.stubGlobal('fetch', spy)
    await expect(fetchChecks('tok')).resolves.toEqual({ a: 't1' })
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${WORKER_URL}/checks`)
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer tok')
  })
  it('throws ApiError with status on non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 401 })))
    const err = await fetchChecks('bad').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(401)
  })
})

describe('postOps', () => {
  it('POSTs the ops batch as JSON and returns the updated map', async () => {
    const spy = vi.fn(async () => okResponse({ checks: { a: 't1' } }))
    vi.stubGlobal('fetch', spy)
    const ops = [{ op: 'check', doseId: 'a', at: 't1' } as const]
    await expect(postOps('tok', ops)).resolves.toEqual({ a: 't1' })
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${WORKER_URL}/ops`)
    expect(init.method).toBe('POST')
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json')
    expect(JSON.parse(init.body as string)).toEqual({ ops })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module './api'`.

- [ ] **Step 3: Implement `src/config.ts` and `src/api.ts`**

`src/config.ts` (use the real URL recorded in Task 3):

```ts
// Base URL of the deployed sync worker (worker/): no trailing slash.
export const WORKER_URL = 'https://dogscheduler-sync.<subdomain>.workers.dev'
```

`src/api.ts`:

```ts
import { WORKER_URL } from './config'
import type { Checks } from './storage'

export type SyncOp =
  | { op: 'check'; doseId: string; at: string }
  | { op: 'uncheck'; doseId: string }

export class ApiError extends Error {
  status: number
  constructor(status: number) {
    super(`API error ${status}`)
    this.status = status
  }
}

async function request(path: string, token: string, init?: RequestInit): Promise<Checks> {
  const res = await fetch(`${WORKER_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
  })
  if (!res.ok) throw new ApiError(res.status)
  const data = (await res.json()) as { checks: Checks }
  return data.checks
}

export function fetchChecks(token: string): Promise<Checks> {
  return request('/checks', token)
}

export function postOps(token: string, ops: SyncOp[]): Promise<Checks> {
  return request('/ops', token, { method: 'POST', body: JSON.stringify({ ops }) })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS. Also run `npm run build` — passes.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/api.ts src/api.test.ts
git commit -m "feat: typed fetch client for the sync worker"
```

---

### Task 5: Sync store

**Files:**
- Create: `src/syncStore.ts`
- Test: `src/syncStore.test.ts`

**Interfaces:**
- Consumes: `loadChecks`/`saveChecks`/`StorageLike`/`Checks` (`src/storage.ts`), `SyncOp`/`ApiError` types (`src/api.ts`), `createSignal` (solid-js).
- Produces:

```ts
export type SyncStatus = 'synced' | 'syncing' | 'offline' | 'no-token'
export interface SyncApi {
  fetchChecks(token: string): Promise<Checks>
  postOps(token: string, ops: SyncOp[]): Promise<Checks>
}
export interface SyncStore {
  isChecked(doseId: string): boolean   // same contract MonthGrid/DayDetail already use
  toggle(doseId: string): void         // optimistic; never blocks on network
  status(): SyncStatus
  pendingCount(): number
  hasToken(): boolean
  setToken(token: string): void        // persists, then start()
  start(): Promise<void>               // migrate-if-needed, then sync()
  sync(): Promise<void>                // GET+adopt, then flush queue
}
export function createSyncStore(storage: StorageLike | null, api: SyncApi): SyncStore
export const TOKEN_KEY = 'dogscheduler:token:v1'
export const QUEUE_KEY = 'dogscheduler:queue:v1'
export const MIGRATED_KEY = 'dogscheduler:migrated:v1'
```

Key semantics (from spec): toggle updates signal+cache, appends the op to the persisted queue, then flushes. Flush POSTs the queue; ops are removed only if the response reflects them (`check` → id present, `uncheck` → absent); the response map is adopted with still-pending ops overlaid; failure keeps the queue and sets `offline`; a 401 clears the token and sets `no-token`. Migration: when a token exists and `MIGRATED_KEY` is unset, every cached entry is enqueued as a `check` op with its original timestamp and the flag is set immediately (queue persistence guarantees delivery even across reloads).

- [ ] **Step 1: Write the failing tests**

Create `src/syncStore.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module './syncStore'`.

- [ ] **Step 3: Implement `src/syncStore.ts`**

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — full suite. If the `401 handling` test leaves TOKEN_KEY as `''`, `hasToken()` must be false (empty string is falsy — covered).

- [ ] **Step 5: Run build**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/syncStore.ts src/syncStore.test.ts
git commit -m "feat: offline-tolerant sync store with op queue and migration"
```

---

### Task 6: App wiring — token screen, status chip, lifecycle

**Files:**
- Create: `src/TokenSetup.tsx`
- Modify: `src/App.tsx`
- Modify: `src/App.css` (append)
- Delete: `src/store.ts`, `src/store.test.ts` (replaced by syncStore)

**Interfaces:**
- Consumes: `createSyncStore`/`SyncStore` (Task 5), `fetchChecks`/`postOps` (Task 4), `getLocalStorage` (`src/storage.ts`), existing `MonthGrid`/`DayDetail` (accept any `{ isChecked, toggle }` — their `ChecksStore` prop type moves to `SyncStore`).
- Produces: the wired app. `MonthGrid.tsx` and `DayDetail.tsx` change only their `store` prop type import from `./store` to `./syncStore`.

- [ ] **Step 1: Implement `src/TokenSetup.tsx`**

```tsx
import { createSignal } from 'solid-js'

export default function TokenSetup(props: { onSave(token: string): void; onSkip(): void }) {
  const [value, setValue] = createSignal('')
  return (
    <div class="token-setup">
      <h2>Connect sync</h2>
      <p>
        Paste the sync token to share checked doses between your devices. You
        can find it where you saved it during setup.
      </p>
      <input
        type="password"
        placeholder="Sync token"
        value={value()}
        onInput={(e) => setValue(e.currentTarget.value)}
      />
      <div class="token-actions">
        <button
          type="button"
          class="today-btn"
          disabled={value().trim().length === 0}
          onClick={() => props.onSave(value().trim())}
        >
          Save
        </button>
        <button type="button" class="nav-btn" onClick={() => props.onSkip()}>
          Skip for now
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Rewire `src/App.tsx`**

Replace entirely:

```tsx
import { createSignal, onCleanup, onMount, Show } from 'solid-js'
import './App.css'
import { todayStr, parseDateStr } from './dates'
import { getLocalStorage } from './storage'
import { fetchChecks, postOps } from './api'
import { createSyncStore, type SyncStatus } from './syncStore'
import MonthGrid from './MonthGrid'
import DayDetail from './DayDetail'
import TokenSetup from './TokenSetup'

const STATUS_LABEL: Record<SyncStatus, string> = {
  synced: 'synced',
  syncing: 'syncing…',
  offline: 'offline',
  'no-token': 'not connected',
}

function App() {
  const store = createSyncStore(getLocalStorage(), { fetchChecks, postOps })
  const today = todayStr()
  const { y, m } = parseDateStr(today)
  const [selected, setSelected] = createSignal(today)
  const [view, setView] = createSignal({ y, m })
  const [setupOpen, setSetupOpen] = createSignal(!store.hasToken())

  onMount(() => {
    void store.start()
    const onVisible = () => {
      if (document.visibilityState === 'visible') void store.sync()
    }
    const onOnline = () => void store.sync()
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', onOnline)
    onCleanup(() => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', onOnline)
    })
  })

  const shiftMonth = (delta: number) => {
    setView((v) => {
      const zeroBased = v.m - 1 + delta
      const yy = v.y + Math.floor(zeroBased / 12)
      const mm = ((zeroBased % 12) + 12) % 12 + 1
      return { y: yy, m: mm }
    })
  }

  const statusLabel = () => {
    const s = store.status()
    return s === 'offline' && store.pendingCount() > 0
      ? `offline (${store.pendingCount()} pending)`
      : STATUS_LABEL[s]
  }

  return (
    <main>
      <Show
        when={!setupOpen()}
        fallback={
          <TokenSetup
            onSave={(t) => {
              store.setToken(t)
              setSetupOpen(false)
            }}
            onSkip={() => setSetupOpen(false)}
          />
        }
      >
        <header class="app-header">
          <h1>DogScheduler</h1>
          <button
            type="button"
            class="sync-chip"
            data-status={store.status()}
            onClick={() => {
              if (store.status() === 'no-token') setSetupOpen(true)
              else void store.sync()
            }}
          >
            <span class="sync-dot" /> {statusLabel()}
          </button>
        </header>
        <MonthGrid
          year={view().y}
          month={view().m}
          selected={selected()}
          today={today}
          store={store}
          onSelect={setSelected}
          onPrev={() => shiftMonth(-1)}
          onNext={() => shiftMonth(1)}
          onToday={() => {
            setView({ y, m })
            setSelected(today)
          }}
        />
        <DayDetail date={selected()} store={store} />
      </Show>
    </main>
  )
}

export default App
```

- [ ] **Step 3: Repoint the store type in components, delete the old store**

In `src/MonthGrid.tsx` and `src/DayDetail.tsx`, change:

```ts
import type { ChecksStore } from './store'
```

to:

```ts
import type { SyncStore } from './syncStore'
```

and rename all `store: ChecksStore` prop annotations to `store: SyncStore` (MonthGrid has one; DayDetail has two — `SlotSection`'s and `DayDetail`'s own).

Then:

```bash
git rm src/store.ts src/store.test.ts
```

- [ ] **Step 4: Append styles to `src/App.css`**

```css
.app-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.sync-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid color-mix(in srgb, currentColor 20%, transparent);
  border-radius: 999px;
  padding: 4px 10px;
  background: none;
  color: inherit;
  font-size: 0.75rem;
  cursor: pointer;
}

.sync-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #9a9aa2;
}

.sync-chip[data-status='synced'] .sync-dot {
  background: #2e9e44;
}

.sync-chip[data-status='syncing'] .sync-dot {
  background: #4a7dff;
}

.sync-chip[data-status='offline'] .sync-dot {
  background: #d64545;
}

.token-setup {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 20vh;
}

.token-setup input {
  font: inherit;
  padding: 10px;
  border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
  border-radius: 8px;
  background: none;
  color: inherit;
}

.token-actions {
  display: flex;
  gap: 8px;
}

.token-actions .today-btn:disabled {
  opacity: 0.4;
  cursor: default;
}
```

- [ ] **Step 5: Verify tests, build, and behavior**

Run: `npm test` — Expected: PASS (store.test.ts is gone; syncStore tests cover it).
Run: `npm run build` — Expected: succeeds.
Run: `npm run dev`, open http://localhost:5173/DogScheduler/ and confirm:
1. First load (or after clearing the token key) shows the token setup screen; **Skip for now** shows the calendar with a gray "not connected" chip.
2. Pasting the real token and saving flips the chip to "syncing…" then "synced", and any previously checked local doses appear on the server (`curl` the worker's `/checks` to confirm migration landed).
3. Toggling doses updates the server (curl again) and the chip stays "synced".
4. DevTools → Network offline: toggling still works instantly, chip shows "offline (N pending)"; back online + click the chip → "synced" and the server catches up.

- [ ] **Step 6: Commit**

```bash
git add src/TokenSetup.tsx src/App.tsx src/App.css src/MonthGrid.tsx src/DayDetail.tsx
git commit -m "feat: wire sync store into app with token setup and status chip"
```

---

### Task 7: PWA — manifest, icons, iOS meta

**Files:**
- Create: `scripts/make-icons.py`
- Create: `public/manifest.webmanifest`
- Create: `public/icons/icon-180.png`, `public/icons/icon-192.png`, `public/icons/icon-512.png` (generated)
- Modify: `index.html`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: installable PWA shell; Vite copies `public/` to the site root and rewrites root-absolute URLs in `index.html` with the `/DogScheduler/` base at build time.

- [ ] **Step 1: Write the icon generator**

Create `scripts/make-icons.py` (stdlib-only PNG writer; green field, white medical cross):

```python
#!/usr/bin/env python3
"""Generate DogScheduler app icons: white cross on green, no dependencies."""
import struct, zlib, os

GREEN = (46, 158, 68)   # #2e9e44, matches the app accent
WHITE = (255, 255, 255)

def make_icon(size: int, path: str) -> None:
    bar = round(size * 0.28)          # cross bar thickness
    arm = round(size * 0.64)          # cross arm length
    c = size / 2
    half_bar, half_arm = bar / 2, arm / 2
    rows = []
    for y in range(size):
        row = bytearray(b"\x00")      # filter byte: None
        for x in range(size):
            dx, dy = abs(x + 0.5 - c), abs(y + 0.5 - c)
            in_cross = (dx <= half_bar and dy <= half_arm) or (dy <= half_bar and dx <= half_arm)
            row += bytes(WHITE if in_cross else GREEN)
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)  # 8-bit RGB
    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
           + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)
    print(f"wrote {path} ({size}x{size})")

if __name__ == "__main__":
    os.makedirs("public/icons", exist_ok=True)
    for s in (180, 192, 512):
        make_icon(s, f"public/icons/icon-{s}.png")
```

- [ ] **Step 2: Generate the icons**

Run from the repo root: `python3 scripts/make-icons.py`
Expected: three `wrote public/icons/icon-*.png` lines. Open one (`open public/icons/icon-192.png`) to sanity-check it renders as a white cross on green.

- [ ] **Step 3: Create `public/manifest.webmanifest`**

```json
{
  "name": "DogScheduler",
  "short_name": "DogSched",
  "display": "standalone",
  "start_url": "/DogScheduler/",
  "scope": "/DogScheduler/",
  "background_color": "#ffffff",
  "theme_color": "#2e9e44",
  "icons": [
    { "src": "/DogScheduler/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/DogScheduler/icons/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

(Icon `src` values are absolute because the manifest is served as a static
file and is not rewritten by Vite.)

- [ ] **Step 4: Link it all in `index.html`**

In `<head>`, after the existing favicon link, add:

```html
    <link rel="manifest" href="/manifest.webmanifest" />
    <link rel="apple-touch-icon" href="/icons/icon-180.png" />
    <meta name="theme-color" content="#2e9e44" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="default" />
    <meta name="apple-mobile-web-app-title" content="DogScheduler" />
```

(Vite rewrites root-absolute `href` values in `index.html` with the
`/DogScheduler/` base at build time.)

- [ ] **Step 5: Verify**

Run: `npm run build && npm run preview`, then:

```bash
curl -s http://localhost:4173/DogScheduler/ | grep -E 'manifest|apple-touch'   # rewritten to /DogScheduler/...
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:4173/DogScheduler/manifest.webmanifest  # 200
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:4173/DogScheduler/icons/icon-180.png    # 200
```

Run: `npm test` — Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/make-icons.py public/manifest.webmanifest public/icons index.html
git commit -m "feat: PWA manifest, generated icons, iOS install meta"
```

---

### Task 8: README, ship, end-to-end

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: everything prior.
- Produces: merged, deployed, end-to-end-verified sync.

- [ ] **Step 1: Update README**

Replace the description paragraph (the one starting "Medication calendar for a dog:") with:

```markdown
Medication calendar for a dog: a month grid with per-day AM/PM dose
checklists. Checks sync across devices through a Cloudflare Worker + KV
backend (`worker/`) guarded by a shared sync token; each device keeps a
localStorage cache and an offline op queue, so checking off a dose never
waits on the network. Installable as a PWA (Add to Home Screen).
Schedules live as declarative rules in `src/schedule.ts`; design specs are
in `docs/superpowers/specs/`.
```

And add a section before "## License":

````markdown
## Sync backend

The Worker lives in `worker/` and deploys manually:

```sh
cd worker && wrangler deploy
```

One-time provisioning was: `wrangler login`, `wrangler kv namespace create
KV` (id goes in `worker/wrangler.toml`), `wrangler secret put SYNC_TOKEN`
(a random token, also pasted into each device via the app's setup screen).
The Worker URL is hardcoded in `src/config.ts`.
````

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: describe sync backend and provisioning"
```

- [ ] **Step 3: Merge and deploy** (via superpowers:finishing-a-development-branch)

Merge `sync-backend` to `main`, push, then:

```bash
gh run watch $(gh run list --limit 1 --json databaseId -q '.[0].databaseId') --exit-status
curl -sL https://nicholaspsmith.github.io/DogScheduler/ | grep -c manifest   # expect >= 1
```

- [ ] **Step 4: End-to-end verification (user-assisted)**

1. On the Mac (Zen): open the live URL, paste the sync token, confirm chip reads "synced" and existing checks migrated (visible after reload too).
2. `curl -s -H "Authorization: Bearer <token>" <worker-url>/checks` shows the real dose ids.
3. On the iPhone: open the live URL in Safari, paste the token, Add to Home Screen, launch — standalone window, green cross icon, same checks visible.
4. Check a dose on the phone; refocus the Mac tab → it appears. And vice versa.
