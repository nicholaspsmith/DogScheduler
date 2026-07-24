# DogScheduler: Medication Editor — Design

**Date:** 2026-07-23
**Status:** Approved
**Builds on:** `2026-07-22-medication-calendar-design.md`, `2026-07-22-cross-device-sync-design.md`

## Purpose

Let the user add and remove medications from the app itself — name, amount
per dose, and a schedule built from phase rows ("twice a day for 5 days,
then once a day for 5 days, then every other day for 12 days") — instead of
schedule changes being code edits. Medication definitions become synced
data flowing through the existing Worker op-log; the five current meds are
seeded in as data.

**Hard requirement:** the current med list and every existing checked dose
must survive this change exactly (see Preservation guarantees).

## Decisions (from brainstorming)

- **Input UX:** structured phase-builder rows (dropdowns), not free-text
  parsing. A live preview of the expanded schedule gates Save.
- **Transport:** med changes ride the existing `/ops` op-log (new op
  kinds), keeping one server pipeline — but the client only permits med
  edits while online; med ops are never placed in the offline queue.
- **Data model:** all meds (including the current five) live in synced
  storage; the hardcoded list becomes seed data.
- **Operations:** add and delete only. Edit = delete + re-add. Deleting a
  med preserves its check history in storage (orphaned, invisible).

## Server

**Storage:** second KV value `meds:v1` — an ordered JSON array of `MedDef`
(display order = add order). `checks:v1` is untouched by med machinery.

**`MedDef`** (exactly the engine's serializable med shape):

```ts
{
  id: string
  name: string
  doseText: string
  unitsPerDose?: number   // present only for countable pill courses
  unitLabel?: string
  phases?: { start: string; startSlot: 'am'|'pm'; intervalSlots: number; count: number }[]
  monthly?: { dayOfMonth: number; slot: 'am'|'pm'; start: string }
}
```

**New ops** accepted by `POST /ops`, mixed freely with `check`/`uncheck`:

- `{ op: 'add-med', med: MedDef }` — appends **only if no med with that id
  exists** (add-if-absent: replays converge).
- `{ op: 'delete-med', medId: string }` — filters the med out; idempotent.

**Validation:** `parseOps` gains full `MedDef` shape validation (string
fields, slot enum, positive integer `count`/`intervalSlots`/`dayOfMonth`
1–31, date strings `YYYY-MM-DD`, at least one of `phases`/`monthly`,
`unitsPerDose` positive number when present, both unit fields present or
both absent). Any invalid op rejects the whole batch with 400, nothing
applied.

**Endpoints:**
- `POST /ops` → now returns `{ checks, meds }`. Loads/writes `meds:v1`
  only when the batch contains med ops.
- `GET /state` (new) → `{ checks, meds }`.
- `GET /checks` → unchanged (`{ checks }`), kept for transition safety; an
  old client POSTing to `/ops` ignores the extra `meds` field in the
  response. Worker deploys before the frontend.

## Client data flow

- Sync store gains a `meds` signal, cached at localStorage
  `dogscheduler:meds:v1`; `sync()` uses `GET /state` and adopts both maps.
  Corrupt meds cache → fall back to `SEED_MEDS` (never crash the calendar).
- **Seeding:** after a successful `GET /state`, if the server med list is
  empty, the client sends `add-med` ops for all of `SEED_MEDS`. No flag:
  deterministic ids + add-if-absent make racing devices converge.
- **Online-only med edits:** add/delete sends a dedicated immediate
  `POST /ops` (never enters the persistent queue). Success adopts the
  response; failure (network, 401) shows an inline error and changes
  nothing. Save is disabled when `navigator.onLine` is false, with a
  "requires connection" note; the runtime failure path covers the cases
  `onLine` misses.
- **Ids:** user-added meds get `slug(name)-<4 random base36 chars>` (e.g.
  `gabapentin-x7k2`) so a deleted med's orphaned checks can never attach to
  a later same-named med. Seeds keep their exact current ids.
- **No-token/local mode:** calendar renders from cached/seed meds; the Meds
  screen shows the list read-only with a "connect sync to manage
  medications" notice.

## UI

Header gains a **Meds** button → full-screen Meds view (pattern as the
token screen), containing:

- **Med list:** one row per med — name, dose text, derived schedule summary
  (e.g. "2 tablets · taper, ends Aug 10", "1 dose · monthly on the 14th ·
  ongoing"). Delete = inline two-tap confirm (row transforms to "Remove
  {name}? [Remove] [Cancel]"); no browser dialogs.
- **Add form:**
  - Name (required, non-empty after trim).
  - Amount per dose: positive number, decimals allowed + unit picker:
    `tablets` / `capsules` / `mL` / `dose`. `doseText` is derived
    ("2 capsules by mouth" for tablets/capsules; "0.7 mL" for mL;
    "1 dose" for dose). `unitsPerDose`/`unitLabel` are stored only for
    tablets/capsules (countable → appears in Pills remaining).
  - Start date (defaults today) + first slot (AM/PM).
  - **Phase rows:** `[frequency ▾] for [N] [days|weeks]` with frequencies
    *Twice a day (AM & PM)* (12h), *Once a day* (24h), *Every other day*
    (48h), *Weekly* (168h, duration in weeks); "+ add phase" appends.
    Optional terminal row *Monthly on day [N] — ongoing* (allowed only as
    the last or only row; maps to the `monthly` rule starting at the first
    day-of-month N strictly after the final phase dose date — matching the
    Adequan precedent: weekly ends Aug 11 → monthly starts Sep 11 — or the
    first day-of-month N on/after the start date if it is the only row).
  - **Slot chaining:** the first phase starts at (start date, first slot);
    each later phase starts one interval after the previous phase's final
    dose, carrying the AM/PM position — reproducing how the prednisone
    taper was hand-computed. Users never pick per-phase slots.
  - **Dose-count math per row:** twice-a-day for N days = 2N doses;
    once-a-day for N days = N; every-other-day for N days =
    floor((N−1)/2)+1; weekly for N weeks = N.
  - **Live preview** (rendered through the real engine): first dose,
    per-phase date ranges, last dose or "ongoing", total doses, total
    units. Save enabled only when: form valid AND preview computed AND
    online.

## Engine refactor

- `schedule.ts`: `dosesForDay(meds, date)` and `pillInventories(meds)`
  take the med list as a parameter; the constant becomes
  `export const SEED_MEDS: MedDef[]` with values copied verbatim from
  today's `MEDS`. `MedDef`/`Slot`/`Dose` types are shared with the worker
  op validation (worker keeps its own structural copy, as it does for
  `Checks` today).
- New pure `buildPhases(startDate: string, startSlot: Slot, rows: Row[])`
  → `{ phases: Phase[]; monthly?: Monthly }` implementing the chaining and
  per-row math above. The form and preview both use it.
- New pure `scheduleSummary(med): string` for the med-list rows.

## Preservation guarantees (hard requirement)

1. **Identity pinned by tests:** the entire existing schedule test suite
   (prednisone taper boundaries, all `medId:date:slot` ids, totals) runs
   against `SEED_MEDS`; any drift in a seeded med's expansion fails CI. A
   test asserts `buildPhases('2026-07-21', 'pm', [twice-a-day×5d,
   once-a-day×5d, every-other-day×9d])` reproduces prednisone's stored
   phases exactly.
2. **Checks isolation:** no code path in add/delete/seed reads or writes
   `checks:v1`; delete-med only filters `meds:v1`. Worker tests assert a
   med-op batch leaves the checks map byte-identical.
3. **Live backup:** before deploying the new Worker, back up the current
   production state (`GET /checks` → timestamped local file, parse-checked).
   After the first device syncs post-deploy, diff live checks against the
   backup — must be identical (modulo doses checked in between).

## Testing

- `buildPhases`: each frequency's count math; multi-phase slot chaining
  (12h→24h ends AM → next AM); prednisone-reproduction test; weekly;
  monthly-tail start-date computation; monthly-only.
- Worker `ops.ts`: MedDef validation matrix (each invalid field rejects
  batch); add-if-absent; delete idempotent; mixed batch applies in order;
  med batch leaves checks untouched.
- Sync store: adopts `{checks, meds}`; seeds only when server list empty;
  seed race converges (two stores, same fake server); med op failure
  changes nothing locally; meds cache round-trip + corrupt fallback.
- UI-level logic (pure helpers): `scheduleSummary` strings; doseText
  derivation; id slugging.
- Live: backup/diff procedure above; manual E2E — add a test med on the
  Mac, see it on the iPhone, check a dose of it, delete it, confirm checks
  for other meds intact.

## Out of scope (this round)

- In-place editing of a med (delete + re-add covers it).
- Offline med management.
- Free-text/natural-language schedule parsing.
- Restoring a deleted med's orphaned check history through the UI.
