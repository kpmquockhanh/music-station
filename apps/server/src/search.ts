import { LRUCache } from 'lru-cache'
import pLimit from 'p-limit'
import type { SearchResult } from '@music-station/shared'

export type SearchFn = (query: string) => Promise<SearchResult[]>

export function createSearch(
  fn: SearchFn,
  opts: { ttlMs?: number; max?: number; concurrency?: number } = {},
): SearchFn {
  const cache = new LRUCache<string, SearchResult[]>({ max: opts.max ?? 100, ttl: opts.ttlMs ?? 600_000 })
  const limit = pLimit(opts.concurrency ?? 2)
  const inflight = new Map<string, Promise<SearchResult[]>>()

  return (query) => {
    const q = query.trim().replace(/\s+/g, ' ')
    const key = q.toLowerCase()
    const hit = cache.get(key)
    if (hit) return Promise.resolve(hit)
    const running = inflight.get(key)
    if (running) return running
    const p = limit(() => fn(q))
      .then((results) => {
        cache.set(key, results)
        return results
      })
      .finally(() => inflight.delete(key))
    inflight.set(key, p)
    return p
  }
}
