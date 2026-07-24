import { For, Index } from 'solid-js'
import { dosesForDay } from './schedule'
import { toDateStr, daysInMonth, firstWeekday, monthLabel } from './dates'
import type { SyncStore } from './syncStore'

interface Props {
  year: number
  month: number // 1-12
  selected: string
  today: string
  store: SyncStore
  onSelect(date: string): void
  onPrev(): void
  onNext(): void
  onToday(): void
}

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

export default function MonthGrid(props: Props) {
  const blanks = () => firstWeekday(props.year, props.month)
  const days = () => daysInMonth(props.year, props.month)

  return (
    <div class="month-grid">
      <div class="month-nav">
        <button type="button" class="nav-btn" onClick={() => props.onPrev()} aria-label="Previous month">
          ‹
        </button>
        <span class="month-label">{monthLabel(props.year, props.month)}</span>
        <button type="button" class="nav-btn" onClick={() => props.onNext()} aria-label="Next month">
          ›
        </button>
        <button type="button" class="today-btn" onClick={() => props.onToday()}>
          Today
        </button>
      </div>
      <div class="grid">
        <Index each={WEEKDAYS}>{(d) => <span class="weekday">{d()}</span>}</Index>
        <Index each={Array.from({ length: blanks() })}>{() => <span />}</Index>
        <Index each={Array.from({ length: days() })}>
          {(_, i) => {
            const date = () => toDateStr(props.year, props.month, i + 1)
            return (
              <button
                type="button"
                class="day-cell"
                classList={{
                  today: date() === props.today,
                  selected: date() === props.selected,
                }}
                onClick={() => props.onSelect(date())}
              >
                <span class="day-num">{i + 1}</span>
                <span class="dots">
                  <For each={dosesForDay(props.store.meds(), date())}>
                    {(dose) => (
                      <span
                        classList={{
                          dot: true,
                          checked: props.store.isChecked(dose.id),
                          missed: !props.store.isChecked(dose.id) && date() < props.today,
                        }}
                      />
                    )}
                  </For>
                </span>
              </button>
            )
          }}
        </Index>
      </div>
    </div>
  )
}
