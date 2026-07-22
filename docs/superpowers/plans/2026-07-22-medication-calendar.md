# Medication Calendar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Month-grid medication calendar with AM/PM dose checklists whose checked state persists permanently in localStorage.

**Architecture:** Declarative schedule rules (`schedule.ts`) expanded by pure functions into dose instances with stable IDs (`medId:YYYY-MM-DD:slot`); a framework-free storage layer (`storage.ts`) with corrupt-data backup; a thin Solid signal wrapper (`store.ts`); three components (`App`, `MonthGrid`, `DayDetail`). Spec: `docs/superpowers/specs/2026-07-22-medication-calendar-design.md`.

**Tech Stack:** SolidJS + Vite + TypeScript (existing scaffold), Vitest for unit tests. Deployed to GitHub Pages by the existing Actions workflow.

## Global Constraints

- No new runtime dependencies: `solid-js` only. Vitest is a devDependency.
- localStorage keys exactly: `dogscheduler:checks:v1` and `dogscheduler:checks:v1:corrupt`.
- Dose ID format exactly: `medId:YYYY-MM-DD:slot` where slot is `am` | `pm`.
- All date math in local time on `YYYY-MM-DD` strings. Never convert through UTC (`toISOString`, `Date.parse` on bare date strings, or `new Date('YYYY-MM-DD')` are forbidden for calendar math — they parse as UTC and shift days).
- Keep `base: '/DogScheduler/'` in `vite.config.ts`.
- `npm run build` (which runs `tsc -b`) must pass at the end of every task.
- Dose text strings verbatim from spec: `2 tablets by mouth`, `3 capsules by mouth`, `1 dose`, `0.7 mL injection`.
- The app never auto-checks/auto-unchecks anything; only user taps change state.

---

### Task 1: Vitest setup + date helpers

**Files:**
- Modify: `package.json` (add vitest devDependency + `test` script)
- Create: `src/dates.ts`
- Test: `src/dates.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `toDateStr(y: number, m: number, d: number): string` (zero-padded `YYYY-MM-DD`, month 1-12), `parseDateStr(date: string): { y: number; m: number; d: number }`, `addDays(date: string, n: number): string`, `todayStr(): string`, `daysInMonth(y: number, m: number): number`, `firstWeekday(y: number, m: number): number` (0=Sunday, weekday of the 1st).

- [ ] **Step 1: Install vitest and add test script**

```bash
cd ~/Code/DogScheduler && npm install -D vitest
```

Then in `package.json`, add to `"scripts"`:

```json
"test": "vitest run"
```

- [ ] **Step 2: Write the failing tests**

Create `src/dates.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { toDateStr, parseDateStr, addDays, daysInMonth, firstWeekday } from './dates'

describe('toDateStr / parseDateStr', () => {
  it('zero-pads month and day', () => {
    expect(toDateStr(2026, 7, 4)).toBe('2026-07-04')
  })
  it('round-trips', () => {
    expect(parseDateStr('2026-07-21')).toEqual({ y: 2026, m: 7, d: 21 })
  })
})

describe('addDays', () => {
  it('adds within a month', () => {
    expect(addDays('2026-07-21', 1)).toBe('2026-07-22')
  })
  it('crosses a month boundary', () => {
    expect(addDays('2026-07-31', 1)).toBe('2026-08-01')
  })
  it('crosses a year boundary', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
  })
  it('handles zero and negative offsets', () => {
    expect(addDays('2026-07-21', 0)).toBe('2026-07-21')
    expect(addDays('2026-08-01', -1)).toBe('2026-07-31')
  })
})

