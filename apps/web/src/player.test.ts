import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Playback, QueueItem } from '@music-station/shared'
import { SyncPlayer, type AudioLike } from './player'

type AudioEvent = 'canplay' | 'loadedmetadata' | 'pause'

class FakeAudio implements AudioLike {
  src = ''
  playbackRate = 1
  preservesPitch = false
  paused = true
  readyState = 0
  seeking = false
  ended = false
  /** The error name play() rejects with, such as NotAllowedError for the autoplay policy. */
  playError: string | null = null
  /** Some browsers already have metadata when load() returns. */
  metadataOnLoad = false
  plays = 0
  loads = 0
  seeks = 0
  private time = 0
  private handlers = new Map<AudioEvent, Set<() => void>>()

  get currentTime(): number {
    return this.time
  }
  set currentTime(value: number) {
    this.time = value
    this.seeks++
  }
  play(): Promise<void> {
    this.plays++
    if (this.playError) return Promise.reject(Object.assign(new Error('play failed'), { name: this.playError }))
    this.paused = false
    this.ended = false
    return Promise.resolve()
  }
  /** Like a real element: no event when already paused, otherwise the event arrives in a later task. */
  pause(): void {
    if (this.paused) return
    this.paused = true
    setTimeout(() => this.emit('pause'), 0)
  }
  load(): void {
    this.loads++
    this.readyState = this.metadataOnLoad ? 1 : 0
  }
  addEventListener(type: AudioEvent, fn: () => void): void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set())
    this.handlers.get(type)!.add(fn)
  }
  removeEventListener(type: AudioEvent, fn: () => void): void {
    this.handlers.get(type)?.delete(fn)
  }
  emit(type: AudioEvent): void {
    for (const fn of this.handlers.get(type) ?? []) fn()
  }
  /** Simulates the browser finishing loading the file. */
  loaded(): void {
    this.readyState = 4
    this.emit('loadedmetadata')
    this.emit('canplay')
  }
  /** Simulates iOS, which can stop at HAVE_METADATA and never fire canplay before play(). */
  metadataOnly(): void {
    this.readyState = 1
    this.emit('loadedmetadata')
  }
  /** Simulates the song reaching its natural end: pause fires before ended. */
  finish(): void {
    this.ended = true
    this.pause()
  }
}

const T0 = 1_000_000
const A = 'aaaaaaaaaaa'
const B = 'bbbbbbbbbbb'
const item = (videoId: string, status: QueueItem['status'] = 'ready'): QueueItem => ({
  id: `item-${videoId}`,
  videoId,
  title: videoId,
  channel: 'c',
  duration: 200,
  thumbnail: '',
  addedBy: 'Minh',
  status,
})
const playing = (position: number, at: number): Playback => ({ status: 'playing', position, at })
const paused = (position: number): Playback => ({ status: 'paused', position, at: T0 })
const settle = () => vi.advanceTimersByTimeAsync(0)
/** Reads the same position for a full drift-averaging window, so the player acts on it alone. */
const holdAt = (t: number) => {
  for (let i = 0; i < 8; i++) {
    audio.currentTime = t
    player.correct()
  }
}

let audio: FakeAudio
let delay: number
let blocked: number
let player: SyncPlayer

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
  audio = new FakeAudio()
  delay = 0
  blocked = 0
  player = new SyncPlayer({
    audio,
    serverNow: () => Date.now(),
    delayMs: () => delay,
    onBlocked: () => blocked++,
    settleMs: 0,
  })
})

afterEach(() => {
  player.destroy()
  vi.useRealTimers()
})

