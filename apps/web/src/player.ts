import { decideCorrection, songEndsAt, targetPosition, type Playback, type QueueItem } from '@music-station/shared'

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

/** A song downloaded in full. release() frees it once the player moves on. */
export interface LocalFile {
  url: string
  release(): void
}

export interface PlayerDeps {
  audio: AudioLike
  /** A second element, unlocked by the same tap, that loads the next song ahead so song changes have no gap. */
  spare?: AudioLike
  serverNow: () => number
  delayMs: () => number
  onBlocked: () => void
  /** Downloads the whole file first, so seeks and slow Wi-Fi never stall playback. Without it the element streams. */
  download?: (url: string, signal: AbortSignal) => Promise<LocalFile>
  /** How long after a seek or start drift is only reported, not corrected. */
  settleMs?: number
  /** The seek lead this device learned earlier, in seconds. */
  seekLeadS?: number
  /** Called when the seek lead changes, so the device can remember it. */
  onSeekLead?: (seconds: number) => void
  /** How long this device's play() took earlier to get the media clock moving, in seconds. */
  startLeadS?: number
  /** Called when the start lead changes, so the device can remember it. */
  onStartLead?: (seconds: number) => void
}

const CORRECT_EVERY_MS = 250
const PARK_TOLERANCE_S = 0.05
/** Seeks fetch a new byte range, so they land late by the network time. The lead never grows past this. */
const MAX_SEEK_LEAD_S = 2
/** Each landing moves the lead only halfway, so one odd landing cannot throw it far off. */
const LEAD_GAIN = 0.5
/** A landing further off than this is not seek latency (the station moved meanwhile), so it teaches nothing. */
const LANDING_SANE_S = 5
/** iOS holds currentTime still for a few hundred ms after a seek or play(), then jumps. Judge drift only after this. */
const SETTLE_MS = 1_500
/** Switch to the next song this long before its early start; the new deck then waits out the rest as a lead-in. */
const HANDOFF_EARLY_MS = 500
const HAVE_METADATA = 1
const HAVE_FUTURE_DATA = 3

const clampLead = (s: number) => (Number.isFinite(s) ? Math.min(MAX_SEEK_LEAD_S, Math.max(0, s)) : 0)

const samePlayback = (a: Playback, b: Playback) =>
  a.status === b.status && a.position === b.position && a.at === b.at

const songPath = (item: QueueItem | null | undefined) => (item?.status === 'ready' ? `/audio/${item.videoId}.m4a` : null)

/** The song the server plays next, as Station.advance() picks it: failed items are skipped. */
function nextUp(queue: QueueItem[]): { item: QueueItem; rest: QueueItem[] } | null {
  const i = queue.findIndex((q) => q.status !== 'failed')
  return i < 0 ? null : { item: queue[i]!, rest: queue.slice(i + 1) }
}

/** One audio element and the song it holds. */
interface Deck {
  readonly audio: AudioLike
  /** The song path it holds or is loading. */
  src: string | null
  /** The URL given to the element: the downloaded file, or the path when streaming. Null while downloading. */
  url: string | null
  /** The element has the file's metadata, so it can be parked and played. */
  ready: boolean
  readonly onCanPlay: () => void
  readonly onPause: () => void
}

interface CachedFile {
  readonly ctrl: AbortController
  file: LocalFile | null
  failed: boolean
  ms: number
  readonly waiters: ((url: string) => void)[]
}

export class SyncPlayer {
  lastDrift: number | null = null
  /** Counters for the sync log: correction seeks, song changes made on a preloaded deck, and playbackRate writes. */
  readonly stats = { seeks: 0, handoffs: 0, rateWrites: 0 }
  private readonly deps: PlayerDeps
  private readonly decks: Deck[]
  private active: Deck
  /** The previous song's deck, left playing until the next song starts so the change has no silence. */
  private retiring: Deck | null = null
  private readonly files = new Map<string, CachedFile>()
  private blocked = false
  /** True while the player expects the active element to play, so a pause event it did not cause is external. */
  private wantPlaying = false
  private current: QueueItem | null = null
  private queue: QueueItem[] = []
  private playback: Playback = { status: 'paused', position: 0, at: 0 }
  private leadTimer: ReturnType<typeof setTimeout> | null = null
  private handoffTimer: ReturnType<typeof setTimeout> | null = null
  /** How far ahead of the target a correction seek aims, learned from where earlier seeks landed. */
  private seekLead: number
  /**
   * How long play() takes to get the media clock moving on this device (about 0.2 s in Safari, 0.5 s in Firefox).
   * Scheduled starts call play() this much early, so the sound begins on time from the very start of the song.
   */
  private startLead: number
  /** Set after a correction seek or a start until the next measurement, which shows where it landed. */
  private landing: 'seek' | 'start' | null = null
  /** Stops the previous song exactly at the boundary, once the next one has been started early. */
  private retireTimer: ReturnType<typeof setTimeout> | null = null
  /** Server time before which the element is still settling from a seek or start. */
  private settleUntil = 0
  private readonly loop: ReturnType<typeof setInterval>

