import { useCallback, useEffect, useRef, useState } from 'react'
import { io, type Socket } from 'socket.io-client'
import type { Ack, Activity, StationState } from '@music-station/shared'
import { ClockSync } from './clockSync'
import { downloadSong } from './download'
import { SyncPlayer } from './player'
import {
  clampDelay,
  getClientId,
  getDelayMs,
  getNickname,
  getSeekLeadMs,
  getStartLeadMs,
  getUpdateReload,
  saveDelayMs,
  saveNickname,
  saveSeekLeadMs,
  saveStartLeadMs,
  saveUpdateReload,
} from './storage'

export type ActionEvent =
  | 'queue:add'
  | 'queue:remove'
  | 'queue:move'
  | 'player:play'
  | 'player:pause'
  | 'player:skip'
  | 'player:seek'
  | 'station:autoplay'

export interface Toast {
  id: number
  text: string
  kind: 'info' | 'error'
}

export interface DebugInfo {
  offsetMs: number
  rttMs: number
  driftMs: number | null
}

export interface Station {
  clientId: string
  state: StationState | null
  connected: boolean
  joined: boolean
  blocked: boolean
  toasts: Toast[]
  delayMs: number
  join(nickname: string): Promise<Ack>
  send(event: ActionEvent, payload?: object): Promise<Ack>
  resume(): void
  setDelayMs(ms: number): void
  serverNow(): number
  debug(): DebugInfo
  notify(text: string, kind?: Toast['kind']): void
}

interface Connection {
  socket: Socket
  clock: ClockSync
  player: SyncPlayer
  audio: HTMLAudioElement
  /** Loads the next song while the current one plays; the player alternates between the two. */
  spare: HTMLAudioElement
  /** Hands the latest state to the player once joined and the clock is measured. */
  sync(): void
}

// 8 samples of 8-bit silence. Playing it inside the Listen tap unlocks the element on iOS.
const SILENCE = 'data:audio/wav;base64,UklGRiwAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQgAAACAgICAgICAgA=='
const TOAST_MS = 4_000
const RESYNC_MS = 30_000
const SYNC_REPORT_MS = 5_000
const JOIN_TIMEOUT_MS = 10_000
/** A tab reloads itself for a new version at most this often, so a stale cache cannot make it loop. */
const UPDATE_RELOAD_GUARD_MS = 60_000

/**
 * iOS loses about a quarter second of playback on every playbackRate change, so steering the rate makes it fall
 * further behind. Every iOS browser runs WebKit, and an iPad reports itself as a Mac with a touch screen.
 */
function isIOS(): boolean {
  const ua = navigator.userAgent
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
}

/** The web build this page runs, named by its hashed main script; null in development. Compare webVersionOf(). */
function pageVersion(): string | null {
  return document.querySelector('script[type="module"][src^="/assets/"]')?.getAttribute('src') ?? null
}

/** The nickname to rejoin with when this tab, joined, just reloaded itself for a new version, else ''. */
function rejoinAfterUpdate(): string {
  const r = getUpdateReload()
  return r.rejoin && Date.now() - r.at < UPDATE_RELOAD_GUARD_MS ? getNickname() : ''
}
const ACTION_TIMEOUT_MS = 30_000

async function ask(socket: Socket, event: string, payload: unknown, timeoutMs: number): Promise<Ack> {
  try {
    return (await socket.timeout(timeoutMs).emitWithAck(event, payload)) as Ack
  } catch {
    return { ok: false, error: 'The station did not answer. Check your connection.' }
  }
}

export function sendAction(socket: Socket, event: ActionEvent, payload: object): Promise<Ack> {
  // Socket.IO buffers emits while offline and sends them before the rejoin, so the server would refuse them.
  if (!socket.connected) return Promise.resolve({ ok: false, error: 'Reconnecting, try again in a moment' })
  return ask(socket, event, payload, ACTION_TIMEOUT_MS)
}

