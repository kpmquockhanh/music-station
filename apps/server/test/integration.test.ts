import { randomUUID } from 'node:crypto'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { io as connect, type Socket } from 'socket.io-client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Ack, StationState, VideoInfo } from '@music-station/shared'
import { createApp, type App, type AppDeps } from '../src/app'
import type { Config } from '../src/config'
import { loadState } from '../src/persist'

const ID = 'dQw4w9WgXcQ'
const FIXTURE = join(import.meta.dirname, 'fixtures', 'tone.m4a')

let dataDir: string
let clock: number
let app: App | undefined
let url: string
const sockets: Socket[] = []

const config = (): Config => ({
  port: 0,
  dataDir,
  webDir: null,
  ytdlpBin: 'unused',
  syncLog: false,
  cacheMaxBytes: 1e9,
  maxDurationSec: 3_600,
  idlePauseMs: 0,
})

const youtube = {
  search: async () => [],
  related: async () => [],
  getInfo: async (videoId: string): Promise<VideoInfo> => ({
    videoId,
    title: 'Tone',
    channel: 'Test',
    duration: 100,
    thumbnail: '',
  }),
  download: async (_videoId: string, dest: string) => {
    await copyFile(FIXTURE, dest)
  },
}

async function start(extra: Partial<AppDeps> = {}) {
  app = await createApp({ config: config(), youtube, now: () => clock, log: () => {}, graceMs: 100, ...extra })
  await app.listen()
  url = `http://127.0.0.1:${(app.http.server.address() as AddressInfo).port}`
}

function client(): Socket {
  const s = connect(url, { transports: ['websocket'], forceNew: true, reconnection: false })
  sockets.push(s)
  return s
}

const send = (s: Socket, event: string, payload?: unknown): Promise<Ack> =>
  s.timeout(3_000).emitWithAck(event, payload ?? {})

function waitFor<T>(s: Socket, event: string, match: (v: T) => boolean): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      s.off(event, on)
      reject(new Error(`timed out waiting for ${event}`))
    }, 3_000)
    const on = (v: T) => {
      if (!match(v)) return
      clearTimeout(timer)
      s.off(event, on)
      resolve(v)
    }
    s.on(event, on)
  })
}

const playingReady = (st: StationState) => st.current?.status === 'ready' && st.playback.status === 'playing'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'ms-int-'))
  clock = 1_000_000
  await start()
})

afterEach(async () => {
  for (const s of sockets.splice(0)) s.disconnect()
  await app?.close()
  app = undefined
  await rm(dataDir, { recursive: true, force: true })
})

