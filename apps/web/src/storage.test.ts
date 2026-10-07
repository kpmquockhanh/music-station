import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clampDelay,
  getClientId,
  getDelayMs,
  getSeekLeadMs,
  getStartLeadMs,
  getUpdateReload,
  newUuid,
  saveDelayMs,
  saveSeekLeadMs,
  saveStartLeadMs,
  saveUpdateReload,
  type KeyValueStore,
} from './storage'

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function memoryStore(): KeyValueStore {
  const data = new Map<string, string>()
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getClientId', () => {
  it('creates a uuid once and reuses it', () => {
    const store = memoryStore()
    const id = getClientId(store)
    expect(id).toMatch(V4)
    expect(getClientId(store)).toBe(id)
  })

  it('replaces a damaged saved id', () => {
    const store = memoryStore()
    store.setItem('musicStation.clientId', 'garbage')
    expect(getClientId(store)).toMatch(V4)
  })

  it('still works when storage throws', () => {
    const denied = () => {
      throw new Error('denied')
    }
    expect(getClientId({ getItem: denied, setItem: denied })).toMatch(V4)
  })
})

describe('newUuid', () => {
  it('falls back to getRandomValues when randomUUID is missing (plain-http LAN address)', () => {
    const real = globalThis.crypto
    vi.stubGlobal('crypto', { getRandomValues: (a: Uint8Array) => real.getRandomValues(a) })
    expect(newUuid()).toMatch(V4)
  })
})

describe('delay', () => {
  it('clamps to 0–500 ms and survives a reload', () => {
    const store = memoryStore()
    expect(getDelayMs(store)).toBe(0)
    saveDelayMs(180, store)
    expect(getDelayMs(store)).toBe(180)
    saveDelayMs(900, store)
    expect(getDelayMs(store)).toBe(500)
    expect(clampDelay(-20)).toBe(0)
    store.setItem('musicStation.delayMs', 'abc')
    expect(getDelayMs(store)).toBe(0)
  })
})

describe('seek lead', () => {
  it('survives a reload and ignores damaged values', () => {
    const store = memoryStore()
    expect(getSeekLeadMs(store)).toBe(0)
    saveSeekLeadMs(485.4, store)
    expect(getSeekLeadMs(store)).toBe(485)
    store.setItem('musicStation.seekLeadMs', '9000')
    expect(getSeekLeadMs(store)).toBe(2_000)
    store.setItem('musicStation.seekLeadMs', 'abc')
    expect(getSeekLeadMs(store)).toBe(0)
  })
})

describe('start lead', () => {
  it('survives a reload and ignores damaged values', () => {
    const store = memoryStore()
    expect(getStartLeadMs(store)).toBe(0)
    saveStartLeadMs(512.6, store)
    expect(getStartLeadMs(store)).toBe(513)
    store.setItem('musicStation.startLeadMs', '-40')
    expect(getStartLeadMs(store)).toBe(0)
  })
})

describe('update reload', () => {
  it('remembers when the tab reloaded itself and whether it had joined', () => {
    const store = memoryStore()
    expect(getUpdateReload(store)).toEqual({ at: 0, rejoin: false })
    saveUpdateReload({ at: 1_791_338_205_973, rejoin: true }, store)
    expect(getUpdateReload(store)).toEqual({ at: 1_791_338_205_973, rejoin: true })
    saveUpdateReload({ at: 5, rejoin: false }, store)
    expect(getUpdateReload(store)).toEqual({ at: 5, rejoin: false })
    store.setItem('musicStation.updateReloadAt', 'abc')
    expect(getUpdateReload(store)).toEqual({ at: 0, rejoin: false })
  })
})
