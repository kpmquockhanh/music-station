import { useEffect, useRef } from 'react'
import {
  expectedPosition,
  UP_NEXT_LIMIT,
  type DesktopBridge,
  type DesktopCommand,
  type DesktopReply,
  type DesktopRequest,
  type NowPlaying,
  type StationState,
  type UpNext,
} from '@music-station/shared'
import { classifyInput } from './format'
import { searchSongs } from './search'
import type { ActionEvent, Station } from './useStation'

/** The bridge inside the desktop app, otherwise null. */
export function getDesktop(win: { desktop?: unknown } = window as unknown as { desktop?: unknown }): DesktopBridge | null {
  const desktop = win.desktop
  return typeof desktop === 'object' && desktop !== null ? (desktop as DesktopBridge) : null
}

/**
 * What the app's menu bar shows: the song and the station status while joined, otherwise null.
 * `blocked` is whether this computer stopped while the station plays on.
 * Given the time, it adds the position, moved onto this computer's clock.
 */
export function nowPlayingOf(
  state: StationState | null,
  joined: boolean,
  blocked = false,
  clock?: { serverNow: number; localNow: number },
): NowPlaying | null {
  const current = state?.current
  if (!joined || !state || !current) return null
  const { title, channel, thumbnail, duration } = current
  const info: NowPlaying = { title, channel, status: state.playback.status, thumbnail, duration, stoppedHere: blocked }
  if (!clock) return info
  return { ...info, position: expectedPosition(state.playback, clock.serverNow), at: clock.localNow }
}

/** Sends the song to an app whose bridge can take it. */
export function reportNowPlaying(bridge: DesktopBridge | null, info: NowPlaying | null): void {
  if (typeof bridge?.nowPlaying === 'function') bridge.nowPlaying(info)
}

const ACTIONS: Partial<Record<DesktopCommand, ActionEvent>> = { play: 'player:play', pause: 'player:pause', skip: 'player:skip' }

/** What this computer does alone: stop, as when it goes to sleep, and start again. */
export interface HereControls {
  pauseHere(): void
  resume(): void
}

/**
 * Runs the app's tray commands: play, pause and skip as station actions, and pauseHere and resumeHere on this
 * computer only. Returns the function that stops listening, or null.
 */
export function listenForCommands(
  bridge: DesktopBridge | null,
  send: (event: ActionEvent) => unknown,
  here: HereControls,
): (() => void) | null {
  if (typeof bridge?.onCommand !== 'function') return null
  const stop = bridge.onCommand((command) => {
    if (command === 'pauseHere') here.pauseHere()
    else if (command === 'resumeHere') here.resume()
    else if (Object.hasOwn(ACTIONS, command)) void send(ACTIONS[command]!)
  })
  return typeof stop === 'function' ? stop : null
}

/** The queue the app's menu-bar card shows while joined, otherwise null. */
export function upNextOf(state: StationState | null, joined: boolean): UpNext | null {
  if (!joined || !state) return null
  const songs = state.queue
    .slice(0, UP_NEXT_LIMIT)
    .map(({ title, duration, thumbnail, addedBy, status }) => ({ title, duration, thumbnail, addedBy, status }))
  return { songs, total: state.queue.length }
}

/** Sends the queue to an app whose bridge can take it. */
export function reportUpNext(bridge: DesktopBridge | null, upNext: UpNext | null): void {
  if (typeof bridge?.upNext === 'function') bridge.upNext(upNext)
}

type Send = (event: ActionEvent, payload?: object) => Promise<{ ok: true } | { ok: false; error: string }>

/** Does what the menu-bar card asks, as the Search box does. Anything that is not a request gets an error. */
export async function answerRequest(request: DesktopRequest, send: Send, search = searchSongs): Promise<DesktopReply> {
  if (request?.kind === 'add' && typeof request.videoId === 'string') {
    return send('queue:add', { input: request.videoId })
  }
  if (request?.kind !== 'submit' || typeof request.text !== 'string') return { ok: false, error: 'Unknown request' }
  const input = classifyInput(request.text)
  if (input.kind === 'empty') return { ok: false, error: 'Type a song name or paste a YouTube link' }
  if (input.kind === 'bad-link') return { ok: false, error: 'That link has no YouTube video in it' }
  if (input.kind === 'link') return send('queue:add', { input: input.videoId })
  return search(input.query)
}

/** Answers the app's card requests. Returns the function that stops listening, or null. */
export function listenForRequests(bridge: DesktopBridge | null, send: Send): (() => void) | null {
  if (typeof bridge?.onRequest !== 'function') return null
  const stop = bridge.onRequest((request) => answerRequest(request, send))
  return typeof stop === 'function' ? stop : null
}

/** Reports the song to the desktop app and runs its tray commands as station actions. Does nothing in a browser. */
export function useDesktopBridge(station: Station): void {
  // A string key, so a new state object with the same song, status and playback sends nothing.
  const key = JSON.stringify([nowPlayingOf(station.state, station.joined, station.blocked), station.state?.playback])
  const { send, serverNow, pauseHere, resume } = station
  const latest = useRef(station)
  latest.current = station
  useEffect(() => {
    const { state, joined, blocked } = latest.current
    reportNowPlaying(getDesktop(), nowPlayingOf(state, joined, blocked, { serverNow: serverNow(), localNow: Date.now() }))
  }, [key, serverNow])
  useEffect(() => listenForCommands(getDesktop(), send, { pauseHere, resume }) ?? undefined, [send, pauseHere, resume])
  const upNextKey = JSON.stringify(upNextOf(station.state, station.joined))
  useEffect(() => reportUpNext(getDesktop(), upNextOf(latest.current.state, latest.current.joined)), [upNextKey])
  useEffect(() => listenForRequests(getDesktop(), send) ?? undefined, [send])
}
