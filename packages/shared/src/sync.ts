import type { Playback } from './types'

export const DEADBAND_S = 0.03
export const SEEK_THRESHOLD_S = 0.3

/** Where the song should be at `serverNow` (ms), ignoring device delay. */
export function expectedPosition(p: Playback, serverNow: number): number {
  if (p.status !== 'playing') return p.position
  return p.position + Math.max(0, serverNow - p.at) / 1000
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
  if (size <= SEEK_THRESHOLD_S) return { rate: drift > 0 ? 0.97 : 1.03, seekTo: null }
  return { rate: 1, seekTo: target }
}
