import type { DesktopCommand, NowPlaying } from '@music-station/shared'

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

/** The page's nowPlaying message, or null for nothing current or anything that is not one. The page is a remote site. */
export function parseNowPlaying(value: unknown): NowPlaying | null {
  if (typeof value !== 'object' || value === null) return null
  const { title, channel, status } = value as Record<string, unknown>
  if (typeof title !== 'string' || typeof channel !== 'string') return null
  if (status !== 'playing' && status !== 'paused' && status !== 'waiting') return null
  return { title, channel, status }
}

/** Menus on Mac and Windows read & as a keyboard-shortcut marker; && shows one &. */
export function escapeMnemonic(label: string): string {
  return label.replaceAll('&', '&&')
}
