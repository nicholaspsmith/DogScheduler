import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { expandMed, type Dose, type MedDef, type Slot } from './schedule'
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

interface Preview {
  med: MedDef | null
  doses: Dose[]
  error: string
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

  const preview = createMemo((): Preview => {
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
      return { med, doses: expandMed(med), error: '' }
    } catch (e) {
      return { med: null, doses: [], error: e instanceof Error ? e.message : 'Invalid schedule' }
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
                <For each={Object.entries(KIND_LABEL)}>{([k, label]) => <option value={k} selected={k === row.kind}>{label}</option>}</For>
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
