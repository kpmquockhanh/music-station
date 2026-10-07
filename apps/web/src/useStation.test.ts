import { describe, expect, it, vi } from 'vitest'
import type { Socket } from 'socket.io-client'
import { sendAction, startupJoin } from './useStation'

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

describe('startupJoin', () => {
  const NOW = 1_000_000
  const never = { at: 0, rejoin: false }
  const none = { nickname: '', updated: false }

  it('keeps the Join screen in a browser, whose Listen tap unlocks audio on iOS', () => {
    expect(startupJoin(never, 'Minh', false, NOW)).toEqual(none)
  })

  it('joins with the saved nickname inside the app, without the update toast', () => {
    expect(startupJoin(never, 'Minh', true, NOW)).toEqual({ nickname: 'Minh', updated: false })
  })

  it('shows the Join screen in the app until a nickname is saved', () => {
    expect(startupJoin(never, '', true, NOW)).toEqual(none)
  })

  it('rejoins a tab that just reloaded itself for a new version, with the update toast', () => {
    const fresh = { at: NOW - 5_000, rejoin: true }
    expect(startupJoin(fresh, 'Minh', false, NOW)).toEqual({ nickname: 'Minh', updated: true })
    expect(startupJoin(fresh, 'Minh', true, NOW)).toEqual({ nickname: 'Minh', updated: true })
  })

  it('ignores an old reload, and one from a tab that had not joined', () => {
    expect(startupJoin({ at: NOW - 60_000, rejoin: true }, 'Minh', false, NOW)).toEqual(none)
    expect(startupJoin({ at: NOW - 5_000, rejoin: false }, 'Minh', false, NOW)).toEqual(none)
  })
})
