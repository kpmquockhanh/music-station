# Music Station — Design

**Date:** 2026-10-06
**Status:** Draft, awaiting review

## 1. Goal

A web app where a group of friends listens to the same music at the same moment. Anyone with the station link can search YouTube, add songs to one shared queue, and control playback. Every device plays the same song at the same position, whether listeners are in one room or in different places.

**Success criteria**

- Friends open one link on their phones, enter a nickname, and hear music within a few seconds of tapping "Listen".
- Devices playing through their own speakers stay within ~50 ms of each other on Wi-Fi.
- Someone who joins mid-song starts at the correct position.
- Any listener can search, add, remove, reorder, play, pause, seek, and skip.

## 2. Key decisions

| Decision | Choice | Rejected alternatives |
|---|---|---|
| How audio reaches listeners | The server downloads each song with yt-dlp and caches it as a file. Every device plays the file and stays in step using a shared server clock. | YouTube embedded player sync (ads, embedding-disabled videos, ~100–300 ms sync). Live radio stream (listeners 2–10 s apart). Host tab capture over WebRTC (host laptop and tab must stay open). |
| Where the server runs | The user's Mac, in Docker | Cloud hosts: YouTube blocks yt-dlp from datacenter IPs. |
| Public access | Tailscale Funnel sidecar container (fixed free https URL) | Cloudflare quick tunnel (URL changes on every restart). Named Cloudflare tunnel (needs a domain). |
| Rooms | One permanent station | Multiple rooms |
| Permissions | Everyone controls everything. Every control action is announced to all listeners. | Host passcode; station password |
| Accounts | None. Nickname only. | — |
| YouTube Premium | Not used. Downloads run without account cookies. An optional cookies file can be mounted as an escape hatch. | Using the Premium account's cookies (only gains 256 kbps, and the account risks a ban) |

## 3. Scope

### MVP features

1. **Join**: open the link, enter a nickname, tap "Listen" (this also unlocks browser audio).
2. **Search**: type a query and see the top 10 YouTube results. No API key needed.
3. **Add by link**: paste a youtube.com, youtu.be, or music.youtube.com video link.
4. **Shared queue**: add, remove, move up or down; songs auto-advance.
5. **Synced playback**: play, pause, seek, and skip reach every device. Late joiners land at the right position.
6. **Listener list**: who is connected.
7. **Activity notices**: "Minh skipped *Blinding Lights*" shown to everyone.
8. **Per-device delay slider** (0–500 ms) to compensate for Bluetooth speakers.
9. **Debug panel**: drift, clock offset, and round-trip time for this device.
10. **Restart recovery**: queue and position survive a server restart.

### Out of scope

Accounts, multiple rooms, chat, voting, playlist import, native apps, gapless transitions, horizontal scaling.

## 4. Architecture

```
 Friends' phones / laptops (browser)
              │  https://music-station.<tailnet>.ts.net
              ▼
┌──────────── user's Mac · docker compose ───────────┐
│  tailscale (sidecar) ── Funnel: public https ──┐   │
│                                                ▼   │
│  app  (one Node 22 process, port 3000)             │
│   ├─ web UI         built React files              │
│   ├─ Socket.IO      station state, controls, clock │
│   ├─ /audio/:id.m4a audio files, Range support     │
│   ├─ /api/search    YouTube search                 │
│   └─ yt-dlp + Deno + ffmpeg ──► YouTube            │
│                                                    │
│  volume ./data   (cache/ + station.json)           │
└────────────────────────────────────────────────────┘
```

### Containers

- **app**: built from `node:22-bookworm-slim`. It includes ffmpeg, Deno (current yt-dlp versions need a JS runtime for YouTube), and the standalone yt-dlp Linux binary for the container's architecture (arm64 on Apple Silicon). The binary must be writable so `yt-dlp -U` can update it. yt-dlp updates on container start and every 24 h. The container uses `network_mode: service:tailscale`.
- **tailscale**: `tailscale/tailscale` image with `TS_HOSTNAME=music-station`. A `TS_SERVE_CONFIG` proxies public port 443 to `127.0.0.1:3000` with Funnel enabled. It also publishes port 3000 to the Mac for local and LAN access.