  constructor(deps: PlayerDeps) {
    this.deps = deps
    this.seekLead = clampLead(deps.seekLeadS ?? 0)
    this.startLead = clampLead(deps.startLeadS ?? 0)
    this.decks = [deps.audio, ...(deps.spare ? [deps.spare] : [])].map((a) => this.makeDeck(a))
    this.active = this.decks[0]!
    this.loop = setInterval(() => this.correct(), CORRECT_EVERY_MS)
  }

  update(current: QueueItem | null, playback: Playback, queue: QueueItem[] = []): void {
    const src = songPath(current)
    this.queue = queue
    if (src !== this.active.src || !samePlayback(playback, this.playback)) {
      this.current = current
      this.playback = playback
      this.landing = null
      if (src !== this.active.src) this.switchTo(src)
      else this.apply()
    }
    this.preloadNext()
    this.scheduleHandoff()
  }

  /** Runs inside the "Tap to resume" gesture. */
  resume(): void {
    this.blocked = false
    // Play before apply(), while the tap still counts. A pending lead-in pauses it again, now unlocked.
    // While the file downloads, the element still holds the previous song, so leave it alone.
    if (this.active.ready) this.active.audio.play().catch(() => {})
    // Unlock the spare in the same tap without a sound: iOS only needs the play() call.
    const standby = this.standby()
    if (standby && standby !== this.retiring && standby.audio.paused) {
      standby.audio.play().catch(() => {})
      standby.audio.pause()
    }
    this.apply()
    this.scheduleHandoff()
  }

  /** Restarts an element that stopped without a banner, such as after a failed play(). Never touches one that plays. */
  realign(): void {
    const { audio } = this.active
    if (!this.active.ready || this.blocked || this.playback.status !== 'playing') return
    if (!audio.paused || audio.ended || this.leadTimer) return
    this.apply()
  }

  correct(): void {
    const { audio } = this.active
    if (audio.seeking || audio.readyState < HAVE_FUTURE_DATA) {
      this.lastDrift = null
      return
    }
    const p = this.playback
    if (!this.active.ready || this.leadTimer || p.status !== 'playing' || audio.paused || !this.current) {
      this.lastDrift = null
      return
    }
    const target = this.target()
    if (target >= this.current.duration) return // the server advances to the next song
    const drift = audio.currentTime - target
    this.lastDrift = drift
    if (this.deps.serverNow() < this.settleUntil) return
    if (this.landing) {
      // A seek that lands late by more than the seek threshold would otherwise seek again forever, and a
      // late start leaves a silence at every song change.
      const kind = this.landing
      this.landing = null
      if (Math.abs(drift) < LANDING_SANE_S) this.learn(kind, drift)
    }
    const { rate, seekTo } = decideCorrection(audio.currentTime, target)
    if (seekTo !== null) {
      audio.currentTime = seekTo + this.seekLead
      this.landing = 'seek'
      this.settle()
      this.stats.seeks++
    }
    this.setRate(rate)
  }

  destroy(): void {
    clearInterval(this.loop)
    this.clearLead()
    this.clearHandoff()
    this.wantPlaying = false
    for (const deck of this.decks) {
      deck.audio.removeEventListener('loadedmetadata', deck.onCanPlay)
      deck.audio.removeEventListener('canplay', deck.onCanPlay)
      deck.audio.removeEventListener('pause', deck.onPause)
      deck.audio.pause()
    }
    for (const src of [...this.files.keys()]) this.dropFile(src)
  }

  /** How the current song was loaded, for the sync log. */
  get source(): 'none' | 'downloading' | 'memory' | 'stream' {
    const src = this.active.src
    if (!src) return 'none'
    if (!this.deps.download) return 'stream'
    const entry = this.files.get(src)
    if (!entry) return 'none'
    return entry.file ? 'memory' : entry.failed ? 'stream' : 'downloading'
  }

