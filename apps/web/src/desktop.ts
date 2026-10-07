import { useEffect } from 'react'
import type { DesktopBridge, DesktopCommand, NowPlaying, StationState } from '@music-station/shared'
import type { ActionEvent, Station } from './useStation'

/** The bridge inside the desktop app, otherwise null. */
export function getDesktop(win: { desktop?: unknown } = window as unknown as { desktop?: unknown }): DesktopBridge | null {
  const desktop = win.desktop
  return typeof desktop === 'object' && desktop !== null ? (desktop as DesktopBridge) : null
}

/** What the app's tray shows: the song and the station status while joined, otherwise null. */
export function nowPlayingOf(state: StationState | null, joined: boolean): NowPlaying | null {
  const current = state?.current
  if (!joined || !state || !current) return null
  return { title: current.title, channel: current.channel, status: state.playback.status }
}

/** Sends the song to an app whose bridge can take it. */
export function reportNowPlaying(bridge: DesktopBridge | null, info: NowPlaying | null): void {
  if (typeof bridge?.nowPlaying === 'function') bridge.nowPlaying(info)
}

const ACTIONS: Record<DesktopCommand, ActionEvent> = { play: 'player:play', pause: 'player:pause', skip: 'player:skip' }

/** Runs the app's tray commands as station actions. Returns the function that stops listening, or null. */
export function listenForCommands(
  bridge: DesktopBridge | null,
  send: (event: ActionEvent) => unknown,
): (() => void) | null {
  if (typeof bridge?.onCommand !== 'function') return null
  const stop = bridge.onCommand((command) => {
    if (Object.hasOwn(ACTIONS, command)) void send(ACTIONS[command])
  })
  return typeof stop === 'function' ? stop : null
}

/** Reports the song to the desktop app and runs its tray commands as station actions. Does nothing in a browser. */
export function useDesktopBridge(station: Station): void {
  // A string key, so a new state object with the same song and status sends nothing.
  const key = JSON.stringify(nowPlayingOf(station.state, station.joined))
  const { send } = station
  useEffect(() => {
    reportNowPlaying(getDesktop(), JSON.parse(key) as NowPlaying | null)
  }, [key])
  useEffect(() => listenForCommands(getDesktop(), send) ?? undefined, [send])
}
