import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSaver, loadState, saveState, type Persisted } from './persist'

let dir: string
let file: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ms-persist-'))
  file = join(dir, 'nested', 'station.json')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const sample = (savedAt = 1_000): Persisted => ({
  version: 1,
  savedAt,
  current: {
    id: '3f2b8c1e-8d4a-4c6b-9f0e-2a1b3c4d5e6f',
    videoId: 'dQw4w9WgXcQ',
    title: 'Song',
    channel: 'Ch',
    duration: 100,
    thumbnail: 't',
    addedBy: 'Minh',
    status: 'ready',
  },
  queue: [],
  playback: { status: 'playing', position: 5, at: 500 },
  autoplay: true,
  history: ['dQw4w9WgXcQ'],
})

describe('saveState / loadState', () => {
  it('round-trips and leaves no temp file', async () => {
    await saveState(file, sample())
    expect(await loadState(file)).toEqual(sample())
    expect(await readdir(join(dir, 'nested'))).toEqual(['station.json'])
  })

  it('turns autoplay off for files saved before it existed', async () => {
    const { autoplay: _a, history: _h, ...old } = sample()
    await saveState(file, sample())
    await writeFile(file, JSON.stringify(old))
    expect(await loadState(file)).toEqual({ ...old, autoplay: false, history: [] })
  })

  it('returns null when the file does not exist', async () => {
    expect(await loadState(file)).toBeNull()
  })

  it.each([
    ['half-written JSON', '{"version":1,"savedAt":'],
    ['wrong shape', JSON.stringify({ version: 1, queue: 'nope' })],
    ['bad video id', JSON.stringify({ ...sample(), current: { ...sample().current, videoId: 'x' } })],
  ])('starts empty on %s and keeps the bad file aside', async (_name, text) => {
    await saveState(file, sample()) // creates the directory
    await writeFile(file, text)
    const log = vi.fn()
    expect(await loadState(file, log)).toBeNull()
    expect(log).toHaveBeenCalledOnce()
    expect(existsSync(file)).toBe(false)
    expect(await readFile(`${file}.corrupt`, 'utf8')).toBe(text)
  })
})

describe('createSaver', () => {
  it('coalesces changes into one delayed write with the latest data', async () => {
    let n = 0
    const getData = vi.fn(() => sample(++n))
    const saver = createSaver(file, getData, 20)
    saver.schedule()
    saver.schedule()
    saver.schedule()
    expect(existsSync(file)).toBe(false)
    await new Promise((r) => setTimeout(r, 80))
    expect(getData).toHaveBeenCalledOnce()
    expect((await loadState(file))!.savedAt).toBe(1)
  })

  it('flush writes immediately', async () => {
    const saver = createSaver(file, () => sample(42), 10_000)
    saver.schedule()
    await saver.flush()
    expect((await loadState(file))!.savedAt).toBe(42)
  })
})
