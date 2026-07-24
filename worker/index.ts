import { applyState, parseOps, type Checks, type MedDef } from './ops'

export interface Env {
  KV: KVNamespace
  SYNC_TOKEN: string
}

const ALLOWED_ORIGINS = new Set([
  'https://nicholaspsmith.github.io',
  'http://localhost:5173',
])

const CHECKS_KEY = 'checks:v1'
const MEDS_KEY = 'meds:v1'

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('Origin') ?? ''
  if (!ALLOWED_ORIGINS.has(origin)) return {}
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  }
}

function json(status: number, body: unknown, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(request)
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors })
    }

    const auth = request.headers.get('Authorization') ?? ''
    if (auth !== `Bearer ${env.SYNC_TOKEN}`) {
      return json(401, { error: 'unauthorized' }, cors)
    }

    const url = new URL(request.url)
    const loadChecks = async (): Promise<Checks> =>
      (await env.KV.get(CHECKS_KEY, 'json')) ?? {}
    const loadMeds = async (): Promise<MedDef[]> =>
      (await env.KV.get(MEDS_KEY, 'json')) ?? []

    if (request.method === 'GET' && url.pathname === '/checks') {
      return json(200, { checks: await loadChecks() }, cors)
    }

    if (request.method === 'GET' && url.pathname === '/state') {
      return json(200, { checks: await loadChecks(), meds: await loadMeds() }, cors)
    }

    if (request.method === 'POST' && url.pathname === '/ops') {
      let body: unknown
      try {
        body = await request.json()
      } catch {
        return json(400, { error: 'invalid JSON' }, cors)
      }
      const ops = parseOps(body)
      if (ops === null) {
        return json(400, { error: 'invalid ops' }, cors)
      }
      const before = { checks: await loadChecks(), meds: await loadMeds() }
      const next = applyState(before, ops)
      const hasCheckOps = ops.some((op) => op.op === 'check' || op.op === 'uncheck')
      const hasMedOps = ops.some((op) => op.op === 'add-med' || op.op === 'delete-med')
      if (hasCheckOps) await env.KV.put(CHECKS_KEY, JSON.stringify(next.checks))
      if (hasMedOps) await env.KV.put(MEDS_KEY, JSON.stringify(next.meds))
      return json(200, next, cors)
    }

    return json(404, { error: 'not found' }, cors)
  },
}
