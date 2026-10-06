import { decideCorrection, targetPosition, type Playback, type QueueItem } from '@music-station/shared'

type AudioEvent = 'canplay' | 'loadedmetadata' | 'pause'

export interface AudioLike {
  src: string
  currentTime: number
  playbackRate: number
  preservesPitch: boolean
  readonly paused: boolean
  readonly readyState: number
  readonly seeking: boolean
  readonly ended: boolean
  play(): Promise<void>
  pause(): void
  load(): void
  addEventListener(type: AudioEvent, fn: () => void): void
  removeEventListener(type: AudioEvent, fn: () => void): void
}

export interface PlayerDeps {
  audio: AudioLike
  serverNow: () => number
  delayMs: () => number
  onBlocked: () => void
}

const CORRECT_EVERY_MS = 250
const PARK_TOLERANCE_S = 0.05
const HAVE_METADATA = 1
const HAVE_FUTURE_DATA = 3

const samePlayback = (a: Playback, b: Playback) =>
  a.status === b.status && a.position === b.position && a.at === b.at

export class SyncPlayer {
  lastDrift: number | null = null
  private readonly deps: PlayerDeps
  private src: string | null = null
  private canPlay = false
  private blocked = false
  /** True while the player expects the element to play, so a pause event it did not cause is external. */
  private wantPlaying = false
  private current: QueueItem | null = null
  private playback: Playback = { status: 'paused', position: 0, at: 0 }
  private leadTimer: ReturnType<typeof setTimeout> | null = null
  private readonly loop: ReturnType<typeof setInterval>

  constructor(deps: PlayerDeps) {
    this.deps = deps
    deps.audio.preservesPitch = true
    // iOS may hold readyState at HAVE_METADATA until play(), so canplay can never come (Ruling R11).
    deps.audio.addEventListener('loadedmetadata', this.onCanPlay)
    deps.audio.addEventListener('canplay', this.onCanPlay)
    deps.audio.addEventListener('pause', this.onPause)
    this.loop = setInterval(() => this.correct(), CORRECT_EVERY_MS)
  }

  update(current: QueueItem | null, playback: Playback): void {
    const src = current?.status === 'ready' ? `/audio/${current.videoId}.m4a` : null
    if (src === this.src && samePlayback(playback, this.playback)) return
    this.current = current
    this.playback = playback
    if (src !== this.src) {
      const { audio } = this.deps
      this.src = src
      this.canPlay = false
      this.clearLead()
      this.pauseAudio()
      if (src) {
        audio.src = src
        audio.load() // iOS does not preload; apply() runs on loadedmetadata or canplay
        if (audio.readyState >= HAVE_METADATA) this.onCanPlay()
      }
      return
    }
    this.apply()
  }

  /** Runs inside the "Tap to resume" gesture. */
  resume(): void {
    this.blocked = false
    // Play before apply(), while the tap still counts. A pending lead-in pauses it again, now unlocked.
    if (this.src) this.deps.audio.play().catch(() => {})
    this.apply()
  }

  /** Restarts an element that stopped without a banner, such as after a failed play(). Never touches one that plays. */
  realign(): void {
    const { audio } = this.deps
    if (!this.canPlay || this.blocked || this.playback.status !== 'playing') return
    if (!audio.paused || audio.ended || this.leadTimer) return
    this.apply()
  }

  correct(): void {
    const { audio } = this.deps
    if (audio.seeking || audio.readyState < HAVE_FUTURE_DATA) {
      this.lastDrift = null
      return
    }
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
    const { audio } = this.deps
    clearInterval(this.loop)
    this.clearLead()
    audio.removeEventListener('loadedmetadata', this.onCanPlay)
    audio.removeEventListener('canplay', this.onCanPlay)
    audio.removeEventListener('pause', this.onPause)
    this.pauseAudio()
  }

  private readonly onCanPlay = (): void => {
    if (this.canPlay || !this.src) return
    this.canPlay = true
    this.apply()
  }

  // A call, Siri or AirPods paused the audio (Ruling R12). Pause events arrive in a later task, so the
  // player's own pauses have already cleared wantPlaying, and one that a newer play() overtook finds it playing.
  private readonly onPause = (): void => {
    const { audio } = this.deps
    if (!this.wantPlaying || !audio.paused || audio.ended || this.playback.status !== 'playing') return
    this.wantPlaying = false
    this.blocked = true
    this.deps.onBlocked()
  }

  private apply(): void {
    const { audio } = this.deps
    this.clearLead()
    if (!this.canPlay) return
    const p = this.playback
    if (p.status !== 'playing') {
      this.pauseAudio()
      audio.playbackRate = 1
      this.park(p.position)
      return
    }
    const startInMs = p.at - this.deps.serverNow() - this.deps.delayMs()
    if (startInMs > 0) {
      this.pauseAudio()
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
    this.wantPlaying = true
    if (!audio.paused) return
    audio.play().catch((err: unknown) => {
      // AbortError just means a newer pause or src change won; only the autoplay policy needs the user.
      if (err instanceof Error && err.name === 'AbortError') return
      this.wantPlaying = false // realign() retries other failures
      if (err instanceof Error && err.name === 'NotAllowedError') {
        this.blocked = true
        this.deps.onBlocked()
      }
    })
  }

  /** Every pause the player makes goes through here, so onPause can tell them from external ones. */
  private pauseAudio(): void {
    this.wantPlaying = false
    this.deps.audio.pause()
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
