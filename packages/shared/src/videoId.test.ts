import { describe, expect, it } from 'vitest'
import { isVideoId, parseVideoInput, parseVideoLink } from './videoId'

const ID = 'dQw4w9WgXcQ'

describe('isVideoId', () => {
  it('accepts 11 URL-safe characters', () => {
    expect(isVideoId(ID)).toBe(true)
    expect(isVideoId('a-b_c123456')).toBe(true)
  })
  it('rejects anything else', () => {
    expect(isVideoId('short')).toBe(false)
    expect(isVideoId('dQw4w9WgXcQx')).toBe(false)
    expect(isVideoId('dQw4w9WgXc!')).toBe(false)
    expect(isVideoId('')).toBe(false)
  })
})

describe('parseVideoLink', () => {
  it.each([
    [`https://www.youtube.com/watch?v=${ID}`],
    [`https://youtube.com/watch?v=${ID}&t=42s`],
    [`https://m.youtube.com/watch?v=${ID}`],
    [`https://music.youtube.com/watch?v=${ID}&feature=share`],
    [`https://youtu.be/${ID}`],
    [`https://youtu.be/${ID}?si=abc`],
    [`https://www.youtube.com/shorts/${ID}`],
    [`https://www.youtube.com/embed/${ID}`],
    [`youtube.com/watch?v=${ID}`],
    [`  https://youtu.be/${ID}  `],
  ])('extracts the ID from %s', (url) => {
    expect(parseVideoLink(url)).toBe(ID)
  })

  it('keeps only the video from a playlist link', () => {
    expect(parseVideoLink(`https://www.youtube.com/watch?v=${ID}&list=PL1234567890`)).toBe(ID)
  })

  it.each([
    ['https://www.youtube.com/playlist?list=PL1234567890'],
    ['https://example.com/watch?v=dQw4w9WgXcQ'],
    ['https://www.youtube.com/watch?v=bad'],
    ['https://youtu.be/'],
    ['not a url at all'],
  ])('returns null for %s', (input) => {
    expect(parseVideoLink(input)).toBeNull()
  })

  it('does not treat an 11-character search word as a link', () => {
    expect(parseVideoLink('rickrolling')).toBeNull()
    expect(parseVideoLink('beethoven_5')).toBeNull()
  })
})

describe('parseVideoInput', () => {
  it('accepts a bare ID', () => {
    expect(parseVideoInput(` ${ID} `)).toBe(ID)
  })
  it('accepts a link', () => {
    expect(parseVideoInput(`https://youtu.be/${ID}`)).toBe(ID)
  })
  it('rejects other text', () => {
    expect(parseVideoInput('hello world')).toBeNull()
  })
})
