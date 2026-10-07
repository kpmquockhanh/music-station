import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  VideoRejected,
  createYouTube,
  downloadArgs,
  explainError,
  infoArgs,
  parseInfo,
  parseSearchOutput,
  searchArgs,
  transcodeArgs,
} from './youtube'
import type { RunFn } from './process'

const ID = 'dQw4w9WgXcQ'
const URL_ = `https://www.youtube.com/watch?v=${ID}`

describe('argument builders', () => {
  it('search puts the term after --', () => {
    expect(searchArgs('-rf lofi')).toEqual([
      '--no-warnings',
      '--no-progress',
      '--flat-playlist',
      '--dump-json',
      '--',
      'ytsearch10:-rf lofi',
    ])
  })

  it('info rebuilds the URL from the id', () => {
    expect(infoArgs(ID)).toEqual(['--no-warnings', '--no-progress', '--dump-json', '--no-playlist', '--', URL_])
  })

  it('download saves the source next to the destination and prints its path', () => {
    expect(downloadArgs(ID, '/data/cache/.tmp/x.m4a')).toEqual([
      '--no-warnings',
      '--no-progress',
      '--no-playlist',
      '-f',
      '140/bestaudio[ext=m4a]/bestaudio',
      '--print',
      'after_move:filepath',
      '-o',
      '/data/cache/.tmp/x.src.%(ext)s',
      '--',
      URL_,
    ])
  })

  it('transcode copies AAC sources untouched, with the index up front', () => {
    const args = transcodeArgs('/tmp/x.src.m4a', '/tmp/x.m4a')
    expect(args.slice(args.indexOf('-i'), args.indexOf('-i') + 2)).toEqual(['-i', '/tmp/x.src.m4a'])
    expect(args.join(' ')).toContain('-c:a copy -movflags +faststart')
    expect(args).not.toContain('-b:a')
    expect(args.at(-1)).toBe('/tmp/x.m4a')
  })

  it('transcode encodes other sources to 128 kbps AAC', () => {
    expect(transcodeArgs('/tmp/x.src.webm', '/tmp/x.m4a').join(' ')).toContain('-c:a aac -b:a 128k -movflags')
  })

  it('adds cookies before --', () => {
    const args = infoArgs(ID, '/data/cookies.txt')
    expect(args.slice(0, 4)).toEqual(['--no-warnings', '--no-progress', '--cookies', '/data/cookies.txt'])
    expect(args.at(-2)).toBe('--')
  })

  it('refuses invalid ids and non-m4a destinations', () => {
    expect(() => infoArgs('bad id')).toThrow()
    expect(() => downloadArgs(ID, '/tmp/x.webm')).toThrow()
  })
})

describe('parseSearchOutput', () => {
  it('keeps videos, drops channels, live streams and junk lines', () => {
    const lines = [
      JSON.stringify({ id: ID, title: 'Never Gonna', channel: 'Rick', duration: 213.0 }),
      JSON.stringify({ id: 'UCuAXFkgsw1L7xaCfnd5JJOw', title: 'A channel', channel: 'Rick' }),
      JSON.stringify({ id: 'abcdefghijk', title: 'Live now', channel: 'X', live_status: 'is_live' }),
      'not json',
      JSON.stringify({ id: 'zzzzzzzzzzz', title: 'No duration', uploader: 'Up' }),
      '',
    ].join('\n')
    expect(parseSearchOutput(lines)).toEqual([
      {
        videoId: ID,
        title: 'Never Gonna',
        channel: 'Rick',
        duration: 213,
        thumbnail: `https://i.ytimg.com/vi/${ID}/mqdefault.jpg`,
      },
      {
        videoId: 'zzzzzzzzzzz',
        title: 'No duration',
        channel: 'Up',
        duration: null,
        thumbnail: 'https://i.ytimg.com/vi/zzzzzzzzzzz/mqdefault.jpg',
      },
    ])
  })
})

describe('parseInfo', () => {
  const base = { id: ID, title: 'Never Gonna', channel: 'Rick', duration: 213, live_status: 'not_live' }

  it('returns video info', () => {
    expect(parseInfo(JSON.stringify(base), 3_600)).toEqual({
      videoId: ID,
      title: 'Never Gonna',
      channel: 'Rick',
      duration: 213,
      thumbnail: `https://i.ytimg.com/vi/${ID}/mqdefault.jpg`,
    })
  })

  it('rejects livestreams, premieres, long and lengthless videos', () => {
    expect(() => parseInfo(JSON.stringify({ ...base, live_status: 'is_live' }), 3_600)).toThrow(VideoRejected)
    expect(() => parseInfo(JSON.stringify({ ...base, live_status: 'is_upcoming' }), 3_600)).toThrow(VideoRejected)
    expect(() => parseInfo(JSON.stringify({ ...base, duration: 3_601 }), 3_600)).toThrow(/60 minutes/)
    expect(() => parseInfo(JSON.stringify({ ...base, duration: null }), 3_600)).toThrow(VideoRejected)
  })
})

