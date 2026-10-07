import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_STATION, loadStation, normaliseStation, saveStation } from './settings'

describe('normaliseStation', () => {
  it.each([
    ['https://music.devxdev.site', 'https://music.devxdev.site'],
    ['music.devxdev.site', 'https://music.devxdev.site'],
    ['  music.devxdev.site/  ', 'https://music.devxdev.site'],
    ['HTTPS://Music.Devxdev.Site/queue?x=1#top', 'https://music.devxdev.site'],
    ['https://music.example.com:8443/', 'https://music.example.com:8443'],
    ['https://music.example.com:443', 'https://music.example.com'],
    ['music.example.com:8443', 'https://music.example.com:8443'],
    ['http://music.example.com', 'http://music.example.com'],
    ['localhost', 'http://localhost'],
    ['localhost:3000', 'http://localhost:3000'],
    ['https://localhost:3000', 'https://localhost:3000'],
    ['192.168.1.20:3000', 'http://192.168.1.20:3000'],
    ['raspberrypi.local:3000', 'http://raspberrypi.local:3000'],
    // What a lookalike really points at is what gets saved.
    ['https://music.devxdev.site@evil.example', 'https://evil.example'],
  ])('%s → %s', (input, expected) => {
    expect(normaliseStation(input)).toBe(expected)
  })

  it.each([
    '',
    '   ',
    'my station',
    'javascript:alert(1)',
    'data:text/html,hi',
    'file:///etc/passwd',
    'ftp://music.example.com',
    'http://',
    '999.1.1.1:3000',
  ])('rejects %j', (input) => {
    expect(normaliseStation(input)).toBeNull()
  })
})

describe('loadStation and saveStation', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'music-station-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('uses the default station before anything is saved', () => {
    expect(loadStation(dir)).toBe(DEFAULT_STATION)
  })

  it('reads back what it saved, and leaves no temporary file behind', () => {
    saveStation(dir, 'http://192.168.1.20:3000')
    expect(loadStation(dir)).toBe('http://192.168.1.20:3000')
    expect(readdirSync(dir)).toEqual(['settings.json'])
  })

  it('creates the folder on the first save', () => {
    const nested = join(dir, 'a', 'b')
    saveStation(nested, 'https://music.example.com')
    expect(loadStation(nested)).toBe('https://music.example.com')
  })

  it('normalises a hand-edited address', () => {
    writeFileSync(join(dir, 'settings.json'), '{"station":"music.example.com/queue"}')
    expect(loadStation(dir)).toBe('https://music.example.com')
  })

  it.each(['', 'not json', 'null', '[]', '{}', '{"station":42}', '{"station":"javascript:alert(1)"}'])(
    'falls back to the default for a corrupt file: %j',
    (text) => {
      writeFileSync(join(dir, 'settings.json'), text)
      expect(loadStation(dir)).toBe(DEFAULT_STATION)
    },
  )
})
