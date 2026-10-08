import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_QUEUE, type SearchResult, type VideoInfo } from '@music-station/shared'
import { Station, StationError } from './station'
import { AUTOPLAY_RETRY_MS, StationService, type CacheLike } from './service'
import type { Persisted } from './persist'

const A = 'aaaaaaaaaaa'
const B = 'bbbbbbbbbbb'
const flush = () => new Promise((r) => setImmediate(r))

afterEach(() => {
  vi.restoreAllMocks()
})

function setup(
  opts: {
    cached?: string[]
    getInfo?: (id: string) => Promise<VideoInfo>
    related?: (id: string) => Promise<SearchResult[]>
    idlePauseMs?: number
  } = {},
) {
  const files = new Set(opts.cached ?? [])
  const pending: { id: string; resolve: () => void; reject: (e: Error) => void }[] = []
  const cache = {
    ensure: vi.fn(
      (id: string) =>
        new Promise<string>((res, rej) =>
          pending.push({
            id,
            resolve: () => {
              files.add(id)
              res(`/cache/${id}.m4a`)
            },
            reject: rej,
          }),
        ),
    ),
    has: (id: string) => files.has(id),
    touch: vi.fn(),
    evict: vi.fn(() => []),
  } satisfies CacheLike
  let t = 0
  const activity: string[] = []
  const logs: string[] = []
  const onChange = vi.fn()
  const getInfo = vi.fn(
    opts.getInfo ??
      (async (id: string): Promise<VideoInfo> => ({
        videoId: id,
        title: `Song ${id[0]!.toUpperCase()}`,
        channel: 'Ch',
        duration: 100,
        thumbnail: 't',
      })),
  )
  const related = vi.fn(opts.related ?? (async (): Promise<SearchResult[]> => []))
  const station = new Station()
  const service = new StationService({
    station,
    cache,
    getInfo,
    related,
    now: () => t,
    onChange,
    onActivity: (text) => activity.push(text),
    log: (msg) => logs.push(msg),
    idlePauseMs: opts.idlePauseMs,
  })
  service.join('l1', 'Minh')
  activity.length = 0
  return {
    service,
    station,
    cache,
    pending,
    files,
    activity,
    logs,
    onChange,
    getInfo,
    related,
    setTime: (v: number) => (t = v),
  }
}

const info = (id: string): VideoInfo => ({ videoId: id, title: `Song ${id}`, channel: 'Ch', duration: 100, thumbnail: 't' })

/** A getInfo whose calls wait until the test resolves them, counting how many run at once. */
function deferredInfo() {
  const calls: { id: string; resolve: () => void }[] = []
  let running = 0
  let peak = 0
  const getInfo = (id: string) =>
    new Promise<VideoInfo>((resolve) => {
      peak = Math.max(peak, ++running)
      calls.push({
        id,
        resolve: () => {
          running--
          resolve(info(id))
        },
      })
    })
  return { calls, getInfo, peak: () => peak }
}

describe('metadata lookups', () => {
  it('runs at most two getInfo calls at once and queues every song', async () => {
    const ids = ['aaaaaaaaaa1', 'aaaaaaaaaa2', 'aaaaaaaaaa3', 'aaaaaaaaaa4', 'aaaaaaaaaa5', 'aaaaaaaaaa6']
    const d = deferredInfo()
    const s = setup({ getInfo: d.getInfo })
    const adds = ids.map((id) => s.service.add('l1', id))
    for (let i = 0; i < ids.length; i++) {
      await flush()
      d.calls[i]!.resolve()
    }
    await Promise.all(adds)
    expect(d.peak()).toBeLessThanOrEqual(2)
    const st = s.service.state()
    expect([st.current!, ...st.queue].map((q) => q.videoId).sort()).toEqual(ids)
  })

  it('looks up the same video once when it is added twice at the same time', async () => {
    const d = deferredInfo()
    const s = setup({ getInfo: d.getInfo })
    const adds = [s.service.add('l1', A), s.service.add('l1', A)]
    await flush()
    expect(s.getInfo).toHaveBeenCalledOnce()
    d.calls[0]!.resolve()
    await Promise.all(adds)
    const st = s.service.state()
    expect([st.current!, ...st.queue].map((q) => q.videoId)).toEqual([A, A])
  })

  it('rejects an add to a full queue without calling getInfo', async () => {
    const s = setup()
    for (let i = 0; i <= MAX_QUEUE; i++) {
      s.station.add({ ...info(B), id: `q${i}`, videoId: B, addedBy: 'Minh', status: 'ready' }, 0)
    }
    await expect(s.service.add('l1', A)).rejects.toThrow(new StationError('The queue is full'))
    expect(s.getInfo).not.toHaveBeenCalled()
  })
})

