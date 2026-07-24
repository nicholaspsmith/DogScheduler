import { createSignal, For, Show } from 'solid-js'
import type { MedDef } from './schedule'
import AddMedForm from './AddMedForm'
import { scheduleSummary } from './summary'
import type { SyncStore } from './syncStore'

function MedRow(props: { med: MedDef; canManage: boolean; store: SyncStore }) {
  const [confirming, setConfirming] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal('')

  const remove = async () => {
    setBusy(true)
    setError('')
    try {
      await props.store.deleteMed(props.med.id)
    } catch {
      setError('Could not remove — check your connection and try again.')
    } finally {
      setBusy(false)
      setConfirming(false)
    }
  }

  return (
    <div class="med-row">
      <Show
        when={!confirming()}
        fallback={
          <div class="med-confirm">
            <span>Remove {props.med.name}?</span>
            <button type="button" class="danger-btn" disabled={busy()} onClick={() => void remove()}>
              Remove
            </button>
            <button type="button" class="nav-btn" disabled={busy()} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        }
      >
        <div class="med-info">
          <span class="dose-name">{props.med.name}</span>
          <span class="med-summary">
            {props.med.doseText} · {scheduleSummary(props.med)}
          </span>
        </div>
        <Show when={props.canManage}>
          <button type="button" class="med-delete" aria-label={`Remove ${props.med.name}`} onClick={() => setConfirming(true)}>
            ✕
          </button>
        </Show>
      </Show>
      <Show when={error()}>
        <p class="med-error">{error()}</p>
      </Show>
    </div>
  )
}

export default function MedsView(props: { store: SyncStore; onBack(): void }) {
  const canManage = () => props.store.hasToken()
  return (
    <div class="meds-view">
      <header class="app-header">
        <h1>Medications</h1>
        <button type="button" class="nav-btn" onClick={() => props.onBack()}>
          Done
        </button>
      </header>
      <Show when={!canManage()}>
        <p class="med-notice">Connect sync to manage medications.</p>
      </Show>
      <For each={props.store.meds()}>{(med) => <MedRow med={med} canManage={canManage()} store={props.store} />}</For>
      <Show when={canManage()}>
        <AddMedForm store={props.store} />
      </Show>
    </div>
  )
}
