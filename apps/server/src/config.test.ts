import { describe, expect, it } from 'vitest'
import { loadConfig } from './config'

describe('loadConfig', () => {
  it('uses defaults', () => {
    expect(loadConfig({})).toEqual({
      port: 3000,
      dataDir: './data',
      webDir: null,
      ytdlpBin: 'yt-dlp',
      cookies: undefined,
      cacheMaxBytes: 2 * 1024 ** 3,
      maxDurationSec: 3_600,
    })
  })

  it('reads overrides', () => {
    const c = loadConfig({
      PORT: '4000',
      DATA_DIR: '/data',
      WEB_DIR: '/app/web',
      YTDLP_BIN: '/opt/yt-dlp/yt-dlp',
      YTDLP_COOKIES: '/data/cookies.txt',
      CACHE_MAX_GB: '0.5',
      MAX_DURATION_MIN: '15',
    })
    expect(c).toMatchObject({
      port: 4000,
      dataDir: '/data',
      webDir: '/app/web',
      ytdlpBin: '/opt/yt-dlp/yt-dlp',
      cookies: '/data/cookies.txt',
      cacheMaxBytes: 0.5 * 1024 ** 3,
      maxDurationSec: 900,
    })
  })

  it('treats empty strings as unset', () => {
    expect(loadConfig({ YTDLP_COOKIES: '', CACHE_MAX_GB: '' })).toMatchObject({
      cookies: undefined,
      cacheMaxBytes: 2 * 1024 ** 3,
    })
  })

  it('rejects invalid numbers', () => {
    expect(() => loadConfig({ CACHE_MAX_GB: 'lots' })).toThrow(/CACHE_MAX_GB/)
    expect(() => loadConfig({ MAX_DURATION_MIN: '-1' })).toThrow(/MAX_DURATION_MIN/)
  })
})
