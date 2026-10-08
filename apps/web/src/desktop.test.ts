import { describe, expect, it, vi } from 'vitest'
import type { DesktopBridge, DesktopCommand, DesktopRequest, QueueItem, StationState } from '@music-station/shared'
import { answerRequest, getDesktop, listenForCommands, listenForRequests, nowPlayingOf, reportNowPlaying, upNextOf } from './desktop'

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
      expect(nowPlayingOf(stateWith(song, status), true)).toEqual({
        title: 'Song',
        channel: 'Band',
        status,
        thumbnail: song.thumbnail,
        duration: 200,
      })
    }
  })

  it('adds the position on this computer\'s clock when given the time', () => {
    const state = stateWith(song, 'playing')
    state.playback = { status: 'playing', position: 30, at: 10_000 }
    // 5 s after the server's position, read at 99_000 on this computer.
    expect(nowPlayingOf(state, true, { serverNow: 15_000, localNow: 99_000 })).toMatchObject({ position: 35, at: 99_000 })
    state.playback = { status: 'paused', position: 30, at: 10_000 }
    expect(nowPlayingOf(state, true, { serverNow: 15_000, localNow: 99_000 })).toMatchObject({ position: 30, at: 99_000 })
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

describe('upNextOf', () => {
  it('sends the first songs of the queue and how many there are while joined', () => {
    const queue = Array.from({ length: 25 }, (_, i) => ({ ...song, id: `item-${i}`, title: `Song ${i}` }))
    const upNext = upNextOf({ ...stateWith(song), queue }, true)
    expect(upNext?.total).toBe(25)
    expect(upNext?.songs).toHaveLength(20)
    expect(upNext?.songs[0]).toEqual({
      title: 'Song 0',
      duration: 200,
      thumbnail: 'https://i.ytimg.com/vi/aaaaaaaaaaa/hqdefault.jpg',
      addedBy: 'Minh',
      status: 'ready',
    })
  })

  it('is null while not joined', () => {
    expect(upNextOf(stateWith(song), false)).toBeNull()
    expect(upNextOf(null, true)).toBeNull()
  })
})

describe('answerRequest', () => {
  const ok = { ok: true } as const
  const setup = () => ({
    send: vi.fn(async () => ok),
    search: vi.fn(async () => ({ ok: true as const, results: [] })),
  })

  it('adds a pasted YouTube link straight to the queue', async () => {
    const { send, search } = setup()
    await expect(answerRequest({ kind: 'submit', text: ' https://youtu.be/dQw4w9WgXcQ ' }, send, search)).resolves.toEqual(ok)
    expect(send).toHaveBeenCalledWith('queue:add', { input: 'dQw4w9WgXcQ' })
    expect(search).not.toHaveBeenCalled()
  })

  it('searches for other text', async () => {
    const { send, search } = setup()
    await answerRequest({ kind: 'submit', text: '  never gonna ' }, send, search)
    expect(search).toHaveBeenCalledWith('never gonna')
    expect(send).not.toHaveBeenCalled()
  })

  it('refuses empty text and links without a video', async () => {
    const { send, search } = setup()
    await expect(answerRequest({ kind: 'submit', text: '  ' }, send, search)).resolves.toMatchObject({ ok: false })
    await expect(answerRequest({ kind: 'submit', text: 'https://youtube.com/' }, send, search)).resolves.toEqual({
      ok: false,
      error: 'That link has no YouTube video in it',
    })
    expect(send).not.toHaveBeenCalled()
    expect(search).not.toHaveBeenCalled()
  })

  it('adds a search result', async () => {
    const { send, search } = setup()
    await answerRequest({ kind: 'add', videoId: 'dQw4w9WgXcQ' }, send, search)
    expect(send).toHaveBeenCalledWith('queue:add', { input: 'dQw4w9WgXcQ' })
  })

  it('answers anything else with an error', async () => {
    const { send, search } = setup()
    for (const request of [null, {}, { kind: 'remove' }, { kind: 'submit', text: 3 }]) {
      await expect(answerRequest(request as never, send, search)).resolves.toMatchObject({ ok: false })
    }
    expect(send).not.toHaveBeenCalled()
  })
})

describe('listenForRequests', () => {
  it('answers through the bridge and returns its stop function', async () => {
    const stop = vi.fn()
    let handler: ((r: DesktopRequest) => Promise<unknown>) | null = null
    const bridge: DesktopBridge = {
      onRequest: (fn) => {
        handler = fn
        return stop
      },
    }
    const send = vi.fn(async () => ({ ok: true }) as const)
    expect(listenForRequests(bridge, send)).toBe(stop)
    await handler!({ kind: 'add', videoId: 'dQw4w9WgXcQ' })
    expect(send).toHaveBeenCalledWith('queue:add', { input: 'dQw4w9WgXcQ' })
  })

  it('does nothing for an app without requests', () => {
    expect(listenForRequests({}, vi.fn())).toBeNull()
    expect(listenForRequests(null, vi.fn())).toBeNull()
  })
})
