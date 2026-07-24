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
