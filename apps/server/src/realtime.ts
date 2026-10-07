import type { Server } from 'socket.io'
import type { z, ZodTypeAny } from 'zod'
import {
  addSchema,
  emptySchema,
  joinSchema,
  moveSchema,
  removeSchema,
  seekSchema,
  type Ack,
} from '@music-station/shared'
import type { StationService } from './service'
import { StationError } from './station'

export interface RealtimeOptions {
  graceMs?: number
  actionIntervalMs?: number
  now?: () => number
  log?: (msg: string) => void
  /** Logs the sync status each device reports. */
  syncLog?: boolean
  /** The web build the server serves. Pages built differently reload themselves to get it. */
  webVersion?: string | null
}

export interface Realtime {
  broadcastState(): void
  broadcastActivity(text: string): void
  close(): void
}

const reply = (ack: unknown, res: Ack) => {
  if (typeof ack === 'function') ack(res)
}

export function attachRealtime(io: Server, service: StationService, opts: RealtimeOptions = {}): Realtime {
  const graceMs = opts.graceMs ?? 10_000
  const actionIntervalMs = opts.actionIntervalMs ?? 500
  const now = opts.now ?? Date.now
  const log = opts.log ?? console.error
  const openSockets = new Map<string, number>() // listenerId -> connected sockets (tabs)
  const leaveTimers = new Map<string, NodeJS.Timeout>()
  let closed = false

  function release(listenerId: string): void {
    if (closed) return
    const remaining = (openSockets.get(listenerId) ?? 1) - 1
    if (remaining > 0) {
      openSockets.set(listenerId, remaining)
      return
    }
    openSockets.delete(listenerId)
    leaveTimers.set(
      listenerId,
      setTimeout(() => {
        leaveTimers.delete(listenerId)
        if (!openSockets.has(listenerId)) service.leave(listenerId)
      }, graceMs),
    )
  }

  io.on('connection', (socket) => {
    let listenerId: string | null = null
    let nickname = ''
    let lastActionAt = Number.NEGATIVE_INFINITY
    let lastReportAt = Number.NEGATIVE_INFINITY

    // Also on every reconnect, which is how open pages learn about a deploy: the restart drops their socket.
    if (opts.webVersion) socket.emit('hello', { webVersion: opts.webVersion })

    socket.on('debug:sync', (payload: unknown) => {
      if (!opts.syncLog || !listenerId || typeof payload !== 'object' || payload === null) return
      const t = now()
      if (t - lastReportAt < 1_000) return
      lastReportAt = t
      log(`[sync] ${nickname}: ${JSON.stringify(payload).slice(0, 600)}`)
    })

    socket.on('time:ping', (_t0: unknown, ack: unknown) => {
      if (typeof ack === 'function') ack(now())
    })

    socket.on('join', (payload: unknown, ack: unknown) => {
      const parsed = joinSchema.safeParse(payload)
      if (!parsed.success) return reply(ack, { ok: false, error: 'Pick a nickname of 1–24 characters' })
      const { clientId } = parsed.data
      nickname = parsed.data.nickname
      if (listenerId !== clientId) {
        if (listenerId) release(listenerId)
        listenerId = clientId
        openSockets.set(clientId, (openSockets.get(clientId) ?? 0) + 1)
      }
      const timer = leaveTimers.get(clientId)
      if (timer) {
        clearTimeout(timer)
        leaveTimers.delete(clientId)
      }
      service.join(clientId, nickname) // broadcasts state to everyone, including this socket
      reply(ack, { ok: true })
    })

    function action<S extends ZodTypeAny>(
      event: string,
      schema: S,
      run: (id: string, data: z.infer<S>) => unknown,
    ): void {
      socket.on(event, async (payload: unknown, ack: unknown) => {
        if (!listenerId) return reply(ack, { ok: false, error: 'Join the station first' })
        const t = now()
        if (t - lastActionAt < actionIntervalMs) return reply(ack, { ok: false, error: 'Slow down a little' })
        lastActionAt = t
        const parsed = schema.safeParse(payload ?? {})
        if (!parsed.success) return reply(ack, { ok: false, error: 'Invalid request' })
        try {
          await run(listenerId, parsed.data)
          reply(ack, { ok: true })
        } catch (err) {
          if (err instanceof StationError) return reply(ack, { ok: false, error: err.message })
          log(`${event} failed: ${String(err)}`)
          reply(ack, { ok: false, error: 'Something went wrong' })
        }
      })
    }

    action('queue:add', addSchema, (id, d) => service.add(id, d.input))
    action('queue:remove', removeSchema, (id, d) => service.remove(id, d.itemId))
    action('queue:move', moveSchema, (id, d) => service.move(id, d.itemId, d.toIndex))
    action('player:play', emptySchema, (id) => service.play(id))
    action('player:pause', emptySchema, (id) => service.pause(id))
    action('player:skip', emptySchema, (id) => service.skip(id))
    action('player:seek', seekSchema, (id, d) => service.seek(id, d.position))

    socket.on('disconnect', () => {
      if (listenerId) release(listenerId)
    })
  })

  return {
    broadcastState: () => io.emit('state', service.state()),
    broadcastActivity: (text) => io.emit('activity', { text, at: now() }),
    close: () => {
      closed = true
      for (const t of leaveTimers.values()) clearTimeout(t)
      leaveTimers.clear()
    },
  }
}