describe('explainError', () => {
  it('gives the bot check a clear remedy', () => {
    const e = explainError(new Error("ERROR: [youtube] abc: Sign in to confirm you're not a bot. Use --cookies"))
    expect(e.message).toMatch(/bot check/i)
    expect(e.message).toMatch(/YTDLP_COOKIES/)
  })

  it('keeps the last ERROR line without the prefix', () => {
    const e = explainError(new Error(`WARNING: x\nERROR: [youtube] ${ID}: Video unavailable`))
    expect(e.message).toBe('Video unavailable')
  })
})

describe('createYouTube', () => {
  function fakeRun(stdout = '') {
    const calls: { bin: string; args: string[]; timeoutMs: number }[] = []
    const run: RunFn = async (bin, args, timeoutMs) => {
      calls.push({ bin, args, timeoutMs })
      return stdout
    }
    return { calls, run }
  }

  it('uses the configured binary and the spec timeouts', async () => {
    const info = JSON.stringify({ id: ID, title: 't', channel: 'c', duration: 10 })
    const fake = fakeRun(info)
    const yt = createYouTube({ bin: '/opt/yt-dlp/yt-dlp', maxDurationSec: 3_600 }, fake.run)
    await yt.search('lofi')
    await yt.getInfo(ID)
    expect(fake.calls.map((c) => [c.bin, c.timeoutMs])).toEqual([
      ['/opt/yt-dlp/yt-dlp', 15_000],
      ['/opt/yt-dlp/yt-dlp', 20_000],
    ])
  })

  it('downloads with yt-dlp, transcodes the printed file with ffmpeg, then deletes the source', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yt-'))
    const src = join(dir, 'a.src.webm')
    writeFileSync(src, 'source')
    const fake = fakeRun(`${src}\n`)
    const yt = createYouTube({ bin: 'yt-dlp', ffmpegBin: '/usr/bin/ffmpeg', maxDurationSec: 3_600 }, fake.run)
    await yt.download(ID, join(dir, 'a.m4a'))
    expect(fake.calls.map((c) => [c.bin, c.timeoutMs])).toEqual([
      ['yt-dlp', 120_000],
      ['/usr/bin/ffmpeg', 180_000],
    ])
    expect(fake.calls[1]!.args).toEqual(transcodeArgs(src, join(dir, 'a.m4a')))
    expect(existsSync(src)).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  it('deletes the source when transcoding fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yt-'))
    const src = join(dir, 'a.src.m4a')
    writeFileSync(src, 'source')
    const run: RunFn = async (bin) => {
      if (bin === 'ffmpeg') throw new Error('Invalid data found when processing input')
      return src
    }
    const yt = createYouTube({ bin: 'yt-dlp', maxDurationSec: 3_600 }, run)
    await expect(yt.download(ID, join(dir, 'a.m4a'))).rejects.toThrow('Invalid data found when processing input')
    expect(existsSync(src)).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  it('fails when yt-dlp prints no path', async () => {
    const fake = fakeRun('')
    const yt = createYouTube({ bin: 'yt-dlp', maxDurationSec: 3_600 }, fake.run)
    await expect(yt.download(ID, '/tmp/a.m4a')).rejects.toThrow('did not say where')
    expect(fake.calls).toHaveLength(1)
  })

  it('rejects an invalid id without spawning', async () => {
    const fake = fakeRun()
    const yt = createYouTube({ bin: 'yt-dlp', maxDurationSec: 3_600 }, fake.run)
    await expect(yt.getInfo('nope')).rejects.toThrow(VideoRejected)
    expect(fake.calls).toEqual([])
  })

  it('explains failures', async () => {
    const run: RunFn = async () => {
      throw new Error('ERROR: [youtube] x: Private video. Sign in if you have access')
    }
    const yt = createYouTube({ bin: 'yt-dlp', maxDurationSec: 3_600 }, run)
    await expect(yt.download(ID, '/tmp/a.m4a')).rejects.toThrow('Private video. Sign in if you have access')
  })
})
