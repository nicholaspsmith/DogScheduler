import { createSignal, onCleanup, onMount, Show } from 'solid-js'
import './App.css'
import { todayStr, parseDateStr } from './dates'
import { getLocalStorage } from './storage'
import { fetchState, postOps } from './api'
import { createSyncStore, type SyncStatus } from './syncStore'
import MonthGrid from './MonthGrid'
import DayDetail from './DayDetail'
import Supply from './Supply'
import MedsView from './MedsView'
import TokenSetup from './TokenSetup'

const STATUS_LABEL: Record<SyncStatus, string> = {
  synced: 'synced',
  syncing: 'syncing…',
  offline: 'offline',
  'no-token': 'not connected',
}

function App() {
  const store = createSyncStore(getLocalStorage(), { fetchState, postOps })
  const today = todayStr()
  const { y, m } = parseDateStr(today)
  const [selected, setSelected] = createSignal(today)
  const [view, setView] = createSignal({ y, m })
  const [setupOpen, setSetupOpen] = createSignal(!store.hasToken())
  const [screen, setScreen] = createSignal<'calendar' | 'meds'>('calendar')

  onMount(() => {
    void store.start()
    const onVisible = () => {
      if (document.visibilityState === 'visible') void store.sync()
    }
    const onOnline = () => void store.sync()
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', onOnline)
    onCleanup(() => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', onOnline)
    })
  })

  const shiftMonth = (delta: number) => {
    setView((v) => {
      const zeroBased = v.m - 1 + delta
      const yy = v.y + Math.floor(zeroBased / 12)
      const mm = ((zeroBased % 12) + 12) % 12 + 1
      return { y: yy, m: mm }
    })
  }

  const statusLabel = () => {
    const s = store.status()
    return s === 'offline' && store.pendingCount() > 0
      ? `offline (${store.pendingCount()} pending)`
      : STATUS_LABEL[s]
  }

  return (
    <main>
      <Show
        when={!setupOpen()}
        fallback={
          <TokenSetup
            onSave={(t) => {
              store.setToken(t)
              setSetupOpen(false)
            }}
            onSkip={() => setSetupOpen(false)}
          />
        }
      >
        <Show
          when={screen() === 'calendar'}
          fallback={<MedsView store={store} onBack={() => setScreen('calendar')} />}
        >
          <header class="app-header">
            <h1>DogScheduler</h1>
            <div class="header-actions">
              <button type="button" class="nav-btn" onClick={() => setScreen('meds')}>
                Meds
              </button>
              <button
                type="button"
                class="sync-chip"
                data-status={store.status()}
                onClick={() => {
                  if (store.status() === 'no-token') setSetupOpen(true)
                  else void store.sync()
                }}
              >
                <span class="sync-dot" /> {statusLabel()}
              </button>
            </div>
          </header>
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
          <Supply store={store} />
        </Show>
      </Show>
    </main>
  )
}

export default App
