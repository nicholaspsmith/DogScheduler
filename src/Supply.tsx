import { For } from 'solid-js'
import { pillInventories } from './schedule'
import type { SyncStore } from './syncStore'

export default function Supply(props: { store: SyncStore }) {
  const rows = () =>
    pillInventories(props.store.meds()).map((inv) => {
      const taken = inv.doseIds.filter((id) => props.store.isChecked(id)).length
      return {
        medId: inv.medId,
        medName: inv.medName,
        unitLabel: inv.unitLabel,
        total: inv.totalUnits,
        left: inv.totalUnits - taken * inv.unitsPerDose,
      }
    })

  return (
    <section class="supply">
      <h3>Pills remaining</h3>
      <For each={rows()}>
        {(row) => (
          <div class="supply-row">
            <span class="dose-name">{row.medName}</span>
            <span class="supply-count" classList={{ done: row.left === 0 }}>
              {row.left} of {row.total} {row.unitLabel}
            </span>
          </div>
        )}
      </For>
    </section>
  )
}
