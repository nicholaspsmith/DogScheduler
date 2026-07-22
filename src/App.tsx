import './App.css'
import { todayStr } from './dates'
import { getLocalStorage } from './storage'
import { createChecksStore } from './store'
import DayDetail from './DayDetail'

function App() {
  const store = createChecksStore(getLocalStorage())
  return (
    <main>
      <DayDetail date={todayStr()} store={store} />
    </main>
  )
}

export default App