### Configuration (`.env`)

| Variable | Default | Purpose |
|---|---|---|
| `TS_AUTHKEY` | — (required) | Tailscale auth key |
| `CACHE_MAX_GB` | `2` | Soft cap for the audio cache |
| `MAX_DURATION_MIN` | `60` | Reject longer videos |
| `YTDLP_COOKIES` | unset | Optional path to a mounted cookies.txt |

### Operations

- The Mac needs Docker Desktop or OrbStack.
- Docker does not keep the Mac awake. Run `caffeinate -s` while the station is on.
- One-time Tailscale setup: create an auth key and allow Funnel for the node in the admin policy.

## 5. Code layout

pnpm monorepo, TypeScript throughout.

```
packages/shared/      types, event schemas (zod), sync math (pure)
apps/server/          Fastify + Socket.IO
  src/station.ts      station state machine (pure, `now` injected)
  src/youtube.ts      yt-dlp wrapper: search, getInfo, download
  src/cache.ts        audio cache folder: ensure, touch, evict
  src/persist.ts      load/save data/station.json
  src/realtime.ts     Socket.IO handlers → station → broadcast
  src/http.ts         /audio, /api/search, static web UI
  src/index.ts        wiring, tick loop, startup
apps/web/             React + Vite + Tailwind
  src/clockSync.ts    server clock offset
  src/player.ts       <audio> wrapper with drift correction
  src/useStation.ts   Socket.IO connection + state hook
  src/screens/        Join, NowPlaying, Queue, Search, Listeners, Settings
docker/               Dockerfile, serve.json
docker-compose.yml
```

### Module contracts

**`station.ts`** holds state only and does no I/O. All time-dependent methods take `now` (server ms).

```ts
class Station {
  join(listenerId: string, nickname: string): void
  leave(listenerId: string): void
  add(item: QueueItem, now: number): void      // if idle, item becomes current
  remove(itemId: string): void                 // upcoming items only
  move(itemId: string, toIndex: number): void
  play(now: number): void
  pause(now: number): void
  seek(position: number, now: number): void
  skip(now: number): void
  markReady(videoId: string, now: number): void
  markFailed(videoId: string): void
  tick(now: number): void                      // auto-advance when the song ends
  snapshot(): StationState
  restore(saved: StationState): void           // playback restored as paused
}
```

**`youtube.ts`** spawns yt-dlp with an argument array, never a shell, and always passes `--` before the URL or search term.

```ts
search(query: string): Promise<SearchResult[]>     // ytsearch10, --flat-playlist; 15 s timeout
getInfo(videoId: string): Promise<VideoInfo>       // --dump-json --no-playlist; 20 s timeout
download(videoId: string, destPath: string): Promise<void>
  // -f "140/bestaudio[ext=m4a]/bestaudio" -x --audio-format m4a; 120 s timeout
```

`getInfo` rejects livestreams (`live_status` is `is_live` or `is_upcoming`) and videos longer than `MAX_DURATION_MIN`.

**`cache.ts`**

```ts
ensure(videoId: string): Promise<string>  // dedupes in-flight downloads; max 2 concurrent
has(videoId: string): boolean
touch(videoId: string): void              // sets mtime; called when a song becomes current
evict(protectedIds: Set<string>): void    // deletes oldest mtime first until under the cap
```

Downloads go to `data/cache/.tmp/` and are renamed to `data/cache/<videoId>.m4a` only when complete. On startup the cache deletes `.tmp/` contents and indexes existing files. Eviction runs after each download and never deletes the current song or queued songs. The cap is soft: it can be exceeded if all files are protected.

## 6. State and protocol

### State (`packages/shared`)

```ts
type QueueItemStatus = 'downloading' | 'ready' | 'failed'

interface QueueItem {
  id: string            // uuid; one video can be queued more than once
  videoId: string       // /^[A-Za-z0-9_-]{11}$/
  title: string
  channel: string
  duration: number      // seconds
  thumbnail: string
  addedBy: string       // nickname
  status: QueueItemStatus
}

interface Playback {
  status: 'playing' | 'paused' | 'waiting'   // waiting = current song still downloading
  position: number      // seconds into the song…
  at: number            // …at this server time (ms)
}

interface StationState {
  current: QueueItem | null                  // null = idle
  queue: QueueItem[]                         // upcoming, in order (max 200)
  playback: Playback
  listeners: { id: string; nickname: string }[]
}
```

