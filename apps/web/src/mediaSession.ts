import { useEffect } from 'react'
import type { StationState } from '@music-station/shared'
import type { Station } from './useStation'

/** What the system's media controls show. */
export interface SessionView {
  title: string
  artist: string
  artwork: string
  /** The station plays and this device is not paused. */
  playing: boolean
}

export function sessionView(state: StationState | null, joined: boolean, blocked: boolean): SessionView | null {
  const current = state?.current
  if (!joined || !state || !current) return null
  return {
    title: current.title,
    artist: current.channel,
    artwork: current.thumbnail,
    playing: state.playback.status === 'playing' && !blocked,
  }
}

/** The part of navigator.mediaSession this uses, so tests can pass a fake. */
export interface SessionLike {
  metadata: MediaMetadata | null
  playbackState: MediaSessionPlaybackState
  setActionHandler(action: MediaSessionAction, handler: MediaSessionActionHandler | null): void
}

export interface SessionHandlers {
  play(): void
  pause(): void
  next(): void
}

/** Sets the song info and the key handlers for a view, or clears them all for null. */
export function applyMediaSession(
  session: SessionLike,
  view: SessionView | null,
  handlers: SessionHandlers,
  toMetadata: (init: MediaMetadataInit) => MediaMetadata = (init) => new MediaMetadata(init),
): void {
  if (view) {
    session.metadata = toMetadata({
      title: view.title,
      artist: view.artist,
      artwork: view.artwork ? [{ src: view.artwork }] : [],
    })
    session.playbackState = view.playing ? 'playing' : 'paused'
  } else {
    session.metadata = null
    session.playbackState = 'none'
  }
  const run = { play: handlers.play, pause: handlers.pause, nexttrack: handlers.next }
  for (const action of ['play', 'pause', 'nexttrack'] as const) {
    try {
      session.setActionHandler(action, view ? () => run[action]() : null)
    } catch {
      // Some browsers throw for an action they do not support; the others must still be set.
    }
  }
}

/**
 * Sets the song info and media-key handlers while joined, and clears them otherwise.
 * Play → station.resume(), Pause → station.pauseHere(), Next → send('player:skip').
 */
export function useMediaSession(station: Station): void {
  const key = JSON.stringify(sessionView(station.state, station.joined, station.blocked))
  const { resume, pauseHere, send } = station
  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    applyMediaSession(navigator.mediaSession, JSON.parse(key) as SessionView | null, {
      play: resume,
      pause: pauseHere,
      next: () => void send('player:skip'),
    })
  }, [key, resume, pauseHere, send])
}
