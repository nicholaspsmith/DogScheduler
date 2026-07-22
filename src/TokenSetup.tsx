import { createSignal } from 'solid-js'

export default function TokenSetup(props: { onSave(token: string): void; onSkip(): void }) {
  const [value, setValue] = createSignal('')
  return (
    <div class="token-setup">
      <h2>Connect sync</h2>
      <p>
        Paste the sync token to share checked doses between your devices. You
        can find it where you saved it during setup.
      </p>
      <input
        type="password"
        placeholder="Sync token"
        value={value()}
        onInput={(e) => setValue(e.currentTarget.value)}
      />
      <div class="token-actions">
        <button
          type="button"
          class="today-btn"
          disabled={value().trim().length === 0}
          onClick={() => props.onSave(value().trim())}
        >
          Save
        </button>
        <button type="button" class="nav-btn" onClick={() => props.onSkip()}>
          Skip for now
        </button>
      </div>
    </div>
  )
}
