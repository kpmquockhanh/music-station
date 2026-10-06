export interface KeyValueStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const CLIENT_ID = 'musicStation.clientId'
const NICKNAME = 'musicStation.nickname'
const DELAY = 'musicStation.delayMs'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function browserStore(): KeyValueStore | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function read(store: KeyValueStore | null, key: string): string | null {
  try {
    return store?.getItem(key) ?? null
  } catch {
    return null
  }
}

function write(store: KeyValueStore | null, key: string, value: string): void {
  try {
    store?.setItem(key, value)
  } catch {
    // Private mode or a full quota: the app still works, it just forgets on reload.
  }
}

export function newUuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  // A plain-http LAN address is not a secure context, so randomUUID is missing there.
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6]! & 0x0f) | 0x40
  b[8] = (b[8]! & 0x3f) | 0x80
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function getClientId(store: KeyValueStore | null = browserStore()): string {
  const saved = read(store, CLIENT_ID)
  if (saved && UUID_RE.test(saved)) return saved
  const id = newUuid()
  write(store, CLIENT_ID, id)
  return id
}

export function getNickname(store: KeyValueStore | null = browserStore()): string {
  return read(store, NICKNAME) ?? ''
}

export function saveNickname(nickname: string, store: KeyValueStore | null = browserStore()): void {
  write(store, NICKNAME, nickname)
}

export const clampDelay = (ms: number): number => Math.min(500, Math.max(0, Math.round(ms)))

export function getDelayMs(store: KeyValueStore | null = browserStore()): number {
  const n = Number(read(store, DELAY))
  return Number.isFinite(n) ? clampDelay(n) : 0
}

export function saveDelayMs(ms: number, store: KeyValueStore | null = browserStore()): void {
  write(store, DELAY, String(clampDelay(ms)))
}
