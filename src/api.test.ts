import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchChecks, postOps, ApiError } from './api'
import { WORKER_URL } from './config'

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchChecks', () => {
  it('GETs /checks with the bearer token and returns the map', async () => {
    const spy = vi.fn(async () => okResponse({ checks: { a: 't1' } }))
    vi.stubGlobal('fetch', spy)
    await expect(fetchChecks('tok')).resolves.toEqual({ a: 't1' })
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${WORKER_URL}/checks`)
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer tok')
  })
  it('throws ApiError with status on non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 401 })))
    const err = await fetchChecks('bad').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(401)
  })
})

describe('postOps', () => {
  it('POSTs the ops batch as JSON and returns the updated map', async () => {
    const spy = vi.fn(async () => okResponse({ checks: { a: 't1' } }))
    vi.stubGlobal('fetch', spy)
    const ops = [{ op: 'check', doseId: 'a', at: 't1' } as const]
    await expect(postOps('tok', ops)).resolves.toEqual({ a: 't1' })
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${WORKER_URL}/ops`)
    expect(init.method).toBe('POST')
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json')
    expect(JSON.parse(init.body as string)).toEqual({ ops })
  })
})
