import { describe, expect, it } from 'vitest'
import { classifyInput, formatTime } from './format'

describe('formatTime', () => {
  it.each([
    [0, '0:00'],
    [5.9, '0:05'],
    [65, '1:05'],
    [3_662, '1:01:02'],
    [-3, '0:00'],
  ])('formats %s as %s', (seconds, text) => {
    expect(formatTime(seconds)).toBe(text)
  })
})

describe('classifyInput', () => {
  it('searches for one-word queries that happen to look like video IDs', () => {
    expect(classifyInput('rickrolling')).toEqual({ kind: 'search', query: 'rickrolling' })
    expect(classifyInput('beethoven_5')).toEqual({ kind: 'search', query: 'beethoven_5' })
  })

  it('adds YouTube video links, with or without a scheme', () => {
    expect(classifyInput(' https://youtu.be/dQw4w9WgXcQ?t=42 ')).toEqual({ kind: 'link', videoId: 'dQw4w9WgXcQ' })
    expect(classifyInput('music.youtube.com/watch?v=dQw4w9WgXcQ&list=RD')).toEqual({
      kind: 'link',
      videoId: 'dQw4w9WgXcQ',
    })
  })

  it('flags links that have no video in them', () => {
    expect(classifyInput('https://www.youtube.com/playlist?list=PL123')).toEqual({ kind: 'bad-link' })
    expect(classifyInput('https://example.com/song')).toEqual({ kind: 'bad-link' })
  })

  it('searches for ordinary text, including the word youtube', () => {
    expect(classifyInput('youtube rewind 2018')).toEqual({ kind: 'search', query: 'youtube rewind 2018' })
    expect(classifyInput('   ')).toEqual({ kind: 'empty' })
  })
})