While playing, the expected position is `position + (serverNow − at) / 1000`.

### Socket.IO events

Every client → server event takes an optional ack callback `({ ok: true } | { ok: false, error: string })`. Payloads are validated with zod schemas from `packages/shared`.

| Client → server | Payload |
|---|---|
| `join` | `{ clientId: uuid, nickname: 1–24 chars, trimmed }` |
| `queue:add` | `{ input: string }` (a URL or an 11-char video ID) |
| `queue:remove` | `{ itemId }` |
| `queue:move` | `{ itemId, toIndex }` |
| `player:play` / `player:pause` / `player:skip` | `{}` |
| `player:seek` | `{ position: number }` |
| `time:ping` | `t0` (the ack returns the server time `ts`) |

| Server → client | Payload |
|---|---|
| `state` | full `StationState`, sent after every change |
| `activity` | `{ text: string, at: number }` |

`clientId` is a uuid stored in the browser's localStorage. It is the listener's ID, so a reconnecting device is the same listener.

### HTTP

| Route | Behavior |
|---|---|
| `GET /api/search?q=` | Top 10 results. Identical queries cached for 10 min (LRU, 100 entries). Max 2 concurrent yt-dlp searches. Rate limit: 30 requests/min per IP. |
| `GET /audio/:videoId.m4a` | Served from the cache with Range support (`@fastify/static`). 404 if not downloaded. `Cache-Control: public, max-age=86400, immutable`. |
| `GET /*` | Built web UI |

## 7. Station rules

- **Add**: `getInfo` validates the video, and the item is appended with status `downloading` (or `ready` if the file is already cached). `cache.ensure` starts. If the station is idle, the item becomes `current`: it plays at `now + START_LEAD_MS` if ready, otherwise playback is `waiting`.
- **Download finishes**: the item is marked `ready`. If it is `current` and playback is `waiting`, playback becomes `playing` from 0 with `at = now + START_LEAD_MS`.
- **Download fails** after one retry: the item is marked `failed` and stays in the queue (shown red, removable). An activity notice is sent. If it is `current`, the station advances.
- **Advance** (song ended, skip, or current failed): the previous `current` is dropped, and the first non-failed item moves from `queue` to `current`. If it is ready, it plays from 0 at `now + START_LEAD_MS`; otherwise playback is `waiting`. If no such item exists, the station goes idle. Failed items stay in the queue until someone removes them.
- **Play**: only when current is ready and paused; `at = now + START_LEAD_MS`. Otherwise it is rejected with an error ack.
- **Pause**: stores the expected position. Pausing while `waiting` sets `paused`, so the song does not auto-start when its download finishes.
- **Seek**: clamps to `[0, duration]`. If playing, `at = now + START_LEAD_MS`; if paused, only `position` changes.
- **Song end**: `tick(now)` runs every 250 ms and advances when the expected position ≥ duration. This leaves a gap of about 1 s between songs, which is accepted for the MVP.
- **Activity**: every control action and every failure produces a notice naming the listener.
- **Rate limit**: each socket can send at most one control or queue action every 500 ms; extra actions get `{ ok: false }`.
- **Listener leave**: a disconnected listener is removed after a 10 s grace period unless the same `clientId` rejoins.
- **Persistence**: the snapshot (without listeners) is written to `data/station.json` 1 s after each change, via a temporary file and rename. On start it is restored with playback `paused`, and downloads restart for any item not in the cache.

Constant: `START_LEAD_MS = 1000`.

## 8. Client sync

**Clock offset.** On connect the device sends 8 `time:ping`s, 100 ms apart. For each it computes `offset = ts − (t0 + t1) / 2` and keeps the sample with the smallest round-trip time. This repeats every 30 s, after reconnect, and when the tab becomes visible again. `serverNow = performance.timeOrigin + performance.now() + offset`.

