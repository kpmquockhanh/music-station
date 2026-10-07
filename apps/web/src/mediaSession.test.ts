import { describe, expect, it, vi } from 'vitest'
import type { QueueItem, StationState } from '@music-station/shared'
import { applyMediaSession, sessionView, type SessionLike, type SessionView } from './mediaSession'

class FakeSession implements SessionLike {
  metadata: MediaMetadata | null = null
  playbackState: MediaSessionPlaybackState = 'none'
  readonly handlers = new Map<MediaSessionAction, MediaSessionActionHandler | null>()
  constructor(private readonly unsupported: MediaSessionAction[] = []) {}
  setActionHandler(action: MediaSessionAction, handler: MediaSessionActionHandler | null): void {
    if (this.unsupported.includes(action)) throw new TypeError(`The action "${action}" is not supported`)
    this.handlers.set(action, handler)
  }
  /** Presses a media key. */
  press(action: MediaSessionAction): void {
    this.handlers.get(action)?.({ action })
  }
}

// Node has no MediaMetadata; a plain object with the same fields stands in for it.
const toMetadata = (init: MediaMetadataInit) => init as unknown as MediaMetadata
const spies = () => ({ play: vi.fn(), pause: vi.fn(), next: vi.fn() })

const song: QueueItem = {
  id: 'item-1',
  videoId: 'aaaaaaaaaaa',
  title: 'Song',
  channel: 'Band',
  duration: 200,
  thumbnail: 'https://i.ytimg.com/vi/aaaaaaaaaaa/hqdefault.jpg',
  addedBy: 'Minh',
  status: 'ready',
}
const stateWith = (current: QueueItem | null, status: StationState['playback']['status']): StationState => ({
  current,
  queue: [],
  playback: { status, position: 0, at: 0 },
  listeners: [],
  autoplay: false,
})
const view: SessionView = { title: 'Song', artist: 'Band', artwork: song.thumbnail, playing: true }

describe('sessionView', () => {
  it('shows the song while joined, playing only when the station plays and this device is not paused', () => {
    expect(sessionView(stateWith(song, 'playing'), true, false)).toEqual(view)
    expect(sessionView(stateWith(song, 'playing'), true, true)?.playing).toBe(false)
    expect(sessionView(stateWith(song, 'paused'), true, false)?.playing).toBe(false)
    expect(sessionView(stateWith(song, 'waiting'), true, false)?.playing).toBe(false)
  })

  it('is null before joining, before the first state, and with nothing current', () => {
    expect(sessionView(stateWith(song, 'playing'), false, false)).toBeNull()
    expect(sessionView(null, true, false)).toBeNull()
    expect(sessionView(stateWith(null, 'paused'), true, false)).toBeNull()
  })
})

describe('applyMediaSession', () => {
  it('sets the song info and the playback state', () => {
    const session = new FakeSession()
    applyMediaSession(session, view, spies(), toMetadata)
    expect(session.metadata).toEqual({ title: 'Song', artist: 'Band', artwork: [{ src: song.thumbnail }] })
    expect(session.playbackState).toBe('playing')
    applyMediaSession(session, { ...view, playing: false }, spies(), toMetadata)
    expect(session.playbackState).toBe('paused')
  })

  it('leaves the artwork out when the song has no thumbnail', () => {
    const session = new FakeSession()
    applyMediaSession(session, { ...view, artwork: '' }, spies(), toMetadata)
    expect(session.metadata).toEqual({ title: 'Song', artist: 'Band', artwork: [] })
  })

  it('maps Play, Pause and Next to resume, pause here and skip', () => {
    const session = new FakeSession()
    const h = spies()
    applyMediaSession(session, view, h, toMetadata)
    session.press('pause')
    expect(h.pause).toHaveBeenCalledOnce()
    session.press('play')
    expect(h.play).toHaveBeenCalledOnce()
    session.press('nexttrack')
    expect(h.next).toHaveBeenCalledOnce()
  })

  it('clears the song info and the handlers when there is nothing to show', () => {
    const session = new FakeSession()
    applyMediaSession(session, view, spies(), toMetadata)
    applyMediaSession(session, null, spies(), toMetadata)
    expect(session.metadata).toBeNull()
    expect(session.playbackState).toBe('none')
    expect([...session.handlers.values()]).toEqual([null, null, null])
  })

  it('still sets the other handlers when the browser does not support one action', () => {
    const session = new FakeSession(['play'])
    const h = spies()
    expect(() => applyMediaSession(session, view, h, toMetadata)).not.toThrow()
    session.press('pause')
    session.press('nexttrack')
    expect(h.pause).toHaveBeenCalledOnce()
    expect(h.next).toHaveBeenCalledOnce()
  })
})
