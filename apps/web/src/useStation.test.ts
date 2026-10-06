import { describe, expect, it, vi } from 'vitest'
import type { Socket } from 'socket.io-client'
import { sendAction } from './useStation'

function fakeSocket(connected: boolean) {
  const emitWithAck = vi.fn(async () => ({ ok: true }))
  const timeout = vi.fn(() => ({ emitWithAck }))
  return { socket: { connected, timeout } as unknown as Socket, timeout, emitWithAck }
}

describe('sendAction', () => {
  it('fails at once without emitting while the socket is reconnecting', async () => {
    const s = fakeSocket(false)
    expect(await sendAction(s.socket, 'player:play', {})).toEqual({
      ok: false,
      error: 'Reconnecting, try again in a moment',
    })
    expect(s.timeout).not.toHaveBeenCalled()
    expect(s.emitWithAck).not.toHaveBeenCalled()
  })

  it('emits with an ack timeout while connected', async () => {
    const s = fakeSocket(true)
    expect(await sendAction(s.socket, 'queue:add', { input: 'x' })).toEqual({ ok: true })
    expect(s.timeout).toHaveBeenCalledWith(30_000)
    expect(s.emitWithAck).toHaveBeenCalledWith('queue:add', { input: 'x' })
  })
})
