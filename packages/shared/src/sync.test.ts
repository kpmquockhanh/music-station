import { describe, expect, it } from 'vitest'
import { decideCorrection, expectedPosition, targetPosition } from './sync'
import type { Playback } from './types'

describe('expectedPosition', () => {
  it('advances with server time while playing', () => {
    const p: Playback = { status: 'playing', position: 10, at: 1_000 }
    expect(expectedPosition(p, 3_500)).toBeCloseTo(12.5)
  })
  it('stays at position before the start time (lead-in)', () => {
    const p: Playback = { status: 'playing', position: 10, at: 5_000 }
    expect(expectedPosition(p, 4_200)).toBe(10)
  })
  it('stays at position while paused or waiting', () => {
    expect(expectedPosition({ status: 'paused', position: 7, at: 0 }, 99_999)).toBe(7)
    expect(expectedPosition({ status: 'waiting', position: 0, at: 0 }, 99_999)).toBe(0)
  })
})

describe('targetPosition', () => {
  it('adds the device delay', () => {
    const p: Playback = { status: 'playing', position: 0, at: 1_000 }
    expect(targetPosition(p, 2_000, 0)).toBeCloseTo(1)
    expect(targetPosition(p, 2_000, 200)).toBeCloseTo(1.2)
  })
})

describe('decideCorrection', () => {
  it('does nothing inside the 30 ms deadband', () => {
    expect(decideCorrection(10.02, 10)).toEqual({ rate: 1, seekTo: null })
    expect(decideCorrection(9.98, 10)).toEqual({ rate: 1, seekTo: null })
  })
  it('slows down when ahead by 30–300 ms', () => {
    expect(decideCorrection(10.1, 10)).toEqual({ rate: 0.97, seekTo: null })
  })
  it('speeds up when behind by 30–300 ms', () => {
    expect(decideCorrection(9.8, 10)).toEqual({ rate: 1.03, seekTo: null })
  })
  it('jumps when more than 300 ms off', () => {
    expect(decideCorrection(11, 10)).toEqual({ rate: 1, seekTo: 10 })
    expect(decideCorrection(5, 10)).toEqual({ rate: 1, seekTo: 10 })
  })
})
