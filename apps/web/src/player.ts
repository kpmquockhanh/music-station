import { decideCorrection, targetPosition, type Playback, type QueueItem } from '@music-station/shared'

export interface AudioLike {
  src: string
  currentTime: number
  playbackRate: number
  preservesPitch: boolean
  readonly paused: boolean
  play(): Promise<void>
  pause(): void
  addEventListener(type: 'canplay', fn: () => void): void
  removeEventListener(type: 'canplay', fn: () => void): void
}

export interface PlayerDeps {
  audio: AudioLike
  serverNow: () => number
  delayMs: () => number
  onBlocked: () => void
}

const CORRECT_EVERY_MS = 250
const PARK_TOLERANCE_S = 0.05

const samePlayback = (a: Playback, b: Playback) =>
  a.status === b.status && a.position === b.position && a.at === b.at

export class SyncPlayer {
  lastDrift: number | null = null
  private readonly deps: PlayerDeps
  private src: string | null = null
  private canPlay = false
  private blocked = false
  private current: QueueItem | null = null
  private playback: Playback = { status: 'paused', position: 0, at: 0 }
  private leadTimer: ReturnType<typeof setTimeout> | null = null
  private readonly loop: ReturnType<typeof setInterval>

  constructor(deps: PlayerDeps) {
    this.deps = deps
    deps.audio.preservesPitch = true
    deps.audio.addEventListener('canplay', this.onCanPlay)
    this.loop = setInterval(() => this.correct(), CORRECT_EVERY_MS)
  }

  update(current: QueueItem | null, playback: Playback): void {
    const src = current?.status === 'ready' ? `/audio/${current.videoId}.m4a` : null
    if (src === this.src && samePlayback(playback, this.playback)) return
    this.current = current
    this.playback = playback
    if (src !== this.src) {
      this.src = src
      this.canPlay = false
      this.clearLead()
      this.deps.audio.pause()
      if (src) this.deps.audio.src = src // apply() runs on canplay
      return
    }
    this.apply()
  }

  resume(): void {
    this.blocked = false
    this.apply()
  }

  correct(): void {
    const { audio } = this.deps
    const p = this.playback
    if (!this.canPlay || this.leadTimer || p.status !== 'playing' || audio.paused || !this.current) {
      this.lastDrift = null
      return
    }
    const target = this.target()
    if (target >= this.current.duration) return // the server advances to the next song
    const { rate, seekTo } = decideCorrection(audio.currentTime, target)
    this.lastDrift = audio.currentTime - target
    if (seekTo !== null) audio.currentTime = seekTo
    audio.playbackRate = rate
  }

  destroy(): void {
    clearInterval(this.loop)
    this.clearLead()
    this.deps.audio.removeEventListener('canplay', this.onCanPlay)
    this.deps.audio.pause()
  }

  private readonly onCanPlay = (): void => {
    if (this.canPlay || !this.src) return
    this.canPlay = true
    this.apply()
  }

  private apply(): void {
    const { audio } = this.deps
    this.clearLead()
    if (!this.canPlay) return
    const p = this.playback
    if (p.status !== 'playing') {
      audio.pause()
      audio.playbackRate = 1
      this.park(p.position)
      return
    }
    const startInMs = p.at - this.deps.serverNow() - this.deps.delayMs()
    if (startInMs > 0) {
      audio.pause()
      this.park(p.position)
      this.leadTimer = setTimeout(() => {
        this.leadTimer = null
        this.start()
      }, startInMs)
      return
    }
    this.start()
  }

  private start(): void {
    const { audio } = this.deps
    if (this.blocked) return
    this.park(this.target())
    audio.playbackRate = 1
    if (!audio.paused) return
    audio.play().catch((err: unknown) => {
      // AbortError just means a newer pause or src change won; only the autoplay policy needs the user.
      if (err instanceof Error && err.name === 'NotAllowedError') {
        this.blocked = true
        this.deps.onBlocked()
      }
    })
  }

  private park(position: number): void {
    const { audio } = this.deps
    if (Math.abs(audio.currentTime - position) > PARK_TOLERANCE_S) audio.currentTime = position
  }

  private target(): number {
    return targetPosition(this.playback, this.deps.serverNow(), this.deps.delayMs())
  }

  private clearLead(): void {
    if (this.leadTimer) clearTimeout(this.leadTimer)
    this.leadTimer = null
  }
}
