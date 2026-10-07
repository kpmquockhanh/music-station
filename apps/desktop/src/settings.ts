import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const DEFAULT_STATION = 'https://music.devxdev.site'

const FILE = 'settings.json'
const SCHEME = /^[a-z][a-z\d+.-]*:\/\//i
// This computer and the local network, which rarely have a certificate.
const LOCAL_HOST = /^(localhost|\d{1,3}(\.\d{1,3}){3}|[^/:?#]+\.local)(:\d+)?([/?#]|$)/i

/**
 * The origin of a typed station address, or null if it is not one.
 * Without a scheme: http:// for localhost, IPv4 addresses and *.local, https:// otherwise.
 * Only http and https are accepted. Any path, query or hash is dropped.
 */
export function normaliseStation(input: string): string | null {
  const text = input.trim()
  if (!text) return null
  const withScheme = SCHEME.test(text) ? text : `${LOCAL_HOST.test(text) ? 'http' : 'https'}://${text}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  return url.origin
}

/** The saved station, or DEFAULT_STATION when the file is missing or invalid. */
export function loadStation(dir: string): string {
  try {
    const saved: unknown = JSON.parse(readFileSync(join(dir, FILE), 'utf8'))
    const station = typeof saved === 'object' && saved !== null ? (saved as { station?: unknown }).station : null
    return (typeof station === 'string' && normaliseStation(station)) || DEFAULT_STATION
  } catch {
    return DEFAULT_STATION
  }
}

export function saveStation(dir: string, url: string): void {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, FILE)
  // Written aside and renamed into place, so a crash mid-write cannot leave half a file.
  writeFileSync(`${file}.tmp`, `${JSON.stringify({ station: url }, null, 2)}\n`)
  renameSync(`${file}.tmp`, file)
}
