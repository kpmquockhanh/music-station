import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AudioCache, type Downloader } from './cache'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ms-cache-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const A = 'aaaaaaaaaaa'
const B = 'bbbbbbbbbbb'
const C = 'ccccccccccc'

function fakeDownloader(bytes = 100) {
  const calls: string[] = []
  const download: Downloader = async (videoId, destPath) => {
    calls.push(videoId)
    await new Promise((r) => setTimeout(r, 10))
    await writeFile(destPath, Buffer.alloc(bytes))
  }
  return { calls, download }
}

describe('AudioCache', () => {
  it('indexes existing files and clears .tmp on init', async () => {
    await writeFile(join(dir, `${A}.m4a`), Buffer.alloc(10))
    await writeFile(join(dir, 'notes.txt'), 'ignore me')
    const cache1 = new AudioCache({ dir, maxBytes: 1e9, download: fakeDownloader().download })
    await cache1.init()
    await writeFile(join(dir, '.tmp', 'half.m4a'), Buffer.alloc(5))

    const cache = new AudioCache({ dir, maxBytes: 1e9, download: fakeDownloader().download })
    await cache.init()
    expect(cache.has(A)).toBe(true)
    expect(cache.has(B)).toBe(false)
    expect(await readdir(join(dir, '.tmp'))).toEqual([])
    expect(cache.totalBytes()).toBe(10)
  })

  it('downloads into .tmp and renames into place', async () => {
    const fake = fakeDownloader()
    const cache = new AudioCache({ dir, maxBytes: 1e9, download: fake.download })
    await cache.init()
    const path = await cache.ensure(A)
    expect(path).toBe(join(dir, `${A}.m4a`))
    expect(existsSync(path)).toBe(true)
    expect(cache.has(A)).toBe(true)
    expect(await readdir(join(dir, '.tmp'))).toEqual([])
  })

  it('dedupes in-flight downloads and skips cached files', async () => {
    const fake = fakeDownloader()
    const cache = new AudioCache({ dir, maxBytes: 1e9, download: fake.download })
    await cache.init()
    await Promise.all([cache.ensure(A), cache.ensure(A), cache.ensure(A)])
    await cache.ensure(A)
    expect(fake.calls).toEqual([A])
  })

  it('runs at most 2 downloads at once', async () => {
    let active = 0
    let peak = 0
    const download: Downloader = async (_id, dest) => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 20))
      await writeFile(dest, Buffer.alloc(1))
      active--
    }
    const cache = new AudioCache({ dir, maxBytes: 1e9, download })
    await cache.init()
    await Promise.all([A, B, C, 'ddddddddddd', 'eeeeeeeeeee'].map((id) => cache.ensure(id)))
    expect(peak).toBe(2)
  })

  it('does not cache failures, so a second call retries', async () => {
    let attempt = 0
    const download: Downloader = async (_id, dest) => {
      attempt++
      if (attempt === 1) {
        await writeFile(dest, 'partial')
        throw new Error('boom')
      }
      await writeFile(dest, Buffer.alloc(1))
    }
    const cache = new AudioCache({ dir, maxBytes: 1e9, download })
    await cache.init()
    await expect(cache.ensure(A)).rejects.toThrow('boom')
    expect(cache.has(A)).toBe(false)
    expect(await readdir(join(dir, '.tmp'))).toEqual([])
    await expect(cache.ensure(A)).resolves.toBe(join(dir, `${A}.m4a`))
  })

  it('evicts oldest first, never protected ids, until under the cap', async () => {
    const cache = new AudioCache({ dir, maxBytes: 250, download: fakeDownloader(100).download })
    await cache.init()
    for (const id of [A, B, C]) await cache.ensure(id)
    const old = new Date(Date.now() - 60_000)
    await utimes(join(dir, `${A}.m4a`), old, new Date(Date.now() - 30_000))
    await utimes(join(dir, `${B}.m4a`), old, new Date(Date.now() - 60_000))
    const cache2 = new AudioCache({ dir, maxBytes: 250, download: fakeDownloader(100).download })
    await cache2.init() // re-index to pick up the mtimes set above

    expect(cache2.evict(new Set([B]))).toEqual([A])
    expect(cache2.has(B)).toBe(true)
    expect(cache2.has(C)).toBe(true)
    expect(cache2.totalBytes()).toBe(200)
  })

  it('may stay over the cap when every file is protected', async () => {
    const cache = new AudioCache({ dir, maxBytes: 50, download: fakeDownloader(100).download })
    await cache.init()
    await cache.ensure(A)
    expect(cache.evict(new Set([A]))).toEqual([])
    expect(cache.has(A)).toBe(true)
  })

  it('touch makes a file the newest', async () => {
    const cache = new AudioCache({ dir, maxBytes: 150, download: fakeDownloader(100).download })
    await cache.init()
    await cache.ensure(A)
    await new Promise((r) => setTimeout(r, 20))
    await cache.ensure(B)
    await new Promise((r) => setTimeout(r, 20))
    cache.touch(A)
    expect(cache.evict(new Set())).toEqual([B])
  })
})
