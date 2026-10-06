# Music Station Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a single-station web app where friends open one link and hear the same YouTube song at the same moment. Anyone can search, queue and control playback.

**Architecture:** One Node 22 process (Fastify + Socket.IO) runs in Docker on the user's Mac. It downloads songs with yt-dlp into a disk cache and owns the playback clock as `{status, position, at}`. Browsers measure their offset from the server clock and steer an `<audio>` element toward the shared target position. A Tailscale Funnel sidecar container gives the app a fixed public https URL.

**Tech Stack:** TypeScript (strict, ESM), pnpm 9 workspaces, Node 22, Fastify 5, @fastify/static 8, @fastify/rate-limit 10, Socket.IO 4, zod 3, lru-cache 11, p-limit 6, Vitest 3, tsup 8, tsx 4, React 19, Vite 6, Tailwind CSS 4, yt-dlp (standalone binary), Deno, ffmpeg, Docker Compose, Tailscale.

**Spec:** `docs/superpowers/specs/2026-10-06-music-station-design.md`

## Global Constraints

- Runtime is Node 22 (`node:22-bookworm-slim` in the container). The package manager is pnpm 9.6.0, declared via `"packageManager": "pnpm@9.6.0"`.
- All packages are ESM (`"type": "module"`), TypeScript `strict: true`, with tests in Vitest.
- `START_LEAD_MS = 1000`. The server `tick` runs every 250 ms, and the client correction loop also runs every 250 ms.
- Drift correction: |drift| < 30 ms → `playbackRate = 1`. 30–300 ms → `drift > 0 ? 0.97 : 1.03`. > 300 ms → `currentTime = target`, `playbackRate = 1`.
- Target position: `target = position + (serverNow − at) / 1000 + delayMs / 1000`. The per-device delay slider ranges over 0–500 ms and is stored in localStorage.
- Clock sync uses 8 pings, 100 ms apart. `offset = ts − (t0 + t1) / 2`, and the sample with the smallest RTT is kept. Repeat every 30 s, after reconnect, and when the tab becomes visible.
- Video IDs must match `/^[A-Za-z0-9_-]{11}$/`. yt-dlp always receives `https://www.youtube.com/watch?v=<id>`, rebuilt from a validated ID.
- yt-dlp is spawned with an argument array and `--` before the URL or search term, never through a shell.
- yt-dlp timeouts: search 15 s, getInfo 20 s, download 120 s. A timeout kills the process (SIGKILL) and counts as a failed attempt.
- Download format: `-f "140/bestaudio[ext=m4a]/bestaudio" -x --audio-format m4a`.
- Nicknames are 1–24 characters after trimming and are rendered as React text, never `dangerouslySetInnerHTML`.
- Limits:
  - Queue max 200.
  - One control or queue action per socket every 500 ms.
  - `/api/search`: 30 requests/min per IP, LRU of 100 entries × 10 min, max 2 concurrent searches.
  - Max 2 concurrent downloads.
- Cache:
  - Files live at `data/cache/<videoId>.m4a`; in-progress downloads go to `data/cache/.tmp/`.
  - Soft cap `CACHE_MAX_GB` (default 2). Eviction removes the oldest mtime first and never removes current or queued songs.
- `/audio` responses send `Cache-Control: public, max-age=86400, immutable` and support Range.
- Persistence: the state is written to `data/station.json` 1 s after each change, via a temporary file and rename. On start it is restored paused.
- A disconnected listener is removed after a 10 s grace period.
- Environment variables: `TS_AUTHKEY` (required, tailscale only), `CACHE_MAX_GB=2`, `MAX_DURATION_MIN=60`, `YTDLP_COOKIES` (optional path).
- Out of scope: accounts, multiple rooms, chat, voting, playlist import, native apps, gapless transitions, horizontal scaling.
- Commit messages use conventional prefixes (`feat:`, `test:`, `chore:`, `docs:`) and end with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A one-word search like `rickrolling` or `beethoven_5`** happens to be 11 URL-safe characters. Typed into the search box, it must run a search, not be added as a video ID. Tested in Task 1 (`parseVideoLink`) and Task 12 (`classifyInput`).
2. **The same video queued twice, or added again while its first download is still running**, must trigger one download. Every copy becomes ready together, or every copy fails with one notice. Tested in Task 6.
3. **A corrupt or half-written `data/station.json`** must leave the server starting with an empty station and a logged warning. It must not crash-loop under `restart: unless-stopped`. Tested in Task 5.
4. **One phone with two tabs open, or a quick reconnect, under the same `clientId`**: the listener appears once, and closing one tab does not remove them. Tested in Task 8.
5. **A server restart in the middle of a playing song** must resume paused near where the song was. It must not jump back to the position of the last control action or past the end. The state is saved every 5 s while playing, and `restore` uses `savedAt`. Tested in Task 2 (restore math) and Task 8 (restart and periodic save).

---

## File Structure

```
package.json                     workspace root scripts, packageManager
pnpm-workspace.yaml
tsconfig.base.json
.gitignore  .dockerignore  .env.example  README.md
packages/shared/src/
  types.ts        QueueItem, Playback, StationState, SearchResult, VideoInfo, Ack, Activity, constants
  videoId.ts      isVideoId, parseVideoInput, parseVideoLink
  sync.ts         expectedPosition, targetPosition, decideCorrection
  schemas.ts      zod schemas for every client→server payload
  index.ts        re-exports
apps/server/src/
  station.ts      pure state machine (no I/O, `now` injected)
  cache.ts        AudioCache: ensure/has/touch/evict over data/cache
  process.ts      runProcess: spawn with timeout, stdout capture
  youtube.ts      createYouTube: search/getInfo/download/update via yt-dlp
  search.ts       createSearch: LRU + in-flight dedupe + concurrency for search
  persist.ts      loadState/saveState/createSaver for data/station.json
  config.ts       loadConfig from env
  service.ts      StationService: station + cache + youtube orchestration, activity text
  http.ts         buildHttp: /audio, /api/search, static web UI
  realtime.ts     attachRealtime: socket events → service, rate limit, grace period
  app.ts          createApp: wires everything (used by index.ts and the integration test)
  index.ts        process entry: config, yt-dlp updates, listen, signals
  smoke.ts        manual yt-dlp smoke check (not in CI)
apps/server/test/
  fixtures/tone.m4a
  integration.test.ts
apps/web/src/
  clockSync.ts    ClockSync + bestSample
  player.ts       SyncPlayer: <audio> wrapper with drift correction
  format.ts       formatTime, classifyInput
  storage.ts      localStorage helpers (clientId, nickname, delayMs)
  useStation.ts   socket connection + state + actions hook
  App.tsx  main.tsx  index.css
  screens/Join.tsx NowPlaying.tsx Queue.tsx Search.tsx Listeners.tsx Settings.tsx Toasts.tsx
docker/Dockerfile  docker/serve.json  docker-compose.yml
```

Task order: Tasks 1–9 build and test the server, Tasks 10–12 build the web client, and Task 13 packages everything in Docker.

---

### Task 1: Monorepo scaffold and shared package

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`
- Create: `packages/shared/src/types.ts`, `videoId.ts`, `sync.ts`, `schemas.ts`, `index.ts`
- Test: `packages/shared/src/videoId.test.ts`, `sync.test.ts`, `schemas.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (import from `@music-station/shared`):
  - Constants: `START_LEAD_MS = 1000`, `MAX_QUEUE = 200`, `VIDEO_ID_RE`.
  - Types: `QueueItemStatus`, `QueueItem`, `Playback`, `Listener`, `StationState`, `SearchResult`, `VideoInfo`, `Ack`, `Activity`.
  - `isVideoId(s: string): boolean`
  - `parseVideoInput(input: string): string | null` accepts a bare ID or a link.
  - `parseVideoLink(input: string): string | null` accepts links only.
  - `expectedPosition(p: Playback, serverNow: number): number`
  - `targetPosition(p: Playback, serverNow: number, delayMs: number): number`
  - `decideCorrection(currentTime: number, target: number): { rate: number; seekTo: number | null }`
  - Schemas: `joinSchema`, `addSchema`, `removeSchema`, `moveSchema`, `seekSchema`, `emptySchema`, `searchQuerySchema`.

- [ ] **Step 1: Write workspace files**

`package.json`:
```json
{
  "name": "music-station",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@9.6.0",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "typecheck": "pnpm -r typecheck"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - packages/*
  - apps/*
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2023"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "resolveJsonModule": true,
    "noEmit": true
  }
}
```

`.gitignore`:
```
node_modules/
dist/
data/
.env
*.log
.DS_Store
```

`packages/shared/package.json`:
```json
{
  "name": "@music-station/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json"
  },
  "dependencies": { "zod": "^3.23.8" },
  "devDependencies": { "typescript": "^5.6.3", "vitest": "^3.2.4" }
}
```
The package exports TypeScript source directly. Vite and Vitest compile it, and the server build (tsup, Task 9) bundles it.

`packages/shared/tsconfig.json` (the DOM lib provides the `URL` global, which `videoId.ts` uses in both Node and the browser):
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "lib": ["ES2023", "DOM"] },
  "include": ["src"]
}
```

Run: `pnpm install`
Expected: the lockfile is created with no errors.

- [ ] **Step 2: Write the types**

`packages/shared/src/types.ts`:
```ts
export const START_LEAD_MS = 1000
export const MAX_QUEUE = 200
export const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/

export type QueueItemStatus = 'downloading' | 'ready' | 'failed'

export interface QueueItem {
  id: string // uuid; one video can be queued more than once
  videoId: string
  title: string
  channel: string
  duration: number // seconds
  thumbnail: string
  addedBy: string // nickname
  status: QueueItemStatus
}

export interface Playback {
  status: 'playing' | 'paused' | 'waiting' // waiting = current song still downloading
  position: number // seconds into the song…
  at: number // …at this server time (ms)
}

export interface Listener {
  id: string
  nickname: string
}

export interface StationState {
  current: QueueItem | null // null = idle
  queue: QueueItem[] // upcoming, in order
  playback: Playback
  listeners: Listener[]
}

export interface SearchResult {
  videoId: string
  title: string
  channel: string
  duration: number | null
  thumbnail: string
}

export interface VideoInfo {
  videoId: string
  title: string
  channel: string
  duration: number
  thumbnail: string
}

export type Ack = { ok: true } | { ok: false; error: string }

export interface Activity {
  text: string
  at: number
}
```

- [ ] **Step 3: Write failing tests for video ID parsing**

`packages/shared/src/videoId.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { isVideoId, parseVideoInput, parseVideoLink } from './videoId'

const ID = 'dQw4w9WgXcQ'

describe('isVideoId', () => {
  it('accepts 11 URL-safe characters', () => {
    expect(isVideoId(ID)).toBe(true)
    expect(isVideoId('a-b_c123456')).toBe(true)
  })
  it('rejects anything else', () => {
    expect(isVideoId('short')).toBe(false)
    expect(isVideoId('dQw4w9WgXcQx')).toBe(false)
    expect(isVideoId('dQw4w9WgXc!')).toBe(false)
    expect(isVideoId('')).toBe(false)
  })
})

describe('parseVideoLink', () => {
  it.each([
    [`https://www.youtube.com/watch?v=${ID}`],
    [`https://youtube.com/watch?v=${ID}&t=42s`],
    [`https://m.youtube.com/watch?v=${ID}`],
    [`https://music.youtube.com/watch?v=${ID}&feature=share`],
    [`https://youtu.be/${ID}`],
    [`https://youtu.be/${ID}?si=abc`],
    [`https://www.youtube.com/shorts/${ID}`],
    [`https://www.youtube.com/embed/${ID}`],
    [`youtube.com/watch?v=${ID}`],
    [`  https://youtu.be/${ID}  `],
  ])('extracts the ID from %s', (url) => {
    expect(parseVideoLink(url)).toBe(ID)
  })

  it('keeps only the video from a playlist link', () => {
    expect(parseVideoLink(`https://www.youtube.com/watch?v=${ID}&list=PL1234567890`)).toBe(ID)
  })

  it.each([
    ['https://www.youtube.com/playlist?list=PL1234567890'],
    ['https://example.com/watch?v=dQw4w9WgXcQ'],
    ['https://www.youtube.com/watch?v=bad'],
    ['https://youtu.be/'],
    ['not a url at all'],
  ])('returns null for %s', (input) => {
    expect(parseVideoLink(input)).toBeNull()
  })

  it('does not treat an 11-character search word as a link', () => {
    expect(parseVideoLink('rickrolling')).toBeNull()
    expect(parseVideoLink('beethoven_5')).toBeNull()
  })
})

describe('parseVideoInput', () => {
  it('accepts a bare ID', () => {
    expect(parseVideoInput(` ${ID} `)).toBe(ID)
  })
  it('accepts a link', () => {
    expect(parseVideoInput(`https://youtu.be/${ID}`)).toBe(ID)
  })
  it('rejects other text', () => {
    expect(parseVideoInput('hello world')).toBeNull()
  })
})
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `pnpm --filter @music-station/shared test`
Expected: FAIL, `Failed to resolve import "./videoId"`.

- [ ] **Step 5: Implement video ID parsing**

`packages/shared/src/videoId.ts`:
```ts
import { VIDEO_ID_RE } from './types'

const HOSTS = new Set(['youtube.com', 'music.youtube.com', 'youtu.be'])

export function isVideoId(s: string): boolean {
  return VIDEO_ID_RE.test(s)
}

/** Extracts a video ID from a YouTube link. Plain words (even 11-char ones) return null. */
export function parseVideoLink(input: string): string | null {
  const s = input.trim()
  if (!s.includes('/') && !s.includes('.')) return null
  let url: URL
  try {
    url = new URL(s.includes('://') ? s : `https://${s}`)
  } catch {
    return null
  }
  const host = url.hostname.toLowerCase().replace(/^(www|m)\./, '')
  if (!HOSTS.has(host)) return null

  let id: string | null = null
  if (host === 'youtu.be') {
    id = url.pathname.split('/')[1] ?? null
  } else if (url.pathname === '/watch') {
    id = url.searchParams.get('v')
  } else {
    const m = url.pathname.match(/^\/(shorts|embed|live|v)\/([^/]+)/)
    id = m ? m[2]! : null
  }
  return id && isVideoId(id) ? id : null
}

/** Accepts a bare 11-char video ID or a YouTube link. */
export function parseVideoInput(input: string): string | null {
  const s = input.trim()
  if (isVideoId(s)) return s
  return parseVideoLink(s)
}
```

- [ ] **Step 6: Write failing tests for sync math**

`packages/shared/src/sync.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { decideCorrection, expectedPosition, targetPosition } from './sync'
import type { Playback } from './types'

describe('expectedPosition', () => {
  it('advances with server time while playing', () => {
    const p: Playback = { status: 'playing', position: 10, at: 1_000 }
    expect(expectedPosition(p, 3_500)).toBeCloseTo(12.5)
  })
  it('stays at position before the start time (lead-in)', () => {
    const p: Playback = { status: 'playing', position: 10, at: 5_000 }
    expect(expectedPosition(p, 4_200)).toBe(10)
  })
  it('stays at position while paused or waiting', () => {
    expect(expectedPosition({ status: 'paused', position: 7, at: 0 }, 99_999)).toBe(7)
    expect(expectedPosition({ status: 'waiting', position: 0, at: 0 }, 99_999)).toBe(0)
  })
})

describe('targetPosition', () => {
  it('adds the device delay', () => {
    const p: Playback = { status: 'playing', position: 0, at: 1_000 }
    expect(targetPosition(p, 2_000, 0)).toBeCloseTo(1)
    expect(targetPosition(p, 2_000, 200)).toBeCloseTo(1.2)
  })
})

describe('decideCorrection', () => {
  it('does nothing inside the 30 ms deadband', () => {
    expect(decideCorrection(10.02, 10)).toEqual({ rate: 1, seekTo: null })
    expect(decideCorrection(9.98, 10)).toEqual({ rate: 1, seekTo: null })
  })
  it('slows down when ahead by 30–300 ms', () => {
    expect(decideCorrection(10.1, 10)).toEqual({ rate: 0.97, seekTo: null })
  })
  it('speeds up when behind by 30–300 ms', () => {
    expect(decideCorrection(9.8, 10)).toEqual({ rate: 1.03, seekTo: null })
  })
  it('jumps when more than 300 ms off', () => {
    expect(decideCorrection(11, 10)).toEqual({ rate: 1, seekTo: 10 })
    expect(decideCorrection(5, 10)).toEqual({ rate: 1, seekTo: 10 })
  })
})
```

- [ ] **Step 7: Run the tests to verify they fail**

Run: `pnpm --filter @music-station/shared test`
Expected: FAIL, `Failed to resolve import "./sync"`.

- [ ] **Step 8: Implement sync math**

`packages/shared/src/sync.ts`:
```ts
import type { Playback } from './types'

export const DEADBAND_S = 0.03
export const SEEK_THRESHOLD_S = 0.3

/** Where the song should be at `serverNow` (ms), ignoring device delay. */
export function expectedPosition(p: Playback, serverNow: number): number {
  if (p.status !== 'playing') return p.position
  return p.position + Math.max(0, serverNow - p.at) / 1000
}

/** Where this device's <audio> should be. Only meaningful once serverNow + delayMs >= p.at. */
export function targetPosition(p: Playback, serverNow: number, delayMs: number): number {
  return p.position + (serverNow - p.at) / 1000 + delayMs / 1000
}

export function decideCorrection(
  currentTime: number,
  target: number,
): { rate: number; seekTo: number | null } {
  const drift = currentTime - target
  const size = Math.abs(drift)
  if (size < DEADBAND_S) return { rate: 1, seekTo: null }
  if (size <= SEEK_THRESHOLD_S) return { rate: drift > 0 ? 0.97 : 1.03, seekTo: null }
  return { rate: 1, seekTo: target }
}
```

- [ ] **Step 9: Write failing tests for schemas**

`packages/shared/src/schemas.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { addSchema, joinSchema, moveSchema, seekSchema } from './schemas'

const UUID = '3f2b8c1e-8d4a-4c6b-9f0e-2a1b3c4d5e6f'

describe('joinSchema', () => {
  it('trims the nickname', () => {
    expect(joinSchema.parse({ clientId: UUID, nickname: '  Minh  ' }).nickname).toBe('Minh')
  })
  it('rejects empty or long nicknames and bad ids', () => {
    expect(joinSchema.safeParse({ clientId: UUID, nickname: '   ' }).success).toBe(false)
    expect(joinSchema.safeParse({ clientId: UUID, nickname: 'x'.repeat(25) }).success).toBe(false)
    expect(joinSchema.safeParse({ clientId: 'nope', nickname: 'Minh' }).success).toBe(false)
  })
})

describe('other payloads', () => {
  it('validates add, move and seek', () => {
    expect(addSchema.safeParse({ input: 'https://youtu.be/dQw4w9WgXcQ' }).success).toBe(true)
    expect(addSchema.safeParse({ input: '' }).success).toBe(false)
    expect(moveSchema.safeParse({ itemId: UUID, toIndex: 0 }).success).toBe(true)
    expect(moveSchema.safeParse({ itemId: UUID, toIndex: -1 }).success).toBe(false)
    expect(moveSchema.safeParse({ itemId: UUID, toIndex: 1.5 }).success).toBe(false)
    expect(seekSchema.safeParse({ position: 12.5 }).success).toBe(true)
    expect(seekSchema.safeParse({ position: Number.NaN }).success).toBe(false)
    expect(seekSchema.safeParse({ position: -1 }).success).toBe(false)
  })
})
```

- [ ] **Step 10: Run the tests to verify they fail**

Run: `pnpm --filter @music-station/shared test`
Expected: FAIL, `Failed to resolve import "./schemas"`.

- [ ] **Step 11: Implement schemas and the index**

`packages/shared/src/schemas.ts`:
```ts
import { z } from 'zod'
import { MAX_QUEUE } from './types'

export const joinSchema = z.object({
  clientId: z.string().uuid(),
  nickname: z.string().trim().min(1).max(24),
})
export const addSchema = z.object({ input: z.string().trim().min(1).max(500) })
export const removeSchema = z.object({ itemId: z.string().uuid() })
export const moveSchema = z.object({
  itemId: z.string().uuid(),
  toIndex: z.number().int().min(0).max(MAX_QUEUE - 1),
})
export const seekSchema = z.object({ position: z.number().finite().min(0) })
export const emptySchema = z.object({}).passthrough()
export const searchQuerySchema = z.object({ q: z.string().trim().min(1).max(200) })
```

`packages/shared/src/index.ts`:
```ts
export * from './types'
export * from './videoId'
export * from './sync'
export * from './schemas'
```

- [ ] **Step 12: Run the tests and typecheck**

Run: `pnpm --filter @music-station/shared test && pnpm --filter @music-station/shared typecheck`
Expected: all tests PASS, and tsc exits 0.

- [ ] **Step 13: Commit**

```bash
git add package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json .gitignore packages/shared
git commit -m "feat: scaffold monorepo and shared types, parsing, sync math

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 2: Station state machine

**Files:**
- Create: `apps/server/package.json`, `apps/server/tsconfig.json`
- Create: `apps/server/src/station.ts`
- Test: `apps/server/src/station.test.ts`

