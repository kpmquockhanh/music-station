import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { Server } from 'socket.io'
import { AudioCache } from './cache'
import type { Config } from './config'
import { buildHttp, webVersionOf } from './http'
import { createSaver, loadState } from './persist'
import { attachRealtime, type Realtime } from './realtime'
import { createSearch } from './search'
import { StationService } from './service'
import { Station } from './station'
import type { YouTube } from './youtube'

export interface AppDeps {
  config: Config
  youtube: Pick<YouTube, 'search' | 'getInfo' | 'related' | 'download'>
  now?: () => number
  log?: (msg: string) => void
  graceMs?: number
  saveDelayMs?: number
  playingSaveMs?: number
}

export interface App {
  http: FastifyInstance
  io: Server
  service: StationService
  cache: AudioCache
  listen(): Promise<void>
  close(): Promise<void>
}

const TICK_MS = 250

export async function createApp(deps: AppDeps): Promise<App> {
  const { config, youtube } = deps
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((msg: string) => console.log(msg))
  const cacheDir = join(config.dataDir, 'cache')
  const stateFile = join(config.dataDir, 'station.json')

  const cache = new AudioCache({ dir: cacheDir, maxBytes: config.cacheMaxBytes, download: youtube.download })
  await cache.init()

  let realtime: Realtime | undefined
  const saver = createSaver(stateFile, () => service.persisted(), deps.saveDelayMs ?? 1_000, log)
  const service: StationService = new StationService({
    station: new Station(),
    cache,
    getInfo: youtube.getInfo,
    related: youtube.related,
    now,
    onChange: () => {
      realtime?.broadcastState()
      saver.schedule()
    },
    onActivity: (text) => {
      log(text)
      realtime?.broadcastActivity(text)
    },
    log,
    idlePauseMs: config.idlePauseMs,
  })
  service.restore(await loadState(stateFile, log))

  const http = await buildHttp({
    cacheDir,
    webDir: config.webDir,
    clientIpHeader: config.clientIpHeader,
    hasAudio: (id) => cache.has(id),
    search: createSearch((q) => youtube.search(q)),
  })
  const io = new Server(http.server, { serveClient: false })
  const webVersion = config.webDir
    ? webVersionOf(await readFile(join(config.webDir, 'index.html'), 'utf8').catch(() => ''))
    : null
  realtime = attachRealtime(io, service, { now, log, graceMs: deps.graceMs, syncLog: config.syncLog, webVersion })

  const tick = setInterval(() => service.tick(), TICK_MS)
  // A crash skips close(), so keep savedAt fresh while the position moves (Review Focus 5).
  const periodicSave = setInterval(() => {
    if (service.isPlaying()) saver.schedule()
  }, deps.playingSaveMs ?? 5_000)

  return {
    http,
    io,
    service,
    cache,
    async listen() {
      await http.listen({ port: config.port, host: '0.0.0.0' })
    },
    async close() {
      clearInterval(tick)
      clearInterval(periodicSave)
      realtime?.close() // before disconnecting, so no leave timers are scheduled
      // Save first: http.close() waits for open responses, such as audio streams, and may never return.
      await saver.flush()
      io.disconnectSockets(true)
      io.engine.close()
      await http.close()
    },
  }
}