describe('SyncPlayer', () => {
  it('does not load a song that is still downloading', async () => {
    player.update(item(A, 'downloading'), { status: 'waiting', position: 0, at: T0 })
    await settle()
    expect(audio.src).toBe('')
    expect(audio.plays).toBe(0)
  })

  it('loads a ready song, waits for canplay, then starts on the shared start time', async () => {
    player.update(item(A), playing(0, T0 + 1_000))
    expect(audio.src).toBe(`/audio/${A}.m4a`)
    expect(audio.preservesPitch).toBe(true)
    audio.loaded()
    await vi.advanceTimersByTimeAsync(999)
    expect(audio.plays).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(audio.plays).toBe(1)
    expect(audio.paused).toBe(false)
    expect(audio.currentTime).toBe(0)
  })

  it('starts earlier by the device delay', async () => {
    delay = 200
    player.update(item(A), playing(0, T0 + 1_000))
    audio.loaded()
    await vi.advanceTimersByTimeAsync(800)
    expect(audio.plays).toBe(1)
  })

  it('joins mid-song at the shared position plus the device delay', async () => {
    delay = 150
    player.update(item(A), playing(10, T0 - 5_000))
    audio.loaded()
    await settle()
    expect(audio.currentTime).toBeCloseTo(15.15)
    expect(audio.paused).toBe(false)
  })

  it('pauses and parks at the paused position', async () => {
    player.update(item(A), playing(0, T0 - 1_000))
    audio.loaded()
    await settle()
    player.update(item(A), paused(42))
    expect(audio.paused).toBe(true)
    expect(audio.currentTime).toBe(42)
  })

  it('on a seek while playing, parks at the new position and restarts on the shared start time', async () => {
    player.update(item(A), playing(0, T0 - 1_000))
    audio.loaded()
    await settle()
    player.update(item(A), playing(30, T0 + 1_000))
    expect(audio.paused).toBe(true)
    expect(audio.currentTime).toBe(30)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(audio.paused).toBe(false)
    expect(audio.currentTime).toBe(30)
  })

  it('nudges the rate for small drift, creeps near the target, and seeks for large drift', async () => {
    player.update(item(A), playing(0, T0 - 10_000)) // the target is 10 s while the clock stands still
    audio.loaded()
    await settle()
    audio.currentTime = 10.1
    player.correct()
    expect(audio.playbackRate).toBe(0.98)
    expect(player.lastDrift).toBeCloseTo(0.1)
    holdAt(9.9)
    expect(audio.playbackRate).toBe(1.02)
    holdAt(10.01)
    expect(audio.playbackRate).toBe(1.002)
    audio.currentTime = 12
    player.correct()
    expect(audio.currentTime).toBe(10)
    expect(audio.playbackRate).toBe(1.002)
  })

  it('never sets the rate to exactly 1, where browsers switch their time-stretcher and click', async () => {
    player.update(item(A), playing(0, T0 - 10_000))
    audio.loaded()
    await settle()
    expect(audio.playbackRate).toBe(1.002)
    audio.currentTime = 10.1
    player.correct()
    expect(audio.playbackRate).toBe(0.98)
    holdAt(10)
    expect(audio.playbackRate).toBe(0.998)
    player.update(item(A), paused(10))
    expect(audio.playbackRate).toBe(0.998)
    player.update(item(A), playing(10, T0))
    await settle()
    expect(audio.paused).toBe(false)
    expect(audio.playbackRate).toBe(0.998)
  })

  it('acts on the drift averaged over 2 s, since Firefox reports currentTime up to 40 ms off', async () => {
    player.update(item(A), playing(0, T0 - 10_000))
    audio.loaded()
    await settle()
    holdAt(10)
    for (const t of [10.045, 9.965, 10.045, 9.965]) {
      audio.currentTime = t // each reading alone is outside the deadband
      player.correct()
      expect(audio.playbackRate).toBe(1.002)
    }
    holdAt(10.1)
    expect(audio.playbackRate).toBe(0.98)
  })

  it('runs the correction every 250 ms', async () => {
    player.update(item(A), playing(0, T0 - 10_000))
    audio.loaded()
    await settle()
    audio.currentTime = 50
    await vi.advanceTimersByTimeAsync(250)
    expect(audio.currentTime).toBeCloseTo(10.25)
  })

  it('reports blocked autoplay once and retries only on resume()', async () => {
    audio.playError = 'NotAllowedError'
    player.update(item(A), playing(0, T0 - 1_000))
    audio.loaded()
    await settle()
    expect(blocked).toBe(1)

    player.update(item(A), playing(5, T0 + 1_000)) // someone seeks while this device is blocked
    await vi.advanceTimersByTimeAsync(1_000)
    expect(audio.plays).toBe(1)

    audio.playError = null
    player.resume()
    await settle()
    expect(audio.plays).toBe(2)
    expect(audio.paused).toBe(false)
    expect(audio.currentTime).toBeCloseTo(5)
  })

  it('ignores states that change neither the song nor the playback', async () => {
    player.update(item(A), playing(0, T0 - 1_000))
    audio.loaded()
    await settle()
    player.update(item(A), playing(0, T0 - 1_000))
    expect(audio.plays).toBe(1)
    expect(audio.paused).toBe(false)
  })

  it('switches songs and waits for the new file to load', async () => {
    player.update(item(A), playing(0, T0 - 1_000))
    audio.loaded()
    await settle()
    player.update(item(B), playing(0, T0 + 1_000))
    expect(audio.src).toBe(`/audio/${B}.m4a`)
    expect(audio.paused).toBe(true)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(audio.plays).toBe(1) // still loading
    audio.loaded()
    await settle()
    expect(audio.plays).toBe(2)
    expect(audio.currentTime).toBeCloseTo(1) // loaded 1 s after the shared start
  })

  it('stops when the station goes idle', async () => {
    player.update(item(A), playing(0, T0 - 1_000))
    audio.loaded()
    await settle()
    player.update(null, paused(0))
    expect(audio.paused).toBe(true)
  })

  it('clears its timers on destroy', async () => {
    player.update(item(A), playing(0, T0 + 1_000))
    audio.loaded()
    player.destroy()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('SyncPlayer on iOS', () => {
  it('aligns on loadedmetadata alone and plays at the lead time on the target', async () => {
    player.update(item(A), playing(30, T0 + 1_000))
    expect(audio.loads).toBe(1)
    audio.metadataOnly()
    await vi.advanceTimersByTimeAsync(999)
    expect(audio.plays).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(audio.plays).toBe(1)
    expect(audio.paused).toBe(false)
    expect(audio.currentTime).toBe(30)
  })

  it('aligns without any event when the element already has metadata after load()', async () => {
    audio.metadataOnLoad = true
    player.update(item(A), playing(10, T0 - 5_000))
    await settle()
    expect(audio.plays).toBe(1)
    expect(audio.currentTime).toBeCloseTo(15)
  })
})

describe('SyncPlayer drift correction while buffering', () => {
  const drifted = async () => {
    player.update(item(A), playing(0, T0 - 10_000)) // the target is 10 s while the clock stands still
    audio.loaded()
    await settle()
    audio.currentTime = 12
    audio.playbackRate = 0.97
    audio.seeks = 0
  }

  it('leaves a seeking element alone', async () => {
    await drifted()
    audio.seeking = true
    player.correct()
    expect(audio.currentTime).toBe(12)
    expect(audio.playbackRate).toBe(0.97)
    expect(audio.seeks).toBe(0)
  })

  it('leaves an element without enough data alone', async () => {
    await drifted()
    audio.readyState = 2
    player.correct()
    expect(audio.currentTime).toBe(12)
    expect(audio.playbackRate).toBe(0.97)
    expect(audio.seeks).toBe(0)
  })

  it('seeks exactly once when the element is ready', async () => {
    await drifted()
    player.correct()
    player.correct()
    expect(audio.seeks).toBe(1)
    expect(audio.currentTime).toBe(10)
    expect(audio.playbackRate).toBe(0.998)
  })

  it('learns how late its seeks land and aims ahead, so it stops seeking', async () => {
    player.update(item(A), playing(0, T0 - 10_000))
    audio.loaded()
    await settle()
    audio.currentTime = 20
    player.correct() // seeks to 10, but a slow seek lets the target move on by 1.5 s
    expect(audio.currentTime).toBe(10)
    vi.setSystemTime(Date.now() + 1_500)
    player.correct() // landed 1.5 s behind: moves the lead halfway and aims at 11.5 + 0.75
    expect(player.leadS).toBeCloseTo(0.75)
    expect(audio.currentTime).toBeCloseTo(12.25)
    const seeks = audio.seeks
    vi.setSystemTime(Date.now() + 500)
    player.correct() // landed 0.25 s ahead: small enough to ease the rate instead of seeking
    expect(audio.seeks).toBe(seeks)
    expect(audio.playbackRate).toBe(0.95)
    expect(player.leadS).toBeCloseTo(0.625)
  })

  it('starts from the saved lead and reports what it learns', async () => {
    const learned: number[] = []
    player.destroy()
    player = new SyncPlayer({
      audio,
      serverNow: () => Date.now(),
      delayMs: () => delay,
      onBlocked: () => blocked++,
      settleMs: 0,
      seekLeadS: 0.5,
      onSeekLead: (s) => learned.push(s),
    })
    player.update(item(A), playing(0, T0 - 10_000))
    audio.loaded()
    await settle()
    audio.currentTime = 20
    player.correct()
    expect(audio.currentTime).toBeCloseTo(10.5) // aims ahead from the first seek
    vi.setSystemTime(Date.now() + 500)
    audio.currentTime = 10.4 // the target is now 10.5: landed 0.1 s behind
    player.correct()
    expect(learned).toHaveLength(1)
    expect(learned[0]).toBeCloseTo(0.55)
  })

  it('does not learn from a landing far off the target', async () => {
    player.update(item(A), playing(0, T0 - 10_000))
    audio.loaded()
    await settle()
    audio.currentTime = 20
    player.correct()
    vi.setSystemTime(Date.now() + 8_000) // a long stall, not seek latency
    player.correct()
    expect(audio.currentTime).toBeCloseTo(18)
  })

  it('forgets a pending landing when the station changes', async () => {
    player.update(item(A), playing(0, T0 - 10_000))
    audio.loaded()
    await settle()
    audio.currentTime = 20
    player.correct()
    player.update(item(A), playing(30, Date.now())) // someone seeked to 30 s
    await settle()
    audio.currentTime = 31.5
    player.correct() // a 1.5 s drift, but not from the correction seek
    expect(audio.currentTime).toBe(30)
  })
})

describe('SyncPlayer pauses from outside', () => {
  const playingAt10 = async () => {
    player.update(item(A), playing(0, T0 - 10_000))
    audio.loaded()
    await settle()
    expect(audio.paused).toBe(false)
  }

  it('shows the banner once when something else pauses the audio', async () => {
    await playingAt10()
    audio.pause() // a phone call, Siri or AirPods
    await settle()
    expect(blocked).toBe(1)
    audio.emit('pause')
    player.realign()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(blocked).toBe(1)
    expect(audio.plays).toBe(1)

    player.resume()
    await settle()
    expect(audio.plays).toBe(2)
    expect(audio.paused).toBe(false)
    expect(audio.currentTime).toBeCloseTo(11)
  })

  it('does not show the banner when it changes the song', async () => {
    await playingAt10()
    player.update(item(B), playing(0, T0 + 1_000))
    await settle()
    audio.loaded()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(audio.paused).toBe(false)
    expect(blocked).toBe(0)
  })

  it('does not show the banner when the station pauses', async () => {
    await playingAt10()
    player.update(item(A), paused(42))
    await settle()
    expect(audio.paused).toBe(true)
    expect(blocked).toBe(0)
  })

  it('does not show the banner while it waits out a lead-in', async () => {
    await playingAt10()
    player.update(item(A), playing(30, T0 + 1_000))
    await settle()
    expect(audio.paused).toBe(true)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(audio.paused).toBe(false)
    expect(blocked).toBe(0)
  })

  it('does not show the banner when the song ends', async () => {
    await playingAt10()
    audio.finish()
    await settle()
    expect(blocked).toBe(0)
  })

  it('realign() restarts an element paused from outside on the target', async () => {
    await playingAt10()
    await vi.advanceTimersByTimeAsync(5_000)
    audio.pause() // its pause event is still queued when the tab becomes visible
    player.realign()
    expect(audio.plays).toBe(2)
    expect(audio.paused).toBe(false)
    expect(audio.currentTime).toBeCloseTo(15 + player.startLeadS) // the frozen fake clock taught it a start lead
    await settle()
    expect(blocked).toBe(0)
  })

  it('realign() retries a play() that failed for a reason other than autoplay', async () => {
    audio.playError = 'NotSupportedError'
    player.update(item(A), playing(0, T0 - 10_000))
    audio.loaded()
    await settle()
    expect(audio.paused).toBe(true)
    expect(blocked).toBe(0)
    audio.playError = null
    player.realign()
    await settle()
    expect(audio.plays).toBe(2)
    expect(audio.paused).toBe(false)
    expect(audio.currentTime).toBeCloseTo(10)
  })

  it('realign() does not restart a song that ended before the server moved on', async () => {
    await playingAt10()
    audio.finish()
    await settle()
    player.realign()
    expect(audio.plays).toBe(1)
    expect(audio.paused).toBe(true)
  })

  it('realign() leaves a playing element alone', async () => {
    await playingAt10()
    audio.currentTime = 10.2
    audio.seeks = 0
    player.realign()
    expect(audio.currentTime).toBe(10.2)
    expect(audio.seeks).toBe(0)
    expect(audio.plays).toBe(1)
  })
})

describe('SyncPlayer resume()', () => {
  it('calls play() inside the tap even while a lead-in is pending', async () => {
    audio.playError = 'NotAllowedError'
    player.update(item(A), playing(0, T0 - 1_000))
    audio.loaded()
    await settle()
    expect(blocked).toBe(1)
    player.update(item(A), playing(5, T0 + 1_000))
    audio.playError = null

    player.resume()
    expect(audio.plays).toBe(2) // synchronously, before any timer runs
    expect(audio.paused).toBe(true) // paused again for the lead-in, now unlocked
    expect(audio.currentTime).toBe(5)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(audio.plays).toBe(3)
    expect(audio.paused).toBe(false)
    expect(audio.currentTime).toBe(5)
    expect(blocked).toBe(1)
  })

  it('does not replay the old file when the station has gone idle', async () => {
    player.update(item(A), playing(0, T0 - 1_000))
    audio.loaded()
    await settle()
    player.update(null, paused(0))
    player.resume()
    expect(audio.plays).toBe(1)
    expect(audio.paused).toBe(true)
  })
})

describe('SyncPlayer settling after a seek', () => {
  beforeEach(() => {
    player.destroy()
    player = new SyncPlayer({ audio, serverNow: () => Date.now(), delayMs: () => delay, onBlocked: () => blocked++, settleMs: 1_500 })
  })

  it('reports drift but does not correct while the element settles after starting', async () => {
    player.update(item(A), playing(0, T0 - 10_000))
    audio.loaded()
    await settle()
    audio.currentTime = 8.5 // iOS still shows the old time
    const seeks = audio.seeks
    player.correct()
    expect(audio.seeks).toBe(seeks)
    expect(player.lastDrift).toBeCloseTo(-1.5)
    vi.setSystemTime(Date.now() + 1_500)
    player.correct()
    expect(audio.seeks).toBe(seeks + 1)
  })

  it('measures where a seek landed only after it settles', async () => {
    player.update(item(A), playing(0, T0 - 10_000))
    audio.loaded()
    await settle()
    vi.setSystemTime(Date.now() + 1_500)
    audio.currentTime = 20
    player.correct() // seeks to 11.5
    vi.setSystemTime(Date.now() + 500)
    audio.currentTime = 11.5 // frozen: would look 0.5 s late
    let seeks = audio.seeks
    player.correct()
    expect(audio.seeks).toBe(seeks)
    vi.setSystemTime(Date.now() + 1_000)
    audio.currentTime = 13.1 // playing again, 0.1 s ahead after the jump
    seeks = audio.seeks
    player.correct()
    expect(audio.seeks).toBe(seeks) // small drift: nudge the rate, no seek
    expect(audio.playbackRate).toBe(0.98)
    expect(player.leadS).toBe(0) // an early landing never makes the lead negative
  })
})

describe('SyncPlayer starting with a learned lead', () => {
  it('starts ahead of the target by the start lead and writes the rate only when it changes', async () => {
    player.destroy()
    let rateWrites = 0
    const rated = audio as FakeAudio & { _rate?: number }
    Object.defineProperty(rated, 'playbackRate', {
      get: () => rated._rate ?? 1,
      set: (v: number) => {
        rated._rate = v
        rateWrites++
      },
    })
    player = new SyncPlayer({
      audio,
      serverNow: () => Date.now(),
      delayMs: () => delay,
      onBlocked: () => blocked++,
      settleMs: 0,
      startLeadS: 0.4,
    })
    player.update(item(A), playing(0, T0 - 10_000))
    audio.loaded()
    await settle()
    expect(audio.currentTime).toBeCloseTo(10.4)
    audio.currentTime = 9.9
    player.correct()
    player.correct()
    expect(audio.playbackRate).toBe(1.02)
    expect(rateWrites).toBe(2) // start() set the creep rate, and the second correction wanted the same rate
  })
})

describe('SyncPlayer on a device that loses time on every rate change', () => {
  let rateWrites: number

  beforeEach(() => {
    player.destroy()
    rateWrites = 0
    const rated = audio as FakeAudio & { _rate?: number }
    Object.defineProperty(rated, 'playbackRate', {
      get: () => rated._rate ?? 1,
      set: (v: number) => {
        rated._rate = v
        rateWrites++
      },
    })
    player = new SyncPlayer({
      audio,
      serverNow: () => Date.now(),
      delayMs: () => delay,
      onBlocked: () => blocked++,
      settleMs: 0,
      fixedRate: true,
    })
  })

  it('never writes the rate, through starts, drift, seeks and pauses', async () => {
    player.update(item(A), playing(0, T0 - 10_000))
    audio.loaded()
    await settle()
    holdAt(10.3)
    holdAt(9.7)
    player.update(item(A), paused(10))
    player.update(item(A), playing(10, T0))
    await settle()
    expect(audio.paused).toBe(false)
    expect(player.stats.seeks).toBeGreaterThan(0)
    expect(rateWrites).toBe(0)
    expect(player.stats.rateWrites).toBe(0)
    expect(audio.playbackRate).toBe(1)
  })

  it('seeks once the drift averaged over 2 s passes 50 ms', async () => {
    player.update(item(A), playing(0, T0 - 10_000)) // the target is 10 s while the clock stands still
    audio.loaded()
    await settle()
    holdAt(10.04)
    expect(player.stats.seeks).toBe(0)
    audio.currentTime = 10.1
    player.correct()
    expect(player.stats.seeks).toBe(0) // one reading moves the average only to 47.5 ms
    audio.currentTime = 10.5
    player.correct()
    expect(player.stats.seeks).toBe(1)
    expect(audio.currentTime).toBe(10)
  })
})

describe('SyncPlayer with a spare deck', () => {
  let spare: FakeAudio
  let downloads: string[]
  const A_SRC = `/audio/${A}.m4a`
  const B_SRC = `/audio/${B}.m4a`
  const C = 'ccccccccccc'
  // A plays from T0 - 190 s, so it ends at T0 + 10 s.
  const nearEnd = playing(0, T0 - 190_000)
  const endsAt = T0 + 10_000

  beforeEach(() => {
    player.destroy()
    spare = new FakeAudio()
    downloads = []
    player = new SyncPlayer({
      audio,
      spare,
      serverNow: () => Date.now(),
      delayMs: () => delay,
      onBlocked: () => blocked++,
      settleMs: 0,
      download: async (url) => {
        downloads.push(url)
        return { url: `blob:${url}`, release: () => {} }
      },
    })
  })

  const playingAWithBNext = async () => {
    player.update(item(A), nearEnd, [item(B)])
    await settle()
    audio.loaded()
    spare.loaded()
    await settle()
    expect(audio.paused).toBe(false)
  }

  it('downloads the next song and loads it into the spare while the current one plays', async () => {
    await playingAWithBNext()
    expect(downloads).toEqual([A_SRC, B_SRC])
    expect(spare.src).toBe(`blob:${B_SRC}`)
    expect(spare.paused).toBe(true)
    expect(player.nextReady).toBe(true)
  })

  it('switches to the spare exactly at the boundary, without waiting for the server', async () => {
    await playingAWithBNext()
    await vi.advanceTimersByTimeAsync(10_000 - 500) // the handoff, 500 ms early
    expect(audio.paused).toBe(false) // the old song plays out its last moment
    expect(spare.paused).toBe(true)
    await vi.advanceTimersByTimeAsync(500)
    expect(Date.now()).toBe(endsAt)
    expect(spare.paused).toBe(false)
    expect(spare.currentTime).toBe(0) // the very start of the song
    expect(audio.paused).toBe(true) // stopped as the new song started: no gap, no overlap
    expect(player.stats.handoffs).toBe(1)
    expect(spare.loads).toBe(1) // it never loaded at the change
  })

  it('changes nothing when the server confirms the switch', async () => {
    await playingAWithBNext()
    await vi.advanceTimersByTimeAsync(10_000)
    const before = { plays: spare.plays, seeks: spare.seeks, loads: spare.loads }
    player.update(item(B), playing(0, endsAt), []) // the server's tick, a moment later
    await settle()
    expect({ plays: spare.plays, seeks: spare.seeks, loads: spare.loads }).toEqual(before)
    expect(spare.paused).toBe(false)
  })

  it('loads the song after next into the freed deck', async () => {
    player.update(item(A), nearEnd, [item(B), item(C)])
    await settle()
    audio.loaded()
    spare.loaded()
    await settle()
    await vi.advanceTimersByTimeAsync(10_000)
    await settle()
    expect(audio.src).toBe(`blob:/audio/${C}.m4a`)
    expect(audio.paused).toBe(true)
  })

  it('does not switch ahead when the next song is still downloading on the server', async () => {
    player.update(item(A), nearEnd, [item(B, 'downloading')])
    await settle()
    audio.loaded()
    await settle()
    await vi.advanceTimersByTimeAsync(11_000)
    expect(player.stats.handoffs).toBe(0)
    expect(spare.plays).toBe(0)
  })

  it('switches to the spare on a skip as well, without loading', async () => {
    await playingAWithBNext()
    player.update(item(B), playing(0, Date.now() + 1_000), []) // someone pressed skip
    await vi.advanceTimersByTimeAsync(1_000)
    expect(spare.paused).toBe(false)
    expect(audio.paused).toBe(true)
    expect(spare.loads).toBe(1)
  })

  it('stops both decks when the station pauses during a handoff', async () => {
    await playingAWithBNext()
    await vi.advanceTimersByTimeAsync(10_000 - 500)
    player.update(item(B), paused(0), [])
    expect(audio.paused).toBe(true)
    expect(spare.paused).toBe(true)
  })

  it('ignores pause events from the spare', async () => {
    await playingAWithBNext()
    spare.emit('pause')
    await settle()
    expect(blocked).toBe(0)
  })

  it('unlocks the spare inside the resume tap without leaving it playing', async () => {
    await playingAWithBNext()
    const plays = spare.plays
    player.resume()
    expect(spare.plays).toBe(plays + 1)
    expect(spare.paused).toBe(true)
  })
})

describe('SyncPlayer start lead', () => {
  let learned: number[]
  const make = (startLeadS: number, spare?: FakeAudio) => {
    player.destroy()
    learned = []
    player = new SyncPlayer({
      audio,
      spare,
      serverNow: () => Date.now(),
      delayMs: () => delay,
      onBlocked: () => blocked++,
      settleMs: 1_500,
      startLeadS,
      onStartLead: (s) => learned.push(s),
    })
  }

  it('calls play() early by the start lead, parked at the start position', async () => {
    make(0.5)
    player.update(item(A), playing(0, T0 + 1_000)) // the station starts in 1 s
    audio.loaded()
    await settle()
    expect(audio.paused).toBe(true)
    await vi.advanceTimersByTimeAsync(499)
    expect(audio.paused).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(audio.paused).toBe(false) // 500 ms before the start time
    expect(audio.currentTime).toBeCloseTo(0) // nothing of the song is skipped
  })

  it('learns the start lead from where a start landed, apart from the seek lead', async () => {
    make(0)
    player.update(item(A), playing(0, T0 + 1_000))
    audio.loaded()
    await settle()
    await vi.advanceTimersByTimeAsync(1_000) // play() now; the fake clock stands still like a slow start
    vi.setSystemTime(Date.now() + 1_500)
    audio.currentTime = 1.0 // the media clock moved 1.0 s in 1.5 s: it started 0.5 s late
    player.correct()
    expect(learned).toHaveLength(1)
    expect(learned[0]).toBeCloseTo(0.25) // halfway to 0.5 s
    expect(player.startLeadS).toBeCloseTo(0.25)
    expect(player.leadS).toBe(0)
  })

  it('on a song change, starts the next song early and stops the old one exactly at the boundary', async () => {
    const spare = new FakeAudio()
    make(0.3, spare)
    player.update(item(A), playing(0, T0 - 190_000), [item(B)]) // A ends at T0 + 10 s
    audio.loaded()
    spare.loaded()
    await settle()
    await vi.advanceTimersByTimeAsync(10_000 - 300)
    expect(spare.paused).toBe(false) // play() 300 ms early, at the very start of B
    expect(spare.currentTime).toBe(0)
    expect(audio.paused).toBe(false) // A still sounds until the boundary
    await vi.advanceTimersByTimeAsync(299)
    expect(audio.paused).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(audio.paused).toBe(true) // stopped exactly at the boundary
  })
})

