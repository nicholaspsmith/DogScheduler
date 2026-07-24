import { WORKER_URL } from './config'
import type { Checks } from './storage'
import type { MedDef } from './schedule'

export type SyncOp =
  | { op: 'check'; doseId: string; at: string }
  | { op: 'uncheck'; doseId: string }
  | { op: 'add-med'; med: MedDef }
  | { op: 'delete-med'; medId: string }

export interface ApiState {
  checks: Checks
  meds: MedDef[]
}

export class ApiError extends Error {
  status: number
  constructor(status: number) {
    super(`API error ${status}`)
    this.status = status
  }
}

async function request(path: string, token: string, init?: RequestInit): Promise<ApiState> {
  const res = await fetch(`${WORKER_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
  })
  if (!res.ok) throw new ApiError(res.status)
  return (await res.json()) as ApiState
}

export function fetchState(token: string): Promise<ApiState> {
  return request('/state', token)
}

export function postOps(token: string, ops: SyncOp[]): Promise<ApiState> {
  return request('/ops', token, { method: 'POST', body: JSON.stringify({ ops }) })
}
