import {
  UP_NEXT_LIMIT,
  VIDEO_ID_RE,
  type DesktopCommand,
  type DesktopReply,
  type NowPlaying,
  type SearchResult,
  type UpNext,
  type UpNextSong,
} from '@music-station/shared'

export type TrayCommand = DesktopCommand | 'show' | 'station' | 'quit'
export type TrayItem = { label: string; enabled: boolean; command?: TrayCommand } | { separator: true }

const MAX_LINE = 60

/** The menu's first line: the song and its channel on one line, cut to fit. */
export function songLine(info: NowPlaying | null): string {
  if (!info) return 'Nothing playing'
  const fold = (s: string) => s.replace(/\s+/g, ' ').trim()
  const title = fold(info.title) || 'Unknown song'
  const channel = fold(info.channel)
  const chars = Array.from(channel ? `${title} — ${channel}` : title) // code points, so emoji stay whole
  return chars.length > MAX_LINE ? `${chars.slice(0, MAX_LINE - 1).join('').trimEnd()}…` : chars.join('')
}

export function trayMenu(info: NowPlaying | null): TrayItem[] {
  const playing = info?.status === 'playing'
  return [
    { label: songLine(info), enabled: false },
    {
      label: playing ? 'Pause for everyone' : 'Play for everyone',
      // While the song downloads, the server cannot play or pause it yet.
      enabled: info !== null && info.status !== 'waiting',
      command: playing ? 'pause' : 'play',
    },
    { label: 'Skip for everyone', enabled: info !== null, command: 'skip' },
    { separator: true },
    { label: 'Show window', enabled: true, command: 'show' },
    { label: 'Change station…', enabled: true, command: 'station' },
    { label: 'Quit', enabled: true, command: 'quit' },
  ]
}

/** Seconds into the song at `now` (ms), or null for a page that sends no timing. */
export function positionAt(info: NowPlaying, now: number): number | null {
  const { duration, position, at } = info
  if (duration === undefined || position === undefined || at === undefined) return null
  const moved = info.status === 'playing' ? Math.max(0, now - at) / 1000 : 0
  return Math.min(duration, position + moved)
}

/** m:ss, rounded up so a countdown shows 0:00 only at the end. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds - 1e-9))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** The text beside the Mac menu-bar icon: the time left while playing, otherwise the status. */
export function menuBarTitle(info: NowPlaying | null, now: number): string {
  if (!info) return ''
  if (info.status === 'paused') return 'Paused'
  if (info.status === 'waiting') return 'Loading'
  const position = positionAt(info, now)
  return position === null || info.duration === undefined ? '' : clock(info.duration - position)
}

/** What the card under the Mac menu-bar icon shows. */
export interface CardView {
  title: string
  subtitle: string
  thumbnail: string | null
  /** 0 to 1, or null without timing. */
  progress: number | null
  /** How much progress a second adds, so the card can move the bar smoothly between updates. 0 unless playing. */
  speed: number
  footer: string
  toggle: { command: 'play' | 'pause'; label: string; enabled: boolean }
  canSkip: boolean
  /** The search box and the Up next list, or null for a station page that cannot answer the card. */
  queue: { rows: UpNextRow[]; more: number } | null
}

export interface UpNextRow {
  title: string
  /** Its length and who added it, such as 3:45 · Minh. */
  detail: string
  thumbnail: string | null
  /** Set while the song is not ready to play. */
  badge: string | null
}

/**
 * `timeOfDay` formats a time on this computer's clock, such as 9:43 PM. `upNext` is null when the station page
 * cannot answer the card's requests, which hides the search box and the list.
 */