describe('add', () => {
  it('validates the video, queues it as downloading and starts the download', async () => {
    const s = setup()
    const item = await s.service.add('l1', `https://youtu.be/${A}`)
    expect(s.getInfo).toHaveBeenCalledWith(A)
    expect(item).toMatchObject({ videoId: A, title: 'Song A', addedBy: 'Minh', status: 'downloading' })
    expect(s.service.state().playback.status).toBe('waiting')
    expect(s.cache.ensure).toHaveBeenCalledWith(A)
    expect(s.activity).toEqual(['Minh added Song A'])
    expect(s.onChange).toHaveBeenCalled()
  })

  it('starts playing when the download finishes, then evicts', async () => {
    const s = setup()
    await s.service.add('l1', A)
    s.setTime(5_000)
    s.pending[0]!.resolve()
    await flush()
    const st = s.service.state()
    expect(st.current!.status).toBe('ready')
    expect(st.playback).toEqual({ status: 'playing', position: 0, at: 6_000 })
    expect(s.cache.evict).toHaveBeenCalledWith(new Set([A]))
  })

  it('plays a cached video without downloading', async () => {
    const s = setup({ cached: [A] })
    await s.service.add('l1', A)
    expect(s.cache.ensure).not.toHaveBeenCalled()
    expect(s.service.state().playback.status).toBe('playing')
  })

  it('rejects input that is not a video', async () => {
    const s = setup()
    await expect(s.service.add('l1', 'hello world')).rejects.toThrow(StationError)
    expect(s.getInfo).not.toHaveBeenCalled()
  })

  it('passes getInfo rejections through as StationError', async () => {
    const s = setup({
      getInfo: async () => {
        throw new Error('Livestreams are not supported')
      },
    })
    await expect(s.service.add('l1', A)).rejects.toThrow(new StationError('Livestreams are not supported'))
    expect(s.service.state().current).toBeNull()
  })

  it('requires joining first', async () => {
    const s = setup()
    await expect(s.service.add('stranger', A)).rejects.toThrow(/join/i)
    expect(() => s.service.play('stranger')).toThrow(/join/i)
  })
})

describe('download failures', () => {
  it('retries once and succeeds', async () => {
    const s = setup()
    await s.service.add('l1', A)
    s.pending[0]!.reject(new Error('flaky'))
    await flush()
    expect(s.cache.ensure).toHaveBeenCalledTimes(2)
    s.pending[1]!.resolve()
    await flush()
    expect(s.service.state().current!.status).toBe('ready')
    expect(s.activity).toEqual(['Minh added Song A'])
  })

  it('fails after the retry, advances, and announces it', async () => {
    const s = setup({ cached: [B] })
    await s.service.add('l1', A)
    await s.service.add('l1', B)
    s.pending[0]!.reject(new Error('flaky'))
    await flush()
    s.pending[1]!.reject(new Error('Video unavailable'))
    await flush()
    const st = s.service.state()
    expect(st.current!.videoId).toBe(B)
    expect(s.activity.at(-1)).toBe("Couldn't download Song A: Video unavailable")
  })

  it('keeps a downloaded song ready when evicting old files fails', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const s = setup()
    s.cache.evict.mockImplementation(() => {
      throw new Error('EACCES')
    })
    await s.service.add('l1', A)
    s.pending[0]!.resolve()
    await flush()
    expect(s.service.state().current!.status).toBe('ready')
    expect(s.service.state().playback.status).toBe('playing')
    expect(s.activity).toEqual(['Minh added Song A'])
    expect(s.logs.filter((l) => l.includes('failed'))).toEqual([])
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('EACCES'))
  })

  it('leaves no unhandled rejection when onChange throws after a download', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const s = setup()
      await s.service.add('l1', A)
      s.onChange.mockImplementation(() => {
        throw new Error('broadcast failed')
      })
      s.pending[0]!.resolve()
      await flush()
      await flush()
      expect(unhandled).not.toHaveBeenCalled()
      expect(errors).toHaveBeenCalledWith(expect.stringContaining('broadcast failed'))
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })
})

