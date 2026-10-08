import { describe, expect, it, vi } from 'vitest'
import { searchSongs } from './search'

const reply = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }))

describe('searchSongs', () => {
  it('returns the results', async () => {
    const results = [{ videoId: 'dQw4w9WgXcQ', title: 'Song', channel: 'Band', duration: 200, thumbnail: 'https://x/y.jpg' }]
    const fetchFn = reply(200, { results })
    await expect(searchSongs('rick & roll', fetchFn)).resolves.toEqual({ ok: true, results })
    expect(fetchFn).toHaveBeenCalledWith('/api/search?q=rick%20%26%20roll')
  })

  it('explains the rate limit and passes on other errors', async () => {
    await expect(searchSongs('a', reply(429, {}))).resolves.toEqual({ ok: false, error: 'Too many searches. Wait a minute.' })
    await expect(searchSongs('a', reply(502, { error: 'YouTube is down' }))).resolves.toEqual({ ok: false, error: 'YouTube is down' })
  })

  it('reports a failed connection', async () => {
    const fetchFn = vi.fn(async () => Promise.reject(new TypeError('fetch failed')))
    await expect(searchSongs('a', fetchFn)).resolves.toEqual({ ok: false, error: 'Search failed. Check your connection.' })
  })
})
