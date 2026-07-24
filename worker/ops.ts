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