export function useStation(): Station {
  const [clientId] = useState(() => getClientId())
  const [state, setState] = useState<StationState | null>(null)
  const [connected, setConnected] = useState(false)
  const [joined, setJoined] = useState(false)
  const [blocked, setBlocked] = useState(false)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [delayMs, setDelay] = useState(() => getDelayMs())
  const delayRef = useRef(delayMs)
  const nicknameRef = useRef<string | null>(null)
  const blockedRef = useRef(false)
  blockedRef.current = blocked
  const conn = useRef<Connection | null>(null)
  const toastId = useRef(0)

  const notify = useCallback((text: string, kind: Toast['kind'] = 'info') => {
    const id = ++toastId.current
    setToasts((list) => [...list.slice(-3), { id, text, kind }])
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), TOAST_MS)
  }, [])

  useEffect(() => {
    const audio = new Audio()
    audio.preload = 'auto'
    const spare = new Audio()
    spare.preload = 'auto'
    const socket = io()
    const clock = new ClockSync(() => socket.timeout(2_000).emitWithAck('time:ping', Date.now()))
    const player = new SyncPlayer({
      audio,
      spare,
      serverNow: () => clock.serverNow(),
      delayMs: () => delayRef.current,
      onBlocked: () => setBlocked(true),
      seekLeadS: getSeekLeadMs() / 1000,
      onSeekLead: (s) => saveSeekLeadMs(s * 1000),
      startLeadS: getStartLeadMs() / 1000,
      onStartLead: (s) => saveStartLeadMs(s * 1000),
      fixedRate: isIOS(),
      download: async (url, signal) => {
        const blobUrl = URL.createObjectURL(await downloadSong(url, signal))
        return { url: blobUrl, release: () => URL.revokeObjectURL(blobUrl) }
      },
    })

    let latest: StationState | null = null
    const handToPlayer = () => {
      if (latest && nicknameRef.current) player.update(latest.current, latest.playback, latest.queue)
    }
    const sync = () => {
      if (clock.synced) handToPlayer()
      else void clock.measure().then(handToPlayer)
    }
    conn.current = { socket, clock, player, audio, spare, sync }

    socket.on('connect', () => {
      setConnected(true)
      void clock.measure().then(handToPlayer)
      const nickname = nicknameRef.current
      if (!nickname) return
      // Rejoin after a drop. Staying on this screen keeps the player's file; going back to Join would not.
      void ask(socket, 'join', { clientId, nickname }, JOIN_TIMEOUT_MS).then((res) => {
        if (!res.ok) notify(`Could not rejoin the station: ${res.error}`, 'error')
      })
    })
    socket.on('disconnect', () => setConnected(false))
    socket.on('state', (s: StationState) => {
      latest = s
      setState(s)
      sync()
    })
    socket.on('activity', (a: Activity) => notify(a.text))
    // The server sends its build on every connect. After a deploy the restart drops this socket, the
    // reconnect brings the new build, and the page reloads itself into it.
    socket.on('hello', ({ webVersion }: { webVersion?: string }) => {
      const own = pageVersion()
      if (!webVersion || !own || webVersion === own) return
      if (Date.now() - getUpdateReload().at < UPDATE_RELOAD_GUARD_MS) return // the last reload did not bring it
      saveUpdateReload({ at: Date.now(), rejoin: nicknameRef.current !== null })
      window.location.reload()
    })

    // Sends this device's sync status to the server log (SYNC_LOG=1), since phones have no console to read.
    let stalls = 0
    const onStall = () => stalls++
    audio.addEventListener('waiting', onStall)
    spare.addEventListener('waiting', onStall)
    let prev: { media: number; wall: number; jumps: number } | null = null
    const report = setInterval(() => {
      if (!nicknameRef.current || latest?.playback.status !== 'playing') return (prev = null)
      const el = player.activeAudio as HTMLAudioElement
      // The speed the element really played at since the last report, to check that iOS applies playbackRate.
      const sample = { media: el.currentTime, wall: performance.now(), jumps: player.stats.seeks + player.stats.handoffs }
      const effRate =
        prev && prev.jumps === sample.jumps && !el.paused
          ? Math.round(((sample.media - prev.media) / ((sample.wall - prev.wall) / 1000)) * 1000) / 1000
          : null
      prev = sample
      const buffered = el.buffered.length ? el.buffered.end(el.buffered.length - 1) : 0
      socket.emit('debug:sync', {
        driftMs: player.lastDrift === null ? null : Math.round(player.lastDrift * 1000),
        offsetMs: Math.round(clock.offset),
        rttMs: Number.isFinite(clock.rtt) ? Math.round(clock.rtt) : null,
        delayMs: delayRef.current,
        source: player.source,
        downloadMs: player.downloadMs,
        seeks: player.stats.seeks,
        rateWrites: player.stats.rateWrites,
        handoffs: player.stats.handoffs,
        nextReady: player.nextReady,
        leadMs: Math.round(player.leadS * 1000),
        startLeadMs: Math.round(player.startLeadS * 1000),
        stalls,
        rate: el.playbackRate,
        effRate,
        paused: el.paused,
        readyState: el.readyState,
        timeS: Math.round(el.currentTime * 10) / 10,
        bufferedS: Math.round(buffered * 10) / 10,
        blocked: blockedRef.current,
        ua: navigator.userAgent.slice(0, 120),
      })
    }, SYNC_REPORT_MS)

    // realign() restarts audio that stopped without a banner; it never touches audio that is playing.
    const resync = setInterval(() => void clock.measure().then(() => player.realign()), RESYNC_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') void clock.measure().then(() => player.realign())
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      clearInterval(report)
      audio.removeEventListener('waiting', onStall)
      spare.removeEventListener('waiting', onStall)
      clearInterval(resync)
      document.removeEventListener('visibilitychange', onVisible)
      socket.disconnect()
      player.destroy()
      conn.current = null
    }
  }, [clientId, notify])

  const join = useCallback(
    async (nickname: string): Promise<Ack> => {
      const c = conn.current
      if (!c) return { ok: false, error: 'Still connecting…' }
      // This must run before the first await, while the browser still counts the Listen tap.
      // iOS unlocks each element separately, so the spare that holds the next song needs this tap too.
      for (const el of [c.audio, c.spare]) {
        el.src = SILENCE
        el.play().then(
          () => {
            if (el.src === SILENCE) el.pause()
          },
          () => {},
        )
      }
      const res = await ask(c.socket, 'join', { clientId, nickname }, JOIN_TIMEOUT_MS)
      if (res.ok) {
        nicknameRef.current = nickname
        saveNickname(nickname)
        setJoined(true)
        c.sync()
      }
      return res
    },
    [clientId],
  )

  // After reloading itself for a new version, the tab rejoins on its own. Without a tap the browser may
  // block the sound; the player then shows the "Tap to resume audio" banner, which unlocks it.
  const pendingRejoin = useRef(rejoinAfterUpdate())
  useEffect(() => {
    const nickname = pendingRejoin.current
    if (!connected || joined || !nickname) return
    pendingRejoin.current = ''
    void join(nickname).then((res) => {
      if (res.ok) notify('Updated to the latest version')
    })
  }, [connected, joined, join, notify])

  const send = useCallback(
    async (event: ActionEvent, payload: object = {}): Promise<Ack> => {
      const c = conn.current
      if (!c) return { ok: false, error: 'Not connected' }
      const res = await sendAction(c.socket, event, payload)
      if (!res.ok) notify(res.error, 'error')
      return res
    },
    [notify],
  )

  const resume = useCallback(() => {
    setBlocked(false)
    conn.current?.player.resume()
  }, [])

  const setDelayMs = useCallback((ms: number) => {
    const value = clampDelay(ms)
    delayRef.current = value
    saveDelayMs(value)
    setDelay(value)
  }, [])

  const serverNow = useCallback(() => conn.current?.clock.serverNow() ?? Date.now(), [])

  const debug = useCallback((): DebugInfo => {
    const c = conn.current
    const drift = c?.player.lastDrift ?? null
    return {
      offsetMs: c?.clock.offset ?? 0,
      rttMs: c?.clock.rtt ?? Number.POSITIVE_INFINITY,
      driftMs: drift === null ? null : drift * 1000,
    }
  }, [])

  return {
    clientId,
    state,
    connected,
    joined,
    blocked,
    toasts,
    delayMs,
    join,
    send,
    resume,
    setDelayMs,
    serverNow,
    debug,
    notify,
  }
}
