import { describe, expect, it } from 'vitest'
import { decideCorrection, expectedPosition, songEndsAt, targetPosition } from './sync'
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
  it('creeps back at 0.2% inside the 30 ms deadband', () => {
    expect(decideCorrection(10.02, 10)).toEqual({ rate: 0.998, seekTo: null })
    expect(decideCorrection(9.98, 10)).toEqual({ rate: 1.002, seekTo: null })
  })
  it('keeps its direction within 10 ms of the target, so noise cannot flip it back and forth', () => {
    expect(decideCorrection(10.005, 10, 0.998)).toEqual({ rate: 0.998, seekTo: null })
    expect(decideCorrection(9.995, 10, 0.998)).toEqual({ rate: 0.998, seekTo: null })
    expect(decideCorrection(10.005, 10, 1.002)).toEqual({ rate: 1.002, seekTo: null })
    expect(decideCorrection(10.005, 10, 0.97)).toEqual({ rate: 0.998, seekTo: null })
    expect(decideCorrection(10.005, 10, 1)).toEqual({ rate: 1.002, seekTo: null })
  })
  it('never returns a rate within 0.2% of 1, where browsers switch their time-stretcher and click', () => {
    for (let drift = -1.5; drift <= 1.5; drift += 0.0005) {
      for (const rate of [1, 0.94, 0.998, 1.002, 1.06]) {
        expect(Math.abs(decideCorrection(10 + drift, 10, rate).rate - 1)).toBeGreaterThan(0.0019)
      }
    }
  })
  it('slows down in proportion when ahead by up to 1 s', () => {
    expect(decideCorrection(10.1, 10)).toEqual({ rate: 0.98, seekTo: null })
    expect(decideCorrection(10.2, 10)).toEqual({ rate: 0.96, seekTo: null })
  })
  it('speeds up in proportion when behind by up to 1 s', () => {
    expect(decideCorrection(9.8, 10)).toEqual({ rate: 1.04, seekTo: null })
  })
  it('caps the rate change at 6%', () => {
    expect(decideCorrection(9.5, 10)).toEqual({ rate: 1.06, seekTo: null })
    expect(decideCorrection(11, 10)).toEqual({ rate: 0.94, seekTo: null })
  })
  it('jumps when more than 1 s off, resting at 0.2% in its current direction', () => {
    expect(decideCorrection(11.5, 10)).toEqual({ rate: 1.002, seekTo: 10 })
    expect(decideCorrection(5, 10, 0.97)).toEqual({ rate: 0.998, seekTo: 10 })
  })
})

describe('songEndsAt', () => {
  it('is the server time the song reaches its duration', () => {
    expect(songEndsAt({ status: 'playing', position: 10, at: 1_000 }, 200)).toBe(191_000)
  })
})
