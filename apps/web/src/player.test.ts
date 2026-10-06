import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Playback, QueueItem } from '@music-station/shared'
import { SyncPlayer, type AudioLike } from './player'

class FakeAudio implements AudioLike {
  src = ''
  currentTime = 0
  playbackRate = 1
  preservesPitch = false
  paused = true
  blockPlay = false
  plays = 0
  private handlers = new Set<() => void>()

  play(): Promise<void> {
    this.plays++
    if (this.blockPlay) return Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' }))
    this.paused = false
    return Promise.resolve()
  }
  pause(): void {
    this.paused = true
  }
  addEventListener(_type: 'canplay', fn: () => void): void {
    this.handlers.add(fn)
  }
  removeEventListener(_type: 'canplay', fn: () => void): void {
    this.handlers.delete(fn)
  }
  /** Simulates the browser finishing loading the file. */
  loaded(): void {
    for (const fn of this.handlers) fn()
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

  it('nudges the rate for small drift and seeks for large drift', async () => {
    player.update(item(A), playing(0, T0 - 10_000)) // the target is 10 s while the clock stands still
    audio.loaded()
    await settle()
    audio.currentTime = 10.1
    player.correct()
    expect(audio.playbackRate).toBe(0.97)
    expect(player.lastDrift).toBeCloseTo(0.1)
    audio.currentTime = 9.9
    player.correct()
    expect(audio.playbackRate).toBe(1.03)
    audio.currentTime = 10.01
    player.correct()
    expect(audio.playbackRate).toBe(1)
    audio.currentTime = 12
    player.correct()
    expect(audio.currentTime).toBe(10)
    expect(audio.playbackRate).toBe(1)
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
    audio.blockPlay = true
    player.update(item(A), playing(0, T0 - 1_000))
    audio.loaded()
    await settle()
    expect(blocked).toBe(1)

    player.update(item(A), playing(5, T0 + 1_000)) // someone seeks while this device is blocked
    await vi.advanceTimersByTimeAsync(1_000)
    expect(audio.plays).toBe(1)

    audio.blockPlay = false
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
