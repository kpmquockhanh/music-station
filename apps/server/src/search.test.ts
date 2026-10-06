import { describe, expect, it, vi } from 'vitest'
import type { SearchResult } from '@music-station/shared'
import { createSearch } from './search'

const result = (title: string): SearchResult[] => [
  { videoId: 'aaaaaaaaaaa', title, channel: 'c', duration: 1, thumbnail: 't' },
]

describe('createSearch', () => {
  it('caches by normalized query and dedupes in-flight calls', async () => {
    const fn = vi.fn(async (q: string) => result(q))
    const search = createSearch(fn)
    const [a, b] = await Promise.all([search('Lofi  Beats'), search(' lofi beats ')])
    await search('LOFI BEATS')
    expect(fn).toHaveBeenCalledOnce()
    expect(fn).toHaveBeenCalledWith('Lofi Beats')
    expect(a).toBe(b)
  })

  it('does not cache failures', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(result('ok'))
    const search = createSearch(fn)
    await expect(search('x')).rejects.toThrow('boom')
    await expect(search('x')).resolves.toEqual(result('ok'))
  })

  it('expires entries after the ttl', async () => {
    const fn = vi.fn(async (q: string) => result(q))
    const search = createSearch(fn, { ttlMs: 20 })
    await search('x')
    await new Promise((r) => setTimeout(r, 40))
    await search('x')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('runs at most 2 searches at once', async () => {
    let active = 0
    let peak = 0
    const search = createSearch(async (q) => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 20))
      active--
      return result(q)
    })
    await Promise.all(['a', 'b', 'c', 'd'].map(search))
    expect(peak).toBe(2)
  })
})
