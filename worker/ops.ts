// Pure op-log semantics over the checks map. Shared vocabulary with the
// frontend: doseId -> ISO timestamp when checked.
export type Checks = Record<string, string>

export type Op =
  | { op: 'check'; doseId: string; at: string }
  | { op: 'uncheck'; doseId: string }

// Returns null if the body is malformed in any way; nothing is applied.
export function parseOps(body: unknown): Op[] | null {
  if (typeof body !== 'object' || body === null) return null
  const ops = (body as { ops?: unknown }).ops
  if (!Array.isArray(ops)) return null
  const parsed: Op[] = []
  for (const raw of ops) {
    if (typeof raw !== 'object' || raw === null) return null
    const o = raw as Record<string, unknown>
    if (o.op === 'check' && typeof o.doseId === 'string' && typeof o.at === 'string') {
      parsed.push({ op: 'check', doseId: o.doseId, at: o.at })
    } else if (o.op === 'uncheck' && typeof o.doseId === 'string') {
      parsed.push({ op: 'uncheck', doseId: o.doseId })
    } else {
      return null
    }
  }
  return parsed
}

export function applyOps(checks: Checks, ops: Op[]): Checks {
  const next = { ...checks }
  for (const op of ops) {
    if (op.op === 'check') {
      // First check wins: keeps replays and migration idempotent.
      if (next[op.doseId] === undefined) next[op.doseId] = op.at
    } else {
      delete next[op.doseId]
    }
  }
  return next
}
