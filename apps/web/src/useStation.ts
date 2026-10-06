import { useCallback, useEffect, useRef, useState } from 'react'
import { io, type Socket } from 'socket.io-client'
import type { Ack, Activity, StationState } from '@music-station/shared'
import { ClockSync } from './clockSync'
import { SyncPlayer } from './player'
import { clampDelay, getClientId, getDelayMs, saveDelayMs, saveNickname } from './storage'

export type ActionEvent =
  | 'queue:add'
  | 'queue:remove'
  | 'queue:move'
  | 'player:play'
  | 'player:pause'
  | 'player:skip'
  | 'player:seek'

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
  /** Hands the latest state to the player once joined and the clock is measured. */
  sync(): void
}

// 8 samples of 8-bit silence. Playing it inside the Listen tap unlocks the element on iOS.
const SILENCE = 'data:audio/wav;base64,UklGRiwAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQgAAACAgICAgICAgA=='
const TOAST_MS = 4_000
const RESYNC_MS = 30_000
const JOIN_TIMEOUT_MS = 10_000
const ACTION_TIMEOUT_MS = 30_000

async function ask(socket: Socket, event: string, payload: unknown, timeoutMs: number): Promise<Ack> {
  try {
    return (await socket.timeout(timeoutMs).emitWithAck(event, payload)) as Ack
  } catch {
    return { ok: false, error: 'The station did not answer. Check your connection.' }
  }
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
    const socket = io()
    const clock = new ClockSync(() => socket.timeout(2_000).emitWithAck('time:ping', Date.now()))
    const player = new SyncPlayer({
      audio,
      serverNow: () => clock.serverNow(),
      delayMs: () => delayRef.current,
      onBlocked: () => setBlocked(true),
    })

    let latest: StationState | null = null
    const handToPlayer = () => {
      if (latest && nicknameRef.current) player.update(latest.current, latest.playback)
    }
    const sync = () => {
      if (clock.synced) handToPlayer()
      else void clock.measure().then(handToPlayer)
    }
    conn.current = { socket, clock, player, audio, sync }

    socket.on('connect', () => {
      setConnected(true)
      void clock.measure().then(handToPlayer)
      const nickname = nicknameRef.current
      if (nickname) void ask(socket, 'join', { clientId, nickname }, JOIN_TIMEOUT_MS) // rejoin after a drop
    })
    socket.on('disconnect', () => setConnected(false))
    socket.on('state', (s: StationState) => {
      latest = s
      setState(s)
      sync()
    })
    socket.on('activity', (a: Activity) => notify(a.text))

    // realign() restarts audio that stopped without a banner; it never touches audio that is playing.
    const resync = setInterval(() => void clock.measure().then(() => player.realign()), RESYNC_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') void clock.measure().then(() => player.realign())
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
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
      c.audio.src = SILENCE
      c.audio.play().then(
        () => {
          if (c.audio.src === SILENCE) c.audio.pause()
        },
        () => {},
      )
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

  const send = useCallback(
    async (event: ActionEvent, payload: object = {}): Promise<Ack> => {
      const c = conn.current
      if (!c) return { ok: false, error: 'Not connected' }
      const res = await ask(c.socket, event, payload, ACTION_TIMEOUT_MS)
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
