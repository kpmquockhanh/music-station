import { parseVideoLink } from '@music-station/shared'

export function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const h = Math.floor(total / 3_600)
  const m = Math.floor((total % 3_600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

export type InputKind =
  | { kind: 'empty' }
  | { kind: 'link'; videoId: string }
  | { kind: 'bad-link' }
  | { kind: 'search'; query: string }

const LOOKS_LIKE_LINK = /^(https?:\/\/|([\w-]+\.)*youtu(\.be|be\.com)\/)/i

/** Only real links are added directly. A bare 11-character word is a search (Review Focus 1). */
export function classifyInput(input: string): InputKind {
  const s = input.trim()
  if (!s) return { kind: 'empty' }
  const videoId = parseVideoLink(s)
  if (videoId) return { kind: 'link', videoId }
  if (LOOKS_LIKE_LINK.test(s)) return { kind: 'bad-link' }
  return { kind: 'search', query: s }
}
