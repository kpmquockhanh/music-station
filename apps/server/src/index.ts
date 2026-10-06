import { createApp } from './app'
import { loadConfig } from './config'
import { createYouTube } from './youtube'

const UPDATE_EVERY_MS = 24 * 60 * 60 * 1000

async function main(): Promise<void> {
  const config = loadConfig(process.env)
  const youtube = createYouTube({
    bin: config.ytdlpBin,
    cookies: config.cookies,
    maxDurationSec: config.maxDurationSec,
  })

  // YouTube changes often and old yt-dlp versions start failing, so update on start and daily.
  const update = () =>
    youtube.update().then(
      (out) => console.log(`yt-dlp: ${out.trim().split('\n').pop() ?? ''}`),
      (err) => console.error(`yt-dlp update failed: ${String(err)}`),
    )
  void update()
  const updates = setInterval(update, UPDATE_EVERY_MS)

  const app = await createApp({ config, youtube })
  await app.listen()
  console.log(`Music station listening on port ${config.port}`)

  let stopping = false
  const stop = async (signal: string) => {
    if (stopping) return
    stopping = true
    console.log(`${signal} received, saving and shutting down`)
    clearInterval(updates)
    await app.close()
    process.exit(0)
  }
  process.on('SIGTERM', () => void stop('SIGTERM'))
  process.on('SIGINT', () => void stop('SIGINT'))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
