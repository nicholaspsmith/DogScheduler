# DogScheduler: Medication Calendar — Design

**Date:** 2026-07-22
**Status:** Approved

## Purpose

A calendar/checklist hybrid for tracking a dog's medications. Each day is split
into AM and PM slots containing dose tasks to check off. Checked state persists
permanently (across reloads, restarts, redeploys) until explicitly unchecked by
the user.

Single user, single device: persistence is browser localStorage on the device
used to check off doses. No backend, no accounts. Hosted as a static SPA on
GitHub Pages (existing setup).

## Medications and schedule rules

All doses anchor to the first doses given **PM (evening) of Mon Jul 21, 2026**.

| Med | Dose text | Rule |
|---|---|---|
| Prednisone | 2 tablets by mouth | 40-pill bottle. Every 12h × 5 days, then every 24h × 5 days, then every other day until pills are gone. |
| Clindamycin | 3 capsules by mouth | Every 12h × 14 days from PM Jul 21. |
| Heartworm | 1 dose | 14th of every month, PM slot, starting Aug 14, 2026, indefinitely. |
| Adequan | 0.7 mL injection | Weekly (Tuesdays, PM) Jul 21 / Jul 28 / Aug 4 / Aug 11, then the 11th of every month (PM) from Sep 11, 2026, indefinitely. |

### Canonical expansion (used as test fixtures)

**Prednisone** — 20 doses, 40 pills, exactly emptying the bottle:

- Every-12h phase (10 doses, 20 pills): PM Jul 21 → AM Jul 26, both slots daily.
- Every-24h phase (5 doses, 10 pills): AM Jul 27 → AM Jul 31, one AM dose daily.
  (The twice-daily phase ends on a morning dose, so the strict every-24h
  continuation lands in the AM slot. Confirmed by user.)
- Every-other-day phase (5 doses, 10 pills): AM on Aug 2, 4, 6, 8, 10.
- Final dose: **AM Aug 10, 2026**.

**Clindamycin** — 28 doses: PM Jul 21 → AM Aug 4, both slots daily.
Final dose: **AM Aug 4, 2026**.

**Heartworm** — PM on Aug 14, Sep 14, Oct 14, … (no end).

**Adequan** — PM on Jul 21, Jul 28, Aug 4, Aug 11, then Sep 11, Oct 11, Nov 11, …
(no end).

The three PM Jul 21 doses were given before the app existed; they appear on the
calendar unchecked and the user taps them once to record them. No pre-seeded
data.

## UI

Single screen, phone-first. Layout chosen from mockups: **month grid + day
detail** (option B).

- **Month grid**: `‹ July 2026 ›` navigation plus a **Today** button. Today's
  cell gets a highlighted border. Any past/future month is reachable; the
  indefinite meds generate doses for whichever month is in view.
- **Status dots**: one dot per dose in each day cell.
  - Green filled — checked.
  - Gray hollow — unchecked, day is today or future.
  - Red hollow — unchecked, day is in the past (missed dose, visible at a
    glance).
- **Day detail panel** below the grid (no modal). Tapping a day shows its date
  header plus AM and PM sections. Each dose is a full-width tappable row:
  checkbox, med name, dose text (e.g., "Prednisone — 2 tablets"). Tapping
  toggles; the grid dot updates immediately.
- **On load**: current month, today auto-selected so its checklist is open.
- Days with no doses render an empty cell / empty detail panel.
- Any dose in any day (past or future) can be checked or unchecked; the app
  never auto-checks or auto-unchecks anything.

## Data model & persistence

- **Dose ID** (stable, derived): `medId:YYYY-MM-DD:slot`, e.g.
  `prednisone:2026-07-22:am`. Slot is `am` | `pm`. IDs derive from schedule
  rules, so history survives code/deploy changes.
- **Storage**: one localStorage key `dogscheduler:checks:v1` holding a JSON
  object `{ [doseId]: ISO-8601 timestamp when checked }`. Unchecking deletes
  the entry. Write-through on every toggle; read once at startup.
- **Degradation**: if localStorage is unavailable, the app runs with in-memory
  state for the session. If the stored JSON fails to parse, the raw value is
  copied to `dogscheduler:checks:v1:corrupt` before resetting to empty — never
  silently discard medical history.

## Architecture

Three units, each independently understandable:

- **`src/schedule.ts`** — the four med definitions as declarative rule data,
  plus pure functions `dosesForDay(dateStr)` and month expansion. No DOM, no
  storage, no side effects. All date math in local time using `YYYY-MM-DD`
  strings; no `Date`→UTC conversions (avoids off-by-one-day timezone bugs).
- **`src/store.ts`** — Solid reactive store over localStorage:
  `isChecked(doseId)`, `toggle(doseId)`. Owns all storage access and the
  degradation behavior.
- **Components** — `App` (selected-day signal, layout), `MonthGrid`
  (grid + dots, month navigation), `DayDetail` (AM/PM checklist rows).
  Plain CSS, mobile-first.

## Testing

Vitest, TDD. The canonical expansion above is the fixture set:

- Prednisone: exactly 20 doses / 40 pills; phase boundaries exact
  (AM Jul 26 last q12h, AM Jul 27 first q24h, AM Jul 31 last q24h,
  AM Aug 2 first alternate-day, AM Aug 10 final); nothing after Aug 10.
- Clindamycin: exactly 28 doses; last is AM Aug 4; nothing after.
- Adequan: PM Jul 21/28, Aug 4/11, Sep 11, Oct 11; nothing on Sep 8
  (i.e., monthly is day-of-month, not every-28-days).
- Heartworm: PM on the 14th from Aug 2026 onward; nothing on Jul 14, 2026.
- Store: toggle round-trips through localStorage; uncheck removes; corrupt
  JSON is backed up then reset; missing localStorage degrades to in-memory.

## Deployment

Unchanged: push to `main` → GitHub Actions builds → GitHub Pages serves
https://nicholaspsmith.github.io/DogScheduler/.

## Out of scope (v1)

- Multi-device sync / backend.
- UI for adding or editing medications (schedule changes are code edits to the
  rule data in `schedule.ts`).
- Notifications/reminders.
- Export/import backup.
