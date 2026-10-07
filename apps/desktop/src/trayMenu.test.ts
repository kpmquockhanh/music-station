import { describe, expect, it } from 'vitest'
import type { NowPlaying } from '@music-station/shared'
import { escapeMnemonic, parseNowPlaying, songLine, trayMenu, type TrayItem } from './trayMenu'

const song = (status: NowPlaying['status']): NowPlaying => ({ title: 'Song', channel: 'Band', status })
/** One line per item: the label, "(off)" when disabled, and the command in brackets. */
const lines = (items: TrayItem[]) =>
  items.map((i) =>
    'separator' in i ? '---' : `${i.label}${i.enabled ? '' : ' (off)'}${i.command ? ` [${i.command}]` : ''}`,
  )
const tail = ['---', 'Show window [show]', 'Change station… [station]', 'Quit [quit]']

describe('trayMenu', () => {
  it('offers pause and skip while the station plays', () => {
    expect(lines(trayMenu(song('playing')))).toEqual([
      'Song — Band (off)',
      'Pause for everyone [pause]',
      'Skip for everyone [skip]',
      ...tail,
    ])
  })

  it('offers play while the station is paused', () => {
    expect(lines(trayMenu(song('paused')))).toEqual([
      'Song — Band (off)',
      'Play for everyone [play]',
      'Skip for everyone [skip]',
      ...tail,
    ])
  })

  it('disables play while the song is still downloading, but still allows a skip', () => {
    expect(lines(trayMenu(song('waiting')))).toEqual([
      'Song — Band (off)',
      'Play for everyone (off) [play]',
      'Skip for everyone [skip]',
      ...tail,
    ])
  })

  it('disables the station controls with nothing playing', () => {
    expect(lines(trayMenu(null))).toEqual([
      'Nothing playing (off)',
      'Play for everyone (off) [play]',
      'Skip for everyone (off) [skip]',
      ...tail,
    ])
  })
})

describe('songLine', () => {
  it('folds whitespace and newlines into one line', () => {
    expect(songLine({ title: ' Song\n\tname  ', channel: ' Band ', status: 'playing' })).toBe('Song name — Band')
  })

  it('leaves out an empty channel and names an empty title', () => {
    expect(songLine({ title: 'Song', channel: '  ', status: 'playing' })).toBe('Song')
    expect(songLine({ title: '', channel: 'Band', status: 'playing' })).toBe('Unknown song — Band')
  })

  it('cuts a long line to 60 characters', () => {
    const line = songLine({ title: 'a'.repeat(500), channel: 'Band', status: 'playing' })
    expect(Array.from(line)).toHaveLength(60)
    expect(line.endsWith('…')).toBe(true)
  })

  it('never cuts an emoji in half', () => {
    const line = songLine({ title: '🎵'.repeat(80), channel: '', status: 'playing' })
    const chars = Array.from(line)
    expect(chars).toHaveLength(60)
    expect(chars.slice(0, -1).every((c) => c === '🎵')).toBe(true)
  })
})

describe('parseNowPlaying', () => {
  it('accepts a valid message and drops extra fields', () => {
    expect(parseNowPlaying({ title: 'Song', channel: 'Band', status: 'waiting', evil: 1 })).toEqual({
      title: 'Song',
      channel: 'Band',
      status: 'waiting',
    })
  })

  it.each([
    null,
    undefined,
    'Song',
    42,
    [],
    {},
    { title: 'Song', channel: 'Band' },
    { title: 42, channel: 'Band', status: 'playing' },
    { title: 'Song', channel: null, status: 'playing' },
    { title: 'Song', channel: 'Band', status: 'stopped' },
  ])('treats %j as nothing playing', (value) => {
    expect(parseNowPlaying(value)).toBeNull()
  })
})

describe('escapeMnemonic', () => {
  it('doubles every & so menus show it instead of underlining the next letter', () => {
    expect(escapeMnemonic('Simon & Garfunkel — A&&B')).toBe('Simon && Garfunkel — A&&&&B')
  })
})
