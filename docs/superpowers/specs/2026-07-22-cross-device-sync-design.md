# DogScheduler: Cross-Device Sync — Design

**Date:** 2026-07-22
**Status:** Approved
**Builds on:** `2026-07-22-medication-calendar-design.md`

## Purpose

Checked doses must be shared between the user's iPhone (installed as a
home-screen web app) and desktop browsers (Zen on macOS), surviving browser
data wipes. Adds a free Cloudflare Worker + KV backend behind the existing
GitHub Pages frontend, an offline-tolerant sync store, and minimal PWA
installability. Single user; two-ish devices.

## Decisions (from brainstorming)

- **Backend:** Cloudflare Worker + Workers KV, free tier. Frontend hosting
  unchanged (GitHub Pages).
- **Access control:** one shared secret bearer token, stored as a Worker
  secret; entered once per device into the app, kept in localStorage.
- **Offline:** localStorage stays as cache; an op queue records taps made
  while unreachable and replays them. Checking off a dose never blocks on
  the network.
- **Sync model:** operation log to a server-held map (approach A). Clients
  never push whole state; a stale device cannot clobber history.
- **PWA:** manifest + icons + iOS meta tags only. **No service worker** this
  round: offline use works for an already-open app; a fresh launch with no
  connectivity may fail to load. Accepted for v1.

## Worker API

Repo layout: `worker/index.ts` (entry), `worker/ops.ts` (pure op logic),
`worker/wrangler.toml` (committed; contains the KV namespace id, which is not
secret). Deployed to `https://<name>.<subdomain>.workers.dev` via
`wrangler deploy` from the developer machine. No Cloudflare credentials in
GitHub.

**Storage:** KV binding `KV`, single key `checks:v1`, value = JSON object
`{ [doseId]: ISO-8601 timestamp }` — the same shape the frontend already
persists.

**Auth:** every request must carry `Authorization: Bearer <SYNC_TOKEN>`.
`SYNC_TOKEN` is a Worker secret (set via `wrangler secret put`), generated
locally (32 random bytes, base64), shown once in the terminal for the user
to paste into devices. Wrong/missing token → `401`.

**Endpoints:**

- `GET /checks` → `200 { "checks": { ... } }`
- `POST /ops` with body
  `{ "ops": [ { "op": "check", "doseId": string, "at": string } | { "op": "uncheck", "doseId": string } ] }`
  → applies ops in order to the stored map, writes it back, returns
  `200 { "checks": { ... } }` (the post-apply map).
  - `check`: sets `map[doseId] = at` **only if `doseId` is absent** (first
    check wins; idempotent under replay and migration).
  - `uncheck`: deletes `map[doseId]`.
  - Malformed body or any invalid op (unknown `op`, missing/non-string
    `doseId`, `check` without string `at`) → `400`, nothing applied.
- Any other route/method → `404`/`405`.

**CORS:** exactly two allowed origins — `https://nicholaspsmith.github.io`
and `http://localhost:5173`. Preflight (`OPTIONS`) answered with
`Access-Control-Allow-Methods: GET, POST` and
`Access-Control-Allow-Headers: Authorization, Content-Type`.

**Consistency tradeoff (accepted):** KV is eventually consistent; ops from
two devices in the same instant can race and the losing tap reverts to
unchecked. Failure direction is safe (a checked dose shows unchecked —
visible and re-tappable — never silently checked). Clients keep each op
queued until a server response reflects it, so lost ops re-send. Durable
Objects would give strict consistency; not needed at this scale.

## Frontend

**`src/config.ts`** — the Worker base URL (hardcoded after first deploy).

**`src/api.ts`** — thin fetch wrapper: `fetchChecks(token)` and
`postOps(token, ops)`; throws on non-2xx; distinguishes `401` (bad token)
from network failure.

**`src/syncStore.ts`** — replaces `createChecksStore` in `App`; keeps the
exact `{ isChecked(doseId), toggle(doseId) }` interface (so `MonthGrid` and
`DayDetail` are untouched) and adds `status()`.

- localStorage keys: `dogscheduler:checks:v1` (cache, existing),
  `dogscheduler:queue:v1` (pending ops array),
  `dogscheduler:token:v1` (the secret),
  `dogscheduler:migrated:v1` (one-time migration flag). Corrupt queue JSON
  is discarded (cache keeps its existing corrupt-backup behavior).
- **Statuses:** `synced` | `syncing` | `offline` (with pending count) |
  `no-token`. Displayed as a small indicator in the app header.
- **Toggle:** optimistic — update signal + cache, append op to queue,
  persist queue, attempt flush.
- **Flush:** POST the whole queue; on success, adopt the response map as
  truth (overlaying any ops still pending), and remove from the queue only
  ops the response reflects (`check` → id present; `uncheck` → id absent).
  On failure: status `offline`, queue kept. Retry triggers: next toggle,
  `online` event, `visibilitychange` → visible.
- **Refresh:** on init and on `visibilitychange` → visible, GET `/checks`
  and adopt (with pending overlay). This is how device B sees device A.
- **Migration:** on first init with a token where `migrated` flag is unset,
  enqueue a `check` op (original cached timestamp) for every cached entry,
  flush, set the flag on success.
- **No token:** app runs purely locally (current behavior), status
  `no-token`; a one-field setup screen ("Paste sync token", saved to
  localStorage) is shown instead of the calendar until saved or skipped.
- `401` responses surface as `no-token` (token cleared) rather than
  `offline`, so a mistyped token is distinguishable from a dead network.

**PWA:** `public/manifest.webmanifest` (name "DogScheduler", short_name
"DogSched", `display: standalone`, `start_url: /DogScheduler/`, theme/
background colors) linked from `index.html`, plus generated PNG icons
(192/512 for the manifest, 180 as `apple-touch-icon`) and
`apple-mobile-web-app-capable` / status-bar meta tags for iOS. Icons are
generated by a small committed script (no external assets).

## Provisioning & deployment

One-time, in order:

1. User: `wrangler login` (done 2026-07-22).
2. `wrangler kv namespace create` → id written into `worker/wrangler.toml`.
3. `wrangler deploy` → Worker URL, written into `src/config.ts`.
4. Generate token (`openssl rand -base64 32`), `wrangler secret put
   SYNC_TOKEN`, print token once for the user.
5. Frontend deploys as always (push to `main` → GitHub Pages).

Worker redeploys are manual (`wrangler deploy`) and rare.

## Testing

- **`worker/ops.ts`** (pure, no I/O): check-if-absent, uncheck-deletes,
  in-order application, idempotent replay, validation rejects malformed ops
  without partial application.
- **`src/syncStore.ts`** with fake fetch + fake storage: optimistic toggle;
  queue survives failed flush; ops removed only when reflected; migration
  enqueues exactly once and carries original timestamps; refresh adopts
  server map with pending overlay; 401 clears token → `no-token`.
- **Live worker smoke test** (after deploy): 401 without token; GET returns
  map with token; POST check → GET reflects it; POST uncheck → gone.
- **Manual E2E:** check a dose in one browser, see it in another after
  refocus; airplane-mode a device, tap, restore network, confirm it lands.

## Out of scope (this round)

- Service worker / fully-offline fresh launch.
- Multiple users, profiles, or per-device identity.
- Real-time push (WebSocket/SSE) between devices.
- Editing medication schedules via UI.
