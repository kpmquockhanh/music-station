import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { MAX_QUEUE, START_LEAD_MS, type QueueItem } from '@music-station/shared'
import { Station, StationError } from './station'

function item(over: Partial<QueueItem> = {}): QueueItem {
  return {
    id: randomUUID(),
    videoId: 'aaaaaaaaaaa',
    title: 'Song A',
    channel: 'Channel',
    duration: 100,
    thumbnail: '',
    addedBy: 'Minh',
    status: 'ready',
    ...over,
  }
}

describe('listeners', () => {
  it('joins, renames on rejoin, and leaves', () => {
    const s = new Station()
    s.join('l1', 'Minh')
    s.join('l2', 'An')
    s.join('l1', 'Minh2')
    expect(s.snapshot().listeners).toEqual([
      { id: 'l1', nickname: 'Minh2' },
      { id: 'l2', nickname: 'An' },
    ])
    expect(s.nickname('l2')).toBe('An')
    s.leave('l2')
    expect(s.snapshot().listeners).toEqual([{ id: 'l1', nickname: 'Minh2' }])
  })
})

describe('add', () => {
  it('starts a ready item on an idle station after the lead-in', () => {
    const s = new Station()
    const a = item()
    s.add(a, 5_000)
    const st = s.snapshot()
    expect(st.current?.id).toBe(a.id)
    expect(st.queue).toEqual([])
    expect(st.playback).toEqual({ status: 'playing', position: 0, at: 5_000 + START_LEAD_MS })
  })

  it('waits when the idle station gets a downloading item', () => {
    const s = new Station()
    s.add(item({ status: 'downloading' }), 5_000)
    expect(s.snapshot().playback.status).toBe('waiting')
  })

  it('appends when something is current', () => {
    const s = new Station()
    const a = item()
    const b = item({ videoId: 'bbbbbbbbbbb' })
    s.add(a, 0)
    s.add(b, 0)
    expect(s.snapshot().queue.map((q) => q.id)).toEqual([b.id])
  })

  it('rejects when the queue is full', () => {
    const s = new Station()
    s.add(item(), 0)
    for (let i = 0; i < MAX_QUEUE; i++) s.add(item(), 0)
    expect(() => s.add(item(), 0)).toThrow(StationError)
  })
})

describe('downloads finishing', () => {
  it('markReady starts a waiting current song from 0', () => {
    const s = new Station()
    s.add(item({ status: 'downloading' }), 0)
    s.add(item({ status: 'downloading' }), 0)
    s.markReady('aaaaaaaaaaa', 7_000)
    const st = s.snapshot()
    expect(st.current?.status).toBe('ready')
    expect(st.queue[0]!.status).toBe('ready')
    expect(st.playback).toEqual({ status: 'playing', position: 0, at: 7_000 + START_LEAD_MS })
  })

  it('markReady keeps a song paused if someone paused while it was loading', () => {
    const s = new Station()
    s.add(item({ status: 'downloading' }), 0)
    s.pause(1_000)
    s.markReady('aaaaaaaaaaa', 2_000)
    expect(s.snapshot().playback.status).toBe('paused')
    expect(s.snapshot().current?.status).toBe('ready')
  })

  it('markFailed marks queued copies and keeps them in the queue', () => {
    const s = new Station()
    s.add(item({ videoId: 'ccccccccccc' }), 0)
    s.add(item({ status: 'downloading' }), 0)
    const failed = s.markFailed('aaaaaaaaaaa', 0)
    expect(failed).toHaveLength(1)
    expect(s.snapshot().queue[0]!.status).toBe('failed')
  })

  it('markFailed on the current song advances past failed items', () => {
    const s = new Station()
    const b = item({ videoId: 'bbbbbbbbbbb', status: 'downloading' })
    const c = item({ videoId: 'ccccccccccc' })
    s.add(item({ status: 'downloading' }), 0)
    s.add(b, 0)
    s.add(c, 0)
    s.markFailed('bbbbbbbbbbb', 0)
    s.markFailed('aaaaaaaaaaa', 1_000)
    const st = s.snapshot()
    expect(st.current?.id).toBe(c.id)
    expect(st.queue.map((q) => q.id)).toEqual([b.id])
    expect(st.playback).toEqual({ status: 'playing', position: 0, at: 1_000 + START_LEAD_MS })
  })
})

describe('queue editing', () => {
  it('removes upcoming items only', () => {
    const s = new Station()
    const a = item()
    const b = item()
    s.add(a, 0)
    s.add(b, 0)
    expect(s.remove(b.id).id).toBe(b.id)
    expect(s.snapshot().queue).toEqual([])
    expect(() => s.remove(a.id)).toThrow(StationError)
  })

  it('moves and clamps the target index', () => {
    const s = new Station()
    s.add(item(), 0)
    const [b, c, d] = [item(), item(), item()]
    s.add(b, 0)
    s.add(c, 0)
    s.add(d, 0)
    s.move(d.id, 0)
    expect(s.snapshot().queue.map((q) => q.id)).toEqual([d.id, b.id, c.id])
    s.move(d.id, 99)
    expect(s.snapshot().queue.map((q) => q.id)).toEqual([b.id, c.id, d.id])
    expect(() => s.move('missing', 0)).toThrow(StationError)
  })
})