describe('month helpers', () => {
  it('daysInMonth handles ordinary and leap years', () => {
    expect(daysInMonth(2026, 7)).toBe(31)
    expect(daysInMonth(2026, 2)).toBe(28)
    expect(daysInMonth(2028, 2)).toBe(29)
  })
  it('firstWeekday: July 2026 starts on a Wednesday', () => {
    expect(firstWeekday(2026, 7)).toBe(3)
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module './dates'` (or similar resolution error).

- [ ] **Step 4: Implement `src/dates.ts`**

```ts
// All calendar math is done on local-time YYYY-MM-DD strings. Constructing
// Date only via (y, m-1, d) numeric args keeps everything in local time.
export function toDateStr(y: number, m: number, d: number): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${y}-${pad(m)}-${pad(d)}`
}

export function parseDateStr(date: string): { y: number; m: number; d: number } {
  const [y, m, d] = date.split('-').map(Number)
  return { y, m, d }
}

export function addDays(date: string, n: number): string {
  const { y, m, d } = parseDateStr(date)
  const dt = new Date(y, m - 1, d + n)
  return toDateStr(dt.getFullYear(), dt.getMonth() + 1, dt.getDate())
}

export function todayStr(): string {
  const now = new Date()
  return toDateStr(now.getFullYear(), now.getMonth() + 1, now.getDate())
}

export function daysInMonth(y: number, m: number): number {
  return new Date(y, m, 0).getDate()
}

export function firstWeekday(y: number, m: number): number {
  return new Date(y, m - 1, 1).getDay()
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all `dates.test.ts` tests green.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/dates.ts src/dates.test.ts
git commit -m "feat: add vitest and local-time date helpers"
```

---

### Task 2: Schedule module — types, med data, phase expansion

**Files:**
- Create: `src/schedule.ts`
- Test: `src/schedule.test.ts`

**Interfaces:**
- Consumes: `addDays` from `src/dates.ts` (Task 1).
- Produces: `type Slot = 'am' | 'pm'`; `interface Dose { id: string; medId: string; medName: string; doseText: string; date: string; slot: Slot }`; `const MEDS: Med[]`; `doseId(medId: string, date: string, slot: Slot): string`; `dosesForDay(date: string): Dose[]` (this task: phase-based doses only; Task 3 adds monthly rules to the same function).

Phase math: a phase is (start date, start slot, interval in half-day slots, dose count). Slot offset `o` from phase start maps to date `addDays(start, floor(o/2))` and slot `o % 2 ? 'pm' : 'am'` relative to an `am`-based index. Intervals: 12h = 1 slot, 24h = 2, 48h = 4, weekly = 14.

- [ ] **Step 1: Write the failing tests**

Create `src/schedule.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { dosesForDay, type Dose } from './schedule'
import { addDays } from './dates'

// Collect every dose in an inclusive date range (ISO strings compare correctly).
function dosesInRange(start: string, end: string): Dose[] {
  const all: Dose[] = []
  for (let d = start; d <= end; d = addDays(d, 1)) all.push(...dosesForDay(d))
  return all
}
const byMed = (id: string, doses: Dose[]) => doses.filter((x) => x.medId === id)
const keys = (doses: Dose[]) => doses.map((x) => `${x.date}:${x.slot}`)

// Wide window covering all finite courses with margin on both sides.
const WINDOW = () => dosesInRange('2026-07-01', '2026-12-31')

describe('prednisone (2 tablets/dose, 40-pill bottle)', () => {
  it('yields exactly 20 doses = 40 pills, ending AM Aug 10', () => {
    const doses = byMed('prednisone', WINDOW())
    expect(doses).toHaveLength(20)
    expect(keys(doses).at(-1)).toBe('2026-08-10:am')
  })
  it('every-12h phase: PM Jul 21 through AM Jul 26, both slots daily', () => {
    const doses = byMed('prednisone', dosesInRange('2026-07-21', '2026-07-26'))
    expect(keys(doses)).toEqual([
      '2026-07-21:pm',
      '2026-07-22:am', '2026-07-22:pm',
      '2026-07-23:am', '2026-07-23:pm',
      '2026-07-24:am', '2026-07-24:pm',
      '2026-07-25:am', '2026-07-25:pm',
      '2026-07-26:am',
    ])
  })
  it('every-24h phase: AM only, Jul 27-31', () => {
    const doses = byMed('prednisone', dosesInRange('2026-07-27', '2026-07-31'))
    expect(keys(doses)).toEqual([
      '2026-07-27:am', '2026-07-28:am', '2026-07-29:am',
      '2026-07-30:am', '2026-07-31:am',
    ])
  })
  it('every-other-day phase: AM Aug 2, 4, 6, 8, 10; nothing on off days or after', () => {
    const doses = byMed('prednisone', dosesInRange('2026-08-01', '2026-12-31'))
    expect(keys(doses)).toEqual([
      '2026-08-02:am', '2026-08-04:am', '2026-08-06:am',
      '2026-08-08:am', '2026-08-10:am',
    ])
  })
})

describe('clindamycin (3 capsules/dose)', () => {
  it('yields exactly 28 doses, PM Jul 21 through AM Aug 4, nothing after', () => {
    const doses = byMed('clindamycin', WINDOW())
    expect(doses).toHaveLength(28)
    expect(keys(doses)[0]).toBe('2026-07-21:pm')
    expect(keys(doses).at(-1)).toBe('2026-08-04:am')
    expect(byMed('clindamycin', dosesInRange('2026-08-05', '2026-12-31'))).toHaveLength(0)
  })
})

describe('adequan weekly phase', () => {
  it('PM on Tuesdays Jul 21, Jul 28, Aug 4, Aug 11; no 5th weekly dose', () => {
    const doses = byMed('adequan', dosesInRange('2026-07-01', '2026-08-31'))
    expect(keys(doses)).toEqual([
      '2026-07-21:pm', '2026-07-28:pm', '2026-08-04:pm', '2026-08-11:pm',
    ])
  })
})

describe('dose identity and shape', () => {
  it('IDs follow medId:YYYY-MM-DD:slot', () => {
    const ids = dosesForDay('2026-07-22').map((d) => d.id)
    expect(ids).toContain('prednisone:2026-07-22:am')
    expect(ids).toContain('clindamycin:2026-07-22:pm')
  })
  it('carries display fields', () => {
    const dose = dosesForDay('2026-07-21').find((d) => d.medId === 'prednisone')!
    expect(dose.medName).toBe('Prednisone')
    expect(dose.doseText).toBe('2 tablets by mouth')
    expect(dose.slot).toBe('pm')
  })
  it('day before any schedule is empty', () => {
    expect(dosesForDay('2026-07-20')).toEqual([])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module './schedule'`.

- [ ] **Step 3: Implement `src/schedule.ts`**

```ts
import { addDays } from './dates'

export type Slot = 'am' | 'pm'

export interface Dose {
  id: string
  medId: string
  medName: string
  doseText: string
  date: string // YYYY-MM-DD, local time
  slot: Slot
}

// A run of evenly spaced doses. Spacing is measured in half-day slots:
// 12h = 1, 24h = 2, 48h = 4, weekly = 14.
interface Phase {
  start: string
  startSlot: Slot
  intervalSlots: number
  count: number
}

// Indefinite day-of-month rule, active from `start` (inclusive).
interface Monthly {
  dayOfMonth: number
  slot: Slot
  start: string
}

interface Med {
  id: string
  name: string
  doseText: string
  phases?: Phase[]
  monthly?: Monthly
}

// Schedule per vet instructions; canonical expansion is pinned by
// docs/superpowers/specs/2026-07-22-medication-calendar-design.md.
export const MEDS: Med[] = [
  {
    id: 'prednisone',
    name: 'Prednisone',
    doseText: '2 tablets by mouth',
    phases: [
      { start: '2026-07-21', startSlot: 'pm', intervalSlots: 1, count: 10 },
      { start: '2026-07-27', startSlot: 'am', intervalSlots: 2, count: 5 },
      { start: '2026-08-02', startSlot: 'am', intervalSlots: 4, count: 5 },
    ],
  },
  {
    id: 'clindamycin',
    name: 'Clindamycin',
    doseText: '3 capsules by mouth',
    phases: [{ start: '2026-07-21', startSlot: 'pm', intervalSlots: 1, count: 28 }],
  },
  {
    id: 'heartworm',
    name: 'Heartworm',
    doseText: '1 dose',
    monthly: { dayOfMonth: 14, slot: 'pm', start: '2026-08-14' },
  },
  {
    id: 'adequan',
    name: 'Adequan',
    doseText: '0.7 mL injection',
    phases: [{ start: '2026-07-21', startSlot: 'pm', intervalSlots: 14, count: 4 }],
    monthly: { dayOfMonth: 11, slot: 'pm', start: '2026-09-11' },
  },
]

export function doseId(medId: string, date: string, slot: Slot): string {
  return `${medId}:${date}:${slot}`
}

function makeDose(med: Med, date: string, slot: Slot): Dose {
  return {
    id: doseId(med.id, date, slot),
    medId: med.id,
    medName: med.name,
    doseText: med.doseText,
    date,
    slot,
  }
}

function phaseDoses(med: Med, phase: Phase): Dose[] {
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

export function dosesForDay(date: string): Dose[] {
  const result: Dose[] = []
  for (const med of MEDS) {
    for (const phase of med.phases ?? []) {
      for (const dose of phaseDoses(med, phase)) {
        if (dose.date === date) result.push(dose)
      }
    }
  }
  return result
}
```

- [ ] **Step 4: Run tests to verify the phase tests pass**

Run: `npm test`
Expected: All tests in this file pass. (Monthly-rule behavior is Task 3; no tests reference it yet.)

- [ ] **Step 5: Commit**

```bash
git add src/schedule.ts src/schedule.test.ts
git commit -m "feat: schedule rules and phase expansion for all four meds"
```

---

### Task 3: Schedule module — monthly rules

**Files:**
- Modify: `src/schedule.ts` (add monthly handling to `dosesForDay`)
- Test: `src/schedule.test.ts` (append tests)

**Interfaces:**
- Consumes: everything from Task 2.
- Produces: `dosesForDay` now also emits doses for `monthly` rules (heartworm; adequan's indefinite tail). Signature unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `src/schedule.test.ts`:

```ts
describe('heartworm monthly rule', () => {
  it('PM on the 14th from Aug 2026 onward', () => {
    const doses = byMed('heartworm', dosesInRange('2026-07-01', '2026-10-31'))
    expect(keys(doses)).toEqual(['2026-08-14:pm', '2026-09-14:pm', '2026-10-14:pm'])
  })
  it('does not fire on Jul 14, 2026 (before rule start)', () => {
    expect(byMed('heartworm', dosesForDay('2026-07-14'))).toHaveLength(0)
  })
  it('continues indefinitely', () => {
    expect(byMed('heartworm', dosesForDay('2030-03-14'))).toHaveLength(1)
  })
})

describe('adequan monthly tail', () => {
  it('is day-of-month (11th), not every-28-days', () => {
    const doses = byMed('adequan', dosesInRange('2026-09-01', '2026-11-30'))
    expect(keys(doses)).toEqual(['2026-09-11:pm', '2026-10-11:pm', '2026-11-11:pm'])
    expect(byMed('adequan', dosesForDay('2026-09-08'))).toHaveLength(0)
  })
  it('weekly phase and monthly tail do not overlap in August', () => {
    // Monthly starts Sep 11; Aug 11 comes only from the weekly phase.
    expect(byMed('adequan', dosesForDay('2026-08-11'))).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npm test`
Expected: FAIL — the four new heartworm/adequan-monthly assertions (empty arrays where doses are expected). All Task 1-2 tests still pass.

- [ ] **Step 3: Implement monthly handling**

In `src/schedule.ts`, change the first import line to:

```ts
import { addDays, parseDateStr } from './dates'
```

Then add below `phaseDoses`:

```ts
function monthlyDoseForDay(med: Med, date: string): Dose | null {
  const rule = med.monthly
  if (!rule) return null
  if (date < rule.start) return null
  if (parseDateStr(date).d !== rule.dayOfMonth) return null
  return makeDose(med, date, rule.slot)
}
```

And extend the med loop in `dosesForDay` — after the phases loop, before the closing brace of `for (const med of MEDS)`:

```ts
    const monthly = monthlyDoseForDay(med, date)
    if (monthly) result.push(monthly)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/schedule.ts src/schedule.test.ts
git commit -m "feat: monthly day-of-month rules for heartworm and adequan"
```

---

### Task 4: Storage layer

**Files:**
- Create: `src/storage.ts`
- Test: `src/storage.test.ts`

**Interfaces:**
- Consumes: nothing (framework-free; no imports).
- Produces: `interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void }`; `type Checks = Record<string, string>` (doseId → ISO timestamp when checked); `CHECKS_KEY`, `CORRUPT_KEY` constants; `loadChecks(storage: StorageLike | null): Checks`; `saveChecks(storage: StorageLike | null, checks: Checks): void`; `getLocalStorage(): StorageLike | null`.

- [ ] **Step 1: Write the failing tests**

Create `src/storage.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { loadChecks, saveChecks, CHECKS_KEY, CORRUPT_KEY, type StorageLike } from './storage'

function fakeStorage(initial: Record<string, string> = {}): StorageLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k)! : null),
    setItem: (k, v) => void data.set(k, v),
  }
}

describe('loadChecks / saveChecks', () => {
  it('round-trips through storage', () => {
    const s = fakeStorage()
    saveChecks(s, { 'prednisone:2026-07-21:pm': '2026-07-21T19:00:00.000Z' })
    expect(loadChecks(s)).toEqual({ 'prednisone:2026-07-21:pm': '2026-07-21T19:00:00.000Z' })
  })
  it('returns empty map when nothing is stored', () => {
    expect(loadChecks(fakeStorage())).toEqual({})
  })
  it('returns empty map and does not throw with null storage', () => {
    expect(loadChecks(null)).toEqual({})
    expect(() => saveChecks(null, { x: 'y' })).not.toThrow()
  })
})

describe('corrupt data handling', () => {
  it('backs up unparseable JSON before resetting — never silently discards', () => {
    const s = fakeStorage({ [CHECKS_KEY]: 'not json{{{' })
    expect(loadChecks(s)).toEqual({})
    expect(s.data.get(CORRUPT_KEY)).toBe('not json{{{')
    expect(s.data.get(CHECKS_KEY)).toBe('{}')
  })
  it('treats parseable-but-wrong-shape values (array) as corrupt', () => {
    const s = fakeStorage({ [CHECKS_KEY]: '[1,2]' })
    expect(loadChecks(s)).toEqual({})
    expect(s.data.get(CORRUPT_KEY)).toBe('[1,2]')
  })
  it('survives a storage that throws', () => {
    const throwing: StorageLike = {
      getItem: () => { throw new Error('denied') },
      setItem: () => { throw new Error('denied') },
    }
    expect(loadChecks(throwing)).toEqual({})
    expect(() => saveChecks(throwing, { x: 'y' })).not.toThrow()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module './storage'`.

- [ ] **Step 3: Implement `src/storage.ts`**

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/storage.ts src/storage.test.ts
git commit -m "feat: localStorage persistence with corrupt-data backup"
```

---

### Task 5: Reactive store + DayDetail checklist

**Files:**
- Create: `src/store.ts`
- Create: `src/DayDetail.tsx`
- Modify: `src/dates.ts` (add `formatDateLong`)
- Modify: `src/App.tsx` (temporary: render today's DayDetail; Task 6 completes it)
- Modify: `src/App.css`
- Test: `src/store.test.ts`

**Interfaces:**
- Consumes: `loadChecks`/`saveChecks`/`getLocalStorage`/`StorageLike`/`CHECKS_KEY` (Task 4), `dosesForDay`/`Dose` (Tasks 2-3), `todayStr` (Task 1).
- Produces: `interface ChecksStore { isChecked(doseId: string): boolean; toggle(doseId: string): void }`; `createChecksStore(storage: StorageLike | null): ChecksStore`; `DayDetail` component with props `{ date: string; store: ChecksStore }`; `formatDateLong(date: string): string` in `dates.ts`.

The store is a thin wrapper — one Solid signal over the tested storage layer, coarse-grained object replacement per toggle (~120 doses/month; performance is a non-issue). `createSignal` works under Node without a reactive root, so the toggle/persist logic is unit-testable; render reactivity is covered by the manual verification below.

- [ ] **Step 1: Write the failing store test**

Create `src/store.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createChecksStore } from './store'
import { CHECKS_KEY, type StorageLike } from './storage'

function fakeStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k)! : null),
    setItem: (k, v) => void data.set(k, v),
  }
}

