import { randomUUID } from 'node:crypto'
import pLimit from 'p-limit'
import { parseVideoInput, type QueueItem, type StationState, type VideoInfo } from '@music-station/shared'
import type { Persisted } from './persist'
import { Station, StationError } from './station'

export interface CacheLike {
  ensure(videoId: string): Promise<string>
  has(videoId: string): boolean
  touch(videoId: string): void
  evict(protectedIds: Set<string>): string[]
}

export interface ServiceDeps {
  station: Station
  cache: CacheLike
  getInfo(videoId: string): Promise<VideoInfo>
  now(): number
  onChange(): void
  onActivity(text: string): void
  log?(msg: string): void
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

function clock(seconds: number): string {
  const s = Math.floor(seconds)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export class StationService {
  private downloading = new Set<string>()
  private lastCurrentId: string | null = null
  // Each lookup spawns yt-dlp, so cap them and share one per video.
  private infoLimit = pLimit(2)
  private lookups = new Map<string, Promise<VideoInfo>>()

  constructor(private deps: ServiceDeps) {}

  state(): StationState {
    return this.deps.station.snapshot()
  }

  persisted(): Persisted {
    return { version: 1, savedAt: this.deps.now(), ...this.deps.station.persisted() }
  }

  isPlaying(): boolean {
    return this.deps.station.persisted().playback.status === 'playing'
  }

  restore(saved: Persisted | null): void {
    const { station, cache } = this.deps
    if (saved) station.restore(saved, saved.savedAt, this.deps.now(), (id) => cache.has(id))
    for (const videoId of station.pendingVideoIds()) this.startDownload(videoId)
    this.changed()
  }

  join(listenerId: string, nickname: string): void {
    const isNew = this.deps.station.nickname(listenerId) === undefined
    this.deps.station.join(listenerId, nickname)
    if (isNew) this.deps.onActivity(`${nickname} joined`)
    this.changed()
  }

  leave(listenerId: string): void {
    const nickname = this.deps.station.nickname(listenerId)
    if (nickname === undefined) return
    this.deps.station.leave(listenerId)
    this.deps.onActivity(`${nickname} left`)
    this.changed()
  }

  async add(listenerId: string, input: string): Promise<QueueItem> {
    const nickname = this.who(listenerId)
    const videoId = parseVideoInput(input)
    if (!videoId) throw new StationError('That is not a YouTube video link')
    this.deps.station.assertRoom() // station.add checks again, as the queue can fill during the lookup
    let info: VideoInfo
    try {
      info = await this.lookup(videoId)
    } catch (err) {
      throw new StationError(message(err))
    }
    const item: QueueItem = {
      id: randomUUID(),
      videoId,
      title: info.title,
      channel: info.channel,
      duration: info.duration,
      thumbnail: info.thumbnail,
      addedBy: nickname,
      status: this.deps.cache.has(videoId) ? 'ready' : 'downloading',
    }
    this.deps.station.add(item, this.deps.now())
    this.deps.onActivity(`${nickname} added ${item.title}`)
    this.changed()
    if (item.status === 'downloading') this.startDownload(videoId)
    return item
  }

  remove(listenerId: string, itemId: string): void {
    const nickname = this.who(listenerId)
    const item = this.deps.station.remove(itemId)
    this.announce(`${nickname} removed ${item.title}`)
  }

  move(listenerId: string, itemId: string, toIndex: number): void {
    const nickname = this.who(listenerId)
    const item = this.deps.station.move(itemId, toIndex)
    this.announce(`${nickname} moved ${item.title}`)
  }

  play(listenerId: string): void {
    const nickname = this.who(listenerId)
    this.deps.station.play(this.deps.now())
    this.announce(`${nickname} pressed play`)
  }

  pause(listenerId: string): void {
    const nickname = this.who(listenerId)
    this.deps.station.pause(this.deps.now())
    this.announce(`${nickname} paused`)
  }

  seek(listenerId: string, position: number): void {
    const nickname = this.who(listenerId)
    this.deps.station.seek(position, this.deps.now())
    this.announce(`${nickname} jumped to ${clock(this.deps.station.persisted().playback.position)}`)
  }

  skip(listenerId: string): void {
    const nickname = this.who(listenerId)
    const item = this.deps.station.skip(this.deps.now())
    this.announce(`${nickname} skipped ${item.title}`)
  }

  tick(): void {
    if (this.deps.station.tick(this.deps.now())) this.changed()
  }

  private who(listenerId: string): string {
    const nickname = this.deps.station.nickname(listenerId)
    if (nickname === undefined) throw new StationError('Join the station first')
    return nickname
  }

  private announce(text: string): void {
    this.deps.onActivity(text)
    this.changed()
  }

  private lookup(videoId: string): Promise<VideoInfo> {
    let pending = this.lookups.get(videoId)
    if (!pending) {
      pending = this.infoLimit(() => this.deps.getInfo(videoId)).finally(() => this.lookups.delete(videoId))
      this.lookups.set(videoId, pending)
    }
    return pending
  }

  private startDownload(videoId: string): void {
    if (this.downloading.has(videoId)) return
    this.downloading.add(videoId)
    void this.download(videoId).catch((err) => console.error(`Download of ${videoId} crashed: ${message(err)}`))
  }

  private async download(videoId: string): Promise<void> {
    const { station, cache, log = console.log } = this.deps
    let ready = false
    try {
      try {
        await cache.ensure(videoId)
      } catch (first) {
        log(`Download of ${videoId} failed, retrying: ${message(first)}`)
        await cache.ensure(videoId)
      }
      station.markReady(videoId, this.deps.now())
      ready = true
    } catch (err) {
      log(`Download of ${videoId} failed: ${message(err)}`)
      const failed = station.markFailed(videoId, this.deps.now())
      if (failed.length > 0) this.deps.onActivity(`Couldn't download ${failed[0]!.title}: ${message(err)}`)
    } finally {
      this.downloading.delete(videoId)
      this.changed()
    }
    if (!ready) return
    try {
      cache.evict(station.protectedIds())
    } catch (err) {
      console.error(`Evicting old songs failed: ${message(err)}`)
    }
  }

  private changed(): void {
    const current = this.deps.station.persisted().current
    if (current && current.id !== this.lastCurrentId && this.deps.cache.has(current.videoId)) {
      this.deps.cache.touch(current.videoId)
    }
    this.lastCurrentId = current?.id ?? null
    this.deps.onChange()
  }
}
