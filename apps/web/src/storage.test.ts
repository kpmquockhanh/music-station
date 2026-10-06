import { afterEach, describe, expect, it, vi } from 'vitest'
import { clampDelay, getClientId, getDelayMs, newUuid, saveDelayMs, type KeyValueStore } from './storage'

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
