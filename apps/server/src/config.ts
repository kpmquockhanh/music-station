export interface Config {
  port: number
  dataDir: string
  webDir: string | null
  ytdlpBin: string
  cookies?: string
  cacheMaxBytes: number
  maxDurationSec: number
}

type Env = Record<string, string | undefined>

function positive(env: Env, name: string, fallback: number): number {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number, got "${raw}"`)
  return n
}

export function loadConfig(env: Env = process.env): Config {
  return {
    port: positive(env, 'PORT', 3000),
    dataDir: env.DATA_DIR || './data',
    webDir: env.WEB_DIR || null,
    ytdlpBin: env.YTDLP_BIN || 'yt-dlp',
    cookies: env.YTDLP_COOKIES || undefined,
    cacheMaxBytes: positive(env, 'CACHE_MAX_GB', 2) * 1024 ** 3,
    maxDurationSec: positive(env, 'MAX_DURATION_MIN', 60) * 60,
  }
}
