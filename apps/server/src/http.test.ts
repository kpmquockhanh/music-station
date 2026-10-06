import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildHttp } from './http'

const A = 'aaaaaaaaaaa'
let dir: string
let app: FastifyInstance

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ms-http-'))
  await writeFile(join(dir, `${A}.m4a`), Buffer.from(Array.from({ length: 100 }, (_, i) => i)))
})
afterEach(async () => {
  await app?.close()
  await rm(dir, { recursive: true, force: true })
})

async function build(over: Partial<Parameters<typeof buildHttp>[0]> = {}) {
  app = await buildHttp({
    cacheDir: dir,
    webDir: null,
    hasAudio: (id) => id === A,
    search: async () => [],
    ...over,
  })
  return app
}

describe('/audio', () => {
  it('serves a cached file with long-lived caching', async () => {
    await build()
    const res = await app.inject(`/audio/${A}.m4a`)
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('public, max-age=86400, immutable')
    expect(res.headers['content-type']).toMatch(/^audio\//)
    expect(res.rawPayload.length).toBe(100)
  })

  it('answers Range requests with 206', async () => {
    await build()
    const res = await app.inject({ url: `/audio/${A}.m4a`, headers: { range: 'bytes=10-19' } })
    expect(res.statusCode).toBe(206)
    expect(res.headers['content-range']).toBe('bytes 10-19/100')
    expect([...res.rawPayload]).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19])
  })

  it.each([`/audio/bbbbbbbbbbb.m4a`, '/audio/..%2F..%2Fetc%2Fpasswd', `/audio/${A}.mp3`, '/audio/x.m4a'])(
    '404s for %s',
    async (url) => {
      await build()
      expect((await app.inject(url)).statusCode).toBe(404)
    },
  )
})

describe('/api/search', () => {
  it('returns results', async () => {
    const search = vi.fn(async () => [
      { videoId: A, title: 't', channel: 'c', duration: 1, thumbnail: 'th' },
    ])
    await build({ search })
    const res = await app.inject('/api/search?q=lofi')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ results: [{ videoId: A, title: 't', channel: 'c', duration: 1, thumbnail: 'th' }] })
    expect(search).toHaveBeenCalledWith('lofi')
  })

  it('400s on an empty query', async () => {
    await build()
    expect((await app.inject('/api/search?q=%20')).statusCode).toBe(400)
    expect((await app.inject('/api/search')).statusCode).toBe(400)
  })

  it('502s with the yt-dlp message when search fails', async () => {
    await build({
      search: async () => {
        throw new Error('YouTube bot check hit.')
      },
    })
    const res = await app.inject('/api/search?q=x')
    expect(res.statusCode).toBe(502)
    expect(res.json()).toEqual({ error: 'YouTube bot check hit.' })
  })

  it('limits each IP to 30 searches per minute', async () => {
    await build()
    for (let i = 0; i < 30; i++) expect((await app.inject('/api/search?q=x')).statusCode).toBe(200)
    expect((await app.inject('/api/search?q=x')).statusCode).toBe(429)
  })
})

describe('web UI', () => {
  it('serves index.html from webDir', async () => {
    const web = await mkdtemp(join(tmpdir(), 'ms-web-'))
    await writeFile(join(web, 'index.html'), '<!doctype html><title>Music Station</title>')
    await build({ webDir: web })
    const res = await app.inject('/')
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Music Station')
    expect((await app.inject(`/audio/${A}.m4a`)).statusCode).toBe(200)
    await rm(web, { recursive: true, force: true })
  })
})