describe('music station server', () => {
  it('gives two listeners identical state after join, add, pause and play', async () => {
    const a = client()
    const b = client()
    expect(await send(a, 'join', { clientId: randomUUID(), nickname: 'Minh' })).toEqual({ ok: true })
    expect(await send(b, 'join', { clientId: randomUUID(), nickname: 'An' })).toEqual({ ok: true })

    const aReady = waitFor<StationState>(a, 'state', playingReady)
    const bReady = waitFor<StationState>(b, 'state', playingReady)
    const notice = waitFor<{ text: string }>(b, 'activity', (x) => x.text.includes('added'))
    expect(await send(a, 'queue:add', { input: `https://youtu.be/${ID}` })).toEqual({ ok: true })

    const [sa, sb] = await Promise.all([aReady, bReady])
    expect(sa).toEqual(sb)
    expect(sa.current).toMatchObject({ videoId: ID, title: 'Tone', addedBy: 'Minh' })
    expect(sa.listeners.map((l) => l.nickname).sort()).toEqual(['An', 'Minh'])
    expect((await notice).text).toBe('Minh added Tone')

    const paused = (st: StationState) => st.playback.status === 'paused'
    const aPaused = waitFor<StationState>(a, 'state', paused)
    expect(await send(b, 'player:pause')).toEqual({ ok: true })
    expect(await aPaused).toMatchObject({ playback: { status: 'paused' } })

    clock += 600 // past the 500 ms action limit for socket a
    const aPlaying = waitFor<StationState>(a, 'state', playingReady)
    const bPlaying = waitFor<StationState>(b, 'state', playingReady)
    expect(await send(a, 'player:play')).toEqual({ ok: true })
    const [pa, pb] = await Promise.all([aPlaying, bPlaying])
    expect(pa.playback).toEqual(pb.playback)
    expect(pa.playback.at).toBe(clock + 1_000)
  })

  it('serves the downloaded file with Range support', async () => {
    const a = client()
    await send(a, 'join', { clientId: randomUUID(), nickname: 'Minh' })
    const ready = waitFor<StationState>(a, 'state', playingReady)
    await send(a, 'queue:add', { input: ID })
    await ready
    const res = await fetch(`${url}/audio/${ID}.m4a`, { headers: { Range: 'bytes=0-99' } })
    expect(res.status).toBe(206)
    expect((await res.arrayBuffer()).byteLength).toBe(100)
  })

  it('autoplay queues a similar song and remembers the setting across restarts', async () => {
    const NEXT = 'znDgBy2mHbc'
    await app!.close()
    const related = async (videoId: string) =>
      [videoId, NEXT].map((id) => ({ videoId: id, title: id, channel: '', duration: 100, thumbnail: '' }))
    await start({ saveDelayMs: 60_000, youtube: { ...youtube, related } })
    const a = client()
    await send(a, 'join', { clientId: randomUUID(), nickname: 'Minh' })
    const ready = waitFor<StationState>(a, 'state', playingReady)
    await send(a, 'queue:add', { input: ID })
    await ready

    const suggested = waitFor<StationState>(a, 'state', (st) => st.queue.length === 1)
    clock += 600
    expect(await send(a, 'station:autoplay', { enabled: true })).toEqual({ ok: true })
    expect((await suggested).queue[0]).toMatchObject({ videoId: NEXT, addedBy: 'Autoplay' })

    await app!.close() // saves
    expect(await loadState(join(dataDir, 'station.json'))).toMatchObject({ autoplay: true, history: [ID] })
    app = undefined
  })

  it('answers time pings with the server clock', async () => {
    const a = client()
    expect(await a.timeout(3_000).emitWithAck('time:ping', 123)).toBe(clock)
  })

  it('rejects invalid payloads, unjoined sockets and rapid actions', async () => {
    const a = client()
    expect(await send(a, 'player:play')).toEqual({ ok: false, error: 'Join the station first' })
    expect(await send(a, 'join', { clientId: 'nope', nickname: '' })).toMatchObject({ ok: false })
    await send(a, 'join', { clientId: randomUUID(), nickname: 'Minh' })
    expect(await send(a, 'queue:move', { itemId: 'x', toIndex: -1 })).toEqual({ ok: false, error: 'Invalid request' })
    expect(await send(a, 'player:play')).toEqual({ ok: false, error: 'Slow down a little' })
  })

  it('keeps a listener with two tabs until both are gone, after the grace period', async () => {
    const watcher = client()
    await send(watcher, 'join', { clientId: randomUUID(), nickname: 'Watcher' })
    const id = randomUUID()
    const tab1 = client()
    const tab2 = client()
    const two = waitFor<StationState>(watcher, 'state', (st) => st.listeners.length === 2)
    await send(tab1, 'join', { clientId: id, nickname: 'Minh' })
    await two
    await send(tab2, 'join', { clientId: id, nickname: 'Minh' })
    expect(app!.service.state().listeners.filter((l) => l.id === id)).toHaveLength(1)

    tab2.disconnect()
    await sleep(250) // longer than graceMs (100)
    expect(app!.service.state().listeners.some((l) => l.id === id)).toBe(true)

    const gone = waitFor<StationState>(watcher, 'state', (st) => !st.listeners.some((l) => l.id === id))
    tab1.disconnect()
    await gone
  })

  it('restores the queue paused near the playing position after a restart', async () => {
    const a = client()
    await send(a, 'join', { clientId: randomUUID(), nickname: 'Minh' })
    const ready = waitFor<StationState>(a, 'state', playingReady)
    await send(a, 'queue:add', { input: ID })
    await ready
    clock += 1_000 + 30_000 // lead-in, then 30 s of playback
    a.disconnect()
    await app!.close()

    clock += 60_000
    await start()
    const st = app!.service.state()
    expect(st.current).toMatchObject({ videoId: ID, status: 'ready' })
    expect(st.playback.status).toBe('paused')
    expect(st.playback.position).toBeCloseTo(30)
  })

  it('keeps saving while playing, so a crash loses at most a few seconds', async () => {
    await app!.close()
    await start({ saveDelayMs: 10, playingSaveMs: 50 })
    const a = client()
    await send(a, 'join', { clientId: randomUUID(), nickname: 'Minh' })
    const ready = waitFor<StationState>(a, 'state', playingReady)
    await send(a, 'queue:add', { input: ID })
    await ready
    clock += 20_000 // nothing changes state now; only the periodic save writes
    await sleep(300)
    const saved = await loadState(join(dataDir, 'station.json'))
    expect(saved?.savedAt).toBe(clock)
    expect(saved?.playback.status).toBe('playing')
  })

  it('saves the station on close while a response is still open', async () => {
    await app!.close()
    await rm(join(dataDir, 'station.json')) // only the final save may write it now
    let reached!: () => void
    const searching = new Promise<void>((r) => (reached = r))
    const search = () => {
      reached()
      return new Promise<never>(() => {}) // like an /audio stream to a slow phone
    }
    await start({ saveDelayMs: 60_000, youtube: { ...youtube, search } })
    const a = client()
    await send(a, 'join', { clientId: randomUUID(), nickname: 'Minh' })
    const ready = waitFor<StationState>(a, 'state', playingReady)
    await send(a, 'queue:add', { input: ID })
    await ready
    const aborter = new AbortController()
    const open = fetch(`${url}/api/search?q=slow`, { signal: aborter.signal }).catch(() => {})
    await searching

    const closing = app!.close()
    app = undefined
    let saved = null
    for (let i = 0; i < 20 && !saved; i++) {
      await sleep(25)
      saved = await loadState(join(dataDir, 'station.json'))
    }
    aborter.abort()
    await open
    await closing
    expect(saved?.current).toMatchObject({ videoId: ID })
  })
})
