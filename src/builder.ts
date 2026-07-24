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
