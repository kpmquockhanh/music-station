import { VIDEO_ID_RE } from './types'

const HOSTS = new Set(['youtube.com', 'music.youtube.com', 'youtu.be'])

export function isVideoId(s: string): boolean {
  return VIDEO_ID_RE.test(s)
}

/** Extracts a video ID from a YouTube link. Plain words (even 11-char ones) return null. */
export function parseVideoLink(input: string): string | null {
  const s = input.trim()
  if (!s.includes('/') && !s.includes('.')) return null
  let url: URL
  try {
    url = new URL(s.includes('://') ? s : `https://${s}`)
  } catch {
    return null
  }
  const host = url.hostname.toLowerCase().replace(/^(www|m)\./, '')
  if (!HOSTS.has(host)) return null

  let id: string | null = null
  if (host === 'youtu.be') {
    id = url.pathname.split('/')[1] ?? null
  } else if (url.pathname === '/watch') {
    id = url.searchParams.get('v')
  } else {
    const m = url.pathname.match(/^\/(shorts|embed|live|v)\/([^/]+)/)
    id = m ? m[2]! : null
  }
  return id && isVideoId(id) ? id : null
}

/** Accepts a bare 11-char video ID or a YouTube link. */
export function parseVideoInput(input: string): string | null {
  const s = input.trim()
  if (isVideoId(s)) return s
  return parseVideoLink(s)
}
