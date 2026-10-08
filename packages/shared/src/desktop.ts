import type { Playback, QueueItemStatus, SearchResult } from './types'

/** The song the desktop app's menu bar shows. The optional fields are missing from pages older than them. */
export interface NowPlaying {
  title: string
  channel: string
  status: Playback['status']
  thumbnail?: string
  /** Seconds. */
  duration?: number
  /** Seconds into the song at `at`, a time on this computer's clock in ms. While playing it moves on from there. */
  position?: number
  at?: number
  /** This computer stopped while the station plays on, as after sleep or the Pause key, until it resumes. */
  stoppedHere?: boolean
}

/** A song in the card's Up next list. */
export interface UpNextSong {
  title: string
  /** Seconds. */
  duration: number
  thumbnail: string
  addedBy: string
  status: QueueItemStatus
}

/** The queue the card shows: its first songs and how many there are in all. */
export interface UpNext {
  songs: UpNextSong[]
  total: number
}

/** The most songs the page sends; the window shows the rest. */
export const UP_NEXT_LIMIT = 20

/**
 * What the menu-bar card asks the page to do, since only the page talks to the station.
 * `submit` is the search box: a YouTube link adds the video, other text searches. `add` adds a search result.
 */
export type DesktopRequest = { kind: 'submit'; text: string } | { kind: 'add'; videoId: string }

/** The page's answer. A search answers with its results, and an add with none. */
export type DesktopReply = { ok: true; results?: SearchResult[] } | { ok: false; error: string }

/**
 * A tray command. The page sends play, pause and skip as the station action of the same name, for everyone.
 * pauseHere and resumeHere stop and restart this computer only. Pages older than them ignore them.
 */
export type DesktopCommand = 'play' | 'pause' | 'skip' | 'pauseHere' | 'resumeHere'

/**
 * What the desktop app's preload puts on window.desktop. Every function is optional and checked before each call,
 * so a page newer than the installed app only misses what that app lacks.
 */
export interface DesktopBridge {
  /** null when nothing is current. */
  nowPlaying?(info: NowPlaying | null): void
  /** Returns a function that stops listening. */
  onCommand?(fn: (command: DesktopCommand) => void): () => void
  /** null while not joined. */
  upNext?(queue: UpNext | null): void
  /** Answers the card's requests. Returns a function that stops listening. */
  onRequest?(fn: (request: DesktopRequest) => Promise<DesktopReply>): () => void
}
