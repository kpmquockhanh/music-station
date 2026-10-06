export const START_LEAD_MS = 1000
export const MAX_QUEUE = 200
export const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/

export type QueueItemStatus = 'downloading' | 'ready' | 'failed'

export interface QueueItem {
  id: string // uuid; one video can be queued more than once
  videoId: string
  title: string
  channel: string
  duration: number // seconds
  thumbnail: string
  addedBy: string // nickname
  status: QueueItemStatus
}

export interface Playback {
  status: 'playing' | 'paused' | 'waiting' // waiting = current song still downloading
  position: number // seconds into the song…
  at: number // …at this server time (ms)
}

export interface Listener {
  id: string
  nickname: string
}

export interface StationState {
  current: QueueItem | null // null = idle
  queue: QueueItem[] // upcoming, in order
  playback: Playback
  listeners: Listener[]
}

export interface SearchResult {
  videoId: string
  title: string
  channel: string
  duration: number | null
  thumbnail: string
}

export interface VideoInfo {
  videoId: string
  title: string
  channel: string
  duration: number
  thumbnail: string
}

export type Ack = { ok: true } | { ok: false; error: string }

export interface Activity {
  text: string
  at: number
}