describe('createChecksStore', () => {
  const ID = 'prednisone:2026-07-21:pm'

  it('toggle checks a dose and writes through to storage', () => {
    const s = fakeStorage()
    const store = createChecksStore(s)
    expect(store.isChecked(ID)).toBe(false)
    store.toggle(ID)
    expect(store.isChecked(ID)).toBe(true)
    expect(Object.keys(JSON.parse(s.data.get(CHECKS_KEY)!))).toEqual([ID])
  })

  it('a fresh store over the same storage sees the check (reload survival)', () => {
    const s = fakeStorage()
    createChecksStore(s).toggle(ID)
    expect(createChecksStore(s).isChecked(ID)).toBe(true)
  })

  it('toggling again unchecks and removes the entry', () => {
    const s = fakeStorage()
    const store = createChecksStore(s)
    store.toggle(ID)
    store.toggle(ID)
    expect(store.isChecked(ID)).toBe(false)
    expect(JSON.parse(s.data.get(CHECKS_KEY)!)).toEqual({})
  })

  it('works with null storage (in-memory only)', () => {
    const store = createChecksStore(null)
    store.toggle(ID)
    expect(store.isChecked(ID)).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module './store'`.

- [ ] **Step 3: Implement `src/store.ts`**

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — full suite green.

- [ ] **Step 5: Add `formatDateLong` to `src/dates.ts`**

Append (locale-dependent output, so no unit test — covered by manual verification):

```ts
export function formatDateLong(date: string): string {
  const { y, m, d } = parseDateStr(date)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}
```

- [ ] **Step 6: Implement `src/DayDetail.tsx`**

```tsx
import { For, Show } from 'solid-js'
import { dosesForDay, type Dose } from './schedule'
import { formatDateLong } from './dates'
import type { ChecksStore } from './store'

function SlotSection(props: { label: string; doses: Dose[]; store: ChecksStore }) {
  return (
    <Show when={props.doses.length > 0}>
      <section class="slot-section">
        <h3>{props.label}</h3>
        <For each={props.doses}>
          {(dose) => (
            <label class="dose-row">
              <input
                type="checkbox"
                checked={props.store.isChecked(dose.id)}
                onChange={() => props.store.toggle(dose.id)}
              />
              <span class="dose-name">{dose.medName}</span>
              <span class="dose-text">{dose.doseText}</span>
            </label>
          )}
        </For>
      </section>
    </Show>
  )
}

export default function DayDetail(props: { date: string; store: ChecksStore }) {
  const doses = () => dosesForDay(props.date)
  return (
    <div class="day-detail">
      <h2>{formatDateLong(props.date)}</h2>
      <Show when={doses().length === 0}>
        <p class="no-doses">No doses this day.</p>
      </Show>
      <SlotSection label="AM" doses={doses().filter((d) => d.slot === 'am')} store={props.store} />
      <SlotSection label="PM" doses={doses().filter((d) => d.slot === 'pm')} store={props.store} />
    </div>
  )
}
```

- [ ] **Step 7: Wire a temporary App and styles**

Replace `src/App.tsx` entirely:

```tsx
import './App.css'
import { todayStr } from './dates'
import { getLocalStorage } from './storage'
import { createChecksStore } from './store'
import DayDetail from './DayDetail'

function App() {
  const store = createChecksStore(getLocalStorage())
  return (
    <main>
      <DayDetail date={todayStr()} store={store} />
    </main>
  )
}

export default App
```

Replace `src/App.css` entirely:

```css
main {
  max-width: 480px;
  margin: 0 auto;
  padding: 12px;
}

.day-detail h2 {
  font-size: 1.1rem;
  margin: 16px 0 4px;
}

.slot-section h3 {
  font-size: 0.75rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  opacity: 0.6;
  margin: 12px 0 4px;
}

.dose-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 44px; /* comfortable touch target */
  padding: 0 4px;
  border-bottom: 1px solid color-mix(in srgb, currentColor 12%, transparent);
  cursor: pointer;
}

.dose-row input[type='checkbox'] {
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  accent-color: #2e9e44;
}

.dose-name {
  font-weight: 600;
}

.dose-text {
  opacity: 0.7;
  font-size: 0.9rem;
}

.no-doses {
  opacity: 0.6;
}
```

- [ ] **Step 8: Verify manually and with the build**

Run: `npm test` — Expected: PASS (no regressions).
Run: `npm run build` — Expected: `tsc -b` and vite build succeed.
Run: `npm run dev`, open the printed URL, and confirm:
1. Today's date heading shows with AM and PM sections listing the correct doses for today per the spec's expansion.
2. Tapping a row toggles its checkbox.
3. Reloading the page keeps checked rows checked (localStorage round-trip).
4. DevTools → Application → Local Storage shows key `dogscheduler:checks:v1` with `medId:date:slot` keys and ISO timestamp values.

- [ ] **Step 9: Commit**

```bash
git add src/store.ts src/store.test.ts src/DayDetail.tsx src/dates.ts src/App.tsx src/App.css
git commit -m "feat: reactive checks store and AM/PM day checklist"
```

---

### Task 6: MonthGrid + full App composition

**Files:**
- Create: `src/MonthGrid.tsx`
- Modify: `src/dates.ts` (add `monthLabel`)
- Modify: `src/App.tsx` (final composition)
- Modify: `src/App.css` (append grid styles)

**Interfaces:**
- Consumes: `dosesForDay` (Tasks 2-3), `ChecksStore` (Task 5), `toDateStr`/`parseDateStr`/`todayStr`/`daysInMonth`/`firstWeekday` (Task 1).
- Produces: `MonthGrid` component with props `{ year: number; month: number; selected: string; today: string; store: ChecksStore; onSelect(date: string): void; onPrev(): void; onNext(): void; onToday(): void }`; `monthLabel(y: number, m: number): string` in `dates.ts`.

Dot semantics (from spec): green filled = checked; red hollow = unchecked and the day is strictly before today; gray hollow = unchecked, today or future. ISO strings compare lexicographically, so `date < today` is the past-day test.

- [ ] **Step 1: Add `monthLabel` to `src/dates.ts`**

Append:

```ts
export function monthLabel(y: number, m: number): string {
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  })
}
```

- [ ] **Step 2: Implement `src/MonthGrid.tsx`**

```tsx
import { For, Index } from 'solid-js'
import { dosesForDay } from './schedule'
import { toDateStr, daysInMonth, firstWeekday, monthLabel } from './dates'
import type { ChecksStore } from './store'

interface Props {
  year: number
  month: number // 1-12
  selected: string
  today: string
  store: ChecksStore
  onSelect(date: string): void
  onPrev(): void
  onNext(): void
  onToday(): void
}

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

export default function MonthGrid(props: Props) {
  const blanks = () => firstWeekday(props.year, props.month)
  const days = () => daysInMonth(props.year, props.month)

  return (
    <div class="month-grid">
      <div class="month-nav">
        <button type="button" class="nav-btn" onClick={() => props.onPrev()} aria-label="Previous month">
          ‹
        </button>
        <span class="month-label">{monthLabel(props.year, props.month)}</span>
        <button type="button" class="nav-btn" onClick={() => props.onNext()} aria-label="Next month">
          ›
        </button>
        <button type="button" class="today-btn" onClick={() => props.onToday()}>
          Today
        </button>
      </div>
      <div class="grid">
        <Index each={WEEKDAYS}>{(d) => <span class="weekday">{d()}</span>}</Index>
        <Index each={Array.from({ length: blanks() })}>{() => <span />}</Index>
        <Index each={Array.from({ length: days() })}>
          {(_, i) => {
            const date = () => toDateStr(props.year, props.month, i + 1)
            return (
              <button
                type="button"
                class="day-cell"
                classList={{
                  today: date() === props.today,
                  selected: date() === props.selected,
                }}
                onClick={() => props.onSelect(date())}
              >
                <span class="day-num">{i + 1}</span>
                <span class="dots">
                  <For each={dosesForDay(date())}>
                    {(dose) => (
                      <span
                        classList={{
                          dot: true,
                          checked: props.store.isChecked(dose.id),
                          missed: !props.store.isChecked(dose.id) && date() < props.today,
                        }}
                      />
                    )}
                  </For>
                </span>
              </button>
            )
          }}
        </Index>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Final `src/App.tsx`**

Replace entirely:

```tsx
import { createSignal } from 'solid-js'
import './App.css'
import { todayStr, parseDateStr } from './dates'
import { getLocalStorage } from './storage'
import { createChecksStore } from './store'
import MonthGrid from './MonthGrid'
import DayDetail from './DayDetail'

function App() {
  const store = createChecksStore(getLocalStorage())
  const today = todayStr()
  const { y, m } = parseDateStr(today)
  const [selected, setSelected] = createSignal(today)
  const [view, setView] = createSignal({ y, m })

  const shiftMonth = (delta: number) => {
    setView((v) => {
      const zeroBased = v.m - 1 + delta
      const yy = v.y + Math.floor(zeroBased / 12)
      const mm = ((zeroBased % 12) + 12) % 12 + 1
      return { y: yy, m: mm }
    })
  }

  return (
    <main>
      <h1>DogScheduler</h1>
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
    </main>
  )
}

export default App
```

- [ ] **Step 4: Append grid styles to `src/App.css`**

```css
h1 {
  font-size: 1.3rem;
  margin: 8px 0 12px;
}

.month-nav {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.month-label {
  font-weight: 600;
  flex: 1;
  text-align: center;
}

.nav-btn,
.today-btn {
  min-width: 44px;
  min-height: 36px;
  border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
  border-radius: 8px;
  background: none;
  color: inherit;
  font-size: 1rem;
  cursor: pointer;
}

.grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 4px;
}

.weekday {
  text-align: center;
  font-size: 0.7rem;
  font-weight: 700;
  opacity: 0.5;
  padding: 2px 0;
}

.day-cell {
  min-height: 48px;
  padding: 4px 2px 6px;
  border: 1px solid color-mix(in srgb, currentColor 12%, transparent);
  border-radius: 8px;
  background: none;
  color: inherit;
  font: inherit;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}

.day-cell.today {
  border: 2px solid #4a7dff;
}

.day-cell.selected {
  background: color-mix(in srgb, #4a7dff 15%, transparent);
}

.day-num {
  font-size: 0.85rem;
}

.dots {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 3px;
  max-width: 100%;
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  border: 1.5px solid #9a9aa2; /* gray hollow: pending, today or future */
  box-sizing: border-box;
}

.dot.missed {
  border-color: #d64545; /* red hollow: past day, unchecked */
}

.dot.checked {
  border-color: #2e9e44;
  background: #2e9e44; /* green filled */
}
```

- [ ] **Step 5: Verify manually and with the build**

Run: `npm test` — Expected: PASS.
Run: `npm run build` — Expected: succeeds.
Run: `npm run dev`, open the printed URL, and confirm:
1. Current month renders; today has a blue border and is pre-selected with its checklist open below.
2. Jul 21 shows 3 dots; Jul 22-25 show 4; Jul 26 shows 3 (2 AM + 1 PM); Aug 14 shows 1.
3. Checking a dose in the detail panel immediately fills its grid dot green.
4. Unchecked dots on days before today render red-hollow; today's own unchecked dots stay gray.
5. `‹`/`›` page months (Sep 2026 shows dots on the 11th and 14th only; December 2026 likewise); **Today** returns and reselects today.
6. Tapping any day opens its checklist; empty days say "No doses this day."
7. Reload: all checked state persists.

- [ ] **Step 6: Commit**

```bash
git add src/MonthGrid.tsx src/dates.ts src/App.tsx src/App.css
git commit -m "feat: month grid with status dots and full app composition"
```

---

### Task 7: CI test gate, README, deploy verification

**Files:**
- Modify: `.github/workflows/deploy.yml` (run tests before build)
- Modify: `README.md`

**Interfaces:**
- Consumes: `npm test` script (Task 1); existing deploy workflow.
- Produces: live, verified deployment at https://nicholaspsmith.github.io/DogScheduler/.

- [ ] **Step 1: Add test step to CI**

In `.github/workflows/deploy.yml`, in the `build` job, insert between `- run: npm ci` and `- run: npm run build`:

```yaml
      - run: npm test
```

- [ ] **Step 2: Update README**

Replace the first two lines of `README.md` body (the description paragraph under the title) with:

```markdown
Medication calendar for a dog: a month grid with per-day AM/PM dose
checklists. Checked doses persist in the browser's localStorage. Schedules
live as declarative rules in `src/schedule.ts`; the design spec is in
`docs/superpowers/specs/2026-07-22-medication-calendar-design.md`.
```

Keep the existing Live site / Development / Deployment / License sections.

- [ ] **Step 3: Commit and push**

```bash
git add .github/workflows/deploy.yml README.md
git commit -m "chore: gate deploys on tests; document the app in README"
git push
```

- [ ] **Step 4: Verify the deployment**

Run: `gh run watch $(gh run list -R nicholaspsmith/DogScheduler --limit 1 --json databaseId -q '.[0].databaseId') -R nicholaspsmith/DogScheduler --exit-status`
Expected: workflow succeeds (tests ran in CI).

Run: `curl -sL https://nicholaspsmith.github.io/DogScheduler/ | grep -o '<title>[^<]*</title>'`
Expected: `<title>DogScheduler</title>`, and the page serves the new bundle (fresh `assets/index-*.js` hash vs. the hello-world deploy).

Then confirm in a real browser that the live URL shows the calendar and that checking a dose + reloading persists.
