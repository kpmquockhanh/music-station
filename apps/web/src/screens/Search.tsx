import { useRef, useState, type FormEvent } from 'react'
import type { SearchResult } from '@music-station/shared'
import { classifyInput, formatTime } from '../format'
import { searchSongs } from '../search'
import { Icon } from '../ui'
import type { Station } from '../useStation'

interface Props {
  send: Station['send']
  notify: Station['notify']
}

export function Search({ send, notify }: Props) {
  const [text, setText] = useState('')
  const [results, setResults] = useState<SearchResult[] | null>(null)
  const [query, setQuery] = useState('')
  const [added, setAdded] = useState<Set<string>>(() => new Set())
  const [pending, setPending] = useState<Set<string>>(() => new Set())
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const kind = classifyInput(text).kind
  const isLink = kind === 'link'

  async function submit(e: FormEvent) {
    e.preventDefault()
    const input = classifyInput(text)
    if (input.kind === 'empty') return
    if (input.kind === 'bad-link') {
      notify('That link has no YouTube video in it', 'error')
      return
    }
    inputRef.current?.blur() // closes the phone keyboard so the results are visible
    setBusy(true)
    try {
      if (input.kind === 'link') {
        const res = await send('queue:add', { input: input.videoId })
        if (res.ok) setText('')
        return
      }
      const found = await searchSongs(input.query)
      if (!found.ok) {
        notify(found.error, 'error')
        return
      }
      setResults(found.results)
      setQuery(input.query)
      setAdded(new Set())
    } finally {
      setBusy(false)
    }
  }

  async function add(result: SearchResult) {
    setPending((s) => new Set(s).add(result.videoId))
    const res = await send('queue:add', { input: result.videoId })
    setPending((s) => {
      const next = new Set(s)
      next.delete(result.videoId)
      return next
    })
    if (res.ok) setAdded((s) => new Set(s).add(result.videoId))
  }

  const clearText = () => {
    setText('')
    inputRef.current?.focus()
  }

  const searching = busy && !isLink
  const showPanel = searching || results !== null

  return (
    <section aria-label="Add songs" className="flex flex-col gap-3">
      <form onSubmit={submit} role="search" className="flex gap-2">
        <div className="relative min-w-0 flex-1">
          <Icon
            name={isLink ? 'link' : 'search'}
            className={`pointer-events-none absolute top-1/2 left-3.5 size-5 -translate-y-1/2 ${isLink ? 'text-accent' : 'text-subtle'}`}
          />
          <input
            ref={inputRef}
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Search or paste a YouTube link"
            aria-label="Search songs or paste a YouTube link"
            aria-describedby={kind === 'link' || kind === 'bad-link' ? 'search-hint' : undefined}
            enterKeyHint={isLink ? 'done' : 'search'}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            maxLength={500}
            className="h-12 w-full rounded-2xl bg-surface pr-11 pl-11 text-ink ring-1 ring-line transition-shadow outline-none placeholder:text-subtle focus:ring-2 focus:ring-accent [&::-webkit-search-cancel-button]:hidden"
          />
          {text && (
            <button
              type="button"
              onClick={clearText}
              aria-label="Clear"
              className="absolute top-1/2 right-0.5 grid size-11 -translate-y-1/2 place-items-center rounded-xl text-subtle hover:text-ink"
            >
              <Icon name="x" className="size-4" />
            </button>
          )}
        </div>
        <button
          type="submit"
          disabled={busy || kind === 'empty'}
          className={`flex h-12 min-w-12 shrink-0 items-center justify-center gap-2 rounded-2xl px-3 font-medium sm:px-4 transition-colors duration-150 disabled:opacity-40 ${
            isLink ? 'bg-accent text-on-accent hover:bg-accent-hover' : 'bg-raised text-ink hover:bg-overlay'
          }`}
        >
          {busy ? <Icon name="spinner" /> : <Icon name={isLink ? 'plus' : 'search'} />}
          <span className="max-sm:sr-only">{isLink ? 'Add' : 'Search'}</span>
        </button>
      </form>

      {kind === 'link' && (
        <p id="search-hint" className="flex items-center gap-1.5 px-1 text-sm text-accent">
          <Icon name="check" className="size-4" />
          YouTube link detected. Add it straight to the queue.
        </p>
      )}
      {kind === 'bad-link' && (
        <p id="search-hint" className="flex items-center gap-1.5 px-1 text-sm text-warn">
          <Icon name="alert" className="size-4" />
          This link has no YouTube video in it.
        </p>
      )}

      {showPanel && (
        <div className="flex animate-fade-in flex-col gap-2 rounded-3xl bg-surface p-2 ring-1 ring-line">
          <div className="flex items-center justify-between gap-2 pl-2">
            <p className="min-w-0 truncate text-sm text-muted" aria-live="polite">
              {searching ? (
                'Searching…'
              ) : (
                <>
                  {results?.length ?? 0} {results?.length === 1 ? 'result' : 'results'} for{' '}
                  <span className="font-medium text-ink">“{query}”</span>
                </>
              )}
            </p>
            <button
              type="button"
              onClick={() => setResults(null)}
              disabled={searching}
              className="flex h-11 shrink-0 items-center gap-1 rounded-xl px-3 text-sm text-muted hover:bg-raised hover:text-ink disabled:invisible"
            >
              <Icon name="x" className="size-4" />
              Close
            </button>
          </div>

          {searching ? (
            <ul aria-hidden="true" className="flex flex-col gap-1">
              {[0, 1, 2, 3].map((n) => (
                <li key={n} className="flex items-center gap-3 p-2">
                  <div className="shimmer h-12 w-[4.5rem] shrink-0 rounded-lg" />
                  <div className="flex flex-1 flex-col gap-2">
                    <div className="shimmer h-3.5 w-4/5 rounded" />
                    <div className="shimmer h-3 w-2/5 rounded" />
                  </div>
                </li>
              ))}
            </ul>
          ) : results && results.length === 0 ? (
            <p className="px-2 pt-2 pb-4 text-center text-sm text-muted">
              No songs found. Try different words, or paste a YouTube link.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {results?.map((r) => {
                const done = added.has(r.videoId)
                const adding = pending.has(r.videoId)
                return (
                  <li key={r.videoId} className="flex items-center gap-3 rounded-2xl p-2 hover:bg-raised/60">
                    <img
                      src={r.thumbnail}
                      alt=""
                      loading="lazy"
                      className="h-12 w-[4.5rem] shrink-0 rounded-lg bg-raised object-cover"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="line-clamp-2 text-sm leading-snug font-medium">{r.title}</p>
                      <p className="flex min-w-0 gap-1.5 text-xs text-subtle">
                        <span className="truncate">{r.channel}</span>
                        {r.duration !== null && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="shrink-0 tabular-nums">{formatTime(r.duration)}</span>
                          </>
                        )}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void add(r)}
                      disabled={done || adding}
                      aria-label={done ? `${r.title} added` : `Add ${r.title} to queue`}
                      className={`grid size-11 shrink-0 place-items-center rounded-full transition-[background-color,color,transform] duration-200 active:scale-90 ${
                        done
                          ? 'bg-accent/15 text-accent'
                          : 'bg-raised text-ink ring-1 ring-line hover:bg-accent hover:text-on-accent hover:ring-accent'
                      }`}
                    >
                      <Icon name={adding ? 'spinner' : done ? 'check' : 'plus'} />
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}
