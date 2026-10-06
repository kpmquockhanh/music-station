import { useEffect, useState } from 'react'
import { expectedPosition, type Playback, type QueueItem } from '@music-station/shared'
import { formatTime } from '../format'
import type { Station } from '../useStation'

interface Props {
  current: QueueItem | null
  playback: Playback
  serverNow(): number
  send: Station['send']
}

export function NowPlaying({ current, playback, serverNow, send }: Props) {
  const [, setFrame] = useState(0)
  const [drag, setDrag] = useState<number | null>(null)

  useEffect(() => {
    const timer = setInterval(() => setFrame((n) => n + 1), 250)
    return () => clearInterval(timer)
  }, [])

  if (!current) {
    return (
      <section className="rounded-2xl bg-zinc-900 p-6 text-center text-zinc-400">
        Nothing is playing. Search for a song to start.
      </section>
    )
  }

  // Pausing while the song still downloads is allowed, so it does not start by itself when the download ends.
  const loading = playback.status === 'waiting' || current.status === 'downloading'
  const paused = playback.status === 'paused'
  const position = Math.min(current.duration, expectedPosition(playback, serverNow()))
  const shown = drag ?? position

  const commitSeek = () => {
    if (drag === null) return
    const target = drag
    setDrag(null)
    void send('player:seek', { position: target })
  }
  // iOS may cancel a drag (a scroll or a system gesture) without a pointerup; drop it without seeking.
  const cancelSeek = () => setDrag(null)

  return (
    <section className="flex flex-col gap-4 rounded-2xl bg-zinc-900 p-4">
      <div className="flex gap-4">
        <img src={current.thumbnail} alt="" className="h-20 w-36 shrink-0 rounded-lg object-cover" />
        <div className="min-w-0">
          <p className="truncate font-semibold">{current.title}</p>
          <p className="truncate text-sm text-zinc-400">{current.channel}</p>
          <p className="truncate text-xs text-zinc-500">Added by {current.addedBy}</p>
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-amber-400">Loading…</p>
      ) : (
        <div className="flex flex-col gap-1">
          <input
            type="range"
            aria-label="Seek"
            min={0}
            max={current.duration}
            step={1}
            value={shown}
            onChange={(e) => setDrag(Number(e.target.value))}
            onPointerUp={commitSeek}
            onKeyUp={commitSeek}
            onPointerCancel={cancelSeek}
            onBlur={cancelSeek}
            className="w-full accent-emerald-500"
          />
          <div className="flex justify-between text-xs tabular-nums text-zinc-400">
            <span>{formatTime(shown)}</span>
            <span>{formatTime(current.duration)}</span>
          </div>
        </div>
      )}

      <div className="flex justify-center gap-3">
        <button
          onClick={() => void send(paused ? 'player:play' : 'player:pause')}
          disabled={paused && current.status !== 'ready'}
          className="rounded-full bg-emerald-500 px-6 py-2 font-semibold text-zinc-950 disabled:opacity-40"
        >
          {paused ? 'Play' : 'Pause'}
        </button>
        <button onClick={() => void send('player:skip')} className="rounded-full bg-zinc-800 px-6 py-2">
          Skip
        </button>
      </div>
    </section>
  )
}