**Interfaces:**
- Consumes: `START_LEAD_MS`, `MAX_QUEUE`, `expectedPosition`, `QueueItem`, `Playback`, `StationState` from `@music-station/shared`.
- Produces:
  - `class StationError extends Error`: messages are safe to show to users.
  - `interface StationSnapshot { current: QueueItem | null; queue: QueueItem[]; playback: Playback }`
  - `class Station` with:
    - `join(listenerId: string, nickname: string): void`
    - `leave(listenerId: string): void`
    - `nickname(listenerId: string): string | undefined`
    - `add(item: QueueItem, now: number): void`
    - `remove(itemId: string): QueueItem`
    - `move(itemId: string, toIndex: number): QueueItem`
    - `play(now: number): void`
    - `pause(now: number): void`
    - `seek(position: number, now: number): void`
    - `skip(now: number): QueueItem` (returns the skipped item)
    - `markReady(videoId: string, now: number): void`
    - `markFailed(videoId: string, now: number): QueueItem[]` (returns the items it marked failed)
    - `tick(now: number): boolean` (true when it advanced)
    - `snapshot(): StationState` (deep copy)
    - `persisted(): StationSnapshot` (deep copy, no listeners)
    - `restore(saved: StationSnapshot, savedAt: number, now: number, isCached: (videoId: string) => boolean): void`
    - `protectedIds(): Set<string>` (video IDs of current and queued items)
    - `pendingVideoIds(): string[]` (unique video IDs whose items are `downloading`)
  - Differences from the spec contract:
    - `markFailed` takes `now`, because failing the current song advances the station.
    - `restore` takes `savedAt` so a song that was playing resumes near where it stopped.
    - `restore` takes `isCached` so item statuses match the files on disk.

- [ ] **Step 1: Create the server package**

`apps/server/package.json`:
```json
{
  "name": "@music-station/server",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsup",
    "start": "node dist/index.js",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@fastify/rate-limit": "^10.1.1",
    "@fastify/static": "^8.0.2",
    "@music-station/shared": "workspace:*",
    "fastify": "^5.1.0",
    "lru-cache": "^11.0.2",
    "p-limit": "^6.1.0",
    "socket.io": "^4.8.1",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^22.9.0",
    "socket.io-client": "^4.8.1",
    "tsup": "^8.3.5",
    "tsx": "^4.19.2",
    "typescript": "^5.6.3",
    "vitest": "^3.2.4"
  }
}
```

`apps/server/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "types": ["node"] },
  "include": ["src", "test"]
}
```

Run: `pnpm install`
Expected: installs with no errors.

- [ ] **Step 2: Write the failing tests**

`apps/server/src/station.test.ts`:
```ts
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { MAX_QUEUE, START_LEAD_MS, type QueueItem } from '@music-station/shared'
import { Station, StationError } from './station'

function item(over: Partial<QueueItem> = {}): QueueItem {
  return {
    id: randomUUID(),
    videoId: 'aaaaaaaaaaa',
    title: 'Song A',
    channel: 'Channel',
    duration: 100,
    thumbnail: '',
    addedBy: 'Minh',
    status: 'ready',
    ...over,
  }
}

describe('listeners', () => {
  it('joins, renames on rejoin, and leaves', () => {
    const s = new Station()
    s.join('l1', 'Minh')
    s.join('l2', 'An')
    s.join('l1', 'Minh2')
    expect(s.snapshot().listeners).toEqual([
      { id: 'l1', nickname: 'Minh2' },
      { id: 'l2', nickname: 'An' },
    ])
    expect(s.nickname('l2')).toBe('An')
    s.leave('l2')
    expect(s.snapshot().listeners).toEqual([{ id: 'l1', nickname: 'Minh2' }])
  })
})

describe('add', () => {
  it('starts a ready item on an idle station after the lead-in', () => {
    const s = new Station()
    const a = item()
    s.add(a, 5_000)
    const st = s.snapshot()
    expect(st.current?.id).toBe(a.id)
    expect(st.queue).toEqual([])
    expect(st.playback).toEqual({ status: 'playing', position: 0, at: 5_000 + START_LEAD_MS })
  })

  it('waits when the idle station gets a downloading item', () => {
    const s = new Station()
    s.add(item({ status: 'downloading' }), 5_000)
    expect(s.snapshot().playback.status).toBe('waiting')
  })

  it('appends when something is current', () => {
    const s = new Station()
    const a = item()
    const b = item({ videoId: 'bbbbbbbbbbb' })
    s.add(a, 0)
    s.add(b, 0)
    expect(s.snapshot().queue.map((q) => q.id)).toEqual([b.id])
  })

  it('rejects when the queue is full', () => {
    const s = new Station()
    s.add(item(), 0)
    for (let i = 0; i < MAX_QUEUE; i++) s.add(item(), 0)
    expect(() => s.add(item(), 0)).toThrow(StationError)
  })
})

describe('downloads finishing', () => {
  it('markReady starts a waiting current song from 0', () => {
    const s = new Station()
    s.add(item({ status: 'downloading' }), 0)
    s.add(item({ status: 'downloading' }), 0)
    s.markReady('aaaaaaaaaaa', 7_000)
    const st = s.snapshot()
    expect(st.current?.status).toBe('ready')
    expect(st.queue[0]!.status).toBe('ready')
    expect(st.playback).toEqual({ status: 'playing', position: 0, at: 7_000 + START_LEAD_MS })
  })

  it('markReady keeps a song paused if someone paused while it was loading', () => {
    const s = new Station()
    s.add(item({ status: 'downloading' }), 0)
    s.pause(1_000)
    s.markReady('aaaaaaaaaaa', 2_000)
    expect(s.snapshot().playback.status).toBe('paused')
    expect(s.snapshot().current?.status).toBe('ready')
  })

  it('markFailed marks queued copies and keeps them in the queue', () => {
    const s = new Station()
    s.add(item({ videoId: 'ccccccccccc' }), 0)
    s.add(item({ status: 'downloading' }), 0)
    const failed = s.markFailed('aaaaaaaaaaa', 0)
    expect(failed).toHaveLength(1)
    expect(s.snapshot().queue[0]!.status).toBe('failed')
  })

  it('markFailed on the current song advances past failed items', () => {
    const s = new Station()
    const b = item({ videoId: 'bbbbbbbbbbb', status: 'downloading' })
    const c = item({ videoId: 'ccccccccccc' })
    s.add(item({ status: 'downloading' }), 0)
    s.add(b, 0)
    s.add(c, 0)
    s.markFailed('bbbbbbbbbbb', 0)
    s.markFailed('aaaaaaaaaaa', 1_000)
    const st = s.snapshot()
    expect(st.current?.id).toBe(c.id)
    expect(st.queue.map((q) => q.id)).toEqual([b.id])
    expect(st.playback).toEqual({ status: 'playing', position: 0, at: 1_000 + START_LEAD_MS })
  })
})

describe('queue editing', () => {
  it('removes upcoming items only', () => {
    const s = new Station()
    const a = item()
    const b = item()
    s.add(a, 0)
    s.add(b, 0)
    expect(s.remove(b.id).id).toBe(b.id)
    expect(s.snapshot().queue).toEqual([])
    expect(() => s.remove(a.id)).toThrow(StationError)
  })

  it('moves and clamps the target index', () => {
    const s = new Station()
    s.add(item(), 0)
    const [b, c, d] = [item(), item(), item()]
    s.add(b, 0)
    s.add(c, 0)
    s.add(d, 0)
    s.move(d.id, 0)
    expect(s.snapshot().queue.map((q) => q.id)).toEqual([d.id, b.id, c.id])
    s.move(d.id, 99)
    expect(s.snapshot().queue.map((q) => q.id)).toEqual([b.id, c.id, d.id])
    expect(() => s.move('missing', 0)).toThrow(StationError)
  })
})

describe('transport', () => {
  it('pause stores the expected position', () => {
    const s = new Station()
    s.add(item(), 0) // plays from 0 at 1000
    s.pause(11_000)
    expect(s.snapshot().playback).toEqual({ status: 'paused', position: 10, at: 11_000 })
  })

  it('pause during the lead-in keeps position 0', () => {
    const s = new Station()
    s.add(item(), 0)
    s.pause(500)
    expect(s.snapshot().playback.position).toBe(0)
  })

  it('play resumes from the paused position after the lead-in', () => {
    const s = new Station()
    s.add(item(), 0)
    s.pause(11_000)
    s.play(20_000)
    expect(s.snapshot().playback).toEqual({ status: 'playing', position: 10, at: 20_000 + START_LEAD_MS })
  })

  it('play is rejected when idle, loading, or already playing', () => {
    const s = new Station()
    expect(() => s.play(0)).toThrow(StationError)
    s.add(item({ status: 'downloading' }), 0)
    s.pause(0)
    expect(() => s.play(0)).toThrow(/loading/i)
    s.markReady('aaaaaaaaaaa', 0)
    s.play(0)
    expect(() => s.play(0)).toThrow(StationError)
  })

  it('pause is rejected when idle or already paused', () => {
    const s = new Station()
    expect(() => s.pause(0)).toThrow(StationError)
    s.add(item(), 0)
    s.pause(0)
    expect(() => s.pause(0)).toThrow(StationError)
  })

  it('seek clamps and restarts the lead-in while playing', () => {
    const s = new Station()
    s.add(item(), 0)
    s.seek(250, 3_000)
    expect(s.snapshot().playback).toEqual({ status: 'playing', position: 100, at: 3_000 + START_LEAD_MS })
    s.seek(-5, 4_000)
    expect(s.snapshot().playback.position).toBe(0)
  })

  it('seek while paused only moves the position', () => {
    const s = new Station()
    s.add(item(), 0)
    s.pause(2_000)
    s.seek(42, 9_000)
    expect(s.snapshot().playback).toEqual({ status: 'paused', position: 42, at: 2_000 })
  })

  it('skip advances, skipping failed items, and goes idle at the end', () => {
    const s = new Station()
    const a = item()
    const failed = item({ status: 'failed' })
    const c = item()
    s.add(a, 0)
    s.add(failed, 0)
    s.add(c, 0)
    expect(s.skip(1_000).id).toBe(a.id)
    expect(s.snapshot().current?.id).toBe(c.id)
    s.skip(2_000)
    const st = s.snapshot()
    expect(st.current).toBeNull()
    expect(st.queue.map((q) => q.id)).toEqual([failed.id])
    expect(st.playback.status).toBe('paused')
    expect(() => s.skip(3_000)).toThrow(StationError)
  })

  it('an idle station starts the next added song even if failed items remain', () => {
    const s = new Station()
    s.add(item(), 0)
    s.add(item({ status: 'failed' }), 0)
    s.skip(0)
    const next = item()
    s.add(next, 10_000)
    expect(s.snapshot().current?.id).toBe(next.id)
  })
})

describe('tick', () => {
  it('advances only when the song has ended', () => {
    const s = new Station()
    const b = item()
    s.add(item({ duration: 10 }), 0) // plays 1000..11000
    s.add(b, 0)
    expect(s.tick(10_900)).toBe(false)
    expect(s.tick(11_000)).toBe(true)
    expect(s.snapshot().current?.id).toBe(b.id)
  })

  it('does nothing while paused', () => {
    const s = new Station()
    s.add(item({ duration: 10 }), 0)
    s.pause(5_000)
    expect(s.tick(999_999)).toBe(false)
  })
})

describe('snapshot, restore and ids', () => {
  it('returns copies', () => {
    const s = new Station()
    s.add(item(), 0)
    s.snapshot().current!.title = 'changed'
    expect(s.snapshot().current!.title).toBe('Song A')
  })

  it('restores paused at the position reached by savedAt', () => {
    const s = new Station()
    s.restore(
      { current: item(), queue: [], playback: { status: 'playing', position: 10, at: 1_000 } },
      31_000,
      999_000,
      () => true,
    )
    expect(s.snapshot().playback).toEqual({ status: 'paused', position: 40, at: 999_000 })
    expect(s.snapshot().listeners).toEqual([])
  })

  it('clamps a restored position to the song duration', () => {
    const s = new Station()
    s.restore(
      { current: item({ duration: 100 }), queue: [], playback: { status: 'playing', position: 90, at: 0 } },
      60_000,
      70_000,
      () => true,
    )
    expect(s.snapshot().playback.position).toBe(100)
  })

  it('matches item statuses to the files on disk', () => {
    const s = new Station()
    const cached = 'ccccccccccc'
    s.restore(
      {
        current: item({ videoId: 'aaaaaaaaaaa', status: 'ready' }),
        queue: [
          item({ videoId: cached, status: 'downloading' }),
          item({ videoId: 'fffffffffff', status: 'failed' }),
        ],
        playback: { status: 'waiting', position: 0, at: 0 },
      },
      0,
      0,
      (id) => id === cached,
    )
    const st = s.snapshot()
    expect(st.current!.status).toBe('downloading')
    expect(st.queue.map((q) => q.status)).toEqual(['ready', 'failed'])
    expect(st.playback.status).toBe('paused')
    expect(s.pendingVideoIds()).toEqual(['aaaaaaaaaaa'])
  })

  it('protects current and queued video ids', () => {
    const s = new Station()
    s.add(item({ videoId: 'aaaaaaaaaaa' }), 0)
    s.add(item({ videoId: 'bbbbbbbbbbb' }), 0)
    expect(s.protectedIds()).toEqual(new Set(['aaaaaaaaaaa', 'bbbbbbbbbbb']))
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @music-station/server test`
Expected: FAIL, `Failed to resolve import "./station"`.

- [ ] **Step 4: Implement the station**

`apps/server/src/station.ts`:
```ts
import {
  MAX_QUEUE,
  START_LEAD_MS,
  expectedPosition,
  type Playback,
  type QueueItem,
  type StationState,
} from '@music-station/shared'

export class StationError extends Error {}

export interface StationSnapshot {
  current: QueueItem | null
  queue: QueueItem[]
  playback: Playback
}

const idle = (): Playback => ({ status: 'paused', position: 0, at: 0 })

export class Station {
  private current: QueueItem | null = null
  private queue: QueueItem[] = []
  private playback: Playback = idle()
  private listeners = new Map<string, string>()

  join(listenerId: string, nickname: string): void {
    this.listeners.set(listenerId, nickname)
  }

  leave(listenerId: string): void {
    this.listeners.delete(listenerId)
  }

  nickname(listenerId: string): string | undefined {
    return this.listeners.get(listenerId)
  }

  add(item: QueueItem, now: number): void {
    if (this.queue.length >= MAX_QUEUE) throw new StationError('The queue is full')
    if (this.current) this.queue.push(item)
    else this.setCurrent(item, now)
  }

  remove(itemId: string): QueueItem {
    const i = this.indexOf(itemId)
    return this.queue.splice(i, 1)[0]!
  }

  move(itemId: string, toIndex: number): QueueItem {
    const [item] = this.queue.splice(this.indexOf(itemId), 1)
    const to = Math.max(0, Math.min(toIndex, this.queue.length))
    this.queue.splice(to, 0, item!)
    return item!
  }

  play(now: number): void {
    const current = this.requireCurrent('Nothing to play')
    if (current.status !== 'ready') throw new StationError('The song is still loading')
    if (this.playback.status !== 'paused') throw new StationError('Already playing')
    this.playback = { status: 'playing', position: this.playback.position, at: now + START_LEAD_MS }
  }

  pause(now: number): void {
    const current = this.requireCurrent('Nothing is playing')
    if (this.playback.status === 'paused') throw new StationError('Already paused')
    const position = Math.min(expectedPosition(this.playback, now), current.duration)
    this.playback = { status: 'paused', position, at: now }
  }

  seek(position: number, now: number): void {
    const current = this.requireCurrent('Nothing is playing')
    const pos = Math.max(0, Math.min(position, current.duration))
    this.playback =
      this.playback.status === 'playing'
        ? { status: 'playing', position: pos, at: now + START_LEAD_MS }
        : { ...this.playback, position: pos }
  }

  skip(now: number): QueueItem {
    const current = this.requireCurrent('Nothing to skip')
    this.advance(now)
    return current
  }

  markReady(videoId: string, now: number): void {
    for (const q of this.queue) if (q.videoId === videoId && q.status === 'downloading') q.status = 'ready'
    const c = this.current
    if (c && c.videoId === videoId && c.status === 'downloading') {
      c.status = 'ready'
      if (this.playback.status === 'waiting') {
        this.playback = { status: 'playing', position: this.playback.position, at: now + START_LEAD_MS }
      }
    }
  }

  markFailed(videoId: string, now: number): QueueItem[] {
    const failed: QueueItem[] = []
    for (const q of this.queue) {
      if (q.videoId === videoId && q.status === 'downloading') {
        q.status = 'failed'
        failed.push(q)
      }
    }
    const c = this.current
    if (c && c.videoId === videoId && c.status === 'downloading') {
      c.status = 'failed'
      failed.push(c)
      this.advance(now)
    }
    return failed
  }

  tick(now: number): boolean {
    if (!this.current || this.playback.status !== 'playing') return false
    if (expectedPosition(this.playback, now) < this.current.duration) return false
    this.advance(now)
    return true
  }

  snapshot(): StationState {
    return {
      ...this.persisted(),
      listeners: [...this.listeners].map(([id, nickname]) => ({ id, nickname })),
    }
  }

  persisted(): StationSnapshot {
    return structuredClone({ current: this.current, queue: this.queue, playback: this.playback })
  }

  restore(saved: StationSnapshot, savedAt: number, now: number, isCached: (videoId: string) => boolean): void {
    const fix = (q: QueueItem): QueueItem =>
      q.status === 'failed' ? { ...q } : { ...q, status: isCached(q.videoId) ? 'ready' : 'downloading' }
    this.current = saved.current ? fix(saved.current) : null
    this.queue = saved.queue.map(fix)
    const reached = expectedPosition(saved.playback, savedAt)
    const position = this.current ? Math.min(Math.max(0, reached), this.current.duration) : 0
    this.playback = { status: 'paused', position, at: now }
  }

  protectedIds(): Set<string> {
    const ids = new Set(this.queue.map((q) => q.videoId))
    if (this.current) ids.add(this.current.videoId)
    return ids
  }

  pendingVideoIds(): string[] {
    const all = this.current ? [this.current, ...this.queue] : this.queue
    return [...new Set(all.filter((q) => q.status === 'downloading').map((q) => q.videoId))]
  }

  private advance(now: number): void {
    const i = this.queue.findIndex((q) => q.status !== 'failed')
    if (i < 0) {
      this.current = null
      this.playback = idle()
      return
    }
    this.setCurrent(this.queue.splice(i, 1)[0]!, now)
  }

  private setCurrent(item: QueueItem, now: number): void {
    this.current = item
    this.playback =
      item.status === 'ready'
        ? { status: 'playing', position: 0, at: now + START_LEAD_MS }
        : { status: 'waiting', position: 0, at: now }
  }

  private requireCurrent(message: string): QueueItem {
    if (!this.current) throw new StationError(message)
    return this.current
  }

  private indexOf(itemId: string): number {
    const i = this.queue.findIndex((q) => q.id === itemId)
    if (i < 0) throw new StationError('That song is no longer in the queue')
    return i
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @music-station/server test && pnpm --filter @music-station/server typecheck`
Expected: all station tests PASS, and tsc exits 0.

- [ ] **Step 6: Commit**

```bash
git add apps/server pnpm-lock.yaml
git commit -m "feat(server): add station state machine

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Audio cache

**Files:**
- Create: `apps/server/src/cache.ts`
- Test: `apps/server/src/cache.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks. Uses `p-limit` and `node:fs`.
- Produces:
  - `type Downloader = (videoId: string, destPath: string) => Promise<void>` must leave a complete file at `destPath`.
  - `interface CacheOptions { dir: string; maxBytes: number; download: Downloader; concurrency?: number }` (concurrency defaults to 2).
  - `class AudioCache` with:
    - `constructor(opts: CacheOptions)`
    - `init(): Promise<void>` creates `dir` and `dir/.tmp`, empties `.tmp`, and indexes `*.m4a` files.
    - `pathFor(videoId: string): string` returns `<dir>/<videoId>.m4a`.
    - `has(videoId: string): boolean`
    - `ensure(videoId: string): Promise<string>` resolves to the final path, dedupes in-flight calls, and runs at most `concurrency` downloads at once. A failed call is not cached, so calling again retries.
    - `touch(videoId: string): void` sets the file's mtime to now.
    - `evict(protectedIds: Set<string>): string[]` deletes the oldest-mtime unprotected files until the total is ≤ `maxBytes` and returns the deleted IDs.
    - `totalBytes(): number`

- [ ] **Step 1: Write the failing tests**

