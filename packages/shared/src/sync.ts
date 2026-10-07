import type { Playback } from './types'

export const DEADBAND_S = 0.03
/** Seeking is a gap you hear, and on iOS it lands up to ±300 ms off, so smaller drift is fixed by rate alone. */
export const SEEK_THRESHOLD_S = 1
/** Rate change per second of drift: 100 ms off plays at 2% speed difference. */
export const RATE_GAIN = 0.2
/** The furthest the rate moves from 1. Pitch is preserved, so 6% faster or slower is hard to hear. */
export const MAX_RATE_CHANGE = 0.06
/**
 * The closest the rate comes to 1 while a song plays. Browsers skip their time-stretcher at exactly 1 and
 * switch it back on for any other rate, and every switch pops. A 0.2% creep is inaudible and never switches.
 */
export const MIN_RATE_CHANGE = 0.002
/** Inside the deadband the creep keeps its direction until the drift passes the target by this much. */
export const FLIP_MARGIN_S = 0.01

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

/** The creep in the direction `rate` already goes, so moving to it never passes through 1. */
export function restRate(rate: number): number {
  return rate < 1 ? 1 - MIN_RATE_CHANGE : 1 + MIN_RATE_CHANGE
}

export function decideCorrection(
  currentTime: number,
  target: number,
  rate = 1,
): { rate: number; seekTo: number | null } {
  const drift = currentTime - target
  const size = Math.abs(drift)
  if (size > SEEK_THRESHOLD_S) return { rate: restRate(rate), seekTo: target }
  if (size < DEADBAND_S) {
    // Flipping only well past the target keeps measurement noise from flipping it back and forth.
    if (drift > FLIP_MARGIN_S) return { rate: 1 - MIN_RATE_CHANGE, seekTo: null }
    if (drift < -FLIP_MARGIN_S) return { rate: 1 + MIN_RATE_CHANGE, seekTo: null }
    return { rate: restRate(rate), seekTo: null }
  }
  // Proportional, so the rate eases off near the target instead of overshooting it.
  const change = Math.min(MAX_RATE_CHANGE, Math.max(-MAX_RATE_CHANGE, -drift * RATE_GAIN))
  return { rate: Math.round((1 + change) * 1000) / 1000, seekTo: null }
}
