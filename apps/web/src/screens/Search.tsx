import { useState, type FormEvent } from 'react'
import type { SearchResult } from '@music-station/shared'
import { classifyInput, formatTime } from '../format'
import type { Station } from '../useStation'

interface Props {
  send: Station['send']
  notify: Station['notify']
}

export function Search({ send, notify }: Props) {
  const [text, setText] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [added, setAdded] = useState<Set<string>>(() => new Set())
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const input = classifyInput(text)
    if (input.kind === 'empty') return
    if (input.kind === 'bad-link') {
      notify('That link has no YouTube video in it', 'error')
      return
    }
    setBusy(true)
    try {
      if (input.kind === 'link') {
        const res = await send('queue:add', { input: input.videoId })
        if (res.ok) setText('')
        return
      }
      const res = await fetch(`/api/search?q=${encodeURIComponent(input.query)}`)
      const body = (await res.json()) as { results?: SearchResult[]; error?: string }
      if (!res.ok) {
        notify(res.status === 429 ? 'Too many searches. Wait a minute.' : (body.error ?? 'Search failed'), 'error')
        return
      }
      setResults(body.results ?? [])
      setAdded(new Set())
    } catch {
      notify('Search failed. Check your connection.', 'error')
    } finally {
      setBusy(false)
    }
  }

  async function add(result: SearchResult) {
    const res = await send('queue:add', { input: result.videoId })
    if (res.ok) setAdded((s) => new Set(s).add(result.videoId))
  }

  return (
    <section className="flex flex-col gap-3">
      <form onSubmit={submit} className="flex gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Search or paste a YouTube link"
          aria-label="Search or paste a YouTube link"
          enterKeyHint="search"
          maxLength={500}
          className="min-w-0 flex-1 rounded-lg bg-zinc-900 px-3 py-2 outline-none ring-1 ring-zinc-800 focus:ring-emerald-500"
        />
        <button disabled={busy} className="rounded-lg bg-zinc-800 px-4 py-2 disabled:opacity-40">
          {busy ? '…' : 'Go'}
        </button>
      </form>
      {results.length > 0 && (
        <>
          <ul className="flex flex-col gap-2">
            {results.map((r) => (
              <li key={r.videoId} className="flex items-center gap-3 rounded-xl bg-zinc-900 p-2">
                <img src={r.thumbnail} alt="" loading="lazy" className="h-12 w-20 shrink-0 rounded object-cover" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{r.title}</p>
                  <p className="truncate text-xs text-zinc-500">
                    {r.channel}
                    {r.duration !== null && ` · ${formatTime(r.duration)}`}
                  </p>
                </div>
                <button
                  onClick={() => void add(r)}
                  disabled={added.has(r.videoId)}
                  className="shrink-0 rounded-lg bg-emerald-500 px-3 py-1.5 text-sm font-semibold text-zinc-950 disabled:bg-zinc-700 disabled:text-zinc-400"
                >
                  {added.has(r.videoId) ? 'Added' : 'Add'}
                </button>
              </li>
            ))}
          </ul>
          <button onClick={() => setResults([])} className="self-center text-sm text-zinc-500">
            Clear results
          </button>
        </>
      )}
    </section>
  )
}
