import rateLimit from '@fastify/rate-limit'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyInstance } from 'fastify'
import { searchQuerySchema } from '@music-station/shared'
import type { SearchFn } from './search'

export interface HttpOptions {
  cacheDir: string
  webDir: string | null
  /** Header holding the visitor's IP, set by a proxy that overwrites it (Cloudflare's cf-connecting-ip). */
  clientIpHeader?: string
  hasAudio(videoId: string): boolean
  search: SearchFn
  logger?: boolean
}

const AUDIO_RE = /^([A-Za-z0-9_-]{11})\.m4a$/

export async function buildHttp(opts: HttpOptions): Promise<FastifyInstance> {
  // Ignore X-Forwarded-For: a client could pick a new IP per request and dodge the limit.
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: false })

  const header = opts.clientIpHeader
  await app.register(rateLimit, {
    global: false,
    keyGenerator: (req) => {
      const value = header ? req.headers[header] : undefined
      return typeof value === 'string' && value !== '' ? value : req.ip
    },
  })
  // One static instance: it serves the web UI when webDir is set, and always provides reply.sendFile.
  await app.register(fastifyStatic, { root: opts.webDir ?? opts.cacheDir, serve: opts.webDir !== null })

  app.get('/api/search', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const parsed = searchQuerySchema.safeParse(req.query)
    if (!parsed.success) return reply.code(400).send({ error: 'Type something to search for' })
    try {
      return { results: await opts.search(parsed.data.q) }
    } catch (err) {
      req.log.warn({ err }, 'search failed')
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'Search failed' })
    }
  })

  app.get<{ Params: { file: string } }>('/audio/:file', async (req, reply) => {
    const m = req.params.file.match(AUDIO_RE)
    if (!m || !opts.hasAudio(m[1]!)) return reply.code(404).send({ error: 'Not found' })
    return reply.sendFile(req.params.file, opts.cacheDir, { maxAge: 86_400_000, immutable: true })
  })

  return app
}

/**
 * Names the web build by its hashed main script, such as /assets/index-s_cwYgfE.js. It changes with every
 * change to the UI, and the page knows its own from the script tag it loaded, so the two can be compared.
 */
export function webVersionOf(indexHtml: string): string | null {
  return indexHtml.match(/<script[^>]*\ssrc="(\/assets\/[^"]+\.js)"/)?.[1] ?? null
}