describe('transport', () => {
  it('pause stores the expected position', () => {
    const s = new Station()
    s.add(item(), 0) // plays from 0 at 1000
    s.pause(11_000)
    expect(s.snapshot().playback).toEqual({ status: 'paused', position: 10, at: 11_000 })
  })

  it('pause during the lead-in keeps position 0', () => {
    const s = new Station()
    s.add(item(), 0)
    s.pause(500)
    expect(s.snapshot().playback.position).toBe(0)
  })

  it('play resumes from the paused position after the lead-in', () => {
    const s = new Station()
    s.add(item(), 0)
    s.pause(11_000)
    s.play(20_000)
    expect(s.snapshot().playback).toEqual({ status: 'playing', position: 10, at: 20_000 + START_LEAD_MS })
  })

  it('play is rejected when idle, loading, or already playing', () => {
    const s = new Station()
    expect(() => s.play(0)).toThrow(StationError)
    s.add(item({ status: 'downloading' }), 0)
    s.pause(0)
    expect(() => s.play(0)).toThrow(/loading/i)
    s.markReady('aaaaaaaaaaa', 0)
    s.play(0)
    expect(() => s.play(0)).toThrow(StationError)
  })

  it('pause is rejected when idle or already paused', () => {
    const s = new Station()
    expect(() => s.pause(0)).toThrow(StationError)
    s.add(item(), 0)
    s.pause(0)
    expect(() => s.pause(0)).toThrow(StationError)
  })

  it('seek clamps and restarts the lead-in while playing', () => {
    const s = new Station()
    s.add(item(), 0)
    s.seek(250, 3_000)
    expect(s.snapshot().playback).toEqual({ status: 'playing', position: 100, at: 3_000 + START_LEAD_MS })
    s.seek(-5, 4_000)
    expect(s.snapshot().playback.position).toBe(0)
  })

  it('seek while paused only moves the position', () => {
    const s = new Station()
    s.add(item(), 0)
    s.pause(2_000)
    s.seek(42, 9_000)
    expect(s.snapshot().playback).toEqual({ status: 'paused', position: 42, at: 2_000 })
  })

  it('skip advances, skipping failed items, and goes idle at the end', () => {
    const s = new Station()
    const a = item()
    const failed = item({ status: 'failed' })
    const c = item()
    s.add(a, 0)
    s.add(failed, 0)
    s.add(c, 0)
    expect(s.skip(1_000).id).toBe(a.id)
    expect(s.snapshot().current?.id).toBe(c.id)
    s.skip(2_000)
    const st = s.snapshot()
    expect(st.current).toBeNull()
    expect(st.queue.map((q) => q.id)).toEqual([failed.id])
    expect(st.playback.status).toBe('paused')
    expect(() => s.skip(3_000)).toThrow(StationError)
  })

  it('an idle station starts the next added song even if failed items remain', () => {
    const s = new Station()
    s.add(item(), 0)
    s.add(item({ status: 'failed' }), 0)
    s.skip(0)
    const next = item()
    s.add(next, 10_000)
    expect(s.snapshot().current?.id).toBe(next.id)
  })
})

describe('tick', () => {
  it('advances only when the song has ended', () => {
    const s = new Station()
    const b = item()
    s.add(item({ duration: 10 }), 0) // plays 1000..11000
    s.add(b, 0)
    expect(s.tick(10_900)).toBe(false)
    expect(s.tick(11_000)).toBe(true)
    expect(s.snapshot().current?.id).toBe(b.id)
  })

  it('does nothing while paused', () => {
    const s = new Station()
    s.add(item({ duration: 10 }), 0)
    s.pause(5_000)
    expect(s.tick(999_999)).toBe(false)
  })
})

describe('snapshot, restore and ids', () => {
  it('returns copies', () => {
    const s = new Station()
    s.add(item(), 0)
    s.snapshot().current!.title = 'changed'
    expect(s.snapshot().current!.title).toBe('Song A')
  })

  it('restores paused at the position reached by savedAt', () => {
    const s = new Station()
    s.restore(
      { current: item(), queue: [], playback: { status: 'playing', position: 10, at: 1_000 } },
      31_000,
      999_000,
      () => true,
    )
    expect(s.snapshot().playback).toEqual({ status: 'paused', position: 40, at: 999_000 })
    expect(s.snapshot().listeners).toEqual([])
  })

  it('clamps a restored position to the song duration', () => {
    const s = new Station()
    s.restore(
      { current: item({ duration: 100 }), queue: [], playback: { status: 'playing', position: 90, at: 0 } },
      60_000,
      70_000,
      () => true,
    )
    expect(s.snapshot().playback.position).toBe(100)
  })

  it('matches item statuses to the files on disk', () => {
    const s = new Station()
    const cached = 'ccccccccccc'
    s.restore(
      {
        current: item({ videoId: 'aaaaaaaaaaa', status: 'ready' }),
        queue: [
          item({ videoId: cached, status: 'downloading' }),
          item({ videoId: 'fffffffffff', status: 'failed' }),
        ],
        playback: { status: 'waiting', position: 0, at: 0 },
      },
      0,
      0,
      (id) => id === cached,
    )
    const st = s.snapshot()
    expect(st.current!.status).toBe('downloading')
    expect(st.queue.map((q) => q.status)).toEqual(['ready', 'failed'])
    expect(st.playback.status).toBe('paused')
    expect(s.pendingVideoIds()).toEqual(['aaaaaaaaaaa'])
  })

  it('protects current and queued video ids', () => {
    const s = new Station()
    s.add(item({ videoId: 'aaaaaaaaaaa' }), 0)
    s.add(item({ videoId: 'bbbbbbbbbbb' }), 0)
    expect(s.protectedIds()).toEqual(new Set(['aaaaaaaaaaa', 'bbbbbbbbbbb']))
  })
})
