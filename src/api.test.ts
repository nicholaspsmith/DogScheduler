import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchState, postOps, ApiError } from './api'
import { WORKER_URL } from './config'

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchState', () => {
  it('GETs /state with the bearer token and returns the state', async () => {
    const spy = vi.fn(async () => okResponse({ checks: { a: 't1' }, meds: [] }))
    vi.stubGlobal('fetch', spy)
    await expect(fetchState('tok')).resolves.toEqual({ checks: { a: 't1' }, meds: [] })
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${WORKER_URL}/state`)
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer tok')
  })
  it('throws ApiError with status on non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 401 })))
    const err = await fetchState('bad').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(401)
  })
})

describe('postOps', () => {
  it('POSTs the ops batch as JSON and returns the updated state', async () => {
    const spy = vi.fn(async () => okResponse({ checks: { a: 't1' }, meds: [] }))
    vi.stubGlobal('fetch', spy)
    const ops = [{ op: 'check', doseId: 'a', at: 't1' } as const]
    await expect(postOps('tok', ops)).resolves.toEqual({ checks: { a: 't1' }, meds: [] })
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${WORKER_URL}/ops`)
    expect(init.method).toBe('POST')
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json')
    expect(JSON.parse(init.body as string)).toEqual({ ops })
  })
})
