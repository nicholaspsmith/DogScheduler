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
