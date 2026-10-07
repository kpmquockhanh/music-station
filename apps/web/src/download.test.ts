import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { downloadSong } from './download'

const URL_ = '/audio/aaaaaaaaaaa.m4a'
const AUDIO = { 'content-type': 'audio/mp4' }

/** A body that sends the given chunks, then never finishes when hang is set. */
function body(chunks: string[], hang = false) {
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk))
      if (!hang) c.close()
    },
  })
}

/** A fetch that plays the given replies in order; a reply that is an Error rejects like a network failure. */
function fakeFetch(...replies: (Response | Error | 'hang')[]) {
  const calls: AbortSignal[] = []
  const fn = vi.fn((_url: string, init?: RequestInit) => {
    const signal = init!.signal!
    calls.push(signal)
    const reply = replies[calls.length - 1] ?? new Error('no more replies')
    if (reply === 'hang') {
      return new Promise<Response>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)))
    }
    return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply)
  })
  return { fetch: fn as unknown as typeof fetch, calls }
}

const ok = (...chunks: string[]) => new Response(body(chunks), { headers: AUDIO })
const text = (blob: Blob) => blob.text()

/** Lets the pending backoffs run out, then settles the download either way. */
async function settled<T>(p: Promise<T>): Promise<{ value?: T; error?: unknown }> {
  const result = p.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  )
  await vi.advanceTimersByTimeAsync(10)
  return result
}

describe('downloadSong', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('returns the whole file with its type', async () => {
    const f = fakeFetch(ok('ab', 'cd'))
    const blob = await downloadSong(URL_, new AbortController().signal, { fetch: f.fetch })
    expect(await text(blob)).toBe('abcd')
    expect(blob.type).toBe('audio/mp4')
  })

  it('retries a network error after a backoff', async () => {
    const f = fakeFetch(new TypeError('Failed to fetch'), ok('song'))
    const p = downloadSong(URL_, new AbortController().signal, { fetch: f.fetch, backoffMs: [1_000] })
    await vi.advanceTimersByTimeAsync(999)
    expect(f.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await text(await p)).toBe('song')
    expect(f.calls).toHaveLength(2)
  })

  it('retries 5xx but not 404', async () => {
    const f = fakeFetch(new Response('', { status: 502 }), ok('song'))
    const retried = await settled(downloadSong(URL_, new AbortController().signal, { fetch: f.fetch, backoffMs: [0] }))
    expect(await text(retried.value!)).toBe('song')
    const g = fakeFetch(new Response('', { status: 404 }), ok('song'))
    const refused = await settled(downloadSong(URL_, new AbortController().signal, { fetch: g.fetch, backoffMs: [0] }))
    expect(String(refused.error)).toContain('HTTP 404')
    expect(g.calls).toHaveLength(1)
  })

  it('gives up after the last attempt so the player can stream instead', async () => {
    const f = fakeFetch(new TypeError('a'), new TypeError('b'), new TypeError('c'), ok('never'))
    const { error } = await settled(downloadSong(URL_, new AbortController().signal, { fetch: f.fetch, backoffMs: [0] }))
    expect(String(error)).toContain('c')
    expect(f.calls).toHaveLength(3)
  })

  it('cuts an attempt whose reply never starts and retries', async () => {
    const f = fakeFetch('hang', ok('song'))
    const p = downloadSong(URL_, new AbortController().signal, { fetch: f.fetch, stallMs: 15_000, backoffMs: [0] })
    await vi.advanceTimersByTimeAsync(15_000)
    expect(f.calls[0]!.aborted).toBe(true)
    expect(await text((await settled(p)).value!)).toBe('song')
  })

  it('cuts a body that stops mid-file, but leaves a slow steady one alone', async () => {
    const f = fakeFetch(new Response(body(['half'], true), { headers: AUDIO }), ok('song'))
    const p = downloadSong(URL_, new AbortController().signal, { fetch: f.fetch, stallMs: 15_000, backoffMs: [0] })
    await vi.advanceTimersByTimeAsync(14_999)
    expect(f.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await text((await settled(p)).value!)).toBe('song')
    expect(f.calls).toHaveLength(2)

    let push!: (s: string) => void
    let close!: () => void
    const slow = new ReadableStream<Uint8Array>({
      start(c) {
        push = (s) => c.enqueue(new TextEncoder().encode(s))
        close = () => c.close()
      },
    })
    const g = fakeFetch(new Response(slow, { headers: AUDIO }))
    const q = downloadSong(URL_, new AbortController().signal, { fetch: g.fetch, stallMs: 15_000 })
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(10_000) // 40 s in all, never 15 s without a byte
      push(String(i))
    }
    close()
    expect(await text(await q)).toBe('0123')
    expect(g.calls).toHaveLength(1)
  })

  it('stops at once without retrying when the player aborts', async () => {
    const f = fakeFetch('hang', ok('song'))
    const ctrl = new AbortController()
    const p = downloadSong(URL_, ctrl.signal, { fetch: f.fetch })
    ctrl.abort()
    await expect(p).rejects.toBeDefined()
    expect(f.calls).toHaveLength(1)
  })

  it('stops during the backoff when the player aborts', async () => {
    const f = fakeFetch(new TypeError('a'), ok('song'))
    const ctrl = new AbortController()
    const p = downloadSong(URL_, ctrl.signal, { fetch: f.fetch, backoffMs: [5_000] })
    const caught = p.catch((e) => e)
    await vi.advanceTimersByTimeAsync(100)
    ctrl.abort()
    expect(await caught).toBeDefined()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(f.calls).toHaveLength(1)
  })
})