`apps/server/src/cache.test.ts`:
```ts
import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AudioCache, type Downloader } from './cache'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ms-cache-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const A = 'aaaaaaaaaaa'
const B = 'bbbbbbbbbbb'
const C = 'ccccccccccc'

function fakeDownloader(bytes = 100) {
  const calls: string[] = []
  const download: Downloader = async (videoId, destPath) => {
    calls.push(videoId)
    await new Promise((r) => setTimeout(r, 10))
    await writeFile(destPath, Buffer.alloc(bytes))
  }
  return { calls, download }
}

describe('AudioCache', () => {
  it('indexes existing files and clears .tmp on init', async () => {
    await writeFile(join(dir, `${A}.m4a`), Buffer.alloc(10))
    await writeFile(join(dir, 'notes.txt'), 'ignore me')
    const cache1 = new AudioCache({ dir, maxBytes: 1e9, download: fakeDownloader().download })
    await cache1.init()
    await writeFile(join(dir, '.tmp', 'half.m4a'), Buffer.alloc(5))

    const cache = new AudioCache({ dir, maxBytes: 1e9, download: fakeDownloader().download })
    await cache.init()
    expect(cache.has(A)).toBe(true)
    expect(cache.has(B)).toBe(false)
    expect(await readdir(join(dir, '.tmp'))).toEqual([])
    expect(cache.totalBytes()).toBe(10)
  })

  it('downloads into .tmp and renames into place', async () => {
    const fake = fakeDownloader()
    const cache = new AudioCache({ dir, maxBytes: 1e9, download: fake.download })
    await cache.init()
    const path = await cache.ensure(A)
    expect(path).toBe(join(dir, `${A}.m4a`))
    expect(existsSync(path)).toBe(true)
    expect(cache.has(A)).toBe(true)
    expect(await readdir(join(dir, '.tmp'))).toEqual([])
  })

  it('dedupes in-flight downloads and skips cached files', async () => {
    const fake = fakeDownloader()
    const cache = new AudioCache({ dir, maxBytes: 1e9, download: fake.download })
    await cache.init()
    await Promise.all([cache.ensure(A), cache.ensure(A), cache.ensure(A)])
    await cache.ensure(A)
    expect(fake.calls).toEqual([A])
  })

  it('runs at most 2 downloads at once', async () => {
    let active = 0
    let peak = 0
    const download: Downloader = async (_id, dest) => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 20))
      await writeFile(dest, Buffer.alloc(1))
      active--
    }
    const cache = new AudioCache({ dir, maxBytes: 1e9, download })
    await cache.init()
    await Promise.all([A, B, C, 'ddddddddddd', 'eeeeeeeeeee'].map((id) => cache.ensure(id)))
    expect(peak).toBe(2)
  })

  it('does not cache failures, so a second call retries', async () => {
    let attempt = 0
    const download: Downloader = async (_id, dest) => {
      attempt++
      if (attempt === 1) {
        await writeFile(dest, 'partial')
        throw new Error('boom')
      }
      await writeFile(dest, Buffer.alloc(1))
    }
    const cache = new AudioCache({ dir, maxBytes: 1e9, download })
    await cache.init()
    await expect(cache.ensure(A)).rejects.toThrow('boom')
    expect(cache.has(A)).toBe(false)
    expect(await readdir(join(dir, '.tmp'))).toEqual([])
    await expect(cache.ensure(A)).resolves.toBe(join(dir, `${A}.m4a`))
  })

  it('evicts oldest first, never protected ids, until under the cap', async () => {
    const cache = new AudioCache({ dir, maxBytes: 250, download: fakeDownloader(100).download })
    await cache.init()
    for (const id of [A, B, C]) await cache.ensure(id)
    const old = new Date(Date.now() - 60_000)
    await utimes(join(dir, `${A}.m4a`), old, new Date(Date.now() - 30_000))
    await utimes(join(dir, `${B}.m4a`), old, new Date(Date.now() - 60_000))
    const cache2 = new AudioCache({ dir, maxBytes: 250, download: fakeDownloader(100).download })
    await cache2.init() // re-index to pick up the mtimes set above

    expect(cache2.evict(new Set([B]))).toEqual([A])
    expect(cache2.has(B)).toBe(true)
    expect(cache2.has(C)).toBe(true)
    expect(cache2.totalBytes()).toBe(200)
  })

  it('may stay over the cap when every file is protected', async () => {
    const cache = new AudioCache({ dir, maxBytes: 50, download: fakeDownloader(100).download })
    await cache.init()
    await cache.ensure(A)
    expect(cache.evict(new Set([A]))).toEqual([])
    expect(cache.has(A)).toBe(true)
  })

  it('touch makes a file the newest', async () => {
    const cache = new AudioCache({ dir, maxBytes: 150, download: fakeDownloader(100).download })
    await cache.init()
    await cache.ensure(A)
    await new Promise((r) => setTimeout(r, 20))
    await cache.ensure(B)
    await new Promise((r) => setTimeout(r, 20))
    cache.touch(A)
    expect(cache.evict(new Set())).toEqual([B])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @music-station/server exec vitest run src/cache.test.ts`
Expected: FAIL, `Failed to resolve import "./cache"`.

- [ ] **Step 3: Implement the cache**

`apps/server/src/cache.ts`:
```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @music-station/server exec vitest run src/cache.test.ts && pnpm --filter @music-station/server typecheck`
Expected: all cache tests PASS, and tsc exits 0.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/cache.ts apps/server/src/cache.test.ts
git commit -m "feat(server): add audio cache with dedupe, concurrency and eviction

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: yt-dlp wrapper

**Files:**
- Create: `apps/server/src/process.ts`, `apps/server/src/youtube.ts`
- Test: `apps/server/src/process.test.ts`, `apps/server/src/youtube.test.ts`

**Interfaces:**
- Consumes: `isVideoId`, `SearchResult`, `VideoInfo` from `@music-station/shared`.
- Produces:
  - `type RunFn = (bin: string, args: string[], timeoutMs: number) => Promise<string>` resolves with stdout. It rejects with the stderr tail on a non-zero exit, or with `yt-dlp timed out after Ns` after SIGKILL.
  - `runProcess: RunFn` spawns with no shell.
  - `class VideoRejected extends Error`: the video is valid YouTube but not allowed (livestream, too long, no duration). The message is user-facing.
  - Argument builders: `searchArgs(query: string, cookies?: string): string[]`, `infoArgs(videoId: string, cookies?: string): string[]`, `downloadArgs(videoId: string, destPath: string, cookies?: string): string[]`.
  - Parsers: `parseSearchOutput(stdout: string): SearchResult[]`, `parseInfo(json: string, maxDurationSec: number): VideoInfo`.
  - `explainError(err: unknown): Error` turns yt-dlp stderr into a short message and gives the bot check a clear remedy.
  - `interface YouTubeOptions { bin: string; cookies?: string; maxDurationSec: number }`
  - `interface YouTube { search(query: string): Promise<SearchResult[]>; getInfo(videoId: string): Promise<VideoInfo>; download(videoId: string, destPath: string): Promise<void>; update(): Promise<string> }`
  - `createYouTube(opts: YouTubeOptions, run?: RunFn): YouTube`
  - `thumbnailUrl(videoId: string): string` returns `https://i.ytimg.com/vi/<id>/mqdefault.jpg`.

- [ ] **Step 1: Write the failing process tests**

These tests run Node itself as the child process, so yt-dlp is not needed.

`apps/server/src/process.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { runProcess } from './process'

const node = process.execPath

describe('runProcess', () => {
  it('resolves with stdout', async () => {
    await expect(runProcess(node, ['-e', 'process.stdout.write("hi")'], 5_000)).resolves.toBe('hi')
  })

  it('passes arguments verbatim, without a shell', async () => {
    const out = await runProcess(node, ['-e', 'process.stdout.write(process.argv[1])', '$(echo pwned); ls'], 5_000)
    expect(out).toBe('$(echo pwned); ls')
  })

  it('rejects with stderr on a non-zero exit', async () => {
    await expect(
      runProcess(node, ['-e', 'console.error("ERROR: bad thing"); process.exit(3)'], 5_000),
    ).rejects.toThrow('ERROR: bad thing')
  })

  it('kills the process and rejects on timeout', async () => {
    const started = Date.now()
    await expect(runProcess(node, ['-e', 'setTimeout(() => {}, 10000)'], 300)).rejects.toThrow(/timed out/)
    expect(Date.now() - started).toBeLessThan(3_000)
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @music-station/server exec vitest run src/process.test.ts`
Expected: FAIL, `Failed to resolve import "./process"`.

- [ ] **Step 3: Implement runProcess**

`apps/server/src/process.ts`:
```ts
import { spawn } from 'node:child_process'

export type RunFn = (bin: string, args: string[], timeoutMs: number) => Promise<string>

export const runProcess: RunFn = (bin, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d))
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr = (stderr + d).slice(-4_000)))
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) reject(new Error(`yt-dlp timed out after ${Math.round(timeoutMs / 1000)}s`))
      else if (code === 0) resolve(stdout)
      else reject(new Error(stderr.trim() || `process exited with code ${code}`))
    })
  })
```

- [ ] **Step 4: Run them to verify they pass**

Run: `pnpm --filter @music-station/server exec vitest run src/process.test.ts`
Expected: 4 tests PASS.

- [ ] **Step 5: Write the failing youtube tests**

`apps/server/src/youtube.test.ts`:
```ts
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

  it('download writes <id>.m4a via an %(ext)s template', () => {
    expect(downloadArgs(ID, '/data/cache/.tmp/x.m4a')).toEqual([
      '--no-warnings',
      '--no-progress',
      '--no-playlist',
      '-f',
      '140/bestaudio[ext=m4a]/bestaudio',
      '-x',
      '--audio-format',
      'm4a',
      '-o',
      '/data/cache/.tmp/x.%(ext)s',
      '--',
      URL_,
    ])
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
    await yt.download(ID, '/tmp/a.m4a')
    expect(fake.calls.map((c) => [c.bin, c.timeoutMs])).toEqual([
      ['/opt/yt-dlp/yt-dlp', 15_000],
      ['/opt/yt-dlp/yt-dlp', 20_000],
      ['/opt/yt-dlp/yt-dlp', 120_000],
    ])
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
```

- [ ] **Step 6: Run them to verify they fail**

Run: `pnpm --filter @music-station/server exec vitest run src/youtube.test.ts`
Expected: FAIL, `Failed to resolve import "./youtube"`.

- [ ] **Step 7: Implement the wrapper**

`apps/server/src/youtube.ts`:
```ts
import { isVideoId, type SearchResult, type VideoInfo } from '@music-station/shared'
import { runProcess, type RunFn } from './process'

export class VideoRejected extends Error {}

export interface YouTubeOptions {
  bin: string
  cookies?: string
  maxDurationSec: number
}

export interface YouTube {
  search(query: string): Promise<SearchResult[]>
  getInfo(videoId: string): Promise<VideoInfo>
  download(videoId: string, destPath: string): Promise<void>
  update(): Promise<string>
}

const SEARCH_TIMEOUT_MS = 15_000
const INFO_TIMEOUT_MS = 20_000
const DOWNLOAD_TIMEOUT_MS = 120_000
const UPDATE_TIMEOUT_MS = 60_000

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

export function infoArgs(videoId: string, cookies?: string): string[] {
  return [...common(cookies), '--dump-json', '--no-playlist', '--', watchUrl(videoId)]
}

export function downloadArgs(videoId: string, destPath: string, cookies?: string): string[] {
  if (!destPath.endsWith('.m4a')) throw new Error('destPath must end with .m4a')
  const template = destPath.replace(/\.m4a$/, '.%(ext)s')
  return [
    ...common(cookies),
    '--no-playlist',
    '-f',
    '140/bestaudio[ext=m4a]/bestaudio',
    '-x',
    '--audio-format',
    'm4a',
    '-o',
    template,
    '--',
    watchUrl(videoId),
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
  const call = async (args: string[], timeoutMs: number) => {
    try {
      return await run(opts.bin, args, timeoutMs)
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
    async download(videoId, destPath) {
      await call(downloadArgs(videoId, destPath, opts.cookies), DOWNLOAD_TIMEOUT_MS)
    },
    update() {
      return call(['-U'], UPDATE_TIMEOUT_MS)
    },
  }
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm --filter @music-station/server exec vitest run src/youtube.test.ts src/process.test.ts && pnpm --filter @music-station/server typecheck`
Expected: all tests PASS, and tsc exits 0.

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/process.ts apps/server/src/process.test.ts apps/server/src/youtube.ts apps/server/src/youtube.test.ts
git commit -m "feat(server): add yt-dlp wrapper with safe args, parsing and timeouts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Persistence and config

**Files:**
- Create: `apps/server/src/persist.ts`, `apps/server/src/config.ts`
- Test: `apps/server/src/persist.test.ts`, `apps/server/src/config.test.ts`

**Interfaces:**
- Consumes:
  - `StationSnapshot` from `./station` (Task 2).
  - `VIDEO_ID_RE` and `MAX_QUEUE` from `@music-station/shared`.
- Produces:
  - Persistence:
    - `interface Persisted extends StationSnapshot { version: 1; savedAt: number }`
    - `loadState(file: string, log?: (msg: string) => void): Promise<Persisted | null>` returns null when the file is missing. When the file is corrupt or has the wrong shape, it returns null, logs, and renames the file to `<file>.corrupt`.
    - `saveState(file: string, data: Persisted): Promise<void>` writes `<file>.tmp` then renames it, creating the directory if needed.
    - `interface Saver { schedule(): void; flush(): Promise<void> }`
    - `createSaver(file: string, getData: () => Persisted, delayMs?: number, log?: (msg: string) => void): Saver`. `schedule` writes once, `delayMs` (default 1000) after the first call, and the write includes later changes. `flush` writes now and resolves when every write is done.
  - Config:
    - `interface Config { port: number; dataDir: string; webDir: string | null; ytdlpBin: string; cookies?: string; cacheMaxBytes: number; maxDurationSec: number }`
    - `loadConfig(env?: Record<string, string | undefined>): Config` reads these variables:

      | Variable | Default |
      |---|---|
      | `PORT` | 3000 |
      | `DATA_DIR` | `./data` |
      | `WEB_DIR` | null |
      | `YTDLP_BIN` | `yt-dlp` |
      | `YTDLP_COOKIES` | unset |
      | `CACHE_MAX_GB` | 2 |
      | `MAX_DURATION_MIN` | 60 |

- [ ] **Step 1: Write the failing persistence tests**

`apps/server/src/persist.test.ts`:
```ts
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSaver, loadState, saveState, type Persisted } from './persist'

let dir: string
let file: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ms-persist-'))
  file = join(dir, 'nested', 'station.json')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const sample = (savedAt = 1_000): Persisted => ({
  version: 1,
  savedAt,
  current: {
    id: '3f2b8c1e-8d4a-4c6b-9f0e-2a1b3c4d5e6f',
    videoId: 'dQw4w9WgXcQ',
    title: 'Song',
    channel: 'Ch',
    duration: 100,
    thumbnail: 't',
    addedBy: 'Minh',
    status: 'ready',
  },
  queue: [],
  playback: { status: 'playing', position: 5, at: 500 },
})

describe('saveState / loadState', () => {
  it('round-trips and leaves no temp file', async () => {
    await saveState(file, sample())
    expect(await loadState(file)).toEqual(sample())
    expect(await readdir(join(dir, 'nested'))).toEqual(['station.json'])
  })

  it('returns null when the file does not exist', async () => {
    expect(await loadState(file)).toBeNull()
  })

  it.each([
    ['half-written JSON', '{"version":1,"savedAt":'],
    ['wrong shape', JSON.stringify({ version: 1, queue: 'nope' })],
    ['bad video id', JSON.stringify({ ...sample(), current: { ...sample().current, videoId: 'x' } })],
  ])('starts empty on %s and keeps the bad file aside', async (_name, text) => {
    await saveState(file, sample()) // creates the directory
    await writeFile(file, text)
    const log = vi.fn()
    expect(await loadState(file, log)).toBeNull()
    expect(log).toHaveBeenCalledOnce()
    expect(existsSync(file)).toBe(false)
    expect(await readFile(`${file}.corrupt`, 'utf8')).toBe(text)
  })
})

describe('createSaver', () => {
  it('coalesces changes into one delayed write with the latest data', async () => {
    let n = 0
    const getData = vi.fn(() => sample(++n))
    const saver = createSaver(file, getData, 20)
    saver.schedule()
    saver.schedule()
    saver.schedule()
    expect(existsSync(file)).toBe(false)
    await new Promise((r) => setTimeout(r, 80))
    expect(getData).toHaveBeenCalledOnce()
    expect((await loadState(file))!.savedAt).toBe(1)
  })

  it('flush writes immediately', async () => {
    const saver = createSaver(file, () => sample(42), 10_000)
    saver.schedule()
    await saver.flush()
    expect((await loadState(file))!.savedAt).toBe(42)
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @music-station/server exec vitest run src/persist.test.ts`
Expected: FAIL, `Failed to resolve import "./persist"`.

- [ ] **Step 3: Implement persistence**

`apps/server/src/persist.ts`:
```ts
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
```

- [ ] **Step 4: Run them to verify they pass**

Run: `pnpm --filter @music-station/server exec vitest run src/persist.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Write the failing config tests**

`apps/server/src/config.test.ts`:
```ts
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
```

- [ ] **Step 6: Run them to verify they fail**

Run: `pnpm --filter @music-station/server exec vitest run src/config.test.ts`
Expected: FAIL, `Failed to resolve import "./config"`.

- [ ] **Step 7: Implement config**

`apps/server/src/config.ts`:
```ts
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
```

- [ ] **Step 8: Run all server tests and typecheck**

Run: `pnpm --filter @music-station/server test && pnpm --filter @music-station/server typecheck`
Expected: all tests PASS, and tsc exits 0.

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/persist.ts apps/server/src/persist.test.ts apps/server/src/config.ts apps/server/src/config.test.ts
git commit -m "feat(server): add crash-safe state persistence and env config

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Station service (orchestration and activity notices)

**Files:**
- Create: `apps/server/src/service.ts`
- Test: `apps/server/src/service.test.ts`

**Interfaces:**
- Consumes:
  - `Station`, `StationError` from `./station` (Task 2).
  - `Persisted` from `./persist` (Task 5).
  - `parseVideoInput`, `QueueItem`, `StationState`, `VideoInfo` from `@music-station/shared`.
  - Structurally, the cache methods `ensure`, `has`, `touch` and `evict` from `AudioCache` (Task 3).
- Produces:
  - `interface CacheLike { ensure(videoId: string): Promise<string>; has(videoId: string): boolean; touch(videoId: string): void; evict(protectedIds: Set<string>): string[] }`
  - `interface ServiceDeps { station: Station; cache: CacheLike; getInfo(videoId: string): Promise<VideoInfo>; now(): number; onChange(): void; onActivity(text: string): void; log?(msg: string): void }`
  - `class StationService` with:
    - `constructor(deps: ServiceDeps)`
    - Lifecycle: `restore(saved: Persisted | null): void`, `tick(): void`
    - Read state: `state(): StationState`, `persisted(): Persisted`, `isPlaying(): boolean`
    - Listeners: `join(listenerId: string, nickname: string): void`, `leave(listenerId: string): void`
    - Queue: `add(listenerId: string, input: string): Promise<QueueItem>`, `remove(listenerId: string, itemId: string): void`, `move(listenerId: string, itemId: string, toIndex: number): void`
    - Transport: `play(listenerId: string): void`, `pause(listenerId: string): void`, `seek(listenerId: string, position: number): void`, `skip(listenerId: string): void`
  - Every user-facing failure is thrown as a `StationError` whose message can be shown in an error ack.

- [ ] **Step 1: Write the failing tests**

`apps/server/src/service.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest'
import type { VideoInfo } from '@music-station/shared'
import { Station, StationError } from './station'
import { StationService, type CacheLike } from './service'
import type { Persisted } from './persist'

const A = 'aaaaaaaaaaa'
const B = 'bbbbbbbbbbb'
const flush = () => new Promise((r) => setImmediate(r))

function setup(opts: { cached?: string[]; getInfo?: (id: string) => Promise<VideoInfo> } = {}) {
  const files = new Set(opts.cached ?? [])
  const pending: { id: string; resolve: () => void; reject: (e: Error) => void }[] = []
  const cache = {
    ensure: vi.fn(
      (id: string) =>
        new Promise<string>((res, rej) =>
          pending.push({
            id,
            resolve: () => {
              files.add(id)
              res(`/cache/${id}.m4a`)
            },
            reject: rej,
          }),
        ),
    ),
    has: (id: string) => files.has(id),
    touch: vi.fn(),
    evict: vi.fn(() => []),
  } satisfies CacheLike
  let t = 0
  const activity: string[] = []
  const onChange = vi.fn()
  const getInfo = vi.fn(
    opts.getInfo ??
      (async (id: string): Promise<VideoInfo> => ({
        videoId: id,
        title: `Song ${id[0]!.toUpperCase()}`,
        channel: 'Ch',
        duration: 100,
        thumbnail: 't',
      })),
  )
  const station = new Station()
  const service = new StationService({
    station,
    cache,
    getInfo,
    now: () => t,
    onChange,
    onActivity: (text) => activity.push(text),
    log: () => {},
  })
  service.join('l1', 'Minh')
  activity.length = 0
  return { service, cache, pending, files, activity, onChange, getInfo, setTime: (v: number) => (t = v) }
}

describe('add', () => {
  it('validates the video, queues it as downloading and starts the download', async () => {
    const s = setup()
    const item = await s.service.add('l1', `https://youtu.be/${A}`)
    expect(s.getInfo).toHaveBeenCalledWith(A)
    expect(item).toMatchObject({ videoId: A, title: 'Song A', addedBy: 'Minh', status: 'downloading' })
    expect(s.service.state().playback.status).toBe('waiting')
    expect(s.cache.ensure).toHaveBeenCalledWith(A)
    expect(s.activity).toEqual(['Minh added Song A'])
    expect(s.onChange).toHaveBeenCalled()
  })

  it('starts playing when the download finishes, then evicts', async () => {
    const s = setup()
    await s.service.add('l1', A)
    s.setTime(5_000)
    s.pending[0]!.resolve()
    await flush()
    const st = s.service.state()
    expect(st.current!.status).toBe('ready')
    expect(st.playback).toEqual({ status: 'playing', position: 0, at: 6_000 })
    expect(s.cache.evict).toHaveBeenCalledWith(new Set([A]))
  })

  it('plays a cached video without downloading', async () => {
    const s = setup({ cached: [A] })
    await s.service.add('l1', A)
    expect(s.cache.ensure).not.toHaveBeenCalled()
    expect(s.service.state().playback.status).toBe('playing')
  })

  it('rejects input that is not a video', async () => {
    const s = setup()
    await expect(s.service.add('l1', 'hello world')).rejects.toThrow(StationError)
    expect(s.getInfo).not.toHaveBeenCalled()
  })

  it('passes getInfo rejections through as StationError', async () => {
    const s = setup({
      getInfo: async () => {
        throw new Error('Livestreams are not supported')
      },
    })
    await expect(s.service.add('l1', A)).rejects.toThrow(new StationError('Livestreams are not supported'))
    expect(s.service.state().current).toBeNull()
  })

  it('requires joining first', async () => {
    const s = setup()
    await expect(s.service.add('stranger', A)).rejects.toThrow(/join/i)
    expect(() => s.service.play('stranger')).toThrow(/join/i)
  })
})

