import rateLimit from '@fastify/rate-limit'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyInstance } from 'fastify'
import { searchQuerySchema } from '@music-station/shared'
import type { SearchFn } from './search'

export interface HttpOptions {
  cacheDir: string
  webDir: string | null
  hasAudio(videoId: string): boolean
  search: SearchFn
  logger?: boolean
}

const AUDIO_RE = /^([A-Za-z0-9_-]{11})\.m4a$/

export async function buildHttp(opts: HttpOptions): Promise<FastifyInstance> {
  // trustProxy: requests arrive through the Tailscale proxy, so use X-Forwarded-For for per-IP limits.
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: true })

  await app.register(rateLimit, { global: false })
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
