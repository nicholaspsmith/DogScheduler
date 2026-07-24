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
    // From Feb 1, monthly on the 31st: February lacks a 31st
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
