import { describe, expect, it, vi } from 'vitest'
import type { DesktopBridge, DesktopCommand, QueueItem, StationState } from '@music-station/shared'
import { getDesktop, listenForCommands, nowPlayingOf, reportNowPlaying } from './desktop'

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
const stateWith = (current: QueueItem | null, status: StationState['playback']['status'] = 'playing'): StationState => ({
  current,
  queue: [],
  playback: { status, position: 0, at: 0 },
  listeners: [],
  autoplay: false,
})

describe('getDesktop', () => {
  it('returns the bridge inside the app', () => {
    const bridge = { nowPlaying() {} }
    expect(getDesktop({ desktop: bridge })).toBe(bridge)
  })

  it('returns null in a browser, or for anything that is not an object', () => {
    expect(getDesktop({})).toBeNull()
    expect(getDesktop({ desktop: null })).toBeNull()
    expect(getDesktop({ desktop: 'yes' })).toBeNull()
  })
})

describe('nowPlayingOf', () => {
  it('reports the song with each station status while joined', () => {
    for (const status of ['playing', 'paused', 'waiting'] as const) {
      expect(nowPlayingOf(stateWith(song, status), true)).toEqual({ title: 'Song', channel: 'Band', status })
    }
  })

  it('is null before joining, before the first state, and with nothing current', () => {
    expect(nowPlayingOf(stateWith(song), false)).toBeNull()
    expect(nowPlayingOf(null, true)).toBeNull()
    expect(nowPlayingOf(stateWith(null), true)).toBeNull()
  })
})

describe('reportNowPlaying', () => {
  it('sends the song, and null when nothing is current', () => {
    const nowPlaying = vi.fn()
    reportNowPlaying({ nowPlaying }, { title: 'Song', channel: 'Band', status: 'paused' })
    reportNowPlaying({ nowPlaying }, null)
    expect(nowPlaying.mock.calls).toEqual([[{ title: 'Song', channel: 'Band', status: 'paused' }], [null]])
  })

  it('does nothing without a bridge, or with an older bridge that lacks nowPlaying', () => {
    expect(() => reportNowPlaying(null, null)).not.toThrow()
    expect(() => reportNowPlaying({}, null)).not.toThrow()
  })
})

describe('listenForCommands', () => {
  function fakeBridge() {
    let listener: ((command: DesktopCommand) => void) | null = null
    const stop = vi.fn(() => {
      listener = null
    })
    const bridge: DesktopBridge = {
      onCommand: (fn) => {
        listener = fn
        return stop
      },
    }
    // The page is remote, but the app could still send a command this page does not know.
    return { bridge, stop, press: (command: string) => listener?.(command as DesktopCommand) }
  }

  it('sends each tray command as its station action', () => {
    const { bridge, press } = fakeBridge()
    const send = vi.fn()
    listenForCommands(bridge, send)
    press('play')
    press('pause')
    press('skip')
    expect(send.mock.calls).toEqual([['player:play'], ['player:pause'], ['player:skip']])
  })

  it('ignores commands it does not know, including inherited property names', () => {
    const { bridge, press } = fakeBridge()
    const send = vi.fn()
    listenForCommands(bridge, send)
    press('toString')
    press('constructor')
    press('seek')
    expect(send).not.toHaveBeenCalled()
  })

  it('returns the function that stops listening', () => {
    const { bridge, stop, press } = fakeBridge()
    const send = vi.fn()
    const unsubscribe = listenForCommands(bridge, send)
    unsubscribe?.()
    expect(stop).toHaveBeenCalledOnce()
    press('play')
    expect(send).not.toHaveBeenCalled()
  })

  it('returns null without a bridge, or with one that lacks onCommand', () => {
    expect(listenForCommands(null, vi.fn())).toBeNull()
    expect(listenForCommands({}, vi.fn())).toBeNull()
  })
})