export function cardView(
  info: NowPlaying | null,
  now: number,
  timeOfDay: (ms: number) => string,
  upNext: UpNext | null = null,
): CardView {
  const queue = upNext && {
    rows: upNext.songs.map((song) => ({
      title: fold(song.title) || 'Unknown song',
      detail: [clock(song.duration), fold(song.addedBy)].filter(Boolean).join(' · '),
      thumbnail: song.thumbnail || null,
      badge: song.status === 'downloading' ? 'Getting ready' : song.status === 'failed' ? 'Failed' : null,
    })),
    more: upNext.total - upNext.songs.length,
  }
  if (!info) {
    return {
      title: 'Nothing playing',
      subtitle: 'Click to add a song',
      thumbnail: null,
      progress: null,
      speed: 0,
      footer: '',
      toggle: { command: 'play', label: 'Play for everyone', enabled: false },
      canSkip: false,
      queue,
    }
  }
  const channel = fold(info.channel)
  const position = positionAt(info, now)
  const duration = info.duration ?? 0
  const timed = position !== null && duration > 0
  const left = timed ? duration - position : 0
  const playing = info.status === 'playing'
  const state = {
    playing: timed ? `${clock(left)} left` : '',
    paused: 'Paused',
    waiting: 'Getting ready',
  }[info.status]
  const footer =
    info.status === 'waiting'
      ? 'Preparing audio for everyone…'
      : !timed
        ? ''
        : playing
          ? `Ends at ${timeOfDay(now + Math.ceil(left) * 1000)}`
          : `${clock(position)} of ${clock(duration)}`
  return {
    title: fold(info.title) || 'Unknown song',
    subtitle: [channel, state].filter(Boolean).join(' • '),
    thumbnail: info.thumbnail ?? null,
    progress: timed ? position / duration : null,
    speed: timed && playing ? 1 / duration : 0,
    footer,
    toggle: {
      command: playing ? 'pause' : 'play',
      label: playing ? 'Pause for everyone' : 'Play for everyone',
      // While the song downloads, the server cannot play or pause it yet.
      enabled: info.status !== 'waiting',
    },
    canSkip: true,
    queue,
  }
}

const fold = (s: string) => s.replace(/\s+/g, ' ').trim()
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
const httpsOrEmpty = (url: unknown) => (typeof url === 'string' && url.startsWith('https://') ? url : '')

/** The page's queue for the card, or null for anything that is not one. The page is a remote site. */
export function parseUpNext(value: unknown): UpNext | null {
  if (typeof value !== 'object' || value === null) return null
  const { songs, total } = value as Record<string, unknown>
  if (!Array.isArray(songs) || !finite(total)) return null
  const parsed = songs.slice(0, UP_NEXT_LIMIT).flatMap((song: unknown): UpNextSong[] => {
    if (typeof song !== 'object' || song === null) return []
    const { title, duration, thumbnail, addedBy, status } = song as Record<string, unknown>
    if (typeof title !== 'string' || typeof addedBy !== 'string') return []
    if (status !== 'downloading' && status !== 'ready' && status !== 'failed') return []
    return [{ title, duration: finite(duration) && duration > 0 ? duration : 0, thumbnail: httpsOrEmpty(thumbnail), addedBy, status }]
  })
  return { songs: parsed, total: Math.max(parsed.length, Math.floor(total)) }
}

/** The page's answer to a card request. Anything malformed becomes an error. The page is a remote site. */
export function parseReply(value: unknown): DesktopReply {
  const broken: DesktopReply = { ok: false, error: 'The station sent an answer the app does not understand.' }
  if (typeof value !== 'object' || value === null) return broken
  const { ok, error, results } = value as Record<string, unknown>
  if (ok === false) return { ok: false, error: typeof error === 'string' && error ? error.slice(0, 200) : 'Something went wrong' }
  if (ok !== true) return broken
  if (results === undefined) return { ok: true }
  if (!Array.isArray(results)) return broken
  const parsed = results.slice(0, 50).flatMap((result: unknown): SearchResult[] => {
    if (typeof result !== 'object' || result === null) return []
    const { videoId, title, channel, duration, thumbnail } = result as Record<string, unknown>
    if (typeof videoId !== 'string' || !VIDEO_ID_RE.test(videoId) || typeof title !== 'string') return []
    return [
      {
        videoId,
        title,
        channel: typeof channel === 'string' ? channel : '',
        duration: finite(duration) && duration > 0 ? duration : null,
        thumbnail: httpsOrEmpty(thumbnail),
      },
    ]
  })
  return { ok: true, results: parsed }
}

/** The page's nowPlaying message, or null for nothing current or anything that is not one. The page is a remote site. */
export function parseNowPlaying(value: unknown): NowPlaying | null {
  if (typeof value !== 'object' || value === null) return null
  const { title, channel, status } = value as Record<string, unknown>
  if (typeof title !== 'string' || typeof channel !== 'string') return null
  if (status !== 'playing' && status !== 'paused' && status !== 'waiting') return null
  const info: NowPlaying = { title, channel, status }
  const { thumbnail, duration, position, at } = value as Record<string, unknown>
  // The card shows the thumbnail as an image, so only a web address will do.
  if (typeof thumbnail === 'string' && thumbnail.startsWith('https://')) info.thumbnail = thumbnail
  const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
  if (finite(duration) && duration > 0) {
    info.duration = duration
    if (finite(position) && position >= 0 && finite(at)) Object.assign(info, { position, at })
  }
  return info
}

/** Menus on Mac and Windows read & as a keyboard-shortcut marker; && shows one &. */
export function escapeMnemonic(label: string): string {
  return label.replaceAll('&', '&&')
}
