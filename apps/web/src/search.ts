import type { SearchResult } from '@music-station/shared'

export type SearchOutcome = { ok: true; results: SearchResult[] } | { ok: false; error: string }

/** Searches YouTube through the station, with an error ready to show. */
export async function searchSongs(query: string, fetchFn: typeof fetch = fetch): Promise<SearchOutcome> {
  try {
    const res = await fetchFn(`/api/search?q=${encodeURIComponent(query)}`)
    const body = (await res.json()) as { results?: SearchResult[]; error?: string }
    if (!res.ok) return { ok: false, error: res.status === 429 ? 'Too many searches. Wait a minute.' : (body.error ?? 'Search failed') }
    return { ok: true, results: body.results ?? [] }
  } catch {
    return { ok: false, error: 'Search failed. Check your connection.' }
  }
}