**Target position.** `target = position + (serverNow − at) / 1000 + delayMs / 1000`, where `delayMs` is the device's slider value (stored in localStorage).

**Correction loop** (every 250 ms while playing):

| `drift = audio.currentTime − target` | Action |
|---|---|
| \|drift\| < 30 ms | `playbackRate = 1` |
| 30–300 ms | `playbackRate = drift > 0 ? 0.97 : 1.03` (pitch preserved) |
| > 300 ms | set `currentTime = target`, `playbackRate = 1` |

- **Before the start time:** while `serverNow + delayMs < at`, the element stays paused at `position`, and a timer calls `play()` when that stops being true.
- **Pause:** pause the element and set `currentTime = position`.
- **New song:** set `src` to `/audio/<videoId>.m4a`, wait for `canplay`, then align.
- **Buffering:** a device that stalls catches up with a jump when it recovers; nobody else waits.
- **Blocked playback:** if `play()` is rejected (autoplay policy), show a "Tap to resume" banner.

## 9. UI

A single mobile-first page.

- **Join**: nickname input and a "Listen" button.
- **Now playing**: thumbnail, title, channel, progress bar (drag to seek), play/pause, skip. Shows "Loading…" while `waiting`.
- **Queue**: items with status badges (downloading spinner, failed in red), move up/down buttons, remove.
- **Search**: input that accepts a query or a pasted link; results with "Add".
- **Listeners**: count and nicknames.
- **Activity**: toasts for notices.
- **Settings sheet**: delay slider and debug panel (drift, offset, RTT).

## 10. Failure handling

| Situation | Behavior |
|---|---|
| Download fails (removed, age-restricted, region-blocked) | One retry. Then marked failed, skipped, and announced. |
| YouTube bot check ("Sign in to confirm you're not a bot") | Logged with a clear message. Remedy: update yt-dlp, wait, or mount a cookies file from a throwaway account. |
| Livestream or video over the length limit | Rejected on add with an error message. |
| Playlist link | Only the video in the link is added. |
| Conflicting controls | Handled in arrival order; the last one wins; everyone gets the new state. |
| Connection drop | Socket.IO reconnects, the device rejoins with the same `clientId`, re-measures the clock, and realigns. |
| Phone locked or tab in background | On `visibilitychange` to visible: re-measure the clock and realign. |
| Server restart | State restored from `station.json`, paused. |
| yt-dlp timeout | Process killed; counts as a failed attempt. |

## 11. Security

- All socket payloads are validated with zod. Invalid payloads are rejected with an error ack.
- Video IDs must match `/^[A-Za-z0-9_-]{11}$/`. URLs are parsed and only the ID is used. yt-dlp always receives a URL rebuilt from a validated ID.
- yt-dlp is spawned with an argument array and `--`, never through a shell.
- Nicknames: 1–24 characters, trimmed, rendered as text (no HTML).
- Rate limits: as specified in sections 6 and 7. Queue length is capped at 200.

## 12. Testing

- **Unit (Vitest)**:
  - `station`: every action, auto-advance, waiting → playing, failed items, restore
  - sync math: target position, drift decision
  - clock offset selection
  - `cache`: eviction order, protected IDs, in-flight dedupe, using a temp dir and a fake downloader
  - URL parsing and video ID validation
- **Integration**: a real server with a fake `youtube` module that serves a short fixture `.m4a`, plus two Socket.IO clients. Check that both receive identical state after join, add, and play, and that `/audio` returns `206` for a Range request.
- **Manual sync check**: laptop plus two phones playing a metronome video, checked with the debug panel. Doubled ticks mean the devices are out of sync.
- **yt-dlp smoke script**: downloads one short known video. Run by hand, not in CI.

## 13. Known risks

- Auto-advancing to the next song while an iPhone is locked may fail. Needs testing on a real device.
- yt-dlp breaks when YouTube changes. Daily self-update reduces this but can't prevent it.
- Heavy use can trigger YouTube bot checks even from a home IP.
- Tailscale Funnel's bandwidth limits are not published. Audio at ~1 MB per minute per listener should stay well within them.
- Bluetooth output latency must be calibrated by hand with the delay slider.
