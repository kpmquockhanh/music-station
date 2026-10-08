import { randomUUID } from 'node:crypto'
import { LRUCache } from 'lru-cache'
import pLimit from 'p-limit'
import {
  AUTOPLAY_NAME,
  parseVideoInput,
  type QueueItem,
  type SearchResult,
  type StationState,
  type VideoInfo,
} from '@music-station/shared'
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
  /** Songs similar to this one, for autoplay. */
  related(videoId: string): Promise<SearchResult[]>
  now(): number
  onChange(): void
  onActivity(text: string): void
  log?(msg: string): void
  /** The station pauses after this long with nobody joined. 0 or missing turns it off. */
  idlePauseMs?: number
}

/** After autoplay finds nothing, or YouTube fails, it waits this long before it tries again. */
export const AUTOPLAY_RETRY_MS = 60_000
/** Candidates autoplay looks up before it gives up until the retry; each lookup spawns yt-dlp. */
const AUTOPLAY_TRIES = 3

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
  private suggesting = false
  private suggestRetryAt = Number.NEGATIVE_INFINITY
  private relatedCache = new LRUCache<string, SearchResult[]>({ max: 20, ttl: 3_600_000 })
  /** When the last listener left, or null while someone is joined. */
  private emptySince: number | null = null
  /** Set by the idle pause until someone plays again, so people who join learn why it stopped. */
  private idlePaused = false

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
    this.emptySince = null
    if (isNew) this.deps.onActivity(`${nickname} joined`)
    if (isNew && this.idlePaused) this.deps.onActivity(`Paused after ${this.idleMinutes()} with nobody listening`)
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
    return this.enqueue(info, nickname)
  }

  setAutoplay(listenerId: string, enabled: boolean): void {
    const nickname = this.who(listenerId)
    if (!this.deps.station.setAutoplay(enabled)) return
    this.suggestRetryAt = Number.NEGATIVE_INFINITY // turning it on again is how people ask for a retry
    this.announce(`${nickname} turned autoplay ${enabled ? 'on' : 'off'}`)
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
    this.idlePaused = false
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
    this.idlePaused = false
    this.announce(`${nickname} skipped ${item.title}`)
  }

  tick(): void {
    if (this.pauseWhenIdle()) return
    if (this.deps.station.tick(this.deps.now())) this.changed()
    else this.maybeSuggest() // retries after a failure, which no state change announces
  }

  /** Pauses for everyone once nobody has been joined for idlePauseMs, so songs and autoplay do not run for no one. */
  private pauseWhenIdle(): boolean {
    const { station, idlePauseMs = 0 } = this.deps
    if (idlePauseMs <= 0 || station.hasListeners()) return false
    const now = this.deps.now()
    this.emptySince ??= now
    if (now - this.emptySince < idlePauseMs || !station.isRunning()) return false
    station.pause(now)
    this.idlePaused = true
    this.announce(`Paused after ${this.idleMinutes()} with nobody listening`)
    return true
  }

  private idleMinutes(): string {
    const min = Math.round(((this.deps.idlePauseMs ?? 0) / 60_000) * 10) / 10
    return `${min} minute${min === 1 ? '' : 's'}`
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

  private enqueue(info: VideoInfo, addedBy: string): QueueItem {
    const item: QueueItem = {
      id: randomUUID(),
      videoId: info.videoId,
      title: info.title,
      channel: info.channel,
      duration: info.duration,
      thumbnail: info.thumbnail,
      addedBy,
      status: this.deps.cache.has(info.videoId) ? 'ready' : 'downloading',
    }
    this.deps.station.add(item, this.deps.now())
    this.deps.onActivity(`${addedBy} added ${item.title}`)
    this.changed()
    if (item.status === 'downloading') this.startDownload(info.videoId)
    return item
  }

  /** Queues a song similar to the current one when autoplay is on and nothing else is left to play. */
  private maybeSuggest(): void {
    if (this.suggesting || this.deps.now() < this.suggestRetryAt) return
    const seed = this.deps.station.autoplaySeed()
    if (!seed) return
    this.suggesting = true
    const log = this.deps.log ?? console.log
    void this.suggest(seed)
      .catch((err) => {
        log(`Autoplay could not add a song: ${message(err)}`)
        this.suggestRetryAt = this.deps.now() + AUTOPLAY_RETRY_MS
      })
      .finally(() => {
        this.suggesting = false
      })
  }

  private async suggest(seed: string): Promise<void> {
    const { station } = this.deps
    let related = this.relatedCache.get(seed)
    if (!related) {
      related = await this.deps.related(seed)
      this.relatedCache.set(seed, related)
    }
    let tries = 0
    let lastError: unknown = new Error('YouTube suggested no new songs')
    for (const candidate of related) {
      // Checked before each pick, since people can add songs or turn autoplay off meanwhile.
      if (!station.autoplaySeed()) return
      if (station.recentVideoIds().has(candidate.videoId)) continue
      if (tries++ === AUTOPLAY_TRIES) break
      let info: VideoInfo
      try {
        info = await this.lookup(candidate.videoId)
      } catch (err) {
        lastError = err // too long, a livestream, or YouTube failing
        continue
      }
      if (!station.autoplaySeed()) return
      this.enqueue(info, AUTOPLAY_NAME) // throws when the queue is full of failed songs; retried later
      return
    }
    throw lastError
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
    this.maybeSuggest()
  }
}
