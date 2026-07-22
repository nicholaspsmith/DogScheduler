import { createSignal } from 'solid-js'
import './App.css'
import { todayStr, parseDateStr } from './dates'
import { getLocalStorage } from './storage'
import { createChecksStore } from './store'
import MonthGrid from './MonthGrid'
import DayDetail from './DayDetail'

function App() {
  const store = createChecksStore(getLocalStorage())
  const today = todayStr()
  const { y, m } = parseDateStr(today)
  const [selected, setSelected] = createSignal(today)
  const [view, setView] = createSignal({ y, m })

  const shiftMonth = (delta: number) => {
    setView((v) => {
      const zeroBased = v.m - 1 + delta
      const yy = v.y + Math.floor(zeroBased / 12)
      const mm = ((zeroBased % 12) + 12) % 12 + 1
      return { y: yy, m: mm }
    })
  }

  return (
    <main>
      <h1>DogScheduler</h1>
      <MonthGrid
        year={view().y}
        month={view().m}
        selected={selected()}
        today={today}
        store={store}
        onSelect={setSelected}
        onPrev={() => shiftMonth(-1)}
        onNext={() => shiftMonth(1)}
        onToday={() => {
          setView({ y, m })
          setSelected(today)
        }}
      />
      <DayDetail date={selected()} store={store} />
    </main>
  )
}

export default App
