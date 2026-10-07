import type { Playback } from './types'

/** The song the desktop app's tray menu shows. */
export interface NowPlaying {
  title: string
  channel: string
  status: Playback['status']
}

/** A tray command, which the page sends as the station action of the same name. */
export type DesktopCommand = 'play' | 'pause' | 'skip'

/**
 * What the desktop app's preload puts on window.desktop. Every function is optional and checked before each call,
 * so a page newer than the installed app only misses what that app lacks.
 */
export interface DesktopBridge {
  /** null when nothing is current. */
  nowPlaying?(info: NowPlaying | null): void
  /** Returns a function that stops listening. */
  onCommand?(fn: (command: DesktopCommand) => void): () => void
}