  get downloadMs(): number {
    return (this.active.src && this.files.get(this.active.src)?.ms) || 0
  }

  /** The spare holds the next song and can start it without loading. */
  get nextReady(): boolean {
    const next = songPath(nextUp(this.queue)?.item)
    const standby = this.standby()
    return next !== null && standby !== null && standby.src === next && standby.ready
  }

  get leadS(): number {
    return this.seekLead
  }

  get startLeadS(): number {
    return this.startLead
  }

  /** The element playing the current song; it alternates between audio and spare. */
  get activeAudio(): AudioLike {
    return this.active.audio
  }

  private makeDeck(audio: AudioLike): Deck {
    audio.preservesPitch = true
    const deck: Deck = {
      audio,
      src: null,
      url: null,
      ready: false,
      onCanPlay: () => {
        if (deck.ready || deck.url === null) return
        deck.ready = true
        if (deck === this.active) this.apply()
      },
      // A call, Siri or AirPods paused the audio (Ruling R12). Pause events arrive in a later task, so the
      // player's own pauses have already cleared wantPlaying, and one that a newer play() overtook finds it playing.
      // The spare's events never count: the player pauses it itself.
      onPause: () => {
        if (deck !== this.active) return
        if (!this.wantPlaying || !audio.paused || audio.ended || this.playback.status !== 'playing') return
        this.wantPlaying = false
        this.blocked = true
        this.deps.onBlocked()
      },
    }
    // iOS may hold readyState at HAVE_METADATA until play(), so canplay can never come (Ruling R11).
    audio.addEventListener('loadedmetadata', deck.onCanPlay)
    audio.addEventListener('canplay', deck.onCanPlay)
    audio.addEventListener('pause', deck.onPause)
    return deck
  }

  private standby(): Deck | null {
    return this.decks.find((d) => d !== this.active) ?? null
  }

  private switchTo(src: string | null): void {
    this.clearLead()
    const standby = this.standby()
    if (src && standby && standby !== this.retiring && standby.src === src) {
      // The next song is already loaded: keep the old one playing until this one starts.
      this.stopRetiring()
      this.retiring = this.active.audio.paused ? null : this.active
      this.wantPlaying = false
      this.active = standby
      this.stats.handoffs++
      if (standby.ready) this.apply()
      return
    }
    this.stopRetiring()
    this.pauseAudio()
    this.loadDeck(this.active, src)
  }

  /** Loads the next song into the spare deck, or with one element just downloads it. */
  private preloadNext(): void {
    const next = songPath(nextUp(this.queue)?.item)
    const standby = this.standby()
    if (next) {
      if (!standby) this.withFile(next, () => {})
      else if (standby !== this.retiring && standby.src !== next) this.loadDeck(standby, next)
    }
    this.pruneFiles(next)
  }

  /**
   * Switches to the next song on this device's own clock, when the current one ends. The server starts the
   * next song at that same time (songEndsAt), so its update a moment later matches and changes nothing.
   */
  private scheduleHandoff(): void {
    this.clearHandoff()
    const current = this.current
    const p = this.playback
    if (!current || p.status !== 'playing' || this.blocked) return
    const up = nextUp(this.queue)
    if (!up || up.item.status !== 'ready') return // the server waits for a download instead
    const endsAt = songEndsAt(p, current.duration)
    // Early enough that the new deck can still call play() a full start lead before the boundary.
    const inMs = endsAt - this.deps.serverNow() - this.deps.delayMs() - this.startLead * 1000 - HANDOFF_EARLY_MS
    this.handoffTimer = setTimeout(
      () => {
        this.handoffTimer = null
        this.update(up.item, { status: 'playing', position: 0, at: endsAt }, up.rest)
      },
      Math.max(0, inMs),
    )
  }

  private loadDeck(deck: Deck, src: string | null): void {
    deck.src = src
    deck.url = null
    deck.ready = false
    if (!src) return
    this.withFile(src, (url) => {
      if (deck.src !== src || deck.url !== null) return // the deck moved on meanwhile
      deck.url = url
      deck.audio.src = url
      deck.audio.load() // iOS does not preload; apply() runs on loadedmetadata or canplay
      if (deck.audio.readyState >= HAVE_METADATA) deck.onCanPlay()
    })
  }