describe('download failures', () => {
  it('retries once and succeeds', async () => {
    const s = setup()
    await s.service.add('l1', A)
    s.pending[0]!.reject(new Error('flaky'))
    await flush()
    expect(s.cache.ensure).toHaveBeenCalledTimes(2)
    s.pending[1]!.resolve()
    await flush()
    expect(s.service.state().current!.status).toBe('ready')
    expect(s.activity).toEqual(['Minh added Song A'])
  })

  it('fails after the retry, advances, and announces it', async () => {
    const s = setup({ cached: [B] })
    await s.service.add('l1', A)
    await s.service.add('l1', B)
    s.pending[0]!.reject(new Error('flaky'))
    await flush()
    s.pending[1]!.reject(new Error('Video unavailable'))
    await flush()
    const st = s.service.state()
    expect(st.current!.videoId).toBe(B)
    expect(s.activity.at(-1)).toBe("Couldn't download Song A: Video unavailable")
  })
})

describe('the same video twice', () => {
  it('downloads once and readies every copy', async () => {
    const s = setup()
    await s.service.add('l1', A)
    await s.service.add('l1', A)
    expect(s.cache.ensure).toHaveBeenCalledTimes(1)
    s.pending[0]!.resolve()
    await flush()
    const st = s.service.state()
    expect(st.current!.status).toBe('ready')
    expect(st.queue[0]!.status).toBe('ready')
  })

  it('fails every copy with a single notice', async () => {
    const s = setup()
    await s.service.add('l1', B)
    s.pending[0]!.resolve()
    await flush()
    await s.service.add('l1', A)
    await s.service.add('l1', A)
    s.activity.length = 0
    s.pending[1]!.reject(new Error('x'))
    await flush()
    s.pending[2]!.reject(new Error('gone'))
    await flush()
    expect(s.service.state().queue.map((q) => q.status)).toEqual(['failed', 'failed'])
    expect(s.activity).toEqual(["Couldn't download Song A: gone"])
  })
})

describe('controls and notices', () => {
  it('announces each control action with the nickname', async () => {
    const s = setup({ cached: [A, B] })
    await s.service.add('l1', A)
    const b = await s.service.add('l1', B)
    const c = await s.service.add('l1', A)
    s.activity.length = 0
    s.setTime(10_000)
    s.service.pause('l1')
    s.service.seek('l1', 75)
    s.service.play('l1')
    s.service.move('l1', c.id, 0)
    s.service.remove('l1', b.id)
    s.service.skip('l1')
    expect(s.activity).toEqual([
      'Minh paused',
      'Minh jumped to 1:15',
      'Minh pressed play',
      'Minh moved Song A',
      'Minh removed Song B',
      'Minh skipped Song A',
    ])
  })

  it('touches the file of a song when it becomes current', async () => {
    const s = setup({ cached: [A, B] })
    await s.service.add('l1', A)
    await s.service.add('l1', B)
    s.cache.touch.mockClear()
    s.service.skip('l1')
    expect(s.cache.touch).toHaveBeenCalledWith(B)
  })

  it('surfaces station errors', () => {
    const s = setup()
    expect(() => s.service.play('l1')).toThrow(StationError)
  })
})

describe('listeners', () => {
  it('announces a join once and a leave', () => {
    const s = setup()
    s.service.join('l2', 'An')
    s.service.join('l2', 'An')
    s.service.leave('l2')
    s.service.leave('l2')
    expect(s.activity).toEqual(['An joined', 'An left'])
  })
})

