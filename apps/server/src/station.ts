import {
  MAX_QUEUE,
  START_LEAD_MS,
  expectedPosition,
  songEndsAt,
  type Playback,
  type QueueItem,
  type StationState,
} from '@music-station/shared'

export class StationError extends Error {}

/** A tick later than this after a song's end (the host slept) starts the next song fresh, not mid-song. */
const MAX_LATE_HANDOFF_MS = 2_000
/** Autoplay does not pick a song that is among the last this many to play. */
export const HISTORY_SIZE = 50

export interface StationSnapshot {
  current: QueueItem | null
  queue: QueueItem[]
  playback: Playback
  autoplay: boolean
  /** Video ids that played most recently, oldest first. */
  history: string[]
}

const idle = (): Playback => ({ status: 'paused', position: 0, at: 0 })

export class Station {
  private current: QueueItem | null = null
  private queue: QueueItem[] = []
  private playback: Playback = idle()
  private listeners = new Map<string, string>()
  private autoplay = false
  private history: string[] = []

  join(listenerId: string, nickname: string): void {
    this.listeners.set(listenerId, nickname)
  }

  leave(listenerId: string): void {
    this.listeners.delete(listenerId)
  }

  nickname(listenerId: string): string | undefined {
    return this.listeners.get(listenerId)
  }

  assertRoom(): void {
    if (this.queue.length >= MAX_QUEUE) throw new StationError('The queue is full')
  }

  add(item: QueueItem, now: number): void {
    this.assertRoom()
    if (this.current) this.queue.push(item)
    else this.setCurrent(item, now)
  }

  remove(itemId: string): QueueItem {
    const i = this.indexOf(itemId)
    return this.queue.splice(i, 1)[0]!
  }

  move(itemId: string, toIndex: number): QueueItem {
    const [item] = this.queue.splice(this.indexOf(itemId), 1)
    const to = Math.max(0, Math.min(toIndex, this.queue.length))
    this.queue.splice(to, 0, item!)
    return item!
  }

  /** Returns false when autoplay was already set that way. */
  setAutoplay(enabled: boolean): boolean {
    if (this.autoplay === enabled) return false
    this.autoplay = enabled
    return true
  }

  /** The song autoplay should find a similar one for, or null when autoplay has nothing to do. */
  autoplaySeed(): string | null {
    if (!this.autoplay || this.queue.some((q) => q.status !== 'failed')) return null
    return this.current?.videoId ?? this.history.at(-1) ?? null
  }

  /** Songs autoplay must not pick: those queued, playing, or played recently. */
  recentVideoIds(): Set<string> {
    const ids = this.protectedIds()
    for (const id of this.history) ids.add(id)
    return ids
  }

  play(now: number): void {
    const current = this.requireCurrent('Nothing to play')
    if (current.status !== 'ready') throw new StationError('The song is still loading')
    if (this.playback.status !== 'paused') throw new StationError('Already playing')
    this.playback = { status: 'playing', position: this.playback.position, at: now + START_LEAD_MS }
  }

  pause(now: number): void {
    const current = this.requireCurrent('Nothing is playing')
    if (this.playback.status === 'paused') throw new StationError('Already paused')
    const position = Math.min(expectedPosition(this.playback, now), current.duration)
    this.playback = { status: 'paused', position, at: now }
  }

  seek(position: number, now: number): void {
    const current = this.requireCurrent('Nothing is playing')
    const pos = Math.max(0, Math.min(position, current.duration))
    this.playback =
      this.playback.status === 'playing'
        ? { status: 'playing', position: pos, at: now + START_LEAD_MS }
        : { ...this.playback, position: pos }
  }

  skip(now: number): QueueItem {
    const current = this.requireCurrent('Nothing to skip')
    this.advance(now)
    return current
  }

  markReady(videoId: string, now: number): void {
    for (const q of this.queue) if (q.videoId === videoId && q.status === 'downloading') q.status = 'ready'
    const c = this.current
    if (c && c.videoId === videoId && c.status === 'downloading') {
      c.status = 'ready'
      if (this.playback.status === 'waiting') {
        this.playback = { status: 'playing', position: this.playback.position, at: now + START_LEAD_MS }
      }
    }
  }

  markFailed(videoId: string, now: number): QueueItem[] {
    const failed: QueueItem[] = []
    for (const q of this.queue) {
      if (q.videoId === videoId && q.status === 'downloading') {
        q.status = 'failed'
        failed.push(q)
      }
    }
    const c = this.current
    if (c && c.videoId === videoId && c.status === 'downloading') {
      c.status = 'failed'
      failed.push(c)
      this.advance(now)
    }
    return failed
  }

  tick(now: number): boolean {
    if (!this.current || this.playback.status !== 'playing') return false
    if (expectedPosition(this.playback, now) < this.current.duration) return false
    // Devices that loaded the next song switched to it at this exact time already, without waiting for the tick.
    const endsAt = songEndsAt(this.playback, this.current.duration)
    this.advance(now, now - endsAt <= MAX_LATE_HANDOFF_MS ? endsAt : undefined)
    return true
  }

  snapshot(): StationState {
    const { current, queue, playback, autoplay } = this.persisted()
    return {
      current,
      queue,
      playback,
      listeners: [...this.listeners].map(([id, nickname]) => ({ id, nickname })),
      autoplay,
    }
  }

  persisted(): StationSnapshot {
    return structuredClone({
      current: this.current,
      queue: this.queue,
      playback: this.playback,
      autoplay: this.autoplay,
      history: this.history,
    })
  }

  restore(saved: StationSnapshot, savedAt: number, now: number, isCached: (videoId: string) => boolean): void {
    const fix = (q: QueueItem): QueueItem =>
      q.status === 'failed' ? { ...q } : { ...q, status: isCached(q.videoId) ? 'ready' : 'downloading' }
    this.current = saved.current ? fix(saved.current) : null
    this.queue = saved.queue.map(fix)
    const reached = expectedPosition(saved.playback, savedAt)
    const position = this.current ? Math.min(Math.max(0, reached), this.current.duration) : 0
    this.playback = { status: 'paused', position, at: now }
    this.autoplay = saved.autoplay
    this.history = saved.history.slice(-HISTORY_SIZE)
  }

  protectedIds(): Set<string> {
    const ids = new Set(this.queue.map((q) => q.videoId))
    if (this.current) ids.add(this.current.videoId)
    return ids
  }

  pendingVideoIds(): string[] {
    const all = this.current ? [this.current, ...this.queue] : this.queue
    return [...new Set(all.filter((q) => q.status === 'downloading').map((q) => q.videoId))]
  }

  private advance(now: number, at?: number): void {
    const i = this.queue.findIndex((q) => q.status !== 'failed')
    if (i < 0) {
      this.current = null
      this.playback = idle()
      return
    }
    this.setCurrent(this.queue.splice(i, 1)[0]!, now, at)
  }

  private setCurrent(item: QueueItem, now: number, at = now + START_LEAD_MS): void {
    this.current = item
    this.history = [...this.history.filter((id) => id !== item.videoId), item.videoId].slice(-HISTORY_SIZE)
    this.playback =
      item.status === 'ready'
        ? { status: 'playing', position: 0, at }
        : { status: 'waiting', position: 0, at: now }
  }

  private requireCurrent(message: string): QueueItem {
    if (!this.current) throw new StationError(message)
    return this.current
  }

  private indexOf(itemId: string): number {
    const i = this.queue.findIndex((q) => q.id === itemId)
    if (i < 0) throw new StationError('That song is no longer in the queue')
    return i
  }
}
