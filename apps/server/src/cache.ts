import { mkdirSync, readdirSync, rmSync, statSync, unlinkSync, utimesSync } from 'node:fs'
import { rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import pLimit from 'p-limit'

export type Downloader = (videoId: string, destPath: string) => Promise<void>

export interface CacheOptions {
  dir: string
  maxBytes: number
  download: Downloader
  concurrency?: number
}

interface Entry {
  size: number
  mtimeMs: number
}

const FILE_RE = /^([A-Za-z0-9_-]{11})\.m4a$/

export class AudioCache {
  private files = new Map<string, Entry>()
  private inflight = new Map<string, Promise<string>>()
  private limit: ReturnType<typeof pLimit>
  private tmpDir: string

  constructor(private opts: CacheOptions) {
    this.limit = pLimit(opts.concurrency ?? 2)
    this.tmpDir = join(opts.dir, '.tmp')
  }

  async init(): Promise<void> {
    mkdirSync(this.opts.dir, { recursive: true })
    rmSync(this.tmpDir, { recursive: true, force: true })
    mkdirSync(this.tmpDir, { recursive: true })
    this.files.clear()
    for (const name of readdirSync(this.opts.dir)) {
      const m = name.match(FILE_RE)
      if (!m) continue
      const st = statSync(join(this.opts.dir, name))
      this.files.set(m[1]!, { size: st.size, mtimeMs: st.mtimeMs })
    }
  }

  pathFor(videoId: string): string {
    return join(this.opts.dir, `${videoId}.m4a`)
  }

  has(videoId: string): boolean {
    return this.files.has(videoId)
  }

  totalBytes(): number {
    let total = 0
    for (const e of this.files.values()) total += e.size
    return total
  }

  ensure(videoId: string): Promise<string> {
    if (this.files.has(videoId)) return Promise.resolve(this.pathFor(videoId))
    const running = this.inflight.get(videoId)
    if (running) return running
    const p = this.limit(() => this.fetch(videoId)).finally(() => this.inflight.delete(videoId))
    this.inflight.set(videoId, p)
    return p
  }

  touch(videoId: string): void {
    const entry = this.files.get(videoId)
    if (!entry) return
    const now = new Date()
    try {
      utimesSync(this.pathFor(videoId), now, now)
      entry.mtimeMs = now.getTime()
    } catch {
      this.files.delete(videoId) // file vanished from disk
    }
  }

  evict(protectedIds: Set<string>): string[] {
    let total = this.totalBytes()
    if (total <= this.opts.maxBytes) return []
    const candidates = [...this.files]
      .filter(([id]) => !protectedIds.has(id))
      .sort((a, b) => a[1].mtimeMs - b[1].mtimeMs)
    const deleted: string[] = []
    for (const [id, entry] of candidates) {
      if (total <= this.opts.maxBytes) break
      try {
        unlinkSync(this.pathFor(id))
      } catch {
        // already gone; still drop it from the index
      }
      this.files.delete(id)
      total -= entry.size
      deleted.push(id)
    }
    return deleted
  }

  private async fetch(videoId: string): Promise<string> {
    const tmp = join(this.tmpDir, `${videoId}.m4a`)
    await rm(tmp, { force: true })
    try {
      await this.opts.download(videoId, tmp)
      const final = this.pathFor(videoId)
      await rename(tmp, final)
      const st = await stat(final)
      this.files.set(videoId, { size: st.size, mtimeMs: st.mtimeMs })
      return final
    } catch (err) {
      await rm(tmp, { force: true })
      throw err
    }
  }
}