describe('restore and tick', () => {
  it('restarts downloads for items that are not cached', () => {
    const s = setup({ cached: [B] })
    const saved: Persisted = {
      version: 1,
      savedAt: 0,
      current: {
        id: 'c1',
        videoId: A,
        title: 'Song A',
        channel: 'Ch',
        duration: 100,
        thumbnail: 't',
        addedBy: 'Minh',
        status: 'ready',
      },
      queue: [
        {
          id: 'q1',
          videoId: B,
          title: 'Song B',
          channel: 'Ch',
          duration: 100,
          thumbnail: 't',
          addedBy: 'Minh',
          status: 'downloading',
        },
      ],
      playback: { status: 'playing', position: 0, at: 0 },
    }
    s.service.restore(saved)
    expect(s.cache.ensure).toHaveBeenCalledTimes(1)
    expect(s.cache.ensure).toHaveBeenCalledWith(A)
    expect(s.service.state().queue[0]!.status).toBe('ready')
    expect(s.service.state().playback.status).toBe('paused')
  })

  it('restore(null) leaves an empty station', () => {
    const s = setup()
    s.service.restore(null)
    expect(s.service.state().current).toBeNull()
  })

  it('tick notifies only when the station advanced', async () => {
    const s = setup({ cached: [A] })
    await s.service.add('l1', A) // plays 1000..101000
    s.onChange.mockClear()
    s.setTime(50_000)
    s.service.tick()
    expect(s.onChange).not.toHaveBeenCalled()
    s.setTime(101_000)
    s.service.tick()
    expect(s.onChange).toHaveBeenCalledOnce()
    expect(s.service.state().current).toBeNull()
  })

  it('persisted() stamps savedAt and reports isPlaying', async () => {
    const s = setup({ cached: [A] })
    await s.service.add('l1', A)
    s.setTime(1_234)
    expect(s.service.persisted()).toMatchObject({ version: 1, savedAt: 1_234 })
    expect(s.service.isPlaying()).toBe(true)
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @music-station/server exec vitest run src/service.test.ts`
Expected: FAIL, `Failed to resolve import "./service"`.

- [ ] **Step 3: Implement the service**

`apps/server/src/service.ts`:
```ts
import { randomUUID } from 'node:crypto'
import { parseVideoInput, type QueueItem, type StationState, type VideoInfo } from '@music-station/shared'
import type { Persisted } from './persist'
import { Station, StationError } from './station'

export interface CacheLike {
  ensure(videoId: string): Promise<string>
  has(videoId: string): boolean
  touch(videoId: string): void
  evict(protectedIds: Set<string>): string[]
}

export interface ServiceDeps {
  station: Station
  cache: CacheLike
  getInfo(videoId: string): Promise<VideoInfo>
  now(): number
  onChange(): void
  onActivity(text: string): void
  log?(msg: string): void
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

function clock(seconds: number): string {
  const s = Math.floor(seconds)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export class StationService {
  private downloading = new Set<string>()
  private lastCurrentId: string | null = null

  constructor(private deps: ServiceDeps) {}

  state(): StationState {
    return this.deps.station.snapshot()
  }

  persisted(): Persisted {
    return { version: 1, savedAt: this.deps.now(), ...this.deps.station.persisted() }
  }

  isPlaying(): boolean {
    return this.deps.station.persisted().playback.status === 'playing'
  }

  restore(saved: Persisted | null): void {
    const { station, cache } = this.deps
    if (saved) station.restore(saved, saved.savedAt, this.deps.now(), (id) => cache.has(id))
    for (const videoId of station.pendingVideoIds()) this.startDownload(videoId)
    this.changed()
  }

  join(listenerId: string, nickname: string): void {
    const isNew = this.deps.station.nickname(listenerId) === undefined
    this.deps.station.join(listenerId, nickname)
    if (isNew) this.deps.onActivity(`${nickname} joined`)
    this.changed()
  }

  leave(listenerId: string): void {
    const nickname = this.deps.station.nickname(listenerId)
    if (nickname === undefined) return
    this.deps.station.leave(listenerId)
    this.deps.onActivity(`${nickname} left`)
    this.changed()
  }

  async add(listenerId: string, input: string): Promise<QueueItem> {
    const nickname = this.who(listenerId)
    const videoId = parseVideoInput(input)
    if (!videoId) throw new StationError('That is not a YouTube video link')
    let info: VideoInfo
    try {
      info = await this.deps.getInfo(videoId)
    } catch (err) {
      throw new StationError(message(err))
    }
    const item: QueueItem = {
      id: randomUUID(),
      videoId,
      title: info.title,
      channel: info.channel,
      duration: info.duration,
      thumbnail: info.thumbnail,
      addedBy: nickname,
      status: this.deps.cache.has(videoId) ? 'ready' : 'downloading',
    }
    this.deps.station.add(item, this.deps.now())
    this.deps.onActivity(`${nickname} added ${item.title}`)
    this.changed()
    if (item.status === 'downloading') this.startDownload(videoId)
    return item
  }

  remove(listenerId: string, itemId: string): void {
    const nickname = this.who(listenerId)
    const item = this.deps.station.remove(itemId)
    this.announce(`${nickname} removed ${item.title}`)
  }

  move(listenerId: string, itemId: string, toIndex: number): void {
    const nickname = this.who(listenerId)
    const item = this.deps.station.move(itemId, toIndex)
    this.announce(`${nickname} moved ${item.title}`)
  }

  play(listenerId: string): void {
    const nickname = this.who(listenerId)
    this.deps.station.play(this.deps.now())
    this.announce(`${nickname} pressed play`)
  }

  pause(listenerId: string): void {
    const nickname = this.who(listenerId)
    this.deps.station.pause(this.deps.now())
    this.announce(`${nickname} paused`)
  }

  seek(listenerId: string, position: number): void {
    const nickname = this.who(listenerId)
    this.deps.station.seek(position, this.deps.now())
    this.announce(`${nickname} jumped to ${clock(this.deps.station.persisted().playback.position)}`)
  }

  skip(listenerId: string): void {
    const nickname = this.who(listenerId)
    const item = this.deps.station.skip(this.deps.now())
    this.announce(`${nickname} skipped ${item.title}`)
  }

  tick(): void {
    if (this.deps.station.tick(this.deps.now())) this.changed()
  }

  private who(listenerId: string): string {
    const nickname = this.deps.station.nickname(listenerId)
    if (nickname === undefined) throw new StationError('Join the station first')
    return nickname
  }

  private announce(text: string): void {
    this.deps.onActivity(text)
    this.changed()
  }

  private startDownload(videoId: string): void {
    if (this.downloading.has(videoId)) return
    this.downloading.add(videoId)
    void this.download(videoId)
  }

  private async download(videoId: string): Promise<void> {
    const { station, cache, log = console.log } = this.deps
    try {
      try {
        await cache.ensure(videoId)
      } catch (first) {
        log(`Download of ${videoId} failed, retrying: ${message(first)}`)
        await cache.ensure(videoId)
      }
      station.markReady(videoId, this.deps.now())
      cache.evict(station.protectedIds())
    } catch (err) {
      log(`Download of ${videoId} failed: ${message(err)}`)
      const failed = station.markFailed(videoId, this.deps.now())
      if (failed.length > 0) this.deps.onActivity(`Couldn't download ${failed[0]!.title}: ${message(err)}`)
    } finally {
      this.downloading.delete(videoId)
      this.changed()
    }
  }

  private changed(): void {
    const current = this.deps.station.persisted().current
    if (current && current.id !== this.lastCurrentId && this.deps.cache.has(current.videoId)) {
      this.deps.cache.touch(current.videoId)
    }
    this.lastCurrentId = current?.id ?? null
    this.deps.onChange()
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @music-station/server exec vitest run src/service.test.ts && pnpm --filter @music-station/server typecheck`
Expected: all service tests PASS, and tsc exits 0.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/service.ts apps/server/src/service.test.ts
git commit -m "feat(server): add station service for downloads, retries and notices

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: HTTP routes and search cache

**Files:**
- Create: `apps/server/src/search.ts`, `apps/server/src/http.ts`
- Test: `apps/server/src/search.test.ts`, `apps/server/src/http.test.ts`

**Interfaces:**
- Consumes: `searchQuerySchema`, `SearchResult` from `@music-station/shared`.
- Produces:
  - `type SearchFn = (query: string) => Promise<SearchResult[]>`
  - `createSearch(fn: SearchFn, opts?: { ttlMs?: number; max?: number; concurrency?: number }): SearchFn`. Defaults are 600 000 ms, 100 entries and 2 concurrent searches. Keys are trimmed, whitespace-collapsed and lowercased. In-flight calls are deduped, and failures are not cached.
  - `interface HttpOptions { cacheDir: string; webDir: string | null; hasAudio(videoId: string): boolean; search: SearchFn; logger?: boolean }`
  - `buildHttp(opts: HttpOptions): Promise<FastifyInstance>` registers these routes:

    | Request | Response |
    |---|---|
    | `GET /api/search?q=` | `200 { results: SearchResult[] }`; `400 { error }` when `q` is empty; `502 { error }` when yt-dlp fails; `429` after 30 requests/min per IP |
    | `GET /audio/:videoId.m4a` | `200`, or `206` for a Range request, with `Cache-Control: public, max-age=86400, immutable`; `404` when the file is not cached or the name is invalid |
    | `GET /` and other web files | served from `webDir` when it is set |

- [ ] **Step 1: Write the failing search cache tests**

`apps/server/src/search.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest'
import type { SearchResult } from '@music-station/shared'
import { createSearch } from './search'

const result = (title: string): SearchResult[] => [
  { videoId: 'aaaaaaaaaaa', title, channel: 'c', duration: 1, thumbnail: 't' },
]

describe('createSearch', () => {
  it('caches by normalized query and dedupes in-flight calls', async () => {
    const fn = vi.fn(async (q: string) => result(q))
    const search = createSearch(fn)
    const [a, b] = await Promise.all([search('Lofi  Beats'), search(' lofi beats ')])
    await search('LOFI BEATS')
    expect(fn).toHaveBeenCalledOnce()
    expect(fn).toHaveBeenCalledWith('Lofi Beats')
    expect(a).toBe(b)
  })

  it('does not cache failures', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(result('ok'))
    const search = createSearch(fn)
    await expect(search('x')).rejects.toThrow('boom')
    await expect(search('x')).resolves.toEqual(result('ok'))
  })

  it('expires entries after the ttl', async () => {
    const fn = vi.fn(async (q: string) => result(q))
    const search = createSearch(fn, { ttlMs: 20 })
    await search('x')
    await new Promise((r) => setTimeout(r, 40))
    await search('x')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('runs at most 2 searches at once', async () => {
    let active = 0
    let peak = 0
    const search = createSearch(async (q) => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 20))
      active--
      return result(q)
    })
    await Promise.all(['a', 'b', 'c', 'd'].map(search))
    expect(peak).toBe(2)
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @music-station/server exec vitest run src/search.test.ts`
Expected: FAIL, `Failed to resolve import "./search"`.

- [ ] **Step 3: Implement the search cache**

`apps/server/src/search.ts`:
```ts
import { LRUCache } from 'lru-cache'
import pLimit from 'p-limit'
import type { SearchResult } from '@music-station/shared'

export type SearchFn = (query: string) => Promise<SearchResult[]>

export function createSearch(
  fn: SearchFn,
  opts: { ttlMs?: number; max?: number; concurrency?: number } = {},
): SearchFn {
  const cache = new LRUCache<string, SearchResult[]>({ max: opts.max ?? 100, ttl: opts.ttlMs ?? 600_000 })
  const limit = pLimit(opts.concurrency ?? 2)
  const inflight = new Map<string, Promise<SearchResult[]>>()

  return (query) => {
    const q = query.trim().replace(/\s+/g, ' ')
    const key = q.toLowerCase()
    const hit = cache.get(key)
    if (hit) return Promise.resolve(hit)
    const running = inflight.get(key)
    if (running) return running
    const p = limit(() => fn(q))
      .then((results) => {
        cache.set(key, results)
        return results
      })
      .finally(() => inflight.delete(key))
    inflight.set(key, p)
    return p
  }
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `pnpm --filter @music-station/server exec vitest run src/search.test.ts`
Expected: 4 tests PASS.

- [ ] **Step 5: Write the failing HTTP tests**

`apps/server/src/http.test.ts`:
```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildHttp } from './http'

const A = 'aaaaaaaaaaa'
let dir: string
let app: FastifyInstance

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ms-http-'))
  await writeFile(join(dir, `${A}.m4a`), Buffer.from(Array.from({ length: 100 }, (_, i) => i)))
})
afterEach(async () => {
  await app?.close()
  await rm(dir, { recursive: true, force: true })
})

async function build(over: Partial<Parameters<typeof buildHttp>[0]> = {}) {
  app = await buildHttp({
    cacheDir: dir,
    webDir: null,
    hasAudio: (id) => id === A,
    search: async () => [],
    ...over,
  })
  return app
}

describe('/audio', () => {
  it('serves a cached file with long-lived caching', async () => {
    await build()
    const res = await app.inject(`/audio/${A}.m4a`)
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('public, max-age=86400, immutable')
    expect(res.headers['content-type']).toMatch(/^audio\//)
    expect(res.rawPayload.length).toBe(100)
  })

  it('answers Range requests with 206', async () => {
    await build()
    const res = await app.inject({ url: `/audio/${A}.m4a`, headers: { range: 'bytes=10-19' } })
    expect(res.statusCode).toBe(206)
    expect(res.headers['content-range']).toBe('bytes 10-19/100')
    expect([...res.rawPayload]).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19])
  })

  it.each([`/audio/bbbbbbbbbbb.m4a`, '/audio/..%2F..%2Fetc%2Fpasswd', `/audio/${A}.mp3`, '/audio/x.m4a'])(
    '404s for %s',
    async (url) => {
      await build()
      expect((await app.inject(url)).statusCode).toBe(404)
    },
  )
})

describe('/api/search', () => {
  it('returns results', async () => {
    const search = vi.fn(async () => [
      { videoId: A, title: 't', channel: 'c', duration: 1, thumbnail: 'th' },
    ])
    await build({ search })
    const res = await app.inject('/api/search?q=lofi')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ results: [{ videoId: A, title: 't', channel: 'c', duration: 1, thumbnail: 'th' }] })
    expect(search).toHaveBeenCalledWith('lofi')
  })

  it('400s on an empty query', async () => {
    await build()
    expect((await app.inject('/api/search?q=%20')).statusCode).toBe(400)
    expect((await app.inject('/api/search')).statusCode).toBe(400)
  })

  it('502s with the yt-dlp message when search fails', async () => {
    await build({
      search: async () => {
        throw new Error('YouTube bot check hit.')
      },
    })
    const res = await app.inject('/api/search?q=x')
    expect(res.statusCode).toBe(502)
    expect(res.json()).toEqual({ error: 'YouTube bot check hit.' })
  })

  it('limits each IP to 30 searches per minute', async () => {
    await build()
    for (let i = 0; i < 30; i++) expect((await app.inject('/api/search?q=x')).statusCode).toBe(200)
    expect((await app.inject('/api/search?q=x')).statusCode).toBe(429)
  })
})

describe('web UI', () => {
  it('serves index.html from webDir', async () => {
    const web = await mkdtemp(join(tmpdir(), 'ms-web-'))
    await writeFile(join(web, 'index.html'), '<!doctype html><title>Music Station</title>')
    await build({ webDir: web })
    const res = await app.inject('/')
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Music Station')
    expect((await app.inject(`/audio/${A}.m4a`)).statusCode).toBe(200)
    await rm(web, { recursive: true, force: true })
  })
})
```

- [ ] **Step 6: Run them to verify they fail**

Run: `pnpm --filter @music-station/server exec vitest run src/http.test.ts`
Expected: FAIL, `Failed to resolve import "./http"`.

- [ ] **Step 7: Implement the HTTP routes**

`apps/server/src/http.ts`:
```ts
import rateLimit from '@fastify/rate-limit'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyInstance } from 'fastify'
import { searchQuerySchema } from '@music-station/shared'
import type { SearchFn } from './search'

export interface HttpOptions {
  cacheDir: string
  webDir: string | null
  hasAudio(videoId: string): boolean
  search: SearchFn
  logger?: boolean
}

const AUDIO_RE = /^([A-Za-z0-9_-]{11})\.m4a$/

export async function buildHttp(opts: HttpOptions): Promise<FastifyInstance> {
  // trustProxy: requests arrive through the Tailscale proxy, so use X-Forwarded-For for per-IP limits.
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: true })

  await app.register(rateLimit, { global: false })
  // One static instance: it serves the web UI when webDir is set, and always provides reply.sendFile.
  await app.register(fastifyStatic, { root: opts.webDir ?? opts.cacheDir, serve: opts.webDir !== null })

  app.get('/api/search', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const parsed = searchQuerySchema.safeParse(req.query)
    if (!parsed.success) return reply.code(400).send({ error: 'Type something to search for' })
    try {
      return { results: await opts.search(parsed.data.q) }
    } catch (err) {
      req.log.warn({ err }, 'search failed')
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'Search failed' })
    }
  })

  app.get<{ Params: { file: string } }>('/audio/:file', async (req, reply) => {
    const m = req.params.file.match(AUDIO_RE)
    if (!m || !opts.hasAudio(m[1]!)) return reply.code(404).send({ error: 'Not found' })
    return reply.sendFile(req.params.file, opts.cacheDir, { maxAge: 86_400_000, immutable: true })
  })

  return app
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm --filter @music-station/server exec vitest run src/http.test.ts src/search.test.ts && pnpm --filter @music-station/server typecheck`
Expected: all tests PASS, and tsc exits 0. `.m4a` maps to an `audio/` MIME type through `send`'s mime table.

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/search.ts apps/server/src/search.test.ts apps/server/src/http.ts apps/server/src/http.test.ts
git commit -m "feat(server): add audio, search and static HTTP routes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Realtime handlers, app wiring and integration test

**Files:**
- Create: `apps/server/src/realtime.ts`, `apps/server/src/app.ts`
- Create: `apps/server/test/fixtures/tone.m4a` (generated with ffmpeg)
- Test: `apps/server/test/integration.test.ts`

**Interfaces:**
- Consumes:
  - `StationService` (Task 6) and `StationError` (Task 2).
  - `AudioCache` (Task 3), `YouTube` (Task 4), `loadState` and `createSaver` (Task 5), `Config` (Task 5).
  - `buildHttp` and `createSearch` (Task 7).
  - `joinSchema`, `addSchema`, `removeSchema`, `moveSchema`, `seekSchema`, `emptySchema`, `Ack` from `@music-station/shared`.
- Produces:
  - Realtime:
    - `interface RealtimeOptions { graceMs?: number; actionIntervalMs?: number; now?: () => number; log?: (msg: string) => void }` (defaults: 10 000 ms grace, 500 ms between actions).
    - `interface Realtime { broadcastState(): void; broadcastActivity(text: string): void; close(): void }`
    - `attachRealtime(io: Server, service: StationService, opts?: RealtimeOptions): Realtime`
  - App:
    - `interface AppDeps { config: Config; youtube: Pick<YouTube, 'search' | 'getInfo' | 'download'>; now?: () => number; log?: (msg: string) => void; graceMs?: number; saveDelayMs?: number; playingSaveMs?: number }`. The defaults are 10 000 ms grace, a 1 000 ms save delay, and a 5 000 ms save interval while playing. Tests shorten them.
    - `interface App { http: FastifyInstance; io: Server; service: StationService; cache: AudioCache; listen(): Promise<void>; close(): Promise<void> }`
    - `createApp(deps: AppDeps): Promise<App>`: the tick loop runs every 250 ms, and while playing the state is also saved every `playingSaveMs`.
  - Socket protocol, exactly as in spec §6:
    - Client → server: `join`, `queue:add`, `queue:remove`, `queue:move`, `player:play`, `player:pause`, `player:skip`, `player:seek`, `time:ping`. Each takes `(payload, ack)`, and the ack receives an `Ack`; `time:ping` acks with the server time.
    - Server → client: `state` (a `StationState`) and `activity` (an `Activity`).

- [ ] **Step 1: Generate the audio fixture**

Run:
```bash
mkdir -p apps/server/test/fixtures
ffmpeg -loglevel error -f lavfi -i "sine=frequency=440:duration=2" -c:a aac -b:a 64k apps/server/test/fixtures/tone.m4a
ls -l apps/server/test/fixtures/tone.m4a
```
Expected: a file of roughly 15–20 KB.

- [ ] **Step 2: Write the failing integration test**

`apps/server/test/integration.test.ts`:
```ts
import { randomUUID } from 'node:crypto'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { io as connect, type Socket } from 'socket.io-client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Ack, StationState, VideoInfo } from '@music-station/shared'
import { createApp, type App, type AppDeps } from '../src/app'
import type { Config } from '../src/config'
import { loadState } from '../src/persist'

const ID = 'dQw4w9WgXcQ'
const FIXTURE = join(import.meta.dirname, 'fixtures', 'tone.m4a')

let dataDir: string
let clock: number
let app: App | undefined
let url: string
const sockets: Socket[] = []

const config = (): Config => ({
  port: 0,
  dataDir,
  webDir: null,
  ytdlpBin: 'unused',
  cacheMaxBytes: 1e9,
  maxDurationSec: 3_600,
})

const youtube = {
  search: async () => [],
  getInfo: async (videoId: string): Promise<VideoInfo> => ({
    videoId,
    title: 'Tone',
    channel: 'Test',
    duration: 100,
    thumbnail: '',
  }),
  download: async (_videoId: string, dest: string) => {
    await copyFile(FIXTURE, dest)
  },
}

async function start(extra: Partial<AppDeps> = {}) {
  app = await createApp({ config: config(), youtube, now: () => clock, log: () => {}, graceMs: 100, ...extra })
  await app.listen()
  url = `http://127.0.0.1:${(app.http.server.address() as AddressInfo).port}`
}

function client(): Socket {
  const s = connect(url, { transports: ['websocket'], forceNew: true, reconnection: false })
  sockets.push(s)
  return s
}

const send = (s: Socket, event: string, payload?: unknown): Promise<Ack> =>
  s.timeout(3_000).emitWithAck(event, payload ?? {})

function waitFor<T>(s: Socket, event: string, match: (v: T) => boolean): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      s.off(event, on)
      reject(new Error(`timed out waiting for ${event}`))
    }, 3_000)
    const on = (v: T) => {
      if (!match(v)) return
      clearTimeout(timer)
      s.off(event, on)
      resolve(v)
    }
    s.on(event, on)
  })
}

const playingReady = (st: StationState) => st.current?.status === 'ready' && st.playback.status === 'playing'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'ms-int-'))
  clock = 1_000_000
  await start()
})

afterEach(async () => {
  for (const s of sockets.splice(0)) s.disconnect()
  await app?.close()
  app = undefined
  await rm(dataDir, { recursive: true, force: true })
})

describe('music station server', () => {
  it('gives two listeners identical state after join, add, pause and play', async () => {
    const a = client()
    const b = client()
    expect(await send(a, 'join', { clientId: randomUUID(), nickname: 'Minh' })).toEqual({ ok: true })
    expect(await send(b, 'join', { clientId: randomUUID(), nickname: 'An' })).toEqual({ ok: true })

    const aReady = waitFor<StationState>(a, 'state', playingReady)
    const bReady = waitFor<StationState>(b, 'state', playingReady)
    const notice = waitFor<{ text: string }>(b, 'activity', (x) => x.text.includes('added'))
    expect(await send(a, 'queue:add', { input: `https://youtu.be/${ID}` })).toEqual({ ok: true })

    const [sa, sb] = await Promise.all([aReady, bReady])
    expect(sa).toEqual(sb)
    expect(sa.current).toMatchObject({ videoId: ID, title: 'Tone', addedBy: 'Minh' })
    expect(sa.listeners.map((l) => l.nickname).sort()).toEqual(['An', 'Minh'])
    expect((await notice).text).toBe('Minh added Tone')

    const paused = (st: StationState) => st.playback.status === 'paused'
    const aPaused = waitFor<StationState>(a, 'state', paused)
    expect(await send(b, 'player:pause')).toEqual({ ok: true })
    expect(await aPaused).toMatchObject({ playback: { status: 'paused' } })

    clock += 600 // past the 500 ms action limit for socket a
    const aPlaying = waitFor<StationState>(a, 'state', playingReady)
    const bPlaying = waitFor<StationState>(b, 'state', playingReady)
    expect(await send(a, 'player:play')).toEqual({ ok: true })
    const [pa, pb] = await Promise.all([aPlaying, bPlaying])
    expect(pa.playback).toEqual(pb.playback)
    expect(pa.playback.at).toBe(clock + 1_000)
  })

  it('serves the downloaded file with Range support', async () => {
    const a = client()
    await send(a, 'join', { clientId: randomUUID(), nickname: 'Minh' })
    const ready = waitFor<StationState>(a, 'state', playingReady)
    await send(a, 'queue:add', { input: ID })
    await ready
    const res = await fetch(`${url}/audio/${ID}.m4a`, { headers: { Range: 'bytes=0-99' } })
    expect(res.status).toBe(206)
    expect((await res.arrayBuffer()).byteLength).toBe(100)
  })

  it('answers time pings with the server clock', async () => {
    const a = client()
    expect(await a.timeout(3_000).emitWithAck('time:ping', 123)).toBe(clock)
  })

  it('rejects invalid payloads, unjoined sockets and rapid actions', async () => {
    const a = client()
    expect(await send(a, 'player:play')).toEqual({ ok: false, error: 'Join the station first' })
    expect(await send(a, 'join', { clientId: 'nope', nickname: '' })).toMatchObject({ ok: false })
    await send(a, 'join', { clientId: randomUUID(), nickname: 'Minh' })
    expect(await send(a, 'queue:move', { itemId: 'x', toIndex: -1 })).toEqual({ ok: false, error: 'Invalid request' })
    expect(await send(a, 'player:play')).toEqual({ ok: false, error: 'Slow down a little' })
  })

  it('keeps a listener with two tabs until both are gone, after the grace period', async () => {
    const watcher = client()
    await send(watcher, 'join', { clientId: randomUUID(), nickname: 'Watcher' })
    const id = randomUUID()
    const tab1 = client()
    const tab2 = client()
    await send(tab1, 'join', { clientId: id, nickname: 'Minh' })
    await waitFor<StationState>(watcher, 'state', (st) => st.listeners.length === 2)
    await send(tab2, 'join', { clientId: id, nickname: 'Minh' })
    expect(app!.service.state().listeners.filter((l) => l.id === id)).toHaveLength(1)

    tab2.disconnect()
    await sleep(250) // longer than graceMs (100)
    expect(app!.service.state().listeners.some((l) => l.id === id)).toBe(true)

    const gone = waitFor<StationState>(watcher, 'state', (st) => !st.listeners.some((l) => l.id === id))
    tab1.disconnect()
    await gone
  })

  it('restores the queue paused near the playing position after a restart', async () => {
    const a = client()
    await send(a, 'join', { clientId: randomUUID(), nickname: 'Minh' })
    const ready = waitFor<StationState>(a, 'state', playingReady)
    await send(a, 'queue:add', { input: ID })
    await ready
    clock += 1_000 + 30_000 // lead-in, then 30 s of playback
    a.disconnect()
    await app!.close()

    clock += 60_000
    await start()
    const st = app!.service.state()
    expect(st.current).toMatchObject({ videoId: ID, status: 'ready' })
    expect(st.playback.status).toBe('paused')
    expect(st.playback.position).toBeCloseTo(30)
  })

  it('keeps saving while playing, so a crash loses at most a few seconds', async () => {
    await app!.close()
    await start({ saveDelayMs: 10, playingSaveMs: 50 })
    const a = client()
    await send(a, 'join', { clientId: randomUUID(), nickname: 'Minh' })
    const ready = waitFor<StationState>(a, 'state', playingReady)
    await send(a, 'queue:add', { input: ID })
    await ready
    clock += 20_000 // nothing changes state now; only the periodic save writes
    await sleep(300)
    const saved = await loadState(join(dataDir, 'station.json'))
    expect(saved?.savedAt).toBe(clock)
    expect(saved?.playback.status).toBe('playing')
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @music-station/server exec vitest run test/integration.test.ts`
Expected: FAIL, `Failed to resolve import "../src/app"`.

- [ ] **Step 4: Implement the realtime handlers**

`apps/server/src/realtime.ts`:
```ts
import type { Server } from 'socket.io'
import type { z, ZodTypeAny } from 'zod'
import {
  addSchema,
  emptySchema,
  joinSchema,
  moveSchema,
  removeSchema,
  seekSchema,
  type Ack,
} from '@music-station/shared'
import type { StationService } from './service'
import { StationError } from './station'

export interface RealtimeOptions {
  graceMs?: number
  actionIntervalMs?: number
  now?: () => number
  log?: (msg: string) => void
}

export interface Realtime {
  broadcastState(): void
  broadcastActivity(text: string): void
  close(): void
}

const reply = (ack: unknown, res: Ack) => {
  if (typeof ack === 'function') ack(res)
}

export function attachRealtime(io: Server, service: StationService, opts: RealtimeOptions = {}): Realtime {
  const graceMs = opts.graceMs ?? 10_000
  const actionIntervalMs = opts.actionIntervalMs ?? 500
  const now = opts.now ?? Date.now
  const log = opts.log ?? console.error
  const openSockets = new Map<string, number>() // listenerId -> connected sockets (tabs)
  const leaveTimers = new Map<string, NodeJS.Timeout>()
  let closed = false

  function release(listenerId: string): void {
    if (closed) return
    const remaining = (openSockets.get(listenerId) ?? 1) - 1
    if (remaining > 0) {
      openSockets.set(listenerId, remaining)
      return
    }
    openSockets.delete(listenerId)
    leaveTimers.set(
      listenerId,
      setTimeout(() => {
        leaveTimers.delete(listenerId)
        if (!openSockets.has(listenerId)) service.leave(listenerId)
      }, graceMs),
    )
  }

  io.on('connection', (socket) => {
    let listenerId: string | null = null
    let lastActionAt = Number.NEGATIVE_INFINITY

    socket.on('time:ping', (_t0: unknown, ack: unknown) => {
      if (typeof ack === 'function') ack(now())
    })

    socket.on('join', (payload: unknown, ack: unknown) => {
      const parsed = joinSchema.safeParse(payload)
      if (!parsed.success) return reply(ack, { ok: false, error: 'Pick a nickname of 1–24 characters' })
      const { clientId, nickname } = parsed.data
      if (listenerId !== clientId) {
        if (listenerId) release(listenerId)
        listenerId = clientId
        openSockets.set(clientId, (openSockets.get(clientId) ?? 0) + 1)
      }
      const timer = leaveTimers.get(clientId)
      if (timer) {
        clearTimeout(timer)
        leaveTimers.delete(clientId)
      }
      service.join(clientId, nickname) // broadcasts state to everyone, including this socket
      reply(ack, { ok: true })
    })

    function action<S extends ZodTypeAny>(
      event: string,
      schema: S,
      run: (id: string, data: z.infer<S>) => unknown,
    ): void {
      socket.on(event, async (payload: unknown, ack: unknown) => {
        if (!listenerId) return reply(ack, { ok: false, error: 'Join the station first' })
        const t = now()
        if (t - lastActionAt < actionIntervalMs) return reply(ack, { ok: false, error: 'Slow down a little' })
        lastActionAt = t
        const parsed = schema.safeParse(payload ?? {})
        if (!parsed.success) return reply(ack, { ok: false, error: 'Invalid request' })
        try {
          await run(listenerId, parsed.data)
          reply(ack, { ok: true })
        } catch (err) {
          if (err instanceof StationError) return reply(ack, { ok: false, error: err.message })
          log(`${event} failed: ${String(err)}`)
          reply(ack, { ok: false, error: 'Something went wrong' })
        }
      })
    }

    action('queue:add', addSchema, (id, d) => service.add(id, d.input))
    action('queue:remove', removeSchema, (id, d) => service.remove(id, d.itemId))
    action('queue:move', moveSchema, (id, d) => service.move(id, d.itemId, d.toIndex))
    action('player:play', emptySchema, (id) => service.play(id))
    action('player:pause', emptySchema, (id) => service.pause(id))
    action('player:skip', emptySchema, (id) => service.skip(id))
    action('player:seek', seekSchema, (id, d) => service.seek(id, d.position))

    socket.on('disconnect', () => {
      if (listenerId) release(listenerId)
    })
  })

  return {
    broadcastState: () => io.emit('state', service.state()),
    broadcastActivity: (text) => io.emit('activity', { text, at: now() }),
    close: () => {
      closed = true
      for (const t of leaveTimers.values()) clearTimeout(t)
      leaveTimers.clear()
    },
  }
}
```

Notes:
- The rapid-action test sends `player:play` right after `queue:move`. The injected clock has not moved, so the second action lands within 500 ms. The rate check runs before validation, so invalid payloads also count.
- `close()` sets `closed` before the app disconnects sockets. That way, shutdown does not schedule leave timers that would fire into a closed server.

- [ ] **Step 5: Implement the app wiring**

`apps/server/src/app.ts`:
```ts
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { Server } from 'socket.io'
import { AudioCache } from './cache'
import type { Config } from './config'
import { buildHttp } from './http'
import { createSaver, loadState } from './persist'
import { attachRealtime, type Realtime } from './realtime'
import { createSearch } from './search'
import { StationService } from './service'
import { Station } from './station'
import type { YouTube } from './youtube'

export interface AppDeps {
  config: Config
  youtube: Pick<YouTube, 'search' | 'getInfo' | 'download'>
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
  })
  service.restore(await loadState(stateFile, log))

  const http = await buildHttp({
    cacheDir,
    webDir: config.webDir,
    hasAudio: (id) => cache.has(id),
    search: createSearch((q) => youtube.search(q)),
  })
  const io = new Server(http.server, { serveClient: false })
  realtime = attachRealtime(io, service, { now, log, graceMs: deps.graceMs })

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
      io.disconnectSockets(true)
      io.engine.close()
      await http.close()
      await saver.flush()
    },
  }
}
```

- [ ] **Step 6: Run the integration test to verify it passes**

Run: `pnpm --filter @music-station/server exec vitest run test/integration.test.ts`
Expected: 7 tests PASS.

- [ ] **Step 7: Run the whole server suite and typecheck**

Run: `pnpm --filter @music-station/server test && pnpm --filter @music-station/server typecheck`
Expected: all tests PASS, and tsc exits 0.

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/realtime.ts apps/server/src/app.ts apps/server/test
git commit -m "feat(server): add socket handlers, app wiring and integration test

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Server entry point, build and smoke script

**Files:**
- Create: `apps/server/src/index.ts`, `apps/server/src/smoke.ts`, `apps/server/tsup.config.ts`

**Interfaces:**
- Consumes: `loadConfig` and `Config` (Task 5), `createYouTube` (Task 4), `createApp` (Task 8).
- Produces:
  - `apps/server/dist/index.js`: the production entry, started with `node apps/server/dist/index.js`. It listens on `0.0.0.0:$PORT`. It runs `yt-dlp -U` on start and every 24 h. On SIGTERM or SIGINT it saves the state, closes, and exits 0.
  - `apps/server/dist/smoke.js`: a manual check against real YouTube. It runs one search, getInfo and download, prints `smoke OK`, and exits non-zero on failure. Task 13 runs it inside the container.

`index.ts` only wires modules that already have tests, so this task checks it by building it and running it.

- [ ] **Step 1: Add the build config**

`apps/server/tsup.config.ts`:
```ts
import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/smoke.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  clean: true,
  // The shared package ships TypeScript source, so bundle it instead of importing it at runtime.
  noExternal: [/^@music-station\//],
})
```

- [ ] **Step 2: Write the entry point**

`apps/server/src/index.ts`:
```ts
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
```

- [ ] **Step 3: Write the smoke script**

`apps/server/src/smoke.ts`:
```ts
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
```

- [ ] **Step 4: Typecheck and build**

Run: `pnpm --filter @music-station/server typecheck && pnpm --filter @music-station/server build && ls apps/server/dist`
Expected: tsc exits 0, and `dist` contains `index.js` and `smoke.js`.

- [ ] **Step 5: Run the built server and check it end to end**

`/usr/bin/false` stands in for yt-dlp here, so the startup update fails and is logged instead of crashing the server.

Run:
```bash
TMP_DATA=$(mktemp -d)
DATA_DIR=$TMP_DATA PORT=3999 YTDLP_BIN=/usr/bin/false node apps/server/dist/index.js &
SERVER_PID=$!
sleep 2
curl -s -o /dev/null -w 'search %{http_code}\n' 'http://127.0.0.1:3999/api/search?q='
curl -s -o /dev/null -w 'audio %{http_code}\n' 'http://127.0.0.1:3999/audio/aaaaaaaaaaa.m4a'
curl -s 'http://127.0.0.1:3999/socket.io/?EIO=4&transport=polling' | head -c 12; echo
kill -TERM $SERVER_PID; wait $SERVER_PID; echo "exit $?"
cat $TMP_DATA/station.json; echo
rm -rf $TMP_DATA
```
Expected:
- `yt-dlp update failed: …` and `Music station listening on port 3999`.
- `search 400` and `audio 404`.
- The Socket.IO handshake starts with `0{"sid":"`.
- `SIGTERM received, saving and shutting down`, then `exit 0`.
- `station.json` contains `"version":1` and an empty queue.

- [ ] **Step 6: Run the server suite again**

Run: `pnpm --filter @music-station/server test`
Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/index.ts apps/server/src/smoke.ts apps/server/tsup.config.ts
git commit -m "feat(server): add entry point, build config and yt-dlp smoke script

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Web app scaffold and clock sync

**Files:**
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/vite.config.ts`, `apps/web/index.html`
- Create: `apps/web/src/index.css`, `apps/web/src/main.tsx` (a minimal version; Task 12 replaces it)
- Create: `apps/web/src/clockSync.ts`
- Test: `apps/web/src/clockSync.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks at runtime. The dev server proxies `/api`, `/audio` and `/socket.io` (WebSocket) to the server from Task 9 at `http://localhost:3000`.
- Produces:
  - `interface ClockSample { offset: number; rtt: number }`
  - `sampleOffset(t0: number, ts: number, t1: number): ClockSample` returns `offset = ts − (t0 + t1) / 2` and `rtt = t1 − t0`.
  - `bestSample(samples: ClockSample[]): ClockSample | null` returns the sample with the smallest RTT.
  - `type PingFn = () => Promise<number>` resolves with the server time in ms.
  - `interface ClockSyncOptions { count?: number; gapMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> }`. The defaults are 8 pings, 100 ms apart, `now = performance.timeOrigin + performance.now()`, and a real `setTimeout` sleep.
  - `class ClockSync` with:
    - `constructor(ping: PingFn, opts?: ClockSyncOptions)`
    - `measure(): Promise<void>`: a concurrent call joins the run already in progress. A failed ping is skipped. If every ping fails, the previous offset stays.
    - `serverNow(): number`
    - Readable fields `offset: number`, `rtt: number` and `synced: boolean`.

- [ ] **Step 1: Create the web package**

`apps/web/package.json`:
```json
{
  "name": "@music-station/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@music-station/shared": "workspace:*",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "socket.io-client": "^4.8.1"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.0.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.4",
    "tailwindcss": "^4.0.0",
    "typescript": "^5.6.3",
    "vite": "^6.0.0",
    "vitest": "^3.2.4"
  }
}
```

`apps/web/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "types": ["vite/client"]
  },
  "include": ["src", "vite.config.ts"]
}
```

`apps/web/vite.config.ts`:
```ts
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const server = 'http://localhost:3000'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': server,
      '/audio': server,
      '/socket.io': { target: server, ws: true },
    },
  },
})
```

`apps/web/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="theme-color" content="#09090b" />
    <title>Music Station</title>
  </head>
  <body class="bg-zinc-950 text-zinc-100 antialiased">
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`apps/web/src/index.css`:
```css
@import 'tailwindcss';
```

`apps/web/src/main.tsx` (a minimal version so the build works; Task 12 replaces it):
```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <p className="p-6">Music Station</p>
  </StrictMode>,
)
```

Run: `pnpm install && pnpm --filter @music-station/web build`
Expected: the install succeeds, and Vite writes `apps/web/dist/index.html` plus one JS and one CSS asset.

- [ ] **Step 2: Write the failing clock sync tests**

`apps/web/src/clockSync.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest'
import { bestSample, ClockSync, sampleOffset } from './clockSync'

