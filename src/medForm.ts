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