describe('the same video twice', () => {
  it('downloads once and readies every copy', async () => {
    const s = setup()
    await s.service.add('l1', A)
    await s.service.add('l1', A)
    expect(s.cache.ensure).toHaveBeenCalledTimes(1)
    s.pending[0]!.resolve()
    await flush()
    const st = s.service.state()
    expect(st.current!.status).toBe('ready')
    expect(st.queue[0]!.status).toBe('ready')
  })

  it('fails every copy with a single notice', async () => {
    const s = setup()
    await s.service.add('l1', B)
    s.pending[0]!.resolve()
    await flush()
    await s.service.add('l1', A)
    await s.service.add('l1', A)
    s.activity.length = 0
    s.pending[1]!.reject(new Error('x'))
    await flush()
    s.pending[2]!.reject(new Error('gone'))
    await flush()
    expect(s.service.state().queue.map((q) => q.status)).toEqual(['failed', 'failed'])
    expect(s.activity).toEqual(["Couldn't download Song A: gone"])
  })
})

describe('controls and notices', () => {
  it('announces each control action with the nickname', async () => {
    const s = setup({ cached: [A, B] })
    await s.service.add('l1', A)
    const b = await s.service.add('l1', B)
    const c = await s.service.add('l1', A)
    s.activity.length = 0
    s.setTime(10_000)
    s.service.pause('l1')
    s.service.seek('l1', 75)
    s.service.play('l1')
    s.service.move('l1', c.id, 0)
    s.service.remove('l1', b.id)
    s.service.skip('l1')
    expect(s.activity).toEqual([
      'Minh paused',
      'Minh jumped to 1:15',
      'Minh pressed play',
      'Minh moved Song A',
      'Minh removed Song B',
      'Minh skipped Song A',
    ])
  })

  it('touches the file of a song when it becomes current', async () => {
    const s = setup({ cached: [A, B] })
    await s.service.add('l1', A)
    await s.service.add('l1', B)
    s.cache.touch.mockClear()
    s.service.skip('l1')
    expect(s.cache.touch).toHaveBeenCalledWith(B)
  })

  it('surfaces station errors', () => {
    const s = setup()
    expect(() => s.service.play('l1')).toThrow(StationError)
  })
})

describe('listeners', () => {
  it('announces a join once and a leave', () => {
    const s = setup()
    s.service.join('l2', 'An')
    s.service.join('l2', 'An')
    s.service.leave('l2')
    s.service.leave('l2')
    expect(s.activity).toEqual(['An joined', 'An left'])
  })
})