const SERVER_AHEAD_MS = 5_000

/** A fake network: each ping takes `rtts[i]` ms. `outShare` is the fraction of that spent before the server reads its clock. */
function fakeNetwork(rtts: (number | undefined)[], outShare: number[] = rtts.map(() => 0.5)) {
  let local = 1_000
  let i = 0
  const ping = vi.fn(async () => {
    const k = i++
    const rtt = rtts[k]
    if (rtt === undefined) throw new Error('lost')
    local += rtt * outShare[k]!
    const ts = local + SERVER_AHEAD_MS
    local += rtt * (1 - outShare[k]!)
    return ts
  })
  const opts = {
    now: () => local,
    sleep: async (ms: number) => {
      local += ms
    },
  }
  return { ping, opts, local: () => local }
}

describe('sampleOffset', () => {
  it('uses the midpoint of the round trip', () => {
    expect(sampleOffset(1_000, 6_050, 1_100)).toEqual({ offset: 5_000, rtt: 100 })
  })
})

describe('bestSample', () => {
  it('picks the smallest round trip', () => {
    expect(bestSample([{ offset: 1, rtt: 90 }, { offset: 2, rtt: 15 }, { offset: 3, rtt: 40 }])).toEqual({ offset: 2, rtt: 15 })
  })

  it('returns null for no samples', () => {
    expect(bestSample([])).toBeNull()
  })
})

