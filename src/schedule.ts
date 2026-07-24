import { addDays, parseDateStr } from './dates'

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
export interface Phase {
  start: string
  startSlot: Slot
  intervalSlots: number
  count: number
}

// Indefinite day-of-month rule, active from `start` (inclusive).
export interface Monthly {
  dayOfMonth: number
  slot: Slot
  start: string
}

export interface MedDef {
  id: string
  name: string
  doseText: string
  phases?: Phase[]
  monthly?: Monthly
  // Present only for finite pill-based courses; drives the supply section.
  unitsPerDose?: number
  unitLabel?: string
}

// Schedule per vet instructions; canonical expansion is pinned by
// docs/superpowers/specs/2026-07-22-medication-calendar-design.md.
export const SEED_MEDS: MedDef[] = [
  {
    id: 'prednisone',
    name: 'Prednisone',
    doseText: '2 tablets by mouth',
    unitsPerDose: 2,
    unitLabel: 'tablets',
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
    unitsPerDose: 3,
    unitLabel: 'capsules',
    phases: [{ start: '2026-07-21', startSlot: 'pm', intervalSlots: 1, count: 28 }],
  },
  {
    id: 'fluconazole',
    name: 'Fluconazole',
    doseText: '4 tablets by mouth',
    unitsPerDose: 4,
    unitLabel: 'tablets',
    phases: [{ start: '2026-07-23', startSlot: 'am', intervalSlots: 2, count: 21 }],
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

function makeDose(med: MedDef, date: string, slot: Slot): Dose {
  return {
    id: doseId(med.id, date, slot),
    medId: med.id,
    medName: med.name,
    doseText: med.doseText,
    date,
    slot,
  }
}

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

export interface PillInventory {
  medId: string
  medName: string
  unitsPerDose: number
  unitLabel: string
  totalUnits: number
  doseIds: string[] // every dose of the course, in schedule order
}

// Finite pill-based courses only; indefinite or non-pill meds have no
// meaningful remaining-count and are omitted.
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