describe('pause with nobody listening', () => {
  const IDLE = 5 * 60_000

  it('pauses for everyone once nobody has been joined for the idle time', async () => {
    const s = setup({ cached: [A], idlePauseMs: IDLE })
    s.station.add({ ...info(A), id: 'long', duration: 3_600, addedBy: 'Minh', status: 'ready' }, 0) // plays from 1 s
    s.setTime(10_000)
    s.service.leave('l1')
    s.service.tick() // the station is empty from here
    s.activity.length = 0
    s.setTime(10_000 + IDLE - 1)
    s.service.tick()
    expect(s.service.state().playback.status).toBe('playing')
    s.setTime(10_000 + IDLE)
    s.service.tick()
    expect(s.service.state().playback).toEqual({ status: 'paused', position: 309, at: 10_000 + IDLE })
    expect(s.activity).toEqual(['Paused after 5 minutes with nobody listening'])
  })

  it('stays paused when someone joins, and tells them why until someone plays', async () => {
    const s = setup({ cached: [A], idlePauseMs: 60_000 })
    s.station.add({ ...info(A), id: 'long', duration: 3_600, addedBy: 'Minh', status: 'ready' }, 0)
    s.service.leave('l1')
    s.service.tick()
    s.setTime(60_000)
    s.service.tick()
    s.activity.length = 0
    s.service.join('l2', 'An')
    expect(s.service.state().playback.status).toBe('paused')
    expect(s.activity).toEqual(['An joined', 'Paused after 1 minute with nobody listening'])
    s.service.play('l2')
    s.service.join('l3', 'Lan')
    expect(s.activity.at(-1)).toBe('Lan joined')
  })

  it('restarts the wait when someone joins and leaves again', async () => {
    const s = setup({ cached: [A], idlePauseMs: 60_000 })
    s.station.add({ ...info(A), id: 'long', duration: 3_600, addedBy: 'Minh', status: 'ready' }, 0)
    s.service.leave('l1')
    s.service.tick()
    s.setTime(50_000)
    s.service.join('l2', 'An')
    s.service.leave('l2')
    s.service.tick()
    s.setTime(100_000)
    s.service.tick()
    expect(s.service.state().playback.status).toBe('playing')
    s.setTime(110_000)
    s.service.tick()
    expect(s.service.state().playback.status).toBe('paused')
  })

  it('also stops a song that is still downloading, so it does not start for nobody', async () => {
    const s = setup({ idlePauseMs: 60_000 })
    await s.service.add('l1', A)
    expect(s.service.state().playback.status).toBe('waiting')
    s.service.leave('l1')
    s.service.tick()
    s.setTime(60_000)
    s.service.tick()
    s.pending[0]!.resolve()
    await flush()
    expect(s.service.state().playback.status).toBe('paused')
  })

  it('does nothing while someone is joined, or with the idle pause off', async () => {
    const on = setup({ cached: [A], idlePauseMs: 60_000 })
    on.station.add({ ...info(A), id: 'long', duration: 3_600, addedBy: 'Minh', status: 'ready' }, 0)
    on.setTime(600_000)
    on.service.tick()
    expect(on.service.state().playback.status).toBe('playing')

    const off = setup({ cached: [A] })
    off.station.add({ ...info(A), id: 'long', duration: 3_600, addedBy: 'Minh', status: 'ready' }, 0)
    off.service.leave('l1')
    off.service.tick()
    off.setTime(600_000)
    off.service.tick()
    expect(off.service.state().playback.status).toBe('playing')
  })
})

describe('restore and tick', () => {
  it('restarts downloads for items that are not cached', () => {
    const s = setup({ cached: [B] })
    const saved: Persisted = {
      version: 1,
      savedAt: 0,
      current: {
        id: 'c1',
        videoId: A,
        title: 'Song A',
        channel: 'Ch',
        duration: 100,
        thumbnail: 't',
        addedBy: 'Minh',
        status: 'ready',
      },
      queue: [
        {
          id: 'q1',
          videoId: B,
          title: 'Song B',
          channel: 'Ch',
          duration: 100,
          thumbnail: 't',
          addedBy: 'Minh',
          status: 'downloading',
        },
      ],
      playback: { status: 'playing', position: 0, at: 0 },
      autoplay: false,
      history: [],
    }
    s.service.restore(saved)
    expect(s.cache.ensure).toHaveBeenCalledTimes(1)
    expect(s.cache.ensure).toHaveBeenCalledWith(A)
    expect(s.service.state().queue[0]!.status).toBe('ready')
    expect(s.service.state().playback.status).toBe('paused')
  })

  it('restore(null) leaves an empty station', () => {
    const s = setup()
    s.service.restore(null)
    expect(s.service.state().current).toBeNull()
  })

  it('tick notifies only when the station advanced', async () => {
    const s = setup({ cached: [A] })
    await s.service.add('l1', A) // plays 1000..101000
    s.onChange.mockClear()
    s.setTime(50_000)
    s.service.tick()
    expect(s.onChange).not.toHaveBeenCalled()
    s.setTime(101_000)
    s.service.tick()
    expect(s.onChange).toHaveBeenCalledOnce()
    expect(s.service.state().current).toBeNull()
  })

  it('persisted() stamps savedAt and reports isPlaying', async () => {
    const s = setup({ cached: [A] })
    await s.service.add('l1', A)
    s.setTime(1_234)
    expect(s.service.persisted()).toMatchObject({ version: 1, savedAt: 1_234 })
    expect(s.service.isPlaying()).toBe(true)
  })
})

