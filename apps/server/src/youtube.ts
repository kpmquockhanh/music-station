import { rm } from 'node:fs/promises'
import { isVideoId, type SearchResult, type VideoInfo } from '@music-station/shared'
import { runProcess, type RunFn } from './process'

export class VideoRejected extends Error {}

export interface YouTubeOptions {
  bin: string
  ffmpegBin?: string
  cookies?: string
  maxDurationSec: number
}

export interface YouTube {
  search(query: string): Promise<SearchResult[]>
  getInfo(videoId: string): Promise<VideoInfo>
  /** Songs similar to this one, from YouTube's Mix for it. The first is usually the song itself. */
  related(videoId: string): Promise<SearchResult[]>
  download(videoId: string, destPath: string): Promise<void>
  update(): Promise<string>
}

const SEARCH_TIMEOUT_MS = 15_000
const INFO_TIMEOUT_MS = 20_000
const RELATED_TIMEOUT_MS = 20_000
const RELATED_COUNT = 25
const DOWNLOAD_TIMEOUT_MS = 120_000
// Copying AAC takes a second; encoding a fallback source takes about 45 s for 60 minutes on a laptop.
const TRANSCODE_TIMEOUT_MS = 180_000
const UPDATE_TIMEOUT_MS = 60_000
/**
 * Only for sources that are not AAC already. ffmpeg's own AAC encoder adds audible clicks when it re-encodes
 * lossy audio at low rates (thousands per song at 64k), so AAC sources are copied untouched instead.
 */
export const FALLBACK_BITRATE = '128k'

export const thumbnailUrl = (videoId: string) => `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`

function watchUrl(videoId: string): string {
  if (!isVideoId(videoId)) throw new VideoRejected('Invalid video id')
  return `https://www.youtube.com/watch?v=${videoId}`
}

function common(cookies?: string): string[] {
  return ['--no-warnings', '--no-progress', ...(cookies ? ['--cookies', cookies] : [])]
}

export function searchArgs(query: string, cookies?: string): string[] {
  return [...common(cookies), '--flat-playlist', '--dump-json', '--', `ytsearch10:${query}`]
}

export function relatedArgs(videoId: string, cookies?: string): string[] {
  const url = `${watchUrl(videoId)}&list=RD${videoId}`
  return [...common(cookies), '--flat-playlist', '--dump-json', '--playlist-end', String(RELATED_COUNT), '--', url]
}

export function infoArgs(videoId: string, cookies?: string): string[] {
  return [...common(cookies), '--dump-json', '--no-playlist', '--', watchUrl(videoId)]
}

/** Downloads the source audio as is, next to destPath, and prints where it landed. */
export function downloadArgs(videoId: string, destPath: string, cookies?: string): string[] {
  if (!destPath.endsWith('.m4a')) throw new Error('destPath must end with .m4a')
  const template = destPath.replace(/\.m4a$/, '.src.%(ext)s')
  return [
    ...common(cookies),
    '--no-playlist',
    '-f',
    '140/bestaudio[ext=m4a]/bestaudio',
    '--print',
    'after_move:filepath',
    '-o',
    template,
    '--',
    watchUrl(videoId),
  ]
}

/**
 * Writes the source as m4a with the index up front so playback can start early. YouTube's m4a audio is AAC and
 * is copied as is; anything else (an opus fallback) is encoded to AAC at FALLBACK_BITRATE.
 */
export function transcodeArgs(srcPath: string, destPath: string): string[] {
  const codec = srcPath.endsWith('.m4a') ? ['copy'] : ['aac', '-b:a', FALLBACK_BITRATE]
  return [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    srcPath,
    '-vn',
    '-map_metadata',
    '-1',
    '-c:a',
    ...codec,
    '-movflags',
    '+faststart',
    destPath,
  ]
}

interface RawEntry {
  id?: unknown
  title?: unknown
  channel?: unknown
  uploader?: unknown
  duration?: unknown
  live_status?: unknown
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const isLive = (e: RawEntry) => e.live_status === 'is_live' || e.live_status === 'is_upcoming'

export function parseSearchOutput(stdout: string): SearchResult[] {
  const results: SearchResult[] = []
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    let e: RawEntry
    try {
      e = JSON.parse(line) as RawEntry
    } catch {
      continue
    }
    if (typeof e.id !== 'string' || !isVideoId(e.id) || isLive(e)) continue
    results.push({
      videoId: e.id,
      title: str(e.title),
      channel: str(e.channel) || str(e.uploader),
      duration: typeof e.duration === 'number' ? Math.round(e.duration) : null,
      thumbnail: thumbnailUrl(e.id),
    })
  }
  return results
}

export function parseInfo(json: string, maxDurationSec: number): VideoInfo {
  const e = JSON.parse(json) as RawEntry
  if (typeof e.id !== 'string' || !isVideoId(e.id)) throw new Error('yt-dlp returned no video id')
  if (isLive(e)) throw new VideoRejected('Livestreams are not supported')
  if (typeof e.duration !== 'number' || e.duration <= 0) {
    throw new VideoRejected('This video has no fixed length')
  }
  if (e.duration > maxDurationSec) {
    throw new VideoRejected(`Videos longer than ${Math.round(maxDurationSec / 60)} minutes are not supported`)
  }
  return {
    videoId: e.id,
    title: str(e.title),
    channel: str(e.channel) || str(e.uploader),
    duration: e.duration,
    thumbnail: thumbnailUrl(e.id),
  }
}

export function explainError(err: unknown): Error {
  if (err instanceof VideoRejected) return err
  const text = err instanceof Error ? err.message : String(err)
  if (/confirm you.?re not a bot/i.test(text)) {
    return new Error(
      'YouTube bot check hit. Update yt-dlp, wait a while, or mount a cookies file (YTDLP_COOKIES).',
    )
  }
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  const line = [...lines].reverse().find((l) => l.startsWith('ERROR:')) ?? lines.at(-1) ?? 'yt-dlp failed'
  return new Error(line.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?([A-Za-z0-9_-]+:\s+)?/, ''))
}

export function createYouTube(opts: YouTubeOptions, run: RunFn = runProcess): YouTube {
  const call = async (args: string[], timeoutMs: number, bin = opts.bin) => {
    try {
      return await run(bin, args, timeoutMs)
    } catch (err) {
      throw explainError(err)
    }
  }
  return {
    async search(query) {
      return parseSearchOutput(await call(searchArgs(query, opts.cookies), SEARCH_TIMEOUT_MS))
    },
    async getInfo(videoId) {
      const args = infoArgs(videoId, opts.cookies) // throws VideoRejected before spawning
      return parseInfo(await call(args, INFO_TIMEOUT_MS), opts.maxDurationSec)
    },
    async related(videoId) {
      const args = relatedArgs(videoId, opts.cookies) // throws VideoRejected before spawning
      return parseSearchOutput(await call(args, RELATED_TIMEOUT_MS))
    },
    async download(videoId, destPath) {
      const out = await call(downloadArgs(videoId, destPath, opts.cookies), DOWNLOAD_TIMEOUT_MS)
      const src = out.trim().split('\n').at(-1)?.trim()
      if (!src) throw new Error('yt-dlp did not say where it saved the audio')
      try {
        await call(transcodeArgs(src, destPath), TRANSCODE_TIMEOUT_MS, opts.ffmpegBin ?? 'ffmpeg')
      } finally {
        await rm(src, { force: true })
      }
    },
    update() {
      return call(['-U'], UPDATE_TIMEOUT_MS)
    },
  }
}