describe('ClockSync', () => {
  it('trusts the fastest ping over slow, lopsided ones', async () => {
    // Ping 0 is slow and lopsided (alone it would give an offset of 4 950); ping 2 is fast and even.
    const net = fakeNetwork([200, 80, 20, 60, 90, 70, 50, 120], [0.25, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5])
    const clock = new ClockSync(net.ping, net.opts)
    await clock.measure()
    expect(net.ping).toHaveBeenCalledTimes(8)
    expect(clock.offset).toBe(SERVER_AHEAD_MS)
    expect(clock.rtt).toBe(20)
    expect(clock.synced).toBe(true)
    expect(clock.serverNow()).toBe(net.local() + SERVER_AHEAD_MS)
  })

  it('waits gapMs between pings', async () => {
    const net = fakeNetwork([10, 10, 10])
    const clock = new ClockSync(net.ping, { ...net.opts, count: 3, gapMs: 100 })
    await clock.measure()
    expect(net.local()).toBe(1_000 + 3 * 10 + 2 * 100)
  })

  it('shares one run between concurrent callers', async () => {
    const net = fakeNetwork([10, 10, 10, 10, 10, 10, 10, 10])
    const clock = new ClockSync(net.ping, net.opts)
    await Promise.all([clock.measure(), clock.measure()])
    expect(net.ping).toHaveBeenCalledTimes(8)
  })

  it('skips lost pings and keeps the old offset when all are lost', async () => {
    const some = fakeNetwork([30, undefined, 30])
    const partial = new ClockSync(some.ping, { ...some.opts, count: 3 })
    await partial.measure()
    expect(partial.offset).toBe(SERVER_AHEAD_MS)

    const none = fakeNetwork([])
    const lost = new ClockSync(none.ping, { ...none.opts, count: 3 })
    await lost.measure()
    expect(lost.synced).toBe(false)
    expect(lost.offset).toBe(0)
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @music-station/web exec vitest run src/clockSync.test.ts`
Expected: FAIL, `Failed to resolve import "./clockSync"`.

- [ ] **Step 4: Implement clock sync**

`apps/web/src/clockSync.ts`:
```ts
export interface ClockSample {
  offset: number
  rtt: number
}

export function sampleOffset(t0: number, ts: number, t1: number): ClockSample {
  return { offset: ts - (t0 + t1) / 2, rtt: t1 - t0 }
}

export function bestSample(samples: ClockSample[]): ClockSample | null {
  let best: ClockSample | null = null
  for (const s of samples) if (!best || s.rtt < best.rtt) best = s
  return best
}

export type PingFn = () => Promise<number>

export interface ClockSyncOptions {
  count?: number
  gapMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export class ClockSync {
  offset = 0
  rtt = Number.POSITIVE_INFINITY
  synced = false
  private readonly count: number
  private readonly gapMs: number
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private running: Promise<void> | null = null

  constructor(
    private readonly ping: PingFn,
    opts: ClockSyncOptions = {},
  ) {
    this.count = opts.count ?? 8
    this.gapMs = opts.gapMs ?? 100
    this.now = opts.now ?? (() => performance.timeOrigin + performance.now())
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  }

  serverNow(): number {
    return this.now() + this.offset
  }

  measure(): Promise<void> {
    this.running ??= this.run().finally(() => {
      this.running = null
    })
    return this.running
  }

  private async run(): Promise<void> {
    const samples: ClockSample[] = []
    for (let i = 0; i < this.count; i++) {
      if (i > 0) await this.sleep(this.gapMs)
      const t0 = this.now()
      try {
        const ts = await this.ping()
        samples.push(sampleOffset(t0, ts, this.now()))
      } catch {
        // A lost or timed-out ping is skipped; the others are enough.
      }
    }
    const best = bestSample(samples)
    if (!best) return
    this.offset = best.offset
    this.rtt = best.rtt
    this.synced = true
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @music-station/web exec vitest run src/clockSync.test.ts && pnpm --filter @music-station/web typecheck`
Expected: 7 tests PASS, and tsc exits 0.

- [ ] **Step 6: Commit**

```bash
git add apps/web pnpm-lock.yaml
git commit -m "feat(web): scaffold Vite app and add clock sync

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Synced audio player

**Files:**
- Create: `apps/web/src/player.ts`
- Test: `apps/web/src/player.test.ts`

**Interfaces:**
- Consumes: `targetPosition`, `decideCorrection`, `Playback`, `QueueItem` from `@music-station/shared` (Task 1).
- Produces:
  - `interface AudioLike { src: string; currentTime: number; playbackRate: number; preservesPitch: boolean; readonly paused: boolean; play(): Promise<void>; pause(): void; addEventListener(type: 'canplay', fn: () => void): void; removeEventListener(type: 'canplay', fn: () => void): void }`. A real `HTMLAudioElement` satisfies it.
  - `interface PlayerDeps { audio: AudioLike; serverNow: () => number; delayMs: () => number; onBlocked: () => void }`
  - `class SyncPlayer` with:
    - `constructor(deps: PlayerDeps)` starts the 250 ms correction loop.
    - `update(current: QueueItem | null, playback: Playback): void`, called with every `state` from the server.
    - `correct(): void` runs one correction now. The loop calls it, and so do the tests.
    - `resume(): void` retries `play()` after the user taps "Tap to resume". It must be called from inside the tap handler.
    - `destroy(): void`
    - `lastDrift: number | null` is `currentTime − target` in seconds from the last correction, for the debug panel.

Player rules:
- A song's file is loaded only when its item is `ready`. Nothing plays until the element fires `canplay`.
- A `playing` state whose start time is still ahead pauses, parks at `position`, and starts after `at − serverNow − delayMs` ms. A seek while playing restarts everyone together through the server's lead time.
- A `paused` state pauses and parks at `position`.
- Only a `NotAllowedError` from `play()` counts as blocked. While blocked the player does not retry on its own, and the UI shows the resume banner.
- A state that changes neither the song file nor the playback values (for example, someone joins) leaves the audio alone.

- [ ] **Step 1: Write the failing tests**

`apps/web/src/player.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Playback, QueueItem } from '@music-station/shared'
import { SyncPlayer, type AudioLike } from './player'

class FakeAudio implements AudioLike {
  src = ''
  currentTime = 0
  playbackRate = 1
  preservesPitch = false
  paused = true
  blockPlay = false
  plays = 0
  private handlers = new Set<() => void>()

  play(): Promise<void> {
    this.plays++
    if (this.blockPlay) return Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' }))
    this.paused = false
    return Promise.resolve()
  }
  pause(): void {
    this.paused = true
  }
  addEventListener(_type: 'canplay', fn: () => void): void {
    this.handlers.add(fn)
  }
  removeEventListener(_type: 'canplay', fn: () => void): void {
    this.handlers.delete(fn)
  }
  /** Simulates the browser finishing loading the file. */
  loaded(): void {
    for (const fn of this.handlers) fn()
  }
}

const T0 = 1_000_000
const A = 'aaaaaaaaaaa'
const B = 'bbbbbbbbbbb'
const item = (videoId: string, status: QueueItem['status'] = 'ready'): QueueItem => ({
  id: `item-${videoId}`,
  videoId,
  title: videoId,
  channel: 'c',
  duration: 200,
  thumbnail: '',
  addedBy: 'Minh',
  status,
})
const playing = (position: number, at: number): Playback => ({ status: 'playing', position, at })
const paused = (position: number): Playback => ({ status: 'paused', position, at: T0 })
const settle = () => vi.advanceTimersByTimeAsync(0)

let audio: FakeAudio
let delay: number
let blocked: number
let player: SyncPlayer

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
  audio = new FakeAudio()
  delay = 0
  blocked = 0
  player = new SyncPlayer({
    audio,
    serverNow: () => Date.now(),
    delayMs: () => delay,
    onBlocked: () => blocked++,
  })
})

afterEach(() => {
  player.destroy()
  vi.useRealTimers()
})

describe('SyncPlayer', () => {
  it('does not load a song that is still downloading', async () => {
    player.update(item(A, 'downloading'), { status: 'waiting', position: 0, at: T0 })
    await settle()
    expect(audio.src).toBe('')
    expect(audio.plays).toBe(0)
  })

  it('loads a ready song, waits for canplay, then starts on the shared start time', async () => {
    player.update(item(A), playing(0, T0 + 1_000))
    expect(audio.src).toBe(`/audio/${A}.m4a`)
    expect(audio.preservesPitch).toBe(true)
    audio.loaded()
    await vi.advanceTimersByTimeAsync(999)
    expect(audio.plays).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(audio.plays).toBe(1)
    expect(audio.paused).toBe(false)
    expect(audio.currentTime).toBe(0)
  })

  it('starts earlier by the device delay', async () => {
    delay = 200
    player.update(item(A), playing(0, T0 + 1_000))
    audio.loaded()
    await vi.advanceTimersByTimeAsync(800)
    expect(audio.plays).toBe(1)
  })

  it('joins mid-song at the shared position plus the device delay', async () => {
    delay = 150
    player.update(item(A), playing(10, T0 - 5_000))
    audio.loaded()
    await settle()
    expect(audio.currentTime).toBeCloseTo(15.15)
    expect(audio.paused).toBe(false)
  })

  it('pauses and parks at the paused position', async () => {
    player.update(item(A), playing(0, T0 - 1_000))
    audio.loaded()
    await settle()
    player.update(item(A), paused(42))
    expect(audio.paused).toBe(true)
    expect(audio.currentTime).toBe(42)
  })

  it('on a seek while playing, parks at the new position and restarts on the shared start time', async () => {
    player.update(item(A), playing(0, T0 - 1_000))
    audio.loaded()
    await settle()
    player.update(item(A), playing(30, T0 + 1_000))
    expect(audio.paused).toBe(true)
    expect(audio.currentTime).toBe(30)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(audio.paused).toBe(false)
    expect(audio.currentTime).toBe(30)
  })

  it('nudges the rate for small drift and seeks for large drift', async () => {
    player.update(item(A), playing(0, T0 - 10_000)) // the target is 10 s while the clock stands still
    audio.loaded()
    await settle()
    audio.currentTime = 10.1
    player.correct()
    expect(audio.playbackRate).toBe(0.97)
    expect(player.lastDrift).toBeCloseTo(0.1)
    audio.currentTime = 9.9
    player.correct()
    expect(audio.playbackRate).toBe(1.03)
    audio.currentTime = 10.01
    player.correct()
    expect(audio.playbackRate).toBe(1)
    audio.currentTime = 12
    player.correct()
    expect(audio.currentTime).toBe(10)
    expect(audio.playbackRate).toBe(1)
  })

  it('runs the correction every 250 ms', async () => {
    player.update(item(A), playing(0, T0 - 10_000))
    audio.loaded()
    await settle()
    audio.currentTime = 50
    await vi.advanceTimersByTimeAsync(250)
    expect(audio.currentTime).toBeCloseTo(10.25)
  })

  it('reports blocked autoplay once and retries only on resume()', async () => {
    audio.blockPlay = true
    player.update(item(A), playing(0, T0 - 1_000))
    audio.loaded()
    await settle()
    expect(blocked).toBe(1)

    player.update(item(A), playing(5, T0 + 1_000)) // someone seeks while this device is blocked
    await vi.advanceTimersByTimeAsync(1_000)
    expect(audio.plays).toBe(1)

    audio.blockPlay = false
    player.resume()
    await settle()
    expect(audio.plays).toBe(2)
    expect(audio.paused).toBe(false)
    expect(audio.currentTime).toBeCloseTo(5)
  })

  it('ignores states that change neither the song nor the playback', async () => {
    player.update(item(A), playing(0, T0 - 1_000))
    audio.loaded()
    await settle()
    player.update(item(A), playing(0, T0 - 1_000))
    expect(audio.plays).toBe(1)
    expect(audio.paused).toBe(false)
  })

  it('switches songs and waits for the new file to load', async () => {
    player.update(item(A), playing(0, T0 - 1_000))
    audio.loaded()
    await settle()
    player.update(item(B), playing(0, T0 + 1_000))
    expect(audio.src).toBe(`/audio/${B}.m4a`)
    expect(audio.paused).toBe(true)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(audio.plays).toBe(1) // still loading
    audio.loaded()
    await settle()
    expect(audio.plays).toBe(2)
    expect(audio.currentTime).toBeCloseTo(1) // loaded 1 s after the shared start
  })

  it('stops when the station goes idle', async () => {
    player.update(item(A), playing(0, T0 - 1_000))
    audio.loaded()
    await settle()
    player.update(null, paused(0))
    expect(audio.paused).toBe(true)
  })

  it('clears its timers on destroy', async () => {
    player.update(item(A), playing(0, T0 + 1_000))
    audio.loaded()
    player.destroy()
    expect(vi.getTimerCount()).toBe(0)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @music-station/web exec vitest run src/player.test.ts`
Expected: FAIL, `Failed to resolve import "./player"`.

- [ ] **Step 3: Implement the player**

`apps/web/src/player.ts`:
```ts
import { decideCorrection, targetPosition, type Playback, type QueueItem } from '@music-station/shared'

export interface AudioLike {
  src: string
  currentTime: number
  playbackRate: number
  preservesPitch: boolean
  readonly paused: boolean
  play(): Promise<void>
  pause(): void
  addEventListener(type: 'canplay', fn: () => void): void
  removeEventListener(type: 'canplay', fn: () => void): void
}

export interface PlayerDeps {
  audio: AudioLike
  serverNow: () => number
  delayMs: () => number
  onBlocked: () => void
}

const CORRECT_EVERY_MS = 250
const PARK_TOLERANCE_S = 0.05

const samePlayback = (a: Playback, b: Playback) =>
  a.status === b.status && a.position === b.position && a.at === b.at

export class SyncPlayer {
  lastDrift: number | null = null
  private readonly deps: PlayerDeps
  private src: string | null = null
  private canPlay = false
  private blocked = false
  private current: QueueItem | null = null
  private playback: Playback = { status: 'paused', position: 0, at: 0 }
  private leadTimer: ReturnType<typeof setTimeout> | null = null
  private readonly loop: ReturnType<typeof setInterval>

  constructor(deps: PlayerDeps) {
    this.deps = deps
    deps.audio.preservesPitch = true
    deps.audio.addEventListener('canplay', this.onCanPlay)
    this.loop = setInterval(() => this.correct(), CORRECT_EVERY_MS)
  }

  update(current: QueueItem | null, playback: Playback): void {
    const src = current?.status === 'ready' ? `/audio/${current.videoId}.m4a` : null
    if (src === this.src && samePlayback(playback, this.playback)) return
    this.current = current
    this.playback = playback
    if (src !== this.src) {
      this.src = src
      this.canPlay = false
      this.clearLead()
      this.deps.audio.pause()
      if (src) this.deps.audio.src = src // apply() runs on canplay
      return
    }
    this.apply()
  }

  resume(): void {
    this.blocked = false
    this.apply()
  }

  correct(): void {
    const { audio } = this.deps
    const p = this.playback
    if (!this.canPlay || this.leadTimer || p.status !== 'playing' || audio.paused || !this.current) {
      this.lastDrift = null
      return
    }
    const target = this.target()
    if (target >= this.current.duration) return // the server advances to the next song
    const { rate, seekTo } = decideCorrection(audio.currentTime, target)
    this.lastDrift = audio.currentTime - target
    if (seekTo !== null) audio.currentTime = seekTo
    audio.playbackRate = rate
  }

  destroy(): void {
    clearInterval(this.loop)
    this.clearLead()
    this.deps.audio.removeEventListener('canplay', this.onCanPlay)
    this.deps.audio.pause()
  }

  private readonly onCanPlay = (): void => {
    if (this.canPlay || !this.src) return
    this.canPlay = true
    this.apply()
  }

  private apply(): void {
    const { audio } = this.deps
    this.clearLead()
    if (!this.canPlay) return
    const p = this.playback
    if (p.status !== 'playing') {
      audio.pause()
      audio.playbackRate = 1
      this.park(p.position)
      return
    }
    const startInMs = p.at - this.deps.serverNow() - this.deps.delayMs()
    if (startInMs > 0) {
      audio.pause()
      this.park(p.position)
      this.leadTimer = setTimeout(() => {
        this.leadTimer = null
        this.start()
      }, startInMs)
      return
    }
    this.start()
  }

  private start(): void {
    const { audio } = this.deps
    if (this.blocked) return
    this.park(this.target())
    audio.playbackRate = 1
    if (!audio.paused) return
    audio.play().catch((err: unknown) => {
      // AbortError just means a newer pause or src change won; only the autoplay policy needs the user.
      if (err instanceof Error && err.name === 'NotAllowedError') {
        this.blocked = true
        this.deps.onBlocked()
      }
    })
  }

  private park(position: number): void {
    const { audio } = this.deps
    if (Math.abs(audio.currentTime - position) > PARK_TOLERANCE_S) audio.currentTime = position
  }

  private target(): number {
    return targetPosition(this.playback, this.deps.serverNow(), this.deps.delayMs())
  }

  private clearLead(): void {
    if (this.leadTimer) clearTimeout(this.leadTimer)
    this.leadTimer = null
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @music-station/web exec vitest run src/player.test.ts && pnpm --filter @music-station/web typecheck`
Expected: 13 tests PASS, and tsc exits 0.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/player.ts apps/web/src/player.test.ts
git commit -m "feat(web): add synced audio player with drift correction

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Station hook and screens

**Files:**
- Create: `apps/web/src/format.ts`, `apps/web/src/storage.ts`, `apps/web/src/useStation.ts`, `apps/web/src/App.tsx`
- Create: `apps/web/src/screens/Join.tsx`, `NowPlaying.tsx`, `Queue.tsx`, `Search.tsx`, `Listeners.tsx`, `Settings.tsx`, `Toasts.tsx`
- Modify: `apps/web/src/main.tsx` (replace the Task 10 version)
- Test: `apps/web/src/format.test.ts`, `apps/web/src/storage.test.ts`

**Interfaces:**
- Consumes:
  - `ClockSync` (Task 10) and `SyncPlayer` (Task 11).
  - `parseVideoLink`, `expectedPosition`, `Ack`, `Activity`, `Listener`, `Playback`, `QueueItem`, `SearchResult`, `StationState` from `@music-station/shared`.
  - The socket events from Task 8 and `GET /api/search` from Task 7.
- Produces:
  - Formatting:
    - `formatTime(seconds: number): string` gives `m:ss`, or `h:mm:ss` from one hour.
    - `type InputKind = { kind: 'empty' } | { kind: 'link'; videoId: string } | { kind: 'bad-link' } | { kind: 'search'; query: string }`
    - `classifyInput(input: string): InputKind` uses `parseVideoLink`, never `parseVideoInput`, so `rickrolling` is a search (Review Focus 1).
  - Storage:
    - `interface KeyValueStore { getItem(key: string): string | null; setItem(key: string, value: string): void }`
    - `newUuid(): string`
    - `getClientId(store?): string`, `getNickname(store?): string`, `saveNickname(nickname, store?): void`
    - `getDelayMs(store?): number`, `saveDelayMs(ms, store?): void`, `clampDelay(ms): number`
    - Every function defaults to `localStorage` and keeps working when storage is missing or throws.
  - Hook:
    - `useStation(): Station`, where `Station` has: `clientId`, `state`, `connected`, `joined`, `blocked`, `toasts`, `delayMs`, `join(nickname)`, `send(event, payload?)`, `resume()`, `setDelayMs(ms)`, `serverNow()`, `debug()`, `notify(text, kind?)`.

Hook rules:
- The socket connects on load, but the player only receives state after a successful join. Unjoined sockets also receive broadcasts, and feeding them to the player would try to play before the Listen tap.
- `join` sets the element's `src` to a tiny silent WAV and calls `play()` before its first `await`, so this happens inside the Listen tap. That unlocks the element on iOS.
- The clock is measured on every `connect` (including reconnects), every 30 s, and when the tab becomes visible. Before the first measurement finishes, state is held back from the player.
- After a reconnect, the hook rejoins with the same `clientId` and nickname.
- Action acks wait up to 30 s, because adding a song waits for yt-dlp `getInfo` (up to 20 s). A failed ack shows an error toast.

- [ ] **Step 1: Write the failing format and storage tests**

`apps/web/src/format.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { classifyInput, formatTime } from './format'

describe('formatTime', () => {
  it.each([
    [0, '0:00'],
    [5.9, '0:05'],
    [65, '1:05'],
    [3_662, '1:01:02'],
    [-3, '0:00'],
  ])('formats %s as %s', (seconds, text) => {
    expect(formatTime(seconds)).toBe(text)
  })
})

describe('classifyInput', () => {
  it('searches for one-word queries that happen to look like video IDs', () => {
    expect(classifyInput('rickrolling')).toEqual({ kind: 'search', query: 'rickrolling' })
    expect(classifyInput('beethoven_5')).toEqual({ kind: 'search', query: 'beethoven_5' })
  })

  it('adds YouTube video links, with or without a scheme', () => {
    expect(classifyInput(' https://youtu.be/dQw4w9WgXcQ?t=42 ')).toEqual({ kind: 'link', videoId: 'dQw4w9WgXcQ' })
    expect(classifyInput('music.youtube.com/watch?v=dQw4w9WgXcQ&list=RD')).toEqual({
      kind: 'link',
      videoId: 'dQw4w9WgXcQ',
    })
  })

  it('flags links that have no video in them', () => {
    expect(classifyInput('https://www.youtube.com/playlist?list=PL123')).toEqual({ kind: 'bad-link' })
    expect(classifyInput('https://example.com/song')).toEqual({ kind: 'bad-link' })
  })

  it('searches for ordinary text, including the word youtube', () => {
    expect(classifyInput('youtube rewind 2018')).toEqual({ kind: 'search', query: 'youtube rewind 2018' })
    expect(classifyInput('   ')).toEqual({ kind: 'empty' })
  })
})
```

`apps/web/src/storage.test.ts`:
```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clampDelay, getClientId, getDelayMs, newUuid, saveDelayMs, type KeyValueStore } from './storage'

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function memoryStore(): KeyValueStore {
  const data = new Map<string, string>()
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getClientId', () => {
  it('creates a uuid once and reuses it', () => {
    const store = memoryStore()
    const id = getClientId(store)
    expect(id).toMatch(V4)
    expect(getClientId(store)).toBe(id)
  })

  it('replaces a damaged saved id', () => {
    const store = memoryStore()
    store.setItem('musicStation.clientId', 'garbage')
    expect(getClientId(store)).toMatch(V4)
  })

  it('still works when storage throws', () => {
    const denied = () => {
      throw new Error('denied')
    }
    expect(getClientId({ getItem: denied, setItem: denied })).toMatch(V4)
  })
})

describe('newUuid', () => {
  it('falls back to getRandomValues when randomUUID is missing (plain-http LAN address)', () => {
    const real = globalThis.crypto
    vi.stubGlobal('crypto', { getRandomValues: (a: Uint8Array) => real.getRandomValues(a) })
    expect(newUuid()).toMatch(V4)
  })
})

describe('delay', () => {
  it('clamps to 0–500 ms and survives a reload', () => {
    const store = memoryStore()
    expect(getDelayMs(store)).toBe(0)
    saveDelayMs(180, store)
    expect(getDelayMs(store)).toBe(180)
    saveDelayMs(900, store)
    expect(getDelayMs(store)).toBe(500)
    expect(clampDelay(-20)).toBe(0)
    store.setItem('musicStation.delayMs', 'abc')
    expect(getDelayMs(store)).toBe(0)
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @music-station/web exec vitest run src/format.test.ts src/storage.test.ts`
Expected: FAIL, `Failed to resolve import "./format"` and `"./storage"`.

- [ ] **Step 3: Implement format and storage**

`apps/web/src/format.ts`:
```ts
import { parseVideoLink } from '@music-station/shared'

export function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const h = Math.floor(total / 3_600)
  const m = Math.floor((total % 3_600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

export type InputKind =
  | { kind: 'empty' }
  | { kind: 'link'; videoId: string }
  | { kind: 'bad-link' }
  | { kind: 'search'; query: string }

const LOOKS_LIKE_LINK = /^(https?:\/\/|([\w-]+\.)*youtu(\.be|be\.com)\/)/i

/** Only real links are added directly. A bare 11-character word is a search (Review Focus 1). */
export function classifyInput(input: string): InputKind {
  const s = input.trim()
  if (!s) return { kind: 'empty' }
  const videoId = parseVideoLink(s)
  if (videoId) return { kind: 'link', videoId }
  if (LOOKS_LIKE_LINK.test(s)) return { kind: 'bad-link' }
  return { kind: 'search', query: s }
}
```

`apps/web/src/storage.ts`:
```ts
export interface KeyValueStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const CLIENT_ID = 'musicStation.clientId'
const NICKNAME = 'musicStation.nickname'
const DELAY = 'musicStation.delayMs'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function browserStore(): KeyValueStore | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function read(store: KeyValueStore | null, key: string): string | null {
  try {
    return store?.getItem(key) ?? null
  } catch {
    return null
  }
}

function write(store: KeyValueStore | null, key: string, value: string): void {
  try {
    store?.setItem(key, value)
  } catch {
    // Private mode or a full quota: the app still works, it just forgets on reload.
  }
}

export function newUuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  // A plain-http LAN address is not a secure context, so randomUUID is missing there.
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6]! & 0x0f) | 0x40
  b[8] = (b[8]! & 0x3f) | 0x80
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function getClientId(store: KeyValueStore | null = browserStore()): string {
  const saved = read(store, CLIENT_ID)
  if (saved && UUID_RE.test(saved)) return saved
  const id = newUuid()
  write(store, CLIENT_ID, id)
  return id
}

export function getNickname(store: KeyValueStore | null = browserStore()): string {
  return read(store, NICKNAME) ?? ''
}

export function saveNickname(nickname: string, store: KeyValueStore | null = browserStore()): void {
  write(store, NICKNAME, nickname)
}

export const clampDelay = (ms: number): number => Math.min(500, Math.max(0, Math.round(ms)))

export function getDelayMs(store: KeyValueStore | null = browserStore()): number {
  const n = Number(read(store, DELAY))
  return Number.isFinite(n) ? clampDelay(n) : 0
}

export function saveDelayMs(ms: number, store: KeyValueStore | null = browserStore()): void {
  write(store, DELAY, String(clampDelay(ms)))
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `pnpm --filter @music-station/web exec vitest run src/format.test.ts src/storage.test.ts`
Expected: 14 tests PASS.

- [ ] **Step 5: Write the station hook**

`apps/web/src/useStation.ts`:
```ts
import { useCallback, useEffect, useRef, useState } from 'react'
import { io, type Socket } from 'socket.io-client'
import type { Ack, Activity, StationState } from '@music-station/shared'
import { ClockSync } from './clockSync'
import { SyncPlayer } from './player'
import { clampDelay, getClientId, getDelayMs, saveDelayMs, saveNickname } from './storage'

export type ActionEvent =
  | 'queue:add'
  | 'queue:remove'
  | 'queue:move'
  | 'player:play'
  | 'player:pause'
  | 'player:skip'
  | 'player:seek'

export interface Toast {
  id: number
  text: string
  kind: 'info' | 'error'
}

export interface DebugInfo {
  offsetMs: number
  rttMs: number
  driftMs: number | null
}

export interface Station {
  clientId: string
  state: StationState | null
  connected: boolean
  joined: boolean
  blocked: boolean
  toasts: Toast[]
  delayMs: number
  join(nickname: string): Promise<Ack>
  send(event: ActionEvent, payload?: object): Promise<Ack>
  resume(): void
  setDelayMs(ms: number): void
  serverNow(): number
  debug(): DebugInfo
  notify(text: string, kind?: Toast['kind']): void
}

interface Connection {
  socket: Socket
  clock: ClockSync
  player: SyncPlayer
  audio: HTMLAudioElement
  /** Hands the latest state to the player once joined and the clock is measured. */
  sync(): void
}

// 8 samples of 8-bit silence. Playing it inside the Listen tap unlocks the element on iOS.
const SILENCE = 'data:audio/wav;base64,UklGRiwAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQgAAACAgICAgICAgA=='
const TOAST_MS = 4_000
const RESYNC_MS = 30_000
const JOIN_TIMEOUT_MS = 10_000
const ACTION_TIMEOUT_MS = 30_000

async function ask(socket: Socket, event: string, payload: unknown, timeoutMs: number): Promise<Ack> {
  try {
    return (await socket.timeout(timeoutMs).emitWithAck(event, payload)) as Ack
  } catch {
    return { ok: false, error: 'The station did not answer. Check your connection.' }
  }
}

export function useStation(): Station {
  const [clientId] = useState(() => getClientId())
  const [state, setState] = useState<StationState | null>(null)
  const [connected, setConnected] = useState(false)
  const [joined, setJoined] = useState(false)
  const [blocked, setBlocked] = useState(false)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [delayMs, setDelay] = useState(() => getDelayMs())
  const delayRef = useRef(delayMs)
  const nicknameRef = useRef<string | null>(null)
  const conn = useRef<Connection | null>(null)
  const toastId = useRef(0)

  const notify = useCallback((text: string, kind: Toast['kind'] = 'info') => {
    const id = ++toastId.current
    setToasts((list) => [...list.slice(-3), { id, text, kind }])
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), TOAST_MS)
  }, [])

  useEffect(() => {
    const audio = new Audio()
    audio.preload = 'auto'
    const socket = io()
    const clock = new ClockSync(() => socket.timeout(2_000).emitWithAck('time:ping', Date.now()))
    const player = new SyncPlayer({
      audio,
      serverNow: () => clock.serverNow(),
      delayMs: () => delayRef.current,
      onBlocked: () => setBlocked(true),
    })

    let latest: StationState | null = null
    const handToPlayer = () => {
      if (latest && nicknameRef.current) player.update(latest.current, latest.playback)
    }
    const sync = () => {
      if (clock.synced) handToPlayer()
      else void clock.measure().then(handToPlayer)
    }
    conn.current = { socket, clock, player, audio, sync }

    socket.on('connect', () => {
      setConnected(true)
      void clock.measure().then(handToPlayer)
      const nickname = nicknameRef.current
      if (nickname) void ask(socket, 'join', { clientId, nickname }, JOIN_TIMEOUT_MS) // rejoin after a drop
    })
    socket.on('disconnect', () => setConnected(false))
    socket.on('state', (s: StationState) => {
      latest = s
      setState(s)
      sync()
    })
    socket.on('activity', (a: Activity) => notify(a.text))

    const resync = setInterval(() => void clock.measure(), RESYNC_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') void clock.measure().then(() => player.correct())
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      clearInterval(resync)
      document.removeEventListener('visibilitychange', onVisible)
      socket.disconnect()
      player.destroy()
      conn.current = null
    }
  }, [clientId, notify])

  const join = useCallback(
    async (nickname: string): Promise<Ack> => {
      const c = conn.current
      if (!c) return { ok: false, error: 'Still connecting…' }
      // This must run before the first await, while the browser still counts the Listen tap.
      c.audio.src = SILENCE
      c.audio.play().then(
        () => {
          if (c.audio.src === SILENCE) c.audio.pause()
        },
        () => {},
      )
      const res = await ask(c.socket, 'join', { clientId, nickname }, JOIN_TIMEOUT_MS)
      if (res.ok) {
        nicknameRef.current = nickname
        saveNickname(nickname)
        setJoined(true)
        c.sync()
      }
      return res
    },
    [clientId],
  )

  const send = useCallback(
    async (event: ActionEvent, payload: object = {}): Promise<Ack> => {
      const c = conn.current
      if (!c) return { ok: false, error: 'Not connected' }
      const res = await ask(c.socket, event, payload, ACTION_TIMEOUT_MS)
      if (!res.ok) notify(res.error, 'error')
      return res
    },
    [notify],
  )

  const resume = useCallback(() => {
    setBlocked(false)
    conn.current?.player.resume()
  }, [])

  const setDelayMs = useCallback((ms: number) => {
    const value = clampDelay(ms)
    delayRef.current = value
    saveDelayMs(value)
    setDelay(value)
  }, [])

  const serverNow = useCallback(() => conn.current?.clock.serverNow() ?? Date.now(), [])

  const debug = useCallback((): DebugInfo => {
    const c = conn.current
    const drift = c?.player.lastDrift ?? null
    return {
      offsetMs: c?.clock.offset ?? 0,
      rttMs: c?.clock.rtt ?? Number.POSITIVE_INFINITY,
      driftMs: drift === null ? null : drift * 1000,
    }
  }, [])

  return {
    clientId,
    state,
    connected,
    joined,
    blocked,
    toasts,
    delayMs,
    join,
    send,
    resume,
    setDelayMs,
    serverNow,
    debug,
    notify,
  }
}
```

Run: `pnpm --filter @music-station/web typecheck`
Expected: tsc exits 0.

- [ ] **Step 6: Write the screens**

Nicknames and titles are rendered only as React text children, never through `dangerouslySetInnerHTML`.

`apps/web/src/screens/Join.tsx`:
```tsx
import { useState, type FormEvent } from 'react'
import type { Ack } from '@music-station/shared'
import { getNickname } from '../storage'

interface Props {
  connected: boolean
  onJoin(nickname: string): Promise<Ack>
}

export function Join({ connected, onJoin }: Props) {
  const [nickname, setNickname] = useState(() => getNickname())
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const name = nickname.trim()

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const res = await onJoin(name) // onJoin unlocks audio before its first await, inside this tap
    setBusy(false)
    if (!res.ok) setError(res.error)
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 p-6">
      <h1 className="text-3xl font-bold">Music Station</h1>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <label htmlFor="nickname" className="text-sm text-zinc-400">
          Your nickname
        </label>
        <input
          id="nickname"
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
          maxLength={24}
          autoFocus
          autoComplete="nickname"
          className="rounded-lg bg-zinc-900 px-4 py-3 text-lg outline-none ring-1 ring-zinc-800 focus:ring-emerald-500"
        />
        <button
          disabled={!connected || busy || name.length === 0}
          className="rounded-lg bg-emerald-500 px-4 py-3 text-lg font-semibold text-zinc-950 disabled:opacity-40"
        >
          {connected ? 'Listen' : 'Connecting…'}
        </button>
        {error && <p className="text-sm text-red-400">{error}</p>}
      </form>
    </main>
  )
}
```

`apps/web/src/screens/NowPlaying.tsx`:
```tsx
import { useEffect, useState } from 'react'
import { expectedPosition, type Playback, type QueueItem } from '@music-station/shared'
import { formatTime } from '../format'
import type { Station } from '../useStation'

interface Props {
  current: QueueItem | null
  playback: Playback
  serverNow(): number
  send: Station['send']
}

export function NowPlaying({ current, playback, serverNow, send }: Props) {
  const [, setFrame] = useState(0)
  const [drag, setDrag] = useState<number | null>(null)

  useEffect(() => {
    const timer = setInterval(() => setFrame((n) => n + 1), 250)
    return () => clearInterval(timer)
  }, [])

  if (!current) {
    return (
      <section className="rounded-2xl bg-zinc-900 p-6 text-center text-zinc-400">
        Nothing is playing. Search for a song to start.
      </section>
    )
  }

  // Pausing while the song still downloads is allowed, so it does not start by itself when the download ends.
  const loading = playback.status === 'waiting' || current.status === 'downloading'
  const paused = playback.status === 'paused'
  const position = Math.min(current.duration, expectedPosition(playback, serverNow()))
  const shown = drag ?? position

  const commitSeek = () => {
    if (drag === null) return
    const target = drag
    setDrag(null)
    void send('player:seek', { position: target })
  }

  return (
    <section className="flex flex-col gap-4 rounded-2xl bg-zinc-900 p-4">
      <div className="flex gap-4">
        <img src={current.thumbnail} alt="" className="h-20 w-36 shrink-0 rounded-lg object-cover" />
        <div className="min-w-0">
          <p className="truncate font-semibold">{current.title}</p>
          <p className="truncate text-sm text-zinc-400">{current.channel}</p>
          <p className="truncate text-xs text-zinc-500">Added by {current.addedBy}</p>
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-amber-400">Loading…</p>
      ) : (
        <div className="flex flex-col gap-1">
          <input
            type="range"
            aria-label="Seek"
            min={0}
            max={current.duration}
            step={1}
            value={shown}
            onChange={(e) => setDrag(Number(e.target.value))}
            onPointerUp={commitSeek}
            onKeyUp={commitSeek}
            className="w-full accent-emerald-500"
          />
          <div className="flex justify-between text-xs tabular-nums text-zinc-400">
            <span>{formatTime(shown)}</span>
            <span>{formatTime(current.duration)}</span>
          </div>
        </div>
      )}

      <div className="flex justify-center gap-3">
        <button
          onClick={() => void send(paused ? 'player:play' : 'player:pause')}
          disabled={paused && current.status !== 'ready'}
          className="rounded-full bg-emerald-500 px-6 py-2 font-semibold text-zinc-950 disabled:opacity-40"
        >
          {paused ? 'Play' : 'Pause'}
        </button>
        <button onClick={() => void send('player:skip')} className="rounded-full bg-zinc-800 px-6 py-2">
          Skip
        </button>
      </div>
    </section>
  )
}
```

`apps/web/src/screens/Queue.tsx`:
```tsx
import type { ReactNode } from 'react'
import type { QueueItem } from '@music-station/shared'
import { formatTime } from '../format'
import type { Station } from '../useStation'

export function Queue({ queue, send }: { queue: QueueItem[]; send: Station['send'] }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="px-1 text-sm font-semibold uppercase tracking-wide text-zinc-400">Up next ({queue.length})</h2>
      {queue.length === 0 && <p className="px-1 text-sm text-zinc-500">The queue is empty.</p>}
      <ul className="flex flex-col gap-2">
        {queue.map((item, i) => (
          <li key={item.id} className="flex items-center gap-3 rounded-xl bg-zinc-900 p-2">
            <img src={item.thumbnail} alt="" className="h-12 w-20 shrink-0 rounded object-cover" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">{item.title}</p>
              <p className="flex items-center gap-1 truncate text-xs text-zinc-500">
                {formatTime(item.duration)} · {item.addedBy}
                <StatusBadge status={item.status} />
              </p>
            </div>
            <div className="flex shrink-0 gap-1">
              <IconButton
                label="Move up"
                disabled={i === 0}
                onClick={() => void send('queue:move', { itemId: item.id, toIndex: i - 1 })}
              >
                ↑
              </IconButton>
              <IconButton
                label="Move down"
                disabled={i === queue.length - 1}
                onClick={() => void send('queue:move', { itemId: item.id, toIndex: i + 1 })}
              >
                ↓
              </IconButton>
              <IconButton label="Remove" onClick={() => void send('queue:remove', { itemId: item.id })}>
                ✕
              </IconButton>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

function StatusBadge({ status }: { status: QueueItem['status'] }) {
  if (status === 'downloading') {
    return (
      <span
        role="status"
        aria-label="Downloading"
        className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-amber-400 border-t-transparent"
      />
    )
  }
  if (status === 'failed') return <span className="font-semibold text-red-400">failed</span>
  return null
}

interface IconButtonProps {
  label: string
  disabled?: boolean
  onClick(): void
  children: ReactNode
}

function IconButton({ label, disabled, onClick, children }: IconButtonProps) {
  return (
    <button
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="h-9 w-9 rounded-lg bg-zinc-800 text-zinc-300 disabled:opacity-30"
    >
      {children}
    </button>
  )
}
```

`apps/web/src/screens/Search.tsx`:
```tsx
import { useState, type FormEvent } from 'react'
import type { SearchResult } from '@music-station/shared'
import { classifyInput, formatTime } from '../format'
import type { Station } from '../useStation'

interface Props {
  send: Station['send']
  notify: Station['notify']
}

export function Search({ send, notify }: Props) {
  const [text, setText] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [added, setAdded] = useState<Set<string>>(() => new Set())
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const input = classifyInput(text)
    if (input.kind === 'empty') return
    if (input.kind === 'bad-link') {
      notify('That link has no YouTube video in it', 'error')
      return
    }
    setBusy(true)
    try {
      if (input.kind === 'link') {
        const res = await send('queue:add', { input: input.videoId })
        if (res.ok) setText('')
        return
      }
      const res = await fetch(`/api/search?q=${encodeURIComponent(input.query)}`)
      const body = (await res.json()) as { results?: SearchResult[]; error?: string }
      if (!res.ok) {
        notify(res.status === 429 ? 'Too many searches. Wait a minute.' : (body.error ?? 'Search failed'), 'error')
        return
      }
      setResults(body.results ?? [])
      setAdded(new Set())
    } catch {
      notify('Search failed. Check your connection.', 'error')
    } finally {
      setBusy(false)
    }
  }

  async function add(result: SearchResult) {
    const res = await send('queue:add', { input: result.videoId })
    if (res.ok) setAdded((s) => new Set(s).add(result.videoId))
  }

  return (
    <section className="flex flex-col gap-3">
      <form onSubmit={submit} className="flex gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Search or paste a YouTube link"
          aria-label="Search or paste a YouTube link"
          enterKeyHint="search"
          maxLength={500}
          className="min-w-0 flex-1 rounded-lg bg-zinc-900 px-3 py-2 outline-none ring-1 ring-zinc-800 focus:ring-emerald-500"
        />
        <button disabled={busy} className="rounded-lg bg-zinc-800 px-4 py-2 disabled:opacity-40">
          {busy ? '…' : 'Go'}
        </button>
      </form>
      {results.length > 0 && (
        <>
          <ul className="flex flex-col gap-2">
            {results.map((r) => (
              <li key={r.videoId} className="flex items-center gap-3 rounded-xl bg-zinc-900 p-2">
                <img src={r.thumbnail} alt="" loading="lazy" className="h-12 w-20 shrink-0 rounded object-cover" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{r.title}</p>
                  <p className="truncate text-xs text-zinc-500">
                    {r.channel}
                    {r.duration !== null && ` · ${formatTime(r.duration)}`}
                  </p>
                </div>
                <button
                  onClick={() => void add(r)}
                  disabled={added.has(r.videoId)}
                  className="shrink-0 rounded-lg bg-emerald-500 px-3 py-1.5 text-sm font-semibold text-zinc-950 disabled:bg-zinc-700 disabled:text-zinc-400"
                >
                  {added.has(r.videoId) ? 'Added' : 'Add'}
                </button>
              </li>
            ))}
          </ul>
          <button onClick={() => setResults([])} className="self-center text-sm text-zinc-500">
            Clear results
          </button>
        </>
      )}
    </section>
  )
}
```

`apps/web/src/screens/Listeners.tsx`:
```tsx
import type { Listener } from '@music-station/shared'

export function Listeners({ listeners, me }: { listeners: Listener[]; me: string }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="px-1 text-sm font-semibold uppercase tracking-wide text-zinc-400">
        Listening ({listeners.length})
      </h2>
      <ul className="flex flex-wrap gap-2">
        {listeners.map((l) => (
          <li key={l.id} className="rounded-full bg-zinc-900 px-3 py-1 text-sm">
            {l.nickname}
            {l.id === me && <span className="text-zinc-500"> (you)</span>}
          </li>
        ))}
      </ul>
    </section>
  )
}
```

`apps/web/src/screens/Settings.tsx`:
```tsx
import { useEffect, useState } from 'react'
import type { DebugInfo } from '../useStation'

interface Props {
  delayMs: number
  setDelayMs(ms: number): void
  debug(): DebugInfo
  onClose(): void
}

const ms = (n: number | null) => (n === null || !Number.isFinite(n) ? '–' : `${Math.round(n)} ms`)

export function Settings({ delayMs, setDelayMs, debug, onClose }: Props) {
  const [info, setInfo] = useState(() => debug())

  useEffect(() => {
    const timer = setInterval(() => setInfo(debug()), 500)
    return () => clearInterval(timer)
  }, [debug])

  return (
    <div className="fixed inset-0 z-20 flex items-end bg-black/60" onClick={onClose}>
      <div
        role="dialog"
        aria-label="Settings"
        className="mx-auto w-full max-w-xl rounded-t-2xl bg-zinc-900 p-5 pb-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Settings</h2>
          <button onClick={onClose} className="text-zinc-400">
            Close
          </button>
        </div>
        <label className="flex flex-col gap-2">
          <span className="text-sm">
            Speaker delay: <b className="tabular-nums">{delayMs} ms</b>
          </span>
          <input
            type="range"
            min={0}
            max={500}
            step={10}
            value={delayMs}
            onChange={(e) => setDelayMs(Number(e.target.value))}
            className="accent-emerald-500"
          />
          <span className="text-xs text-zinc-500">Raise this if your speaker sounds behind the other devices.</span>
        </label>
        <dl className="mt-6 grid grid-cols-3 gap-2 text-center text-sm">
          <Stat label="Drift" value={ms(info.driftMs)} />
          <Stat label="Clock offset" value={ms(info.offsetMs)} />
          <Stat label="Round trip" value={ms(info.rttMs)} />
        </dl>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-zinc-950 p-2">
      <dt className="text-xs text-zinc-500">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  )
}
```

`apps/web/src/screens/Toasts.tsx`:
```tsx
import type { Toast } from '../useStation'

export function Toasts({ toasts }: { toasts: Toast[] }) {
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-4 z-30 flex flex-col items-center gap-2 px-4"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`max-w-md rounded-lg px-4 py-2 text-sm shadow-lg ${
            t.kind === 'error' ? 'bg-red-600 text-white' : 'bg-zinc-800 text-zinc-100'
          }`}
        >
          {t.text}
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 7: Write the app shell and entry**

`apps/web/src/App.tsx`:
```tsx
import { useState } from 'react'
import { Join } from './screens/Join'
import { Listeners } from './screens/Listeners'
import { NowPlaying } from './screens/NowPlaying'
import { Queue } from './screens/Queue'
import { Search } from './screens/Search'
import { Settings } from './screens/Settings'
import { Toasts } from './screens/Toasts'
import { useStation } from './useStation'

export function App() {
  const station = useStation()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const { state } = station

  if (!station.joined || !state) return <Join connected={station.connected} onJoin={station.join} />

  return (
    <div className="mx-auto flex min-h-dvh max-w-xl flex-col gap-5 p-4 pb-24">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Music Station</h1>
        <div className="flex items-center gap-2">
          {!station.connected && (
            <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-xs text-amber-300">Reconnecting…</span>
          )}
          <button onClick={() => setSettingsOpen(true)} className="rounded-lg bg-zinc-900 px-3 py-1.5 text-sm">
            Settings
          </button>
        </div>
      </header>

      {station.blocked && (
        <button onClick={station.resume} className="rounded-xl bg-amber-500 p-3 font-semibold text-zinc-950">
          Tap to resume audio
        </button>
      )}

      <NowPlaying current={state.current} playback={state.playback} serverNow={station.serverNow} send={station.send} />
      <Search send={station.send} notify={station.notify} />
      <Queue queue={state.queue} send={station.send} />
      <Listeners listeners={state.listeners} me={station.clientId} />

      {settingsOpen && (
        <Settings
          delayMs={station.delayMs}
          setDelayMs={station.setDelayMs}
          debug={station.debug}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      <Toasts toasts={station.toasts} />
    </div>
  )
}
```

`apps/web/src/main.tsx` (replaces the Task 10 version):
```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
```

- [ ] **Step 8: Typecheck, test and build**

Run: `pnpm --filter @music-station/web typecheck && pnpm --filter @music-station/web test && pnpm --filter @music-station/web build`
Expected: tsc exits 0, all web tests PASS (7 clock sync, 13 player, 14 format and storage), and Vite writes `apps/web/dist`.

- [ ] **Step 9: Check the UI in a browser**

Real songs need yt-dlp, which Task 13 provides in Docker. This step checks the UI against the built server, with `/usr/bin/false` standing in for yt-dlp.

Run:
```bash
pnpm --filter @music-station/server build
TMP_DATA=$(mktemp -d)
DATA_DIR=$TMP_DATA WEB_DIR=$PWD/apps/web/dist YTDLP_BIN=/usr/bin/false node apps/server/dist/index.js
```
Open `http://localhost:3000` in two browser windows (one of them private). Expected:
1. The Join screen shows. "Listen" is disabled until a nickname is typed.
2. After joining as `Minh` and `An`, both windows list both names, and an "An joined" toast appears in Minh's window.
3. Searching `rickrolling` shows a red search error toast, not "added".
4. Pasting `https://www.youtube.com/playlist?list=PL123` shows "That link has no YouTube video in it".
5. Pasting `https://youtu.be/dQw4w9WgXcQ` shows a red error toast from yt-dlp.
6. In Settings, set the delay to 120 ms, reload, rejoin, and open Settings again. It still shows 120 ms, and the round-trip time shows a number.
7. Reloading one window does not leave a duplicate name in the other window's list.

Stop the server with Ctrl+C (it logs `SIGINT received, saving and shutting down`), then `rm -rf $TMP_DATA`.

- [ ] **Step 10: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): add station hook and screens

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Docker, Tailscale Funnel and README

**Files:**
- Create: `docker/Dockerfile`, `docker/serve.json`, `docker-compose.yml`, `.dockerignore`, `.env.example`, `README.md`

**Interfaces:**
- Consumes:
  - Root `pnpm build` (Task 1), which runs the server tsup build (Task 9) and the web Vite build (Task 10).
  - `apps/server/dist/index.js` and `apps/server/dist/smoke.js` (Task 9).
  - The environment variables read by `loadConfig` (Task 5): `PORT`, `DATA_DIR`, `WEB_DIR`, `YTDLP_BIN`, `YTDLP_COOKIES`, `CACHE_MAX_GB`, `MAX_DURATION_MIN`.
- Produces: `docker compose up -d --build` starts the station at `https://music-station.<tailnet>.ts.net` and at `http://localhost:3000` on the Mac.

Nothing here has unit tests. Each file is checked by building or running it.

- [ ] **Step 1: Write the Dockerfile and `.dockerignore`**

`docker/Dockerfile`:
```dockerfile
# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim

ARG TARGETARCH

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg \
  && rm -rf /var/lib/apt/lists/*

# Current yt-dlp versions need a JavaScript runtime to read YouTube's player code.
COPY --from=denoland/deno:bin /deno /usr/local/bin/deno

# The standalone yt-dlp build for this CPU. It stays writable so `yt-dlp -U` can replace it.
RUN mkdir -p /opt/yt-dlp \
  && case "$TARGETARCH" in arm64) asset=yt-dlp_linux_aarch64 ;; *) asset=yt-dlp_linux ;; esac \
  && curl -fsSL -o /opt/yt-dlp/yt-dlp "https://github.com/yt-dlp/yt-dlp/releases/latest/download/$asset" \
  && chmod 755 /opt/yt-dlp/yt-dlp

RUN npm install -g pnpm@9.6.0

WORKDIR /app

# Install dependencies in their own layer so code changes do not reinstall them.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

ENV PORT=3000 \
    DATA_DIR=/data \
    WEB_DIR=/app/apps/web/dist \
    YTDLP_BIN=/opt/yt-dlp/yt-dlp

EXPOSE 3000
CMD ["node", "apps/server/dist/index.js"]
```

`.dockerignore`:
```
**/node_modules
**/dist
data
docs
.env
.git
*.log
.DS_Store
```

- [ ] **Step 2: Build the image and check the tools inside it**

Run: `docker build -f docker/Dockerfile -t music-station .`
Expected: the build finishes. The `pnpm build` layer prints tsup's `dist/index.js` and `dist/smoke.js` lines and Vite's `built in` line.

Run: `docker run --rm music-station sh -c 'ffmpeg -version | head -n 1; deno --version | head -n 1; /opt/yt-dlp/yt-dlp --version; /opt/yt-dlp/yt-dlp -v 2>&1 | grep -i "js runtimes"'`
Expected: four lines. They show the ffmpeg version, the deno version, a yt-dlp date version such as `2026.09.30`, and a `[debug] JS runtimes:` line that names `deno`. If the last line is missing or says `none`, yt-dlp cannot find Deno on the `PATH`, and YouTube downloads will fail.

- [ ] **Step 3: Run the container alone against real YouTube**

This checks the image without Tailscale, using host port 3001.

Run:
```bash
TEST_DATA=$PWD/data/docker-test
mkdir -p "$TEST_DATA"
docker run -d --name ms-test -p 3001:3000 -v "$TEST_DATA:/data" music-station
sleep 5
docker logs ms-test
curl -s http://localhost:3001/ | grep -c 'id="root"'
curl -s -o /dev/null -w '%{http_code}\n' 'http://localhost:3001/api/search?q=metronome'
docker exec ms-test node apps/server/dist/smoke.js "metronome 120 bpm"
```
Expected:
- The log shows a yt-dlp update line (`Updating to …` or `yt-dlp is up to date …`) and `Music station listening on port 3000`.
- The first curl prints `1`, so the web UI is served.
- The second curl prints `200`, so a real search went through yt-dlp.
- The smoke script prints `search …`, `info …`, `download: … MB in …s`, then `smoke OK`.

If the smoke script fails with `YouTube bot check hit`, follow the cookies section of the README from Step 6. This is a YouTube-side block, not a bug in the image.

Then run:
```bash
docker stop ms-test
docker logs ms-test | tail -n 2
cat "$TEST_DATA/station.json"
docker rm ms-test
rm -rf "$TEST_DATA"
```
Expected: `docker stop` returns within a few seconds, the log ends with `SIGTERM received, saving and shutting down`, and `station.json` contains `"version":1`.

- [ ] **Step 4: Write the Tailscale serve config, Compose file and `.env.example`**

`docker/serve.json` (the Tailscale container replaces `${TS_CERT_DOMAIN}` with the node's `music-station.<tailnet>.ts.net` name):
```json
{
  "TCP": { "443": { "HTTPS": true } },
  "Web": {
    "${TS_CERT_DOMAIN}:443": {
      "Handlers": { "/": { "Proxy": "http://127.0.0.1:3000" } }
    }
  },
  "AllowFunnel": { "${TS_CERT_DOMAIN}:443": true }
}
```

`docker-compose.yml`:
```yaml
services:
  tailscale:
    image: tailscale/tailscale:latest
    environment:
      TS_AUTHKEY: ${TS_AUTHKEY:?Set TS_AUTHKEY in .env}
      TS_HOSTNAME: music-station
      TS_STATE_DIR: /var/lib/tailscale
      TS_SERVE_CONFIG: /config/serve.json
      TS_USERSPACE: "true"
    volumes:
      - ./data/tailscale:/var/lib/tailscale
      - ./docker/serve.json:/config/serve.json:ro
    ports:
      # The app shares this container's network, so its port is published here.
      - "3000:3000"
    restart: unless-stopped

  app:
    build:
      context: .
      dockerfile: docker/Dockerfile
    init: true
    network_mode: service:tailscale
    depends_on:
      - tailscale
    environment:
      CACHE_MAX_GB: ${CACHE_MAX_GB:-2}
      MAX_DURATION_MIN: ${MAX_DURATION_MIN:-60}
      YTDLP_COOKIES: ${YTDLP_COOKIES:-}
    volumes:
      - ./data/app:/data
    restart: unless-stopped
```

`.env.example`:
```
# Required. Create one at https://login.tailscale.com/admin/settings/keys
TS_AUTHKEY=

# Soft cap for downloaded audio, in GB.
CACHE_MAX_GB=2

# Videos longer than this many minutes are rejected.
MAX_DURATION_MIN=60

# Optional. Path inside the container to a cookies file, for example /data/cookies.txt
YTDLP_COOKIES=
```

- [ ] **Step 5: Validate the Compose file**

Run: `TS_AUTHKEY=test docker compose config --quiet && echo valid`
Expected: `valid`.

Run: `env -u TS_AUTHKEY docker compose config --quiet`
Expected: it fails with `Set TS_AUTHKEY in .env` (this assumes there is no `.env` file yet).

- [ ] **Step 6: Write the README**

`README.md`:
````markdown
# Music Station

Open one link, add songs to one shared queue, and everyone hears the same song at the same moment. The server downloads audio from YouTube with yt-dlp, and each browser keeps its player aligned with the server clock.

## What you need

- A Mac with Docker Desktop or OrbStack.
- A Tailscale account. The free plan is enough.

## One-time Tailscale setup

1. In the Tailscale admin console, open **DNS** and turn on **MagicDNS** and **HTTPS Certificates**.
2. Open **Access controls** and allow Funnel by adding this entry to the policy file. If the file already has `nodeAttrs`, add the entry to that list.
   ```json
   "nodeAttrs": [
     { "target": ["autogroup:member"], "attr": ["funnel"] }
   ]
   ```
3. Open **Settings → Keys** and generate an auth key. If your tailnet requires device approval, tick **Pre-approved**.

## Start the station

```bash
cp .env.example .env    # then paste the auth key after TS_AUTHKEY=
docker compose up -d --build
docker compose exec tailscale tailscale funnel status
```

The last command prints the public link, `https://music-station.<your-tailnet>.ts.net`. Send it to your friends. The first visit can take up to a minute while Tailscale gets a certificate.

On the Mac you can also use `http://localhost:3000`, and devices on your Wi-Fi can use `http://<mac-ip>:3000`.

The auth key is only used for the first login. The login is then kept in `data/tailscale`, so it does not matter if the key expires later.

If the link says `music-station-1`, an old device named `music-station` still exists. Remove it in the admin console, then run `docker compose restart tailscale`.

### Keep the Mac awake

Docker does not stop the Mac from sleeping. While the station is on, run this in a terminal and leave it open:

```bash
caffeinate -s
```

This only works while the Mac is plugged in, and closing the lid still puts it to sleep.

### Everyday commands

| Task | Command |
|---|---|
| Follow the app log | `docker compose logs -f app` |
| Stop | `docker compose down` |
| Rebuild after changing the code | `docker compose up -d --build` |
| Check yt-dlp against YouTube | `docker compose exec app node apps/server/dist/smoke.js "metronome 120 bpm"` |

yt-dlp updates itself when the app starts and every 24 hours. `docker compose restart app` forces an update.

## Settings (`.env`)

| Variable | Default | Purpose |
|---|---|---|
| `TS_AUTHKEY` | required | Tailscale auth key |
| `CACHE_MAX_GB` | `2` | Soft cap for downloaded audio. The oldest songs that are not playing or queued are deleted first. |
| `MAX_DURATION_MIN` | `60` | Longer videos are rejected |
| `YTDLP_COOKIES` | unset | Path inside the container to a cookies file. See below. |

The app keeps everything in `data/app`: audio files in `cache/` and the queue in `station.json`. To free space, stop the station and delete `data/app/cache`.

## If YouTube asks "Sign in to confirm you're not a bot"

The app log then shows `YouTube bot check hit`, and songs fail to add. Try these in order:

1. Run `docker compose restart app` to update yt-dlp.
2. Wait an hour. These blocks usually lift on their own.
3. Use cookies from a spare Google account, not your main one, because YouTube can flag an account used this way.
   1. Sign in to YouTube with the spare account in a private browser window.
   2. Export the YouTube cookies in Netscape format with a cookies.txt browser extension. Save the file as `data/app/cookies.txt`.
   3. Close the private window, so the browser does not rotate those cookies.
   4. Set `YTDLP_COOKIES=/data/cookies.txt` in `.env` and run `docker compose up -d`.

## Checking sync

1. Open the station on a laptop and two phones in the same room. Search for "metronome 120 bpm" and add a result.
2. Listen. One clean tick means the devices are in sync. Doubled or smeared ticks mean they are not.
3. Open **Settings** on each device. After a few seconds, **Drift** should stay within about ±30 ms.
4. On a device that plays through a Bluetooth speaker, raise **Speaker delay** until its ticks line up with the others.

If a device shows **Tap to resume audio**, its browser blocked playback. Tap the button once.

## Development

```bash
brew install yt-dlp deno ffmpeg
pnpm install
pnpm --filter @music-station/server dev    # API on http://localhost:3000, data in apps/server/data
pnpm --filter @music-station/web dev       # UI on http://localhost:5173
```

Run the two `dev` commands in separate terminals and open http://localhost:5173. The Homebrew yt-dlp cannot update itself, so the server logs `yt-dlp update failed` at start. Update it with `brew upgrade yt-dlp` instead.

| Task | Command |
|---|---|
| Unit and integration tests | `pnpm test` |
| Typecheck | `pnpm typecheck` |
| Production build | `pnpm build` |
| yt-dlp smoke check | `pnpm build && node apps/server/dist/smoke.js` |

## Known limits

- A locked iPhone may not start the next song by itself. Unlock it and tap **Tap to resume audio**.
- yt-dlp breaks when YouTube changes something. The daily update usually brings a fix within a day or two.
````

- [ ] **Step 7: Run the whole station with Tailscale**

This needs the user's tailnet, so it is a manual check. Finish the README's one-time Tailscale setup first.

Run:
```bash
cp .env.example .env    # paste the auth key after TS_AUTHKEY=
docker compose up -d --build
docker compose ps
docker compose exec tailscale tailscale funnel status
```
Expected: both services are `running`, and the funnel status lists `https://music-station.<tailnet>.ts.net` with `Funnel on` and a proxy to `http://127.0.0.1:3000`.

Then check by hand:
1. On a phone with Wi-Fi turned off, open the public link. The Join screen loads over mobile data.
2. Join on the phone and on the Mac (`http://localhost:3000`). Search for "metronome 120 bpm" and add a result. The queue item shows a spinner, then the song starts on both devices about 1 s after the download finishes.
3. Do the README's "Checking sync" steps with a laptop and two phones. Drift stays within about ±30 ms.
4. While the song plays, run `docker compose restart app`. Every device reconnects and shows the song paused within about 5 s of where it was. Pressing Play resumes it everywhere.
5. Run `docker compose down`. `data/app/station.json` and `data/app/cache/<videoId>.m4a` are still there.

- [ ] **Step 8: Commit**

```bash
git add docker docker-compose.yml .dockerignore .env.example README.md
git commit -m "chore: add Docker Compose setup with Tailscale Funnel and README

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
