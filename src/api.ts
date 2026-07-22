import { WORKER_URL } from './config'
import type { Checks } from './storage'

export type SyncOp =
  | { op: 'check'; doseId: string; at: string }
  | { op: 'uncheck'; doseId: string }

export class ApiError extends Error {
  status: number
  constructor(status: number) {
    super(`API error ${status}`)
    this.status = status
  }
}

async function request(path: string, token: string, init?: RequestInit): Promise<Checks> {
  const res = await fetch(`${WORKER_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
  })
  if (!res.ok) throw new ApiError(res.status)
  const data = (await res.json()) as { checks: Checks }
  return data.checks
}

export function fetchChecks(token: string): Promise<Checks> {
  return request('/checks', token)
}

export function postOps(token: string, ops: SyncOp[]): Promise<Checks> {
  return request('/ops', token, { method: 'POST', body: JSON.stringify({ ops }) })
}