describe('autoplay', () => {
  const C = 'ccccccccccc'
  const result = (id: string): SearchResult => ({ videoId: id, title: `Song ${id}`, channel: 'Ch', duration: 100, thumbnail: 't' })
  const settle = async () => {
    for (let i = 0; i < 10; i++) await flush()
  }
  const queued = (s: ReturnType<typeof setup>) => s.service.state().queue.map((q) => [q.videoId, q.addedBy])

  it('adds a similar song when the queue runs out', async () => {
    const s = setup({ cached: [A], related: async () => [result(A), result(B)] })
    await s.service.add('l1', A)
    await settle()
    expect(s.related).not.toHaveBeenCalled()

    s.service.setAutoplay('l1', true)
    await settle()
    expect(s.related).toHaveBeenCalledWith(A)
    expect(queued(s)).toEqual([[B, 'Autoplay']])
    expect(s.service.state().autoplay).toBe(true)
    expect(s.activity).toEqual(['Minh added Song A', 'Minh turned autoplay on', 'Autoplay added Song B'])
    expect(s.cache.ensure).toHaveBeenCalledWith(B)
  })

  it('announces only real changes', () => {
    const s = setup()
    s.service.setAutoplay('l1', false)
    s.service.setAutoplay('l1', true)
    s.service.setAutoplay('l1', true)
    s.service.setAutoplay('l1', false)
    expect(s.activity).toEqual(['Minh turned autoplay on', 'Minh turned autoplay off'])
  })

  it('waits while songs are queued', async () => {
    const s = setup({ cached: [A, B], related: async () => [result(C)] })
    await s.service.add('l1', A)
    await s.service.add('l1', B)
    s.service.setAutoplay('l1', true)
    await settle()
    expect(s.related).not.toHaveBeenCalled()
  })

  it('skips songs that are playing or played recently', async () => {
    const s = setup({ cached: [A, C], related: async () => [result(C), result(A), result(B)] })
    await s.service.add('l1', A)
    await s.service.add('l1', C)
    s.service.skip('l1') // C plays, A played
    s.service.setAutoplay('l1', true)
    await settle()
    expect(s.related).toHaveBeenCalledWith(C)
    expect(queued(s)).toEqual([[B, 'Autoplay']])
  })

  it('tries the next song when YouTube rejects one', async () => {
    const s = setup({
      cached: [A],
      related: async () => [result(B), result(C)],
      getInfo: async (id) => {
        if (id === B) throw new Error('Videos longer than 60 minutes are not supported')
        return info(id)
      },
    })
    await s.service.add('l1', A)
    s.service.setAutoplay('l1', true)
    await settle()
    expect(queued(s)).toEqual([[C, 'Autoplay']])
  })

  it('starts the station again from the last song when it went idle', async () => {
    const s = setup({ cached: [A, B], related: async () => [result(B)] })
    await s.service.add('l1', A)
    s.service.skip('l1')
    expect(s.service.state().current).toBeNull()
    s.service.setAutoplay('l1', true)
    await settle()
    expect(s.service.state().current).toMatchObject({ videoId: B, addedBy: 'Autoplay' })
    expect(s.service.state().playback.status).toBe('playing')
  })

  it('adds nothing when someone queues a song during the lookup', async () => {
    let release!: (r: SearchResult[]) => void
    const s = setup({ cached: [A, C], related: () => new Promise((r) => (release = r)) })
    await s.service.add('l1', A)
    s.service.setAutoplay('l1', true)
    await settle()
    await s.service.add('l1', C)
    release([result(B)])
    await settle()
    expect(queued(s)).toEqual([[C, 'Minh']])
  })

  it('waits a minute before retrying after YouTube fails', async () => {
    const s = setup({
      cached: [A],
      related: async () => {
        throw new Error('YouTube bot check hit')
      },
    })
    await s.service.add('l1', A)
    s.service.setAutoplay('l1', true)
    await settle()
    expect(s.logs).toContain('Autoplay could not add a song: YouTube bot check hit')
    s.setTime(AUTOPLAY_RETRY_MS - 1)
    s.service.tick()
    await settle()
    expect(s.related).toHaveBeenCalledOnce()
    s.setTime(AUTOPLAY_RETRY_MS)
    s.service.tick()
    await settle()
    expect(s.related).toHaveBeenCalledTimes(2)
  })
})
