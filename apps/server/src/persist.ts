import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { MAX_QUEUE, VIDEO_ID_RE } from '@music-station/shared'
import type { StationSnapshot } from './station'

export interface Persisted extends StationSnapshot {
  version: 1
  savedAt: number
}

const itemSchema = z.object({
  id: z.string().min(1),
  videoId: z.string().regex(VIDEO_ID_RE),
  title: z.string(),
  channel: z.string(),
  duration: z.number().positive(),
  thumbnail: z.string(),
  addedBy: z.string(),
  status: z.enum(['downloading', 'ready', 'failed']),
})

const persistedSchema = z.object({
  version: z.literal(1),
  savedAt: z.number(),
  current: itemSchema.nullable(),
  queue: z.array(itemSchema).max(MAX_QUEUE),
  playback: z.object({
    status: z.enum(['playing', 'paused', 'waiting']),
    position: z.number().min(0),
    at: z.number(),
  }),
})

export async function loadState(
  file: string,
  log: (msg: string) => void = console.warn,
): Promise<Persisted | null> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    log(`Could not read ${file}: ${String(err)}. Starting with an empty station.`)
    return null
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  const parsed = persistedSchema.safeParse(json)
  if (parsed.success) return parsed.data
  log(`${file} is corrupt. Starting with an empty station; the old file is kept as ${file}.corrupt`)
  await rename(file, `${file}.corrupt`).catch(() => {})
  return null
}

export async function saveState(file: string, data: Persisted): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await writeFile(tmp, JSON.stringify(data))
  await rename(tmp, file)
}

export interface Saver {
  schedule(): void
  flush(): Promise<void>
}

export function createSaver(
  file: string,
  getData: () => Persisted,
  delayMs = 1_000,
  log: (msg: string) => void = console.error,
): Saver {
  let timer: NodeJS.Timeout | null = null
  let chain: Promise<void> = Promise.resolve()
  const write = () => {
    chain = chain
      .then(() => saveState(file, getData()))
      .catch((err) => log(`Saving station state failed: ${String(err)}`))
  }
  return {
    schedule() {
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        write()
      }, delayMs)
    },
    flush() {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      write()
      return chain
    },
  }
}
