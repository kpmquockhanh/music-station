import { describe, expect, it } from 'vitest'
import type { NowPlaying } from '@music-station/shared'
import {
  cardView,
  escapeMnemonic,
  menuBarTitle,
  parseNowPlaying,
  parseReply,
  parseUpNext,
  songLine,
  trayMenu,
  type TrayItem,
} from './trayMenu'

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

  it('offers to resume this computer after it stopped, as after sleep', () => {
    expect(lines(trayMenu({ ...song('playing'), stoppedHere: true }))).toEqual([
      'Song — Band (off)',
      'Resume on this computer [resumeHere]',
      'Pause for everyone [pause]',
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

describe('menuBarTitle', () => {
  const timed = (status: NowPlaying['status']): NowPlaying => ({ ...song(status), duration: 200, position: 50, at: 1_000 })

  it('counts down the time left while playing', () => {
    expect(menuBarTitle(timed('playing'), 1_000)).toBe('2:30')
    expect(menuBarTitle(timed('playing'), 11_500)).toBe('2:20') // rounds up, so it reads 0:00 only at the end
    expect(menuBarTitle(timed('playing'), 999_999)).toBe('0:00')
  })

  it('names the status otherwise', () => {
    expect(menuBarTitle(timed('paused'), 99_000)).toBe('Paused')
    expect(menuBarTitle(timed('waiting'), 99_000)).toBe('Loading')
    expect(menuBarTitle(null, 0)).toBe('')
  })

  it('says Stopped while this computer is silent and the station plays on', () => {
    expect(menuBarTitle({ ...timed('playing'), stoppedHere: true }, 1_000)).toBe('Stopped')
  })

  it('shows nothing while playing for a page that sends no timing', () => {
    expect(menuBarTitle(song('playing'), 0)).toBe('')
  })
})

describe('cardView', () => {
  const at = (ms: number) => `@${ms}`
  const timed = (status: NowPlaying['status']): NowPlaying => ({
    ...song(status),
    thumbnail: 'https://i.ytimg.com/vi/x/mqdefault.jpg',
    duration: 200,
    position: 50,
    at: 1_000,
  })

  it('shows the song, the time left and when it ends while playing', () => {
    expect(cardView(timed('playing'), 11_000, at)).toEqual({
      title: 'Song',
      subtitle: 'Band • 2:20 left',
      thumbnail: 'https://i.ytimg.com/vi/x/mqdefault.jpg',
      progress: 0.3,
      speed: 0.005,
      footer: 'Ends at @151000',
      toggle: { command: 'pause', label: 'Pause for everyone', enabled: true },
      canSkip: true,
      resume: false,
      queue: null,
    })
  })

  it('holds the position while paused', () => {
    expect(cardView(timed('paused'), 99_000, at)).toMatchObject({
      subtitle: 'Band • Paused',
      progress: 0.25,
      speed: 0,
      footer: '0:50 of 3:20',
      toggle: { command: 'play', label: 'Play for everyone', enabled: true },
    })
  })

  it('shows Tap to resume while this computer is stopped', () => {
    expect(cardView({ ...timed('playing'), stoppedHere: true }, 11_000, at)).toMatchObject({ resume: true, subtitle: 'Band • 2:20 left' })
  })

  it('turns play off while the song downloads', () => {
    expect(cardView(timed('waiting'), 99_000, at)).toMatchObject({
      subtitle: 'Band • Getting ready',
      footer: 'Preparing audio for everyone…',
      toggle: { command: 'play', enabled: false },
      canSkip: true,
    })
  })

  it('leaves out the progress for a page that sends no timing', () => {
    expect(cardView(song('playing'), 0, at)).toMatchObject({ subtitle: 'Band', progress: null, footer: '', thumbnail: null })
  })

  it('turns everything off with nothing playing', () => {
    expect(cardView(null, 0, at)).toEqual({
      title: 'Nothing playing',
      subtitle: 'Click to add a song',
      thumbnail: null,
      progress: null,
      speed: 0,
      footer: '',
      toggle: { command: 'play', label: 'Play for everyone', enabled: false },
      canSkip: false,
      resume: false,
      queue: null,
    })
  })

  it('lists Up next with each song length, who added it and whether it is ready', () => {
    const songs = [
      { title: ' Next\nsong ', duration: 225, thumbnail: 'https://i.ytimg.com/a.jpg', addedBy: 'Minh', status: 'ready' as const },
      { title: '', duration: 0, thumbnail: '', addedBy: ' ', status: 'downloading' as const },
      { title: 'Broken', duration: 61, thumbnail: '', addedBy: 'Lan', status: 'failed' as const },
    ]
    expect(cardView(null, 0, at, { songs, total: 7 }).queue).toEqual({
      rows: [
        { title: 'Next song', detail: '3:45 · Minh', thumbnail: 'https://i.ytimg.com/a.jpg', badge: null },
        { title: 'Unknown song', detail: '0:00', thumbnail: null, badge: 'Getting ready' },
        { title: 'Broken', detail: '1:01 · Lan', thumbnail: null, badge: 'Failed' },
      ],
      more: 4,
    })
  })

  it('shows an empty Up next', () => {
    expect(cardView(timed('playing'), 0, at, { songs: [], total: 0 }).queue).toEqual({ rows: [], more: 0 })
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
  it('keeps valid timing and an https thumbnail', () => {
    const timing = { thumbnail: 'https://i.ytimg.com/vi/x/mqdefault.jpg', duration: 200, position: 5, at: 1_000 }
    expect(parseNowPlaying({ title: 'Song', channel: 'Band', status: 'playing', ...timing })).toEqual({
      title: 'Song',
      channel: 'Band',
      status: 'playing',
      ...timing,
    })
  })

  it('drops a thumbnail that is not https, and timing that is not usable', () => {
    const base = { title: 'Song', channel: 'Band', status: 'playing' }
    const clean = { ...base }
    expect(parseNowPlaying({ ...base, thumbnail: 'file:///etc/passwd' })).toEqual(clean)
    expect(parseNowPlaying({ ...base, thumbnail: 'javascript:alert(1)' })).toEqual(clean)
    expect(parseNowPlaying({ ...base, duration: 0, position: 1, at: 1 })).toEqual(clean)
    expect(parseNowPlaying({ ...base, duration: 200, position: -1, at: 1 })).toEqual({ ...clean, duration: 200 })
    expect(parseNowPlaying({ ...base, duration: 200, position: 1, at: Number.NaN })).toEqual({ ...clean, duration: 200 })
    expect(parseNowPlaying({ ...base, duration: '200' })).toEqual(clean)
  })

  it('keeps stoppedHere only when it is true', () => {
    const base = { title: 'Song', channel: 'Band', status: 'playing' }
    expect(parseNowPlaying({ ...base, stoppedHere: true })).toEqual({ ...base, stoppedHere: true })
    expect(parseNowPlaying({ ...base, stoppedHere: false })).toEqual(base)
    expect(parseNowPlaying({ ...base, stoppedHere: 'yes' })).toEqual(base)
  })

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

describe('parseUpNext', () => {
  const ok = { title: 'Song', duration: 200, thumbnail: 'https://i.ytimg.com/a.jpg', addedBy: 'Minh', status: 'ready' }

  it('keeps valid songs and cleans their fields', () => {
    expect(
      parseUpNext({
        songs: [ok, { ...ok, duration: -1, thumbnail: 'file:///etc/passwd', status: 'failed' }],
        total: 5.7,
      }),
    ).toEqual({ songs: [ok, { ...ok, duration: 0, thumbnail: '', status: 'failed' }], total: 5 })
  })

  it('drops songs that are not songs, and never reports fewer than it kept', () => {
    expect(parseUpNext({ songs: [ok, null, { ...ok, title: 1 }, { ...ok, status: 'playing' }], total: 0 })).toEqual({
      songs: [ok],
      total: 1,
    })
  })

  it('keeps at most 20 songs', () => {
    expect(parseUpNext({ songs: Array(30).fill(ok), total: 30 })?.songs).toHaveLength(20)
  })

  it.each([null, 'queue', [], { songs: [] }, { songs: 'x', total: 1 }, { songs: [], total: Number.NaN }])(
    'treats %j as no queue',
    (value) => {
      expect(parseUpNext(value)).toBeNull()
    },
  )
})

describe('parseReply', () => {
  const result = { videoId: 'dQw4w9WgXcQ', title: 'Song', channel: 'Band', duration: 212, thumbnail: 'https://i.ytimg.com/a.jpg' }

  it('passes on success and errors', () => {
    expect(parseReply({ ok: true })).toEqual({ ok: true })
    expect(parseReply({ ok: false, error: 'Too many searches. Wait a minute.' })).toEqual({
      ok: false,
      error: 'Too many searches. Wait a minute.',
    })
    expect(parseReply({ ok: false })).toEqual({ ok: false, error: 'Something went wrong' })
    expect((parseReply({ ok: false, error: 'x'.repeat(500) }) as { error: string }).error).toHaveLength(200)
  })

  it('keeps valid search results and cleans their fields', () => {
    expect(
      parseReply({
        ok: true,
        results: [
          result,
          { ...result, channel: 3, duration: 0, thumbnail: 'javascript:alert(1)' },
          { ...result, videoId: '../../etc' },
          { ...result, title: null },
          'x',
        ],
      }),
    ).toEqual({ ok: true, results: [result, { ...result, channel: '', duration: null, thumbnail: '' }] })
  })

  it.each([null, 'ok', {}, { ok: 'yes' }, { ok: true, results: 'x' }])('turns %j into an error', (value) => {
    expect(parseReply(value)).toEqual({ ok: false, error: 'The station sent an answer the app does not understand.' })
  })
})

describe('escapeMnemonic', () => {
  it('doubles every & so menus show it instead of underlining the next letter', () => {
    expect(escapeMnemonic('Simon & Garfunkel — A&&B')).toBe('Simon && Garfunkel — A&&&&B')
  })
})
