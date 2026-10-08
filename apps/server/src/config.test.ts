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
      clientIpHeader: undefined,
      syncLog: false,
      cacheMaxBytes: 2 * 1024 ** 3,
      maxDurationSec: 3_600,
      idlePauseMs: 300_000,
    })
  })

  it('reads overrides', () => {
    const c = loadConfig({
      PORT: '4000',
      DATA_DIR: '/data',
      WEB_DIR: '/app/web',
      YTDLP_BIN: '/opt/yt-dlp/yt-dlp',
      YTDLP_COOKIES: '/data/cookies.txt',
      CLIENT_IP_HEADER: 'CF-Connecting-IP',
      CACHE_MAX_GB: '0.5',
      MAX_DURATION_MIN: '15',
      IDLE_PAUSE_MIN: '0.5',
    })
    expect(c).toMatchObject({
      port: 4000,
      dataDir: '/data',
      webDir: '/app/web',
      ytdlpBin: '/opt/yt-dlp/yt-dlp',
      cookies: '/data/cookies.txt',
      clientIpHeader: 'cf-connecting-ip',
      cacheMaxBytes: 0.5 * 1024 ** 3,
      maxDurationSec: 900,
      idlePauseMs: 30_000,
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
    expect(() => loadConfig({ IDLE_PAUSE_MIN: '-1' })).toThrow(/IDLE_PAUSE_MIN/)
  })

  it('turns the idle pause off with 0', () => {
    expect(loadConfig({ IDLE_PAUSE_MIN: '0' }).idlePauseMs).toBe(0)
  })
})
