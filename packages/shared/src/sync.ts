import type { Playback } from './types'

export const DEADBAND_S = 0.03
/** Seeking is a gap you hear, and on iOS it lands up to ±300 ms off, so smaller drift is fixed by rate alone. */
export const SEEK_THRESHOLD_S = 1
/** Rate change per second of drift: 100 ms off plays at 2% speed difference. */
export const RATE_GAIN = 0.2
/** The furthest the rate moves from 1. Pitch is preserved, so 6% faster or slower is hard to hear. */
export const MAX_RATE_CHANGE = 0.06

/** Where the song should be at `serverNow` (ms), ignoring device delay. */
export function expectedPosition(p: Playback, serverNow: number): number {
  if (p.status !== 'playing') return p.position
  return p.position + Math.max(0, serverNow - p.at) / 1000
}

/**
 * When the current song ends, in server ms. The next song starts exactly then, so a device that loaded it
 * ahead can switch on its own and the server's later update changes nothing. Server and devices must share this.
 */
export function songEndsAt(p: Playback, duration: number): number {
  return p.at + (duration - p.position) * 1000
}

/** Where this device's <audio> should be. Only meaningful once serverNow + delayMs >= p.at. */
export function targetPosition(p: Playback, serverNow: number, delayMs: number): number {
  return p.position + (serverNow - p.at) / 1000 + delayMs / 1000
}

export function decideCorrection(
  currentTime: number,
  target: number,
): { rate: number; seekTo: number | null } {
  const drift = currentTime - target
  const size = Math.abs(drift)
  if (size < DEADBAND_S) return { rate: 1, seekTo: null }
  if (size > SEEK_THRESHOLD_S) return { rate: 1, seekTo: target }
  // Proportional, so the rate eases off near the target instead of overshooting it.
  const change = Math.min(MAX_RATE_CHANGE, Math.max(-MAX_RATE_CHANGE, -drift * RATE_GAIN))
  return { rate: Math.round((1 + change) * 1000) / 1000, seekTo: null }
}