  /** Calls back with a URL for the song: the downloaded file, or the path to stream if downloading failed. */
  private withFile(src: string, done: (url: string) => void): void {
    const { download } = this.deps
    if (!download) return done(src)
    let entry = this.files.get(src)
    if (!entry) {
      const started = performance.now()
      const created: CachedFile = { ctrl: new AbortController(), file: null, failed: false, ms: 0, waiters: [] }
      entry = created
      this.files.set(src, created)
      download(src, created.ctrl.signal).then(
        (file) => {
          if (this.files.get(src) !== created) return file.release() // no longer needed
          created.file = file
          created.ms = Math.round(performance.now() - started)
          for (const w of created.waiters.splice(0)) w(file.url)
        },
        () => {
          if (this.files.get(src) !== created) return
          created.failed = true
          for (const w of created.waiters.splice(0)) w(src) // stream it instead
        },
      )
    }
    if (entry.file) return done(entry.file.url)
    if (entry.failed) return done(src)
    entry.waiters.push(done)
  }

  /** Frees every downloaded song that no deck holds and that is not next. */
  private pruneFiles(next: string | null): void {
    const keep = new Set([next, ...this.decks.map((d) => d.src)])
    for (const src of [...this.files.keys()]) if (!keep.has(src)) this.dropFile(src)
  }

  private dropFile(src: string): void {
    const entry = this.files.get(src)
    if (!entry) return
    this.files.delete(src)
    entry.ctrl.abort()
    entry.file?.release()
  }

  private apply(): void {
    this.clearLead()
    if (!this.active.ready) return
    const p = this.playback
    if (p.status !== 'playing') {
      this.stopRetiring()
      this.pauseAudio()
      this.setRate(1)
      this.park(p.position)
      return
    }
    // Call play() early by the start lead, so the media clock starts moving right on time.
    const startInMs = p.at - this.deps.serverNow() - this.deps.delayMs() - this.startLead * 1000
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
    const { audio } = this.active
    if (this.blocked) return this.stopRetiring()
    // The old song plays to the boundary, where the new one, started early, begins to sound.
    this.retireAtBoundary()
    // From pause, play() takes the start lead to get going; on an element that already plays it is just a seek.
    // Before the start time the target is behind the start position by the time left, so this parks on it.
    const lead = audio.paused ? this.startLead : this.seekLead
    this.park(this.target() + lead)
    this.landing = audio.paused ? 'start' : 'seek'
    this.setRate(1)
    this.settle()
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

  private retireAtBoundary(): void {
    if (!this.retiring) return
    if (this.retireTimer) clearTimeout(this.retireTimer)
    const inMs = this.playback.at - this.deps.serverNow() - this.deps.delayMs()
    if (inMs <= 0) return this.stopRetiring()
    this.retireTimer = setTimeout(() => this.stopRetiring(), inMs)
  }

  private learn(kind: 'seek' | 'start', drift: number): void {
    const old = kind === 'seek' ? this.seekLead : this.startLead
    const lead = clampLead(old - LEAD_GAIN * drift)
    if (lead === old) return
    if (kind === 'seek') {
      this.seekLead = lead
      this.deps.onSeekLead?.(lead)
    } else {
      this.startLead = lead
      this.deps.onStartLead?.(lead)
      this.scheduleHandoff() // the next song must now start earlier or later
    }
  }

  private stopRetiring(): void {
    if (this.retireTimer) clearTimeout(this.retireTimer)
    this.retireTimer = null
    const deck = this.retiring
    if (!deck) return
    this.retiring = null
    deck.audio.pause()
    this.preloadNext() // the deck is free for the song after this one
  }

  /** Every pause the player makes goes through here, so onPause can tell them from external ones. */
  private pauseAudio(): void {
    this.wantPlaying = false
    this.active.audio.pause()
  }

  private park(position: number): void {
    const { audio } = this.active
    if (Math.abs(audio.currentTime - position) > PARK_TOLERANCE_S) audio.currentTime = position
  }

  /** iOS may restart its time-stretching on every write, so write only real changes. */
  private setRate(rate: number): void {
    if (this.active.audio.playbackRate === rate) return
    this.active.audio.playbackRate = rate
    this.stats.rateWrites++
  }

  private settle(): void {
    this.settleUntil = this.deps.serverNow() + (this.deps.settleMs ?? SETTLE_MS)
  }

  private target(): number {
    return targetPosition(this.playback, this.deps.serverNow(), this.deps.delayMs())
  }

  private clearLead(): void {
    if (this.leadTimer) clearTimeout(this.leadTimer)
    this.leadTimer = null
  }

  private clearHandoff(): void {
    if (this.handoffTimer) clearTimeout(this.handoffTimer)
    this.handoffTimer = null
  }
}
