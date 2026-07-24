# Medication Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Users add and remove medications in-app (name, amount per dose, phase-builder schedule) with definitions synced through the existing Worker op-log; the five current meds become seed data.

**Architecture:** `schedule.ts` becomes an engine parameterized over a `MedDef[]` list (`SEED_MEDS` holds today's five meds verbatim). A pure `buildPhases` turns builder rows into phase data with automatic slot chaining. The Worker's `/ops` gains `add-med`/`delete-med` op kinds and a `GET /state` endpoint; `meds:v1` is a second KV value. The sync store gains a cached `meds` signal, empty-server seeding, and online-only `addMed`/`deleteMed`. UI: a Meds screen (list + inline delete confirm + add form with live preview). Spec: `docs/superpowers/specs/2026-07-23-med-editor-design.md`.

**Tech Stack:** Existing SolidJS + Vite + Vitest + Cloudflare Worker/KV. No new dependencies.

## Global Constraints

- **Preservation (hard requirement):** seeded med ids and every dose id must stay byte-identical (`prednisone:2026-07-22:am` etc.); no med code path reads or writes `checks:v1`; live backup taken before the Worker deploy.
- localStorage keys: existing ones unchanged; new `dogscheduler:meds:v1`.
- KV: existing `checks:v1` untouched; new `meds:v1` (ordered JSON array of MedDef).
- Op semantics: `add-med` appends only if id absent; `delete-med` filters, idempotent; any invalid op in a batch → 400, nothing applied.
- Med edits are online-only: dedicated immediate `POST /ops`, never the offline queue.
- User-added med ids: `slug(name)-<4 base36 chars>`.
- `GET /checks` keeps working; Worker deploys before the frontend ships.
- `npm test` and `npm run build` pass at the end of every task. Branch: `med-editor`.

---

### Task 1: Engine parameterized over meds; `SEED_MEDS`

**Files:**
- Modify: `src/schedule.ts`
- Modify: `src/schedule.test.ts`
- Modify: `src/MonthGrid.tsx`, `src/DayDetail.tsx`, `src/Supply.tsx` (temporary direct `SEED_MEDS` import; Task 6 threads dynamic meds)

**Interfaces:**
- Consumes: current schedule module.
- Produces: `export interface Phase { start: string; startSlot: Slot; intervalSlots: number; count: number }`; `export interface Monthly { dayOfMonth: number; slot: Slot; start: string }`; `export interface MedDef { id: string; name: string; doseText: string; unitsPerDose?: number; unitLabel?: string; phases?: Phase[]; monthly?: Monthly }`; `export const SEED_MEDS: MedDef[]` (values verbatim from today's `MEDS`, same order); `expandPhase(med: MedDef, phase: Phase): Dose[]`; `expandMed(med: MedDef): Dose[]` (all finite phase doses, phase order); `dosesForDay(meds: MedDef[], date: string): Dose[]`; `pillInventories(meds: MedDef[]): PillInventory[]`. `Dose`, `PillInventory`, `Slot`, `doseId` unchanged.

This is a behavior-preserving refactor: the suite is the safety net and must end green with assertions unchanged except for the new parameter.

- [ ] **Step 1: Add the seed-identity test (fails against current code)**

Append to `src/schedule.test.ts`:

```ts
describe('SEED_MEDS identity', () => {
  it('keeps the five med ids, in order', () => {
    expect(SEED_MEDS.map((m) => m.id)).toEqual([
      'prednisone', 'clindamycin', 'fluconazole', 'heartworm', 'adequan',
    ])
  })
  it('expandMed(prednisone) yields the exact 20 known dose ids', () => {
    const pred = SEED_MEDS.find((m) => m.id === 'prednisone')!
    const ids = expandMed(pred).map((d) => d.id)
    expect(ids).toHaveLength(20)
    expect(ids[0]).toBe('prednisone:2026-07-21:pm')
    expect(ids[9]).toBe('prednisone:2026-07-26:am')
    expect(ids[10]).toBe('prednisone:2026-07-27:am')
    expect(ids.at(-1)).toBe('prednisone:2026-08-10:am')
  })
})
```

And change the imports/usages throughout `src/schedule.test.ts`:

```ts
import { dosesForDay, pillInventories, expandMed, SEED_MEDS, type Dose } from './schedule'
```

Every `dosesForDay(<date>)` becomes `dosesForDay(SEED_MEDS, <date>)` (including inside the `dosesInRange` helper) and `pillInventories()` becomes `pillInventories(SEED_MEDS)`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `SEED_MEDS`/`expandMed` not exported and `dosesForDay` arity mismatch.

- [ ] **Step 3: Refactor `src/schedule.ts`**

Rename the internal interfaces and export them (`interface Phase` → `export interface Phase`, `interface Monthly` → `export interface Monthly`, `interface Med` → `export interface MedDef` — update the field comment mentions), rename `const MEDS` to `export const SEED_MEDS: MedDef[]` (identical contents), and replace the function bottom half with:

```ts
export function expandPhase(med: MedDef, phase: Phase): Dose[] {
  const doses: Dose[] = []
  const base = phase.startSlot === 'pm' ? 1 : 0
  for (let i = 0; i < phase.count; i++) {
    const offset = base + i * phase.intervalSlots
    const date = addDays(phase.start, Math.floor(offset / 2))
    const slot: Slot = offset % 2 === 1 ? 'pm' : 'am'
    doses.push(makeDose(med, date, slot))
  }
  return doses
}

export function expandMed(med: MedDef): Dose[] {
  return (med.phases ?? []).flatMap((phase) => expandPhase(med, phase))
}

function monthlyDoseForDay(med: MedDef, date: string): Dose | null {
  const rule = med.monthly
  if (!rule) return null
  if (date < rule.start) return null
  if (parseDateStr(date).d !== rule.dayOfMonth) return null
  return makeDose(med, date, rule.slot)
}

export function dosesForDay(meds: MedDef[], date: string): Dose[] {
  const result: Dose[] = []
  for (const med of meds) {
    for (const dose of expandMed(med)) {
      if (dose.date === date) result.push(dose)
    }
    const monthly = monthlyDoseForDay(med, date)
    if (monthly) result.push(monthly)
  }
  return result
}

export function pillInventories(meds: MedDef[]): PillInventory[] {
  const result: PillInventory[] = []
  for (const med of meds) {
    if (med.unitsPerDose === undefined || med.unitLabel === undefined) continue
    const doses = expandMed(med)
    result.push({
      medId: med.id,
      medName: med.name,
      unitsPerDose: med.unitsPerDose,
      unitLabel: med.unitLabel,
      totalUnits: med.unitsPerDose * doses.length,
      doseIds: doses.map((d) => d.id),
    })
  }
  return result
}
```

(`makeDose`, `doseId`, the `PillInventory` interface, and the med data itself are untouched; the old `phaseDoses` helper is subsumed by `expandPhase`.)

- [ ] **Step 4: Patch the three components (temporary)**

In `src/MonthGrid.tsx` and `src/DayDetail.tsx`: `import { dosesForDay, SEED_MEDS } from './schedule'` (DayDetail also keeps `type Dose`) and change each `dosesForDay(<arg>)` call to `dosesForDay(SEED_MEDS, <arg>)`. In `src/Supply.tsx`: `import { pillInventories, SEED_MEDS } from './schedule'` and `pillInventories(SEED_MEDS)`.

- [ ] **Step 5: Verify green**

Run: `npm test` — Expected: PASS (65 tests).
Run: `npm run build` — Expected: succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/schedule.ts src/schedule.test.ts src/MonthGrid.tsx src/DayDetail.tsx src/Supply.tsx
git commit -m "refactor: parameterize schedule engine over a MedDef list"
```

---

### Task 2: `buildPhases` — builder rows → phase data

**Files:**
- Create: `src/builder.ts`
- Test: `src/builder.test.ts`

**Interfaces:**
- Consumes: `Phase`, `Monthly`, `Slot` from `src/schedule.ts`; `addDays`, `parseDateStr`, `toDateStr`, `daysInMonth` from `src/dates.ts`.
- Produces: `export type BuilderRow = { kind: 'twice-daily' | 'once-daily' | 'every-other-day'; days: number } | { kind: 'weekly'; weeks: number } | { kind: 'monthly'; dayOfMonth: number }`; `export function buildPhases(startDate: string, startSlot: Slot, rows: BuilderRow[]): { phases: Phase[]; monthly?: Monthly }` — throws `Error` with a user-showable message on invalid input.

Semantics (from spec): first phase starts at (startDate, startSlot); each later phase starts one of **its own** intervals after the previous phase's final dose, carrying the AM/PM position. Dose counts: twice-daily×Nd = 2N; once-daily×Nd = N; every-other-day×Nd = floor((N−1)/2)+1; weekly×Nw = N. Monthly row only last; its start = first day-of-month N **strictly after** the final phase dose (or on/after startDate if it is the only row); its slot carries from the last phase dose (or startSlot if only row).

- [ ] **Step 1: Write the failing tests**

Create `src/builder.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildPhases } from './builder'
import { SEED_MEDS } from './schedule'

describe('buildPhases', () => {
  it('reproduces the prednisone taper exactly from its row description', () => {
    const { phases, monthly } = buildPhases('2026-07-21', 'pm', [
      { kind: 'twice-daily', days: 5 },
      { kind: 'once-daily', days: 5 },
      { kind: 'every-other-day', days: 9 },
    ])
    const pred = SEED_MEDS.find((m) => m.id === 'prednisone')!
    expect(phases).toEqual(pred.phases)
    expect(monthly).toBeUndefined()
  })

  it('reproduces adequan: weekly ×4 then monthly on the 11th', () => {
    const { phases, monthly } = buildPhases('2026-07-21', 'pm', [
      { kind: 'weekly', weeks: 4 },
      { kind: 'monthly', dayOfMonth: 11 },
    ])
    const adequan = SEED_MEDS.find((m) => m.id === 'adequan')!
    expect(phases).toEqual(adequan.phases)
    expect(monthly).toEqual(adequan.monthly) // start 2026-09-11: first 11th strictly after Aug 11
  })

  it('monthly-only: first day-of-month on/after the start date, start slot', () => {
    expect(buildPhases('2026-08-14', 'pm', [{ kind: 'monthly', dayOfMonth: 14 }])).toEqual({
      phases: [],
      monthly: { dayOfMonth: 14, slot: 'pm', start: '2026-08-14' }, // on/after includes the day itself
    })
    expect(buildPhases('2026-08-15', 'am', [{ kind: 'monthly', dayOfMonth: 14 }]).monthly)
      .toEqual({ dayOfMonth: 14, slot: 'am', start: '2026-09-14' })
  })

  it('monthly start skips months lacking that day', () => {
    // From Jan 31, monthly on the 31st: Feb/Apr etc. lack a 31st
    expect(buildPhases('2027-02-01', 'am', [{ kind: 'monthly', dayOfMonth: 31 }]).monthly!.start)
      .toBe('2027-03-31')
  })

  it('every-other-day day-count math: 12 days = 6 doses', () => {
    const { phases } = buildPhases('2026-07-23', 'am', [{ kind: 'every-other-day', days: 12 }])
    expect(phases).toEqual([{ start: '2026-07-23', startSlot: 'am', intervalSlots: 4, count: 6 }])
  })

  it('chains slots: twice-daily from AM ends PM, then once-daily lands PM next day', () => {
    // 2 days twice-daily from AM Jul 23: doses AM23,PM23,AM24,PM24 (4). Next daily dose: PM Jul 25.
    const { phases } = buildPhases('2026-07-23', 'am', [
      { kind: 'twice-daily', days: 2 },
      { kind: 'once-daily', days: 3 },
    ])
    expect(phases[1]).toEqual({ start: '2026-07-25', startSlot: 'pm', intervalSlots: 2, count: 3 })
  })

  it.each([
    ['no rows', '2026-07-23', [] as never[]],
    ['monthly not last', '2026-07-23', [{ kind: 'monthly', dayOfMonth: 1 }, { kind: 'once-daily', days: 2 }]],
    ['zero days', '2026-07-23', [{ kind: 'once-daily', days: 0 }]],
    ['fractional days', '2026-07-23', [{ kind: 'once-daily', days: 1.5 }]],
    ['dayOfMonth out of range', '2026-07-23', [{ kind: 'monthly', dayOfMonth: 32 }]],
    ['bad start date', 'not-a-date', [{ kind: 'once-daily', days: 2 }]],
  ])('throws on %s', (_name, start, rows) => {
    expect(() => buildPhases(start as string, 'am', rows as never)).toThrow()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module './builder'`.

- [ ] **Step 3: Implement `src/builder.ts`**

```ts
import type { Monthly, Phase, Slot } from './schedule'
import { addDays, daysInMonth, parseDateStr, toDateStr } from './dates'

export type BuilderRow =
  | { kind: 'twice-daily' | 'once-daily' | 'every-other-day'; days: number }
  | { kind: 'weekly'; weeks: number }
  | { kind: 'monthly'; dayOfMonth: number }

const INTERVAL: Record<'twice-daily' | 'once-daily' | 'every-other-day' | 'weekly', number> = {
  'twice-daily': 1,
  'once-daily': 2,
  'every-other-day': 4,
  weekly: 14,
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function isPosInt(n: number): boolean {
  return Number.isInteger(n) && n > 0
}

function rowCount(row: BuilderRow): number {
  switch (row.kind) {
    case 'twice-daily':
      return row.days * 2
    case 'once-daily':
      return row.days
    case 'every-other-day':
      return Math.floor((row.days - 1) / 2) + 1
    case 'weekly':
      return row.weeks
    case 'monthly':
      return 0 // not phase-based
  }
}

// First date with day-of-month `dayOfMonth` satisfying the comparison with
// `fromDate`; skips months that lack that day (e.g. the 31st in February).
function monthlyStart(fromDate: string, dayOfMonth: number, strictlyAfter: boolean): string {
  let { y, m } = parseDateStr(fromDate)
  for (;;) {
    if (dayOfMonth <= daysInMonth(y, m)) {
      const candidate = toDateStr(y, m, dayOfMonth)
      if (strictlyAfter ? candidate > fromDate : candidate >= fromDate) return candidate
    }
    m++
    if (m > 12) {
      m = 1
      y++
    }
  }
}

export function buildPhases(
  startDate: string,
  startSlot: Slot,
  rows: BuilderRow[],
): { phases: Phase[]; monthly?: Monthly } {
  if (!DATE_RE.test(startDate)) throw new Error('Invalid start date')
  if (rows.length === 0) throw new Error('Add at least one schedule phase')

  const phases: Phase[] = []
  let monthly: Monthly | undefined
  const base = startSlot === 'pm' ? 1 : 0
  // Absolute half-day-slot offset (from startDate AM) of the last dose so far.
  let lastOffset: number | null = null

  rows.forEach((row, i) => {
    if (row.kind === 'monthly') {
      if (i !== rows.length - 1) throw new Error('Monthly must be the last phase')
      if (!isPosInt(row.dayOfMonth) || row.dayOfMonth > 31) throw new Error('Day of month must be 1-31')
      if (lastOffset === null) {
        monthly = { dayOfMonth: row.dayOfMonth, slot: startSlot, start: monthlyStart(startDate, row.dayOfMonth, false) }
      } else {
        const lastDate = addDays(startDate, Math.floor(lastOffset / 2))
        const slot: Slot = lastOffset % 2 === 1 ? 'pm' : 'am'
        monthly = { dayOfMonth: row.dayOfMonth, slot, start: monthlyStart(lastDate, row.dayOfMonth, true) }
      }
      return
    }
    const duration = row.kind === 'weekly' ? row.weeks : row.days
    if (!isPosInt(duration)) throw new Error('Phase length must be a whole number of at least 1')
    const interval = INTERVAL[row.kind]
    const count = rowCount(row)
    const startOffset = lastOffset === null ? base : lastOffset + interval
    phases.push({
      start: addDays(startDate, Math.floor(startOffset / 2)),
      startSlot: startOffset % 2 === 1 ? 'pm' : 'am',
      intervalSlots: interval,
      count,
    })
    lastOffset = startOffset + (count - 1) * interval
  })

  return monthly === undefined ? { phases } : { phases, monthly }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS. The prednisone/adequan reproduction tests are the preservation cornerstone — if they fail, do not adjust the seeds; fix `buildPhases`.

- [ ] **Step 5: Commit**

```bash
git add src/builder.ts src/builder.test.ts
git commit -m "feat: phase builder math with slot chaining"
```

---

### Task 3: Summary + form helpers (pure)

**Files:**
- Create: `src/summary.ts`
- Create: `src/medForm.ts`
- Test: `src/summary.test.ts`, `src/medForm.test.ts`

**Interfaces:**
- Consumes: `MedDef`, `expandMed`, `Slot` (Task 1); `buildPhases`, `BuilderRow` (Task 2); `parseDateStr` from dates.
- Produces: `scheduleSummary(med: MedDef): string`; `export type Unit = 'tablets' | 'capsules' | 'mL' | 'dose'`; `export interface MedFormInput { name: string; amount: number; unit: Unit; startDate: string; startSlot: Slot; rows: BuilderRow[] }`; `deriveDoseText(amount: number, unit: Unit): string`; `slugId(name: string, rand?: () => number): string`; `buildMedDef(input: MedFormInput, rand?: () => number): MedDef` (throws user-showable `Error`).

- [ ] **Step 1: Write the failing tests**

Create `src/summary.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { scheduleSummary } from './summary'
import { SEED_MEDS } from './schedule'

const med = (id: string) => SEED_MEDS.find((m) => m.id === id)!

describe('scheduleSummary', () => {
  it('summarizes a finite multi-phase taper with its end date', () => {
    expect(scheduleSummary(med('prednisone'))).toBe(
      'twice daily ×10, then daily ×5, then every other day ×5 · ends Aug 10, 2026',
    )
  })
  it('summarizes a monthly-only med as ongoing', () => {
    expect(scheduleSummary(med('heartworm'))).toBe('monthly on the 14th, ongoing')
  })
  it('summarizes phases + monthly tail', () => {
    expect(scheduleSummary(med('adequan'))).toBe('weekly ×4, then monthly on the 11th, ongoing')
  })
  it('uses correct ordinals', () => {
    expect(scheduleSummary({ id: 'x', name: 'X', doseText: 'x', monthly: { dayOfMonth: 21, slot: 'am', start: '2026-08-21' } }))
      .toBe('monthly on the 21st, ongoing')
    expect(scheduleSummary({ id: 'x', name: 'X', doseText: 'x', monthly: { dayOfMonth: 12, slot: 'am', start: '2026-08-12' } }))
      .toBe('monthly on the 12th, ongoing')
  })
})
```

Create `src/medForm.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildMedDef, deriveDoseText, slugId } from './medForm'

const fixedRand = () => 0 // suffix "0000"

describe('deriveDoseText', () => {
  it.each([
    [2, 'tablets', '2 tablets by mouth'],
    [3, 'capsules', '3 capsules by mouth'],
    [0.7, 'mL', '0.7 mL'],
    [1, 'dose', '1 dose'],
    [2, 'dose', '2 doses'],
  ] as const)('%s %s -> %s', (amount, unit, expected) => {
    expect(deriveDoseText(amount, unit)).toBe(expected)
  })
})

describe('slugId', () => {
  it('slugifies and suffixes', () => {
    expect(slugId('Gabapentin 100mg!', fixedRand)).toBe('gabapentin-100mg-0000')
  })
  it('falls back for all-symbol names', () => {
    expect(slugId('★★★', fixedRand)).toBe('med-0000')
  })
})

describe('buildMedDef', () => {
  const base = {
    name: 'Gabapentin',
    amount: 2,
    unit: 'capsules' as const,
    startDate: '2026-07-24',
    startSlot: 'am' as const,
    rows: [{ kind: 'once-daily' as const, days: 3 }],
  }
  it('builds a countable med with units and phases', () => {
    expect(buildMedDef(base, fixedRand)).toEqual({
      id: 'gabapentin-0000',
      name: 'Gabapentin',
      doseText: '2 capsules by mouth',
      unitsPerDose: 2,
      unitLabel: 'capsules',
      phases: [{ start: '2026-07-24', startSlot: 'am', intervalSlots: 2, count: 3 }],
    })
  })
  it('omits unit fields for mL and non-integer amounts', () => {
    expect(buildMedDef({ ...base, unit: 'mL', amount: 0.7 }, fixedRand).unitsPerDose).toBeUndefined()
    expect(buildMedDef({ ...base, amount: 2.5 }, fixedRand).unitsPerDose).toBeUndefined()
  })
  it('rejects empty name and non-positive amount', () => {
    expect(() => buildMedDef({ ...base, name: '  ' }, fixedRand)).toThrow('Name')
    expect(() => buildMedDef({ ...base, amount: 0 }, fixedRand)).toThrow('Amount')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module './summary'` and `'./medForm'`.

- [ ] **Step 3: Implement `src/summary.ts`**

```ts
import { expandMed, type MedDef } from './schedule'
import { parseDateStr } from './dates'

const FREQ_WORD: Record<number, string> = {
  1: 'twice daily',
  2: 'daily',
  4: 'every other day',
  14: 'weekly',
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function ordinal(n: number): string {
  const tens = n % 100
  if (tens >= 11 && tens <= 13) return `${n}th`
  switch (n % 10) {
    case 1: return `${n}st`
    case 2: return `${n}nd`
    case 3: return `${n}rd`
    default: return `${n}th`
  }
}

export function shortDate(date: string): string {
  const { y, m, d } = parseDateStr(date)
  return `${MONTHS[m - 1]} ${d}, ${y}`
}

export function scheduleSummary(med: MedDef): string {
  const parts = (med.phases ?? []).map(
    (p) => `${FREQ_WORD[p.intervalSlots] ?? `every ${p.intervalSlots * 12}h`} ×${p.count}`,
  )
  if (med.monthly) parts.push(`monthly on the ${ordinal(med.monthly.dayOfMonth)}, ongoing`)
  let text = parts.join(', then ')
  if (!med.monthly) {
    const doses = expandMed(med)
    const last = doses.at(-1)
    if (last) text += ` · ends ${shortDate(last.date)}`
  }
  return text
}
```

- [ ] **Step 4: Implement `src/medForm.ts`**

```ts
import type { MedDef, Slot } from './schedule'
import { buildPhases, type BuilderRow } from './builder'

export type Unit = 'tablets' | 'capsules' | 'mL' | 'dose'

export interface MedFormInput {
  name: string
  amount: number
  unit: Unit
  startDate: string
  startSlot: Slot
  rows: BuilderRow[]
}

export function deriveDoseText(amount: number, unit: Unit): string {
  if (unit === 'tablets' || unit === 'capsules') return `${amount} ${unit} by mouth`
  if (unit === 'mL') return `${amount} mL`
  return amount === 1 ? '1 dose' : `${amount} doses`
}

const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz'

export function slugId(name: string, rand: () => number = Math.random): string {
  const slug =
    name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'med'
  let suffix = ''
  for (let i = 0; i < 4; i++) suffix += BASE36[Math.floor(rand() * 36)]
  return `${slug}-${suffix}`
}

export function buildMedDef(input: MedFormInput, rand: () => number = Math.random): MedDef {
  if (input.name.trim().length === 0) throw new Error('Name is required')
  if (!(input.amount > 0)) throw new Error('Amount must be positive')
  const { phases, monthly } = buildPhases(input.startDate, input.startSlot, input.rows)
  const med: MedDef = {
    id: slugId(input.name, rand),
    name: input.name.trim(),
    doseText: deriveDoseText(input.amount, input.unit),
  }
  if (phases.length > 0) med.phases = phases
  if (monthly) med.monthly = monthly
  if ((input.unit === 'tablets' || input.unit === 'capsules') && Number.isInteger(input.amount)) {
    med.unitsPerDose = input.amount
    med.unitLabel = input.unit
  }
  return med
}
```

- [ ] **Step 5: Verify green, commit**

Run: `npm test` — Expected: PASS. Run: `npm run build` — Expected: succeeds.

```bash
git add src/summary.ts src/summary.test.ts src/medForm.ts src/medForm.test.ts
git commit -m "feat: schedule summaries and med-form helpers"
```

---

### Task 4: Worker — med ops, `/state`, backup, deploy

**Files:**
- Modify: `worker/ops.ts`
- Modify: `worker/ops.test.ts`
- Modify: `worker/index.ts`
- Modify: `.gitignore` (add `.backups/`)

**Interfaces:**
- Consumes: existing worker module.
- Produces (worker-side structural types): `PhaseDef`, `MonthlyDef`, `MedDef`, `SyncState { checks: Checks; meds: MedDef[] }`; `Op` gains `{ op: 'add-med'; med: MedDef }` and `{ op: 'delete-med'; medId: string }`; `validMedDef(raw: unknown): boolean`; `applyState(state: SyncState, ops: Op[]): SyncState` (replaces `applyOps`). Endpoints: `GET /state` → `{ checks, meds }`; `POST /ops` → `{ checks, meds }`; `GET /checks` unchanged.

- [ ] **Step 1: Write the failing tests**

In `worker/ops.test.ts`, change the import to `import { parseOps, applyState, type MedDef } from './ops'`, wrap every existing `applyOps(<checks>, <ops>)` call as `applyState({ checks: <checks>, meds: [] }, <ops>).checks` (the assertions stay identical), and append:

```ts
const GABA: MedDef = {
  id: 'gabapentin-x7k2',
  name: 'Gabapentin',
  doseText: '2 capsules by mouth',
  unitsPerDose: 2,
  unitLabel: 'capsules',
  phases: [{ start: '2026-07-24', startSlot: 'am', intervalSlots: 2, count: 3 }],
}

describe('med ops', () => {
  it('add-med appends; second add with same id is ignored', () => {
    const once = applyState({ checks: {}, meds: [] }, [{ op: 'add-med', med: GABA }])
    expect(once.meds).toEqual([GABA])
    const twice = applyState(once, [{ op: 'add-med', med: { ...GABA, name: 'Impostor' } }])
    expect(twice.meds).toEqual([GABA])
  })
  it('delete-med removes; deleting a missing id is a no-op', () => {
    const state = { checks: {}, meds: [GABA] }
    expect(applyState(state, [{ op: 'delete-med', medId: GABA.id }]).meds).toEqual([])
    expect(applyState(state, [{ op: 'delete-med', medId: 'nope' }]).meds).toEqual([GABA])
  })
  it('a med-op batch leaves checks untouched (preservation)', () => {
    const checks = { 'prednisone:2026-07-21:pm': 't0' }
    const out = applyState({ checks, meds: [] }, [
      { op: 'add-med', med: GABA },
      { op: 'delete-med', medId: GABA.id },
    ])
    expect(out.checks).toEqual(checks)
  })
  it('mixed batch applies in order', () => {
    const out = applyState({ checks: {}, meds: [] }, [
      { op: 'add-med', med: GABA },
      { op: 'check', doseId: 'gabapentin-x7k2:2026-07-24:am', at: 't1' },
    ])
    expect(out.meds).toHaveLength(1)
    expect(out.checks['gabapentin-x7k2:2026-07-24:am']).toBe('t1')
  })
})

describe('parseOps med validation', () => {
  it('accepts valid add-med and delete-med', () => {
    expect(parseOps({ ops: [{ op: 'add-med', med: GABA }] })).toHaveLength(1)
    expect(parseOps({ ops: [{ op: 'delete-med', medId: 'x' }] })).toHaveLength(1)
  })
  it('accepts a monthly-only med', () => {
    const med = { id: 'h', name: 'H', doseText: '1 dose', monthly: { dayOfMonth: 14, slot: 'pm', start: '2026-08-14' } }
    expect(parseOps({ ops: [{ op: 'add-med', med }] })).toHaveLength(1)
  })
  it.each([
    ['missing name', { ...GABA, name: undefined }],
    ['empty name', { ...GABA, name: '  ' }],
    ['no phases and no monthly', { id: 'x', name: 'X', doseText: 'x' }],
    ['empty phases array', { ...GABA, phases: [] }],
    ['bad slot', { ...GABA, phases: [{ ...GABA.phases![0], startSlot: 'noon' }] }],
    ['non-integer count', { ...GABA, phases: [{ ...GABA.phases![0], count: 1.5 }] }],
    ['bad phase date', { ...GABA, phases: [{ ...GABA.phases![0], start: '24/07/2026' }] }],
    ['dayOfMonth 32', { id: 'x', name: 'X', doseText: 'x', monthly: { dayOfMonth: 32, slot: 'pm', start: '2026-08-01' } }],
    ['unitsPerDose without unitLabel', { ...GABA, unitLabel: undefined }],
    ['negative unitsPerDose', { ...GABA, unitsPerDose: -1 }],
  ])('rejects add-med with %s (whole batch null)', (_n, med) => {
    expect(parseOps({ ops: [{ op: 'uncheck', doseId: 'ok' }, { op: 'add-med', med }] })).toBeNull()
  })
  it('rejects delete-med without string medId', () => {
    expect(parseOps({ ops: [{ op: 'delete-med', medId: 5 }] })).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `applyState` not exported (existing applyOps tests now error too; that is expected mid-refactor).

- [ ] **Step 3: Rewrite `worker/ops.ts`**

```ts
// Pure op-log semantics over the sync state. Structural copies of the
// frontend types (the worker builds separately from src/).
export type Checks = Record<string, string>
export type Slot = 'am' | 'pm'

export interface PhaseDef {
  start: string
  startSlot: Slot
  intervalSlots: number
  count: number
}

export interface MonthlyDef {
  dayOfMonth: number
  slot: Slot
  start: string
}

export interface MedDef {
  id: string
  name: string
  doseText: string
  unitsPerDose?: number
  unitLabel?: string
  phases?: PhaseDef[]
  monthly?: MonthlyDef
}

export interface SyncState {
  checks: Checks
  meds: MedDef[]
}

export type Op =
  | { op: 'check'; doseId: string; at: string }
  | { op: 'uncheck'; doseId: string }
  | { op: 'add-med'; med: MedDef }
  | { op: 'delete-med'; medId: string }

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function isSlot(v: unknown): v is Slot {
  return v === 'am' || v === 'pm'
}

function isPosInt(v: unknown): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v > 0
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

function validPhase(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null) return false
  const p = raw as Record<string, unknown>
  return (
    typeof p.start === 'string' && DATE_RE.test(p.start) &&
    isSlot(p.startSlot) && isPosInt(p.intervalSlots) && isPosInt(p.count)
  )
}

function validMonthly(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null) return false
  const m = raw as Record<string, unknown>
  return (
    isPosInt(m.dayOfMonth) && (m.dayOfMonth as number) <= 31 &&
    isSlot(m.slot) && typeof m.start === 'string' && DATE_RE.test(m.start)
  )
}

export function validMedDef(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null) return false
  const m = raw as Record<string, unknown>
  if (!nonEmptyString(m.id) || !nonEmptyString(m.name) || !nonEmptyString(m.doseText)) return false
  if (m.phases !== undefined) {
    if (!Array.isArray(m.phases) || m.phases.length === 0 || !m.phases.every(validPhase)) return false
  }
  if (m.monthly !== undefined && !validMonthly(m.monthly)) return false
  if (m.phases === undefined && m.monthly === undefined) return false
  if ((m.unitsPerDose !== undefined) !== (m.unitLabel !== undefined)) return false
  if (m.unitsPerDose !== undefined) {
    if (!(typeof m.unitsPerDose === 'number' && Number.isFinite(m.unitsPerDose) && m.unitsPerDose > 0)) return false
    if (!nonEmptyString(m.unitLabel)) return false
  }
  return true
}

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
    } else if (o.op === 'add-med' && validMedDef(o.med)) {
      parsed.push({ op: 'add-med', med: o.med as MedDef })
    } else if (o.op === 'delete-med' && typeof o.medId === 'string') {
      parsed.push({ op: 'delete-med', medId: o.medId })
    } else {
      return null
    }
  }
  return parsed
}

export function applyState(state: SyncState, ops: Op[]): SyncState {
  const checks = { ...state.checks }
  let meds = [...state.meds]
  for (const op of ops) {
    if (op.op === 'check') {
      // First check wins: keeps replays and migration idempotent.
      if (checks[op.doseId] === undefined) checks[op.doseId] = op.at
    } else if (op.op === 'uncheck') {
      delete checks[op.doseId]
    } else if (op.op === 'add-med') {
      if (!meds.some((m) => m.id === op.med.id)) meds = [...meds, op.med]
    } else {
      meds = meds.filter((m) => m.id !== op.medId)
    }
  }
  return { checks, meds }
}
```

- [ ] **Step 4: Update `worker/index.ts`**

Replace the import and the route handling:

```ts
import { applyState, parseOps, type Checks, type MedDef } from './ops'
```

Add below `CHECKS_KEY`:

```ts
const MEDS_KEY = 'meds:v1'
```

Replace everything from `const url = new URL(request.url)` through the end of the `POST /ops` block with:

```ts
    const url = new URL(request.url)
    const loadChecks = async (): Promise<Checks> =>
      (await env.KV.get(CHECKS_KEY, 'json')) ?? {}
    const loadMeds = async (): Promise<MedDef[]> =>
      (await env.KV.get(MEDS_KEY, 'json')) ?? []

    if (request.method === 'GET' && url.pathname === '/checks') {
      return json(200, { checks: await loadChecks() }, cors)
    }

    if (request.method === 'GET' && url.pathname === '/state') {
      return json(200, { checks: await loadChecks(), meds: await loadMeds() }, cors)
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
      const before = { checks: await loadChecks(), meds: await loadMeds() }
      const next = applyState(before, ops)
      const hasCheckOps = ops.some((op) => op.op === 'check' || op.op === 'uncheck')
      const hasMedOps = ops.some((op) => op.op === 'add-med' || op.op === 'delete-med')
      if (hasCheckOps) await env.KV.put(CHECKS_KEY, JSON.stringify(next.checks))
      if (hasMedOps) await env.KV.put(MEDS_KEY, JSON.stringify(next.meds))
      return json(200, next, cors)
    }
```

(The rename `load` → `loadChecks` and the conditional writes keep KV write usage minimal — check flushes don't rewrite the med list.)

- [ ] **Step 5: Verify green**

Run: `npm test` — Expected: PASS. Run: `npm run build` — Expected: succeeds.

- [ ] **Step 6: Back up live state (preservation gate — do not deploy without it)**

```bash
mkdir -p ~/Code/DogScheduler/.backups
echo '.backups/' >> ~/Code/DogScheduler/.gitignore
source /private/tmp/claude-501/-Users-nicholassmith-Code/8e7f502d-d3cf-4ff7-9344-55af65d1d809/scratchpad/sync-token.txt
U=https://dogscheduler-sync.nicholaspsmith-software.workers.dev
BK=~/Code/DogScheduler/.backups/checks-$(date +%Y%m%d-%H%M%S).json
curl -s -H "Authorization: Bearer $SYNC_TOKEN" $U/checks | python3 -m json.tool > "$BK"
python3 -c "import json,sys; d=json.load(open('$BK')); print('backup OK,', len(d['checks']), 'checks')"
```

Expected: `backup OK, <n> checks` with n > 0. If the token file is missing, ask the user for the token — do not skip the backup.

- [ ] **Step 7: Deploy the Worker and verify compatibility**

```bash
cd ~/Code/DogScheduler/worker && wrangler deploy 2>&1 | tail -3
sleep 5
curl -s -H "Authorization: Bearer $SYNC_TOKEN" $U/checks | python3 -c "import json,sys; print('checks:', len(json.load(sys.stdin)['checks']))"
curl -s -H "Authorization: Bearer $SYNC_TOKEN" $U/state | python3 -c "import json,sys; d=json.load(sys.stdin); print('state checks:', len(d['checks']), 'meds:', d['meds'])"
```

Expected: both check counts equal the backup's count; `meds: []`. The old frontend keeps working against this Worker (it only uses `/checks` and `/ops` with check ops).

- [ ] **Step 8: Commit**

```bash
git add worker/ops.ts worker/ops.test.ts worker/index.ts .gitignore
git commit -m "feat: worker med ops, /state endpoint, meds KV value"
```

---

### Task 5: API client + sync store — meds state, seeding, online-only edits

**Files:**
- Modify: `src/api.ts`, `src/api.test.ts`
- Modify: `src/syncStore.ts`, `src/syncStore.test.ts`

**Interfaces:**
- Consumes: `MedDef`, `SEED_MEDS` (Task 1); Worker `/state` (Task 4).
- Produces: `api.ts`: `export interface ApiState { checks: Checks; meds: MedDef[] }`; `SyncOp` gains `{ op: 'add-med'; med: MedDef } | { op: 'delete-med'; medId: string }`; `fetchState(token): Promise<ApiState>` (replaces `fetchChecks`); `postOps(token, ops): Promise<ApiState>`. `syncStore.ts`: `export const MEDS_KEY = 'dogscheduler:meds:v1'`; `SyncApi` = `{ fetchState, postOps }`; `SyncStore` gains `meds(): MedDef[]`, `addMed(med: MedDef): Promise<void>`, `deleteMed(medId: string): Promise<void>` (both throw on failure; never queue).

- [ ] **Step 1: Update `src/api.ts`**

```ts
import { WORKER_URL } from './config'
import type { Checks } from './storage'
import type { MedDef } from './schedule'

export type SyncOp =
  | { op: 'check'; doseId: string; at: string }
  | { op: 'uncheck'; doseId: string }
  | { op: 'add-med'; med: MedDef }
  | { op: 'delete-med'; medId: string }

export interface ApiState {
  checks: Checks
  meds: MedDef[]
}

export class ApiError extends Error {
  status: number
  constructor(status: number) {
    super(`API error ${status}`)
    this.status = status
  }
}

async function request(path: string, token: string, init?: RequestInit): Promise<ApiState> {
  const res = await fetch(`${WORKER_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
  })
  if (!res.ok) throw new ApiError(res.status)
  return (await res.json()) as ApiState
}

export function fetchState(token: string): Promise<ApiState> {
  return request('/state', token)
}

export function postOps(token: string, ops: SyncOp[]): Promise<ApiState> {
  return request('/ops', token, { method: 'POST', body: JSON.stringify({ ops }) })
}
```

In `src/api.test.ts`: rename both `fetchChecks` imports/calls to `fetchState`, change the two `okResponse({ checks: ... })` payloads to `okResponse({ checks: { a: 't1' }, meds: [] })`, change the two `.resolves.toEqual({ a: 't1' })` assertions to `.resolves.toEqual({ checks: { a: 't1' }, meds: [] })`, and change only the fetch test's URL assertion to `${WORKER_URL}/state` (the postOps URL stays `/ops`).

- [ ] **Step 2: Update `src/syncStore.test.ts` (failing for the new API)**

Replace the `fakeApi` helper with a state-shaped fake mirroring the server:

```ts
import type { MedDef } from './schedule'

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
```

Mechanical updates to existing tests: `fakeApi({ [ID]: 't0' })` → `fakeApi({ [ID]: 't0' })` (unchanged shape — first arg is still the checks map); every `api.server()[X]` → `api.server().checks[X]`; `api.fetchChecks` → `api.fetchState` (including the `mockRejectedValueOnce`); the migration test's non-empty-postOps count filter now must exclude the seed batch — change its expectation to count batches containing a `check` op:

```ts
    expect(api.postOps.mock.calls.filter(([, ops]) => ops.some((o) => o.op === 'check'))).toHaveLength(1)
```

Then append the new tests:

```ts
import { SEED_MEDS } from './schedule'
import { MEDS_KEY } from './syncStore'

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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `fetchState`/`meds`/`MEDS_KEY` missing.

- [ ] **Step 4: Update `src/syncStore.ts`**

Changes (full replacement of the affected parts):

```ts
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
```

`getItem`/`setItem`/`loadQueue` are unchanged. Add next to `loadQueue`:

```ts
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
```

Inside `createSyncStore`, add a meds signal and adoption helper, and rework `sync`:

```ts
  const [meds, setMeds] = createSignal<MedDef[]>(loadMeds(storage))

  function persistMeds(next: MedDef[]): void {
    setMeds(next)
    setItem(storage, MEDS_KEY, JSON.stringify(next))
  }

  function adopt(state: ApiState): void {
    persistChecks(overlay(state.checks))
    if (state.meds.length > 0) persistMeds(state.meds)
  }
```

In `flush()`, the response is now an `ApiState`; replace the two lines using `server` after `postOps`:

```ts
      const state = await api.postOps(t, sent)
      persistQueue(queue().filter((op) => !(sent.includes(op) && reflected(op, state.checks))))
      adopt(state)
```

Because `SyncOp` now includes med ops (which lack `doseId`), `overlay` and `reflected` must narrow explicitly — update both:

```ts
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
```

Rework `sync()`:

```ts
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
```

Add to the returned `store` object:

```ts
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
```

Note on `adopt`'s `state.meds.length > 0` guard: the server list is only ever empty pre-seed, and `sync()` seeds before adopting; the guard keeps a raced empty read from blanking the local cache. `deleteMed` can never produce an empty list in practice (seeds exist); if it somehow did, the local cache falls back to seeds on next load — never a blank calendar.

- [ ] **Step 5: Verify green**

Run: `npm test` — Expected: PASS.
Run: `npm run build` — Expected: succeeds (App still compiles: it passes `{ fetchChecks, postOps }` — fix now: in `src/App.tsx` change the import to `import { fetchState, postOps } from './api'` and the store creation to `createSyncStore(getLocalStorage(), { fetchState, postOps })`).

- [ ] **Step 6: Commit**

```bash
git add src/api.ts src/api.test.ts src/syncStore.ts src/syncStore.test.ts src/App.tsx
git commit -m "feat: synced med definitions with empty-server seeding"
```

---

### Task 6: Thread dynamic meds; Meds screen (list + delete)

**Files:**
- Modify: `src/MonthGrid.tsx`, `src/DayDetail.tsx`, `src/Supply.tsx` (SEED_MEDS → `props.store.meds()`)
- Create: `src/MedsView.tsx`
- Modify: `src/App.tsx` (screen routing + Meds button)
- Modify: `src/App.css` (append)

**Interfaces:**
- Consumes: `SyncStore.meds()/deleteMed/hasToken` (Task 5), `scheduleSummary` (Task 3).
- Produces: `MedsView` component, props `{ store: SyncStore; onBack(): void }`. App holds `const [screen, setScreen] = createSignal<'calendar' | 'meds'>('calendar')`. Task 7 inserts the add form into `MedsView` below the list.

- [ ] **Step 1: Swap the temporary seed imports for store meds**

In `src/MonthGrid.tsx` and `src/DayDetail.tsx`: remove `SEED_MEDS` from the schedule import and change calls to `dosesForDay(props.store.meds(), <date>)`. Note `MonthGrid`'s `DayCell`-level `For` sits inside a function receiving `props` — the store is already in scope. In `src/Supply.tsx`: `pillInventories(props.store.meds())`.

- [ ] **Step 2: Create `src/MedsView.tsx`**

```tsx
import { createSignal, For, Show } from 'solid-js'
import type { MedDef } from './schedule'
import { scheduleSummary } from './summary'
import type { SyncStore } from './syncStore'

function MedRow(props: { med: MedDef; canManage: boolean; store: SyncStore }) {
  const [confirming, setConfirming] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal('')

  const remove = async () => {
    setBusy(true)
    setError('')
    try {
      await props.store.deleteMed(props.med.id)
    } catch {
      setError('Could not remove — check your connection and try again.')
    } finally {
      setBusy(false)
      setConfirming(false)
    }
  }

  return (
    <div class="med-row">
      <Show
        when={!confirming()}
        fallback={
          <div class="med-confirm">
            <span>Remove {props.med.name}?</span>
            <button type="button" class="danger-btn" disabled={busy()} onClick={() => void remove()}>
              Remove
            </button>
            <button type="button" class="nav-btn" disabled={busy()} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        }
      >
        <div class="med-info">
          <span class="dose-name">{props.med.name}</span>
          <span class="med-summary">
            {props.med.doseText} · {scheduleSummary(props.med)}
          </span>
        </div>
        <Show when={props.canManage}>
          <button type="button" class="med-delete" aria-label={`Remove ${props.med.name}`} onClick={() => setConfirming(true)}>
            ✕
          </button>
        </Show>
      </Show>
      <Show when={error()}>
        <p class="med-error">{error()}</p>
      </Show>
    </div>
  )
}

export default function MedsView(props: { store: SyncStore; onBack(): void }) {
  const canManage = () => props.store.hasToken()
  return (
    <div class="meds-view">
      <header class="app-header">
        <h1>Medications</h1>
        <button type="button" class="nav-btn" onClick={() => props.onBack()}>
          Done
        </button>
      </header>
      <Show when={!canManage()}>
        <p class="med-notice">Connect sync to manage medications.</p>
      </Show>
      <For each={props.store.meds()}>{(med) => <MedRow med={med} canManage={canManage()} store={props.store} />}</For>
    </div>
  )
}
```

- [ ] **Step 3: Route it in `src/App.tsx`**

Add imports and a screen signal:

```tsx
import MedsView from './MedsView'
```

```tsx
  const [screen, setScreen] = createSignal<'calendar' | 'meds'>('calendar')
```

Change the header (inside the main `Show`) to add the button before the sync chip:

```tsx
        <header class="app-header">
          <h1>DogScheduler</h1>
          <div class="header-actions">
            <button type="button" class="nav-btn" onClick={() => setScreen('meds')}>
              Meds
            </button>
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
          </div>
        </header>
```

And wrap the calendar body so the meds screen replaces it: change the content of the main `<Show when={!setupOpen()}>` branch to:

```tsx
        <Show
          when={screen() === 'calendar'}
          fallback={<MedsView store={store} onBack={() => setScreen('calendar')} />}
        >
          <header class="app-header">…(as above)…</header>
          <MonthGrid … />
          <DayDetail … />
          <Supply store={store} />
        </Show>
```

(Keep all existing MonthGrid/DayDetail/Supply props unchanged.)

- [ ] **Step 4: Append styles to `src/App.css`**

```css
.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.med-row {
  padding: 8px 4px;
  border-bottom: 1px solid color-mix(in srgb, currentColor 12%, transparent);
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.med-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.med-summary {
  font-size: 0.85rem;
  opacity: 0.7;
}

.med-delete {
  border: none;
  background: none;
  color: inherit;
  opacity: 0.5;
  font-size: 1rem;
  cursor: pointer;
  min-width: 44px;
  min-height: 36px;
}

.med-confirm {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.danger-btn {
  min-height: 36px;
  border: 1px solid #d64545;
  border-radius: 8px;
  background: #d64545;
  color: #fff;
  font-size: 0.9rem;
  padding: 0 12px;
  cursor: pointer;
}

.med-error {
  width: 100%;
  color: #d64545;
  font-size: 0.85rem;
  margin: 4px 0 0;
}

.med-notice {
  opacity: 0.6;
}
```

- [ ] **Step 5: Verify**

Run: `npm test` — Expected: PASS. Run: `npm run build` — Expected: succeeds.
Run: `npm run dev`, open http://localhost:5173/DogScheduler/ and confirm: calendar unchanged; Meds button opens the list showing all five meds with dose text + summaries; the ✕ → "Remove …? [Remove] [Cancel]" → Cancel flow works. Do NOT remove a real med here — actual deletion is exercised on a throwaway med in Task 7's verification.

- [ ] **Step 6: Commit**

```bash
git add src/MonthGrid.tsx src/DayDetail.tsx src/Supply.tsx src/MedsView.tsx src/App.tsx src/App.css
git commit -m "feat: dynamic meds everywhere; meds screen with delete"
```

---

### Task 7: Add-medication form with live preview

**Files:**
- Create: `src/AddMedForm.tsx`
- Modify: `src/MedsView.tsx` (render the form under the list)
- Modify: `src/App.css` (append)

**Interfaces:**
- Consumes: `buildMedDef`/`MedFormInput`/`Unit` (Task 3), `expandMed`/`MedDef`/`Slot` (Task 1), `BuilderRow` (Task 2), `scheduleSummary`/`shortDate` (Task 3), `todayStr` (dates), `SyncStore.addMed` (Task 5).
- Produces: `AddMedForm` component, props `{ store: SyncStore }`.

- [ ] **Step 1: Create `src/AddMedForm.tsx`**

```tsx
import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { expandMed, type MedDef, type Slot } from './schedule'
import type { BuilderRow } from './builder'
import { buildMedDef, type Unit } from './medForm'
import { scheduleSummary, shortDate } from './summary'
import { todayStr } from './dates'
import type { SyncStore } from './syncStore'

type RowKind = BuilderRow['kind']

interface RowState {
  kind: RowKind
  n: string // duration or day-of-month, kept as input text
}

const KIND_LABEL: Record<RowKind, string> = {
  'twice-daily': 'Twice a day (AM & PM)',
  'once-daily': 'Once a day',
  'every-other-day': 'Every other day',
  weekly: 'Weekly',
  monthly: 'Monthly on day…',
}

function toBuilderRows(rows: RowState[]): BuilderRow[] {
  return rows.map((r): BuilderRow => {
    const n = Number(r.n)
    if (r.kind === 'monthly') return { kind: 'monthly', dayOfMonth: n }
    if (r.kind === 'weekly') return { kind: 'weekly', weeks: n }
    return { kind: r.kind, days: n }
  })
}

export default function AddMedForm(props: { store: SyncStore }) {
  const [name, setName] = createSignal('')
  const [amount, setAmount] = createSignal('1')
  const [unit, setUnit] = createSignal<Unit>('tablets')
  const [startDate, setStartDate] = createSignal(todayStr())
  const [startSlot, setStartSlot] = createSignal<Slot>('am')
  const [rows, setRows] = createSignal<RowState[]>([{ kind: 'once-daily', n: '5' }])
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal('')
  const [saved, setSaved] = createSignal('')
  const [online, setOnline] = createSignal(navigator.onLine)

  onMount(() => {
    const up = () => setOnline(true)
    const down = () => setOnline(false)
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    onCleanup(() => {
      window.removeEventListener('online', up)
      window.removeEventListener('offline', down)
    })
  })

  const preview = createMemo(() => {
    try {
      const med = buildMedDef(
        {
          name: name() || 'preview',
          amount: Number(amount()),
          unit: unit(),
          startDate: startDate(),
          startSlot: startSlot(),
          rows: toBuilderRows(rows()),
        },
        () => 0,
      )
      const doses = expandMed(med)
      return { med, doses, error: '' }
    } catch (e) {
      return { med: null as MedDef | null, doses: [] as ReturnType<typeof expandMed>, error: e instanceof Error ? e.message : 'Invalid schedule' }
    }
  })

  const canSave = () =>
    !busy() && online() && props.store.hasToken() && name().trim().length > 0 && preview().med !== null

  const updateRow = (i: number, patch: Partial<RowState>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)))

  const save = async () => {
    setBusy(true)
    setError('')
    setSaved('')
    try {
      const med = buildMedDef({
        name: name(),
        amount: Number(amount()),
        unit: unit(),
        startDate: startDate(),
        startSlot: startSlot(),
        rows: toBuilderRows(rows()),
      })
      await props.store.addMed(med)
      setSaved(`${med.name} added.`)
      setName('')
      setRows([{ kind: 'once-daily', n: '5' }])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save — check your connection.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      class="add-med"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <h3>Add medication</h3>
      <label class="field">
        <span>Name</span>
        <input value={name()} onInput={(e) => setName(e.currentTarget.value)} placeholder="Medication name" />
      </label>
      <div class="field-row">
        <label class="field">
          <span>Amount per dose</span>
          <input type="number" min="0" step="any" inputmode="decimal" value={amount()} onInput={(e) => setAmount(e.currentTarget.value)} />
        </label>
        <label class="field">
          <span>Unit</span>
          <select value={unit()} onInput={(e) => setUnit(e.currentTarget.value as Unit)}>
            <option value="tablets">tablets</option>
            <option value="capsules">capsules</option>
            <option value="mL">mL</option>
            <option value="dose">dose</option>
          </select>
        </label>
      </div>
      <div class="field-row">
        <label class="field">
          <span>Starts</span>
          <input type="date" value={startDate()} onInput={(e) => setStartDate(e.currentTarget.value)} />
        </label>
        <label class="field">
          <span>First slot</span>
          <select value={startSlot()} onInput={(e) => setStartSlot(e.currentTarget.value as Slot)}>
            <option value="am">AM</option>
            <option value="pm">PM</option>
          </select>
        </label>
      </div>
      <div class="field">
        <span>Schedule</span>
        <For each={rows()}>
          {(row, i) => (
            <div class="phase-row">
              <select value={row.kind} onInput={(e) => updateRow(i(), { kind: e.currentTarget.value as RowKind })}>
                <For each={Object.entries(KIND_LABEL)}>{([k, label]) => <option value={k}>{label}</option>}</For>
              </select>
              <Show when={row.kind !== 'monthly'} fallback={<span>day</span>}>
                <span>for</span>
              </Show>
              <input type="number" min="1" inputmode="numeric" value={row.n} onInput={(e) => updateRow(i(), { n: e.currentTarget.value })} />
              <span>{row.kind === 'weekly' ? 'weeks' : row.kind === 'monthly' ? 'of the month, ongoing' : 'days'}</span>
              <Show when={rows().length > 1}>
                <button type="button" class="med-delete" aria-label="Remove phase" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i()))}>
                  ✕
                </button>
              </Show>
            </div>
          )}
        </For>
        <button type="button" class="nav-btn" onClick={() => setRows((rs) => [...rs, { kind: 'once-daily', n: '5' }])}>
          + add phase
        </button>
      </div>

      <div class="preview">
        <Show when={preview().med} fallback={<p class="med-error">{preview().error}</p>}>
          {(med) => (
            <>
              <p>{scheduleSummary(med())}</p>
              <Show when={preview().doses.length > 0}>
                <p>
                  First dose {shortDate(preview().doses[0].date)} ({preview().doses[0].slot.toUpperCase()}) ·{' '}
                  {preview().doses.length} doses
                  <Show when={med().unitsPerDose}>
                    {' '}· {med().unitsPerDose! * preview().doses.length} {med().unitLabel}
                  </Show>
                </p>
              </Show>
            </>
          )}
        </Show>
      </div>

      <Show when={!online()}>
        <p class="med-notice">Adding medications requires a connection.</p>
      </Show>
      <Show when={error()}>
        <p class="med-error">{error()}</p>
      </Show>
      <Show when={saved()}>
        <p class="med-saved">{saved()}</p>
      </Show>
      <button type="submit" class="today-btn" disabled={!canSave()}>
        {busy() ? 'Saving…' : 'Add medication'}
      </button>
    </form>
  )
}
```

- [ ] **Step 2: Render it in `src/MedsView.tsx`**

Add `import AddMedForm from './AddMedForm'` and, inside the root `div.meds-view` after the `<For>` list:

```tsx
      <Show when={canManage()}>
        <AddMedForm store={props.store} />
      </Show>
```

- [ ] **Step 3: Append styles to `src/App.css`**

```css
.add-med {
  margin-top: 24px;
  padding-top: 12px;
  border-top: 1px solid color-mix(in srgb, currentColor 12%, transparent);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.add-med h3 {
  font-size: 0.75rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  opacity: 0.6;
  margin: 0;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
}

.field > span {
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  opacity: 0.55;
}

.field input,
.field select,
.phase-row input,
.phase-row select {
  font: inherit;
  padding: 8px;
  border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
  border-radius: 8px;
  background: none;
  color: inherit;
  min-height: 40px;
}

.field-row {
  display: flex;
  gap: 8px;
}

.phase-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.phase-row input {
  width: 64px;
}

.preview {
  background: color-mix(in srgb, #2e9e44 8%, transparent);
  border: 1px solid color-mix(in srgb, #2e9e44 30%, transparent);
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 0.9rem;
}

.preview p {
  margin: 2px 0;
}

.med-saved {
  color: #2e9e44;
  font-size: 0.9rem;
  margin: 0;
}
```

- [ ] **Step 4: Verify**

Run: `npm test` — Expected: PASS. Run: `npm run build` — Expected: succeeds.
Run: `npm run dev` and on the Meds screen confirm: entering the mock med (Gabapentin, 2 capsules, starts tomorrow AM, once daily for 3 days) previews "daily ×3 · ends <date> · First dose <tomorrow> (AM) · 3 doses · 6 capsules"; changing rows to include a monthly row anywhere but last shows the error; Save adds it — it appears in the med list, on the calendar dots for the next 3 days, and in Pills remaining; delete it via the ✕ flow and confirm calendar/supply drop it while other checks are untouched.

- [ ] **Step 5: Commit**

```bash
git add src/AddMedForm.tsx src/MedsView.tsx src/App.css
git commit -m "feat: add-medication form with phase builder and live preview"
```

---

### Task 8: Ship + preservation verification + E2E

**Files:**
- Modify: `README.md`

- [ ] **Step 1: README**

In the description paragraph, change "Schedules live as declarative rules in `src/schedule.ts`" to "Medications are managed in-app (Meds screen) and sync as data; the seed schedules live in `src/schedule.ts`".

```bash
git add README.md && git commit -m "docs: meds are managed in-app"
```

- [ ] **Step 2: Merge and deploy the frontend** (via superpowers:finishing-a-development-branch)

Merge `med-editor` to `main`, push, watch CI:

```bash
gh run watch $(gh run list --limit 1 --json databaseId -q '.[0].databaseId') --exit-status
```

- [ ] **Step 3: Preservation verification (against the Task 4 backup)**

After loading the live site once (which triggers seeding):

```bash
source /private/tmp/claude-501/-Users-nicholassmith-Code/8e7f502d-d3cf-4ff7-9344-55af65d1d809/scratchpad/sync-token.txt
U=https://dogscheduler-sync.nicholaspsmith-software.workers.dev
curl -s -H "Authorization: Bearer $SYNC_TOKEN" $U/state | python3 -c "
import json, sys, glob
live = json.load(sys.stdin)
backup = json.load(open(sorted(glob.glob('.backups/checks-*.json'))[-1]))
missing = {k: v for k, v in backup['checks'].items() if live['checks'].get(k) != v}
print('meds seeded:', [m['id'] for m in live['meds']])
print('backup checks preserved:', 'ALL' if not missing else f'MISSING {missing}')"
```

Expected: the five seed ids in order; `backup checks preserved: ALL`. If anything is missing, STOP — restore from the backup via a POST of check ops before doing anything else.

- [ ] **Step 4: E2E with the user**

1. Mac: open the live site → Meds → confirm the five meds listed.
2. Add a test med ("Test Med", 1 tablet, once daily for 2 days) → appears on calendar + Pills remaining.
3. iPhone: refocus the PWA → Test Med appears; check one dose of it; Mac sees the check.
4. Delete Test Med on either device → gone from both; all real checks intact.
