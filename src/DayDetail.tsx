import { For, Show } from 'solid-js'
import { dosesForDay, type Dose } from './schedule'
import { formatDateLong } from './dates'
import type { SyncStore } from './syncStore'

function SlotSection(props: { label: string; doses: Dose[]; store: SyncStore }) {
  return (
    <Show when={props.doses.length > 0}>
      <section class="slot-section">
        <h3>{props.label}</h3>
        <For each={props.doses}>
          {(dose) => (
            <label class="dose-row">
              <input
                type="checkbox"
                checked={props.store.isChecked(dose.id)}
                onChange={() => props.store.toggle(dose.id)}
              />
              <span class="dose-name">{dose.medName}</span>
              <span class="dose-text">{dose.doseText}</span>
            </label>
          )}
        </For>
      </section>
    </Show>
  )
}

export default function DayDetail(props: { date: string; store: SyncStore }) {
  const doses = () => dosesForDay(props.store.meds(), props.date)
  return (
    <div class="day-detail">
      <h2>{formatDateLong(props.date)}</h2>
      <Show when={doses().length === 0}>
        <p class="no-doses">No doses this day.</p>
      </Show>
      <SlotSection label="AM" doses={doses().filter((d) => d.slot === 'am')} store={props.store} />
      <SlotSection label="PM" doses={doses().filter((d) => d.slot === 'pm')} store={props.store} />
    </div>
  )
}
