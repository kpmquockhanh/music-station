import { useEffect, useState, type CSSProperties } from 'react'
import { expectedPosition, type Playback, type QueueItem } from '@music-station/shared'
import { formatTime } from '../format'
import { Avatar, Equalizer, Icon } from '../ui'
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
      <section
        aria-label="Now playing"
        className="flex flex-col items-center gap-4 rounded-3xl bg-surface px-6 py-12 text-center ring-1 ring-line"
      >
        <span className="grid size-16 place-items-center rounded-full bg-raised text-subtle">
          <Icon name="music" className="size-7" />
        </span>
        <div className="flex flex-col gap-1">
          <p className="font-display text-xl font-semibold">Nothing playing yet</p>
          <p className="text-pretty text-muted">Search for a song or paste a YouTube link to get the station going.</p>
        </div>
      </section>
    )
  }

  // Pausing while the song still downloads is allowed, so it does not start by itself when the download ends.
  const loading = playback.status === 'waiting' || current.status === 'downloading'
  const paused = playback.status === 'paused'
  const position = Math.min(current.duration, expectedPosition(playback, serverNow()))
  const shown = drag ?? position
  const fill = current.duration > 0 ? (shown / current.duration) * 100 : 0

  const commitSeek = () => {
    if (drag === null) return
    const target = drag
    setDrag(null)
    void send('player:seek', { position: target })
  }
  // iOS may cancel a drag (a scroll or a system gesture) without a pointerup; drop it without seeking.
  const cancelSeek = () => setDrag(null)

  return (
    <section
      aria-label="Now playing"
      className="relative isolate flex flex-col gap-5 overflow-hidden rounded-3xl bg-surface p-4 ring-1 ring-line sm:p-5"
    >
      {/* Ambient light taken from the artwork */}
      <img
        src={current.thumbnail}
        alt=""
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 size-full scale-150 object-cover opacity-45 blur-3xl saturate-150"
      />
      <div aria-hidden="true" className="absolute inset-0 -z-10 bg-gradient-to-b from-surface/30 via-surface/75 to-surface" />

      <div className="flex items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-xs font-semibold tracking-[0.14em] text-muted uppercase">
          <Equalizer playing={!paused && !loading} className="text-accent" />
          {loading ? 'Getting ready' : paused ? 'Paused' : 'Now playing'}
        </p>
        <p className="flex min-w-0 items-center gap-2 text-xs text-muted">
          <Avatar name={current.addedBy} className="size-6 text-[10px]" />
          <span className="truncate">
            Added by <span className="font-medium text-ink">{current.addedBy}</span>
          </span>
        </p>
      </div>

      <img
        key={current.id}
        src={current.thumbnail}
        alt=""
        className="aspect-video w-full animate-rise-in rounded-2xl bg-raised object-cover shadow-2xl shadow-black/60"
      />

      <div className="flex min-w-0 flex-col gap-1">
        <h2 className="line-clamp-2 font-display text-xl leading-snug font-semibold text-balance sm:text-2xl" title={current.title}>
          {current.title}
        </h2>
        <p className="truncate text-muted">{current.channel}</p>
      </div>

      {loading ? (
        <div role="status" className="flex flex-col gap-2">
          <div className="shimmer h-1.5 w-full rounded-full" />
          <p className="flex items-center gap-2 text-sm text-warn">
            <Icon name="spinner" className="size-4" />
            Preparing audio for everyone…
          </p>
        </div>
      ) : (
        <div className="flex flex-col">
          <input
            type="range"
            aria-label="Seek"
            aria-valuetext={`${formatTime(shown)} of ${formatTime(current.duration)}`}
            min={0}
            max={current.duration}
            step={1}
            value={shown}
            onChange={(e) => setDrag(Number(e.target.value))}
            onPointerUp={commitSeek}
            onKeyUp={commitSeek}
            onPointerCancel={cancelSeek}
            onBlur={cancelSeek}
            style={{ '--fill': `${fill}%` } as CSSProperties}
            className="range"
          />
          <div className="flex justify-between font-display text-xs font-medium tabular-nums text-muted">
            <span>{formatTime(shown)}</span>
            <span>-{formatTime(current.duration - shown)}</span>
          </div>
        </div>
      )}

      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-4">
        <span />
        <button
          type="button"
          onClick={() => void send(paused ? 'player:play' : 'player:pause')}
          disabled={paused && current.status !== 'ready'}
          aria-label={paused ? 'Play' : 'Pause'}
          className="grid size-16 place-items-center rounded-full bg-accent text-on-accent shadow-[0_8px_28px_-6px_rgb(34_197_94/0.6)] transition-[background-color,transform] duration-150 hover:bg-accent-hover active:scale-95 disabled:bg-raised disabled:text-subtle disabled:shadow-none"
        >
          <Icon name={paused ? 'play' : 'pause'} className={`size-7 ${paused ? 'translate-x-0.5' : ''}`} />
        </button>
        <button
          type="button"
          onClick={() => void send('player:skip')}
          aria-label="Skip to next song"
          title="Skip"
          className="grid size-12 place-items-center justify-self-start rounded-full bg-raised/80 text-ink ring-1 ring-line backdrop-blur transition-[background-color,transform] duration-150 hover:bg-overlay active:scale-95"
        >
          <Icon name="skip" className="size-5" />
        </button>
      </div>
    </section>
  )
}
