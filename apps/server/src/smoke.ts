// Manual check against real YouTube: node dist/smoke.js ["search words"]
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from './config'
import { createYouTube } from './youtube'

const config = loadConfig(process.env)
const youtube = createYouTube({
  bin: config.ytdlpBin,
  cookies: config.cookies,
  maxDurationSec: config.maxDurationSec,
})
const query = process.argv[2] ?? 'lofi hip hop'
const dir = await mkdtemp(join(tmpdir(), 'ms-smoke-'))

try {
  const results = await youtube.search(query)
  console.log(`search "${query}": ${results.length} results`)
  const pick = results.find((r) => r.duration !== null && r.duration < 600)
  if (!pick) throw new Error('No result shorter than 10 minutes to test with')

  const info = await youtube.getInfo(pick.videoId)
  console.log(`info: ${info.title} by ${info.channel}, ${info.duration}s`)

  const dest = join(dir, `${info.videoId}.m4a`)
  const started = Date.now()
  await youtube.download(info.videoId, dest)
  const { size } = await stat(dest)
  console.log(`download: ${(size / 1_048_576).toFixed(1)} MB in ${((Date.now() - started) / 1000).toFixed(1)}s`)
  console.log('smoke OK')
} finally {
  await rm(dir, { recursive: true, force: true })
}
