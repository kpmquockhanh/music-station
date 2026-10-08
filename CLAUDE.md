# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A shared listening station. Everyone opens one link and adds songs to one queue, and every device plays the same song at the same moment. The server downloads YouTube audio with yt-dlp and owns the playback clock, and each browser steers its own `<audio>` to match. It runs on a Raspberry Pi in Docker and is reachable from the internet through a Cloudflare Tunnel. There is also an Electron desktop app.

## Commands

pnpm workspace (`pnpm@9.6.0`, Node ≥ 22). Package names: `@music-station/server`, `@music-station/web`, `@music-station/shared`, `@music-station/desktop`.

```bash
pnpm install
pnpm test                 # vitest in every package
pnpm typecheck            # tsc in every package
pnpm build                # server (tsup), web (vite), desktop (esbuild)

pnpm --filter @music-station/server dev   # API + socket.io on :3000, data in apps/server/data
pnpm --filter @music-station/web dev      # UI on :5173, proxies /api, /audio, /socket.io to :3000

# One test file, or one test by name
pnpm --filter @music-station/server exec vitest run src/station.test.ts
pnpm --filter @music-station/web exec vitest run -t "startupJoin"

STATION_URL=http://localhost:5173 pnpm --filter @music-station/desktop dev   # app against the local UI
pnpm --filter @music-station/desktop dist                                     # installer into apps/desktop/release/
pnpm build && node apps/server/dist/smoke.js "metronome 120 bpm"              # real yt-dlp check
```

Local dev needs `yt-dlp`, `deno` and `ffmpeg` on the PATH (`brew install yt-dlp deno ffmpeg`). Tests need none of them: they pass fake YouTube functions, and `apps/server/test/integration.test.ts` serves the fixture `test/fixtures/tone.m4a`.

Deploy: `docker compose up -d --build` on the Pi, or `scripts/deploy-pi.sh [--env]`, which builds the arm64 image on your computer and ships it over SSH. Desktop installers are built locally and attached to a GitHub release by hand. There are no GitHub Actions workflows, and none should be added.

## Architecture

**`packages/shared`** ships TypeScript source, not a build. The server's tsup bundles it (`noExternal`), and Vite and esbuild compile it directly. It holds the types (`StationState`, `QueueItem`, `Playback`), the zod schemas for every socket payload, the desktop bridge contract (`desktop.ts`), and the sync math (`sync.ts`). Both sides must share `songEndsAt`, `expectedPosition` and `decideCorrection`.

**Playback model.** `Playback` is `{ status, position, at }`: "`position` seconds into the song at server time `at`". Devices work out where the song should be from that, rather than receiving a stream of positions. `status: 'waiting'` means the current song is still downloading. The next song starts exactly at `songEndsAt`, so a device that preloaded it switches on its own and the server's later update changes nothing.

**Server (`apps/server`)**, Fastify + socket.io, wired up in `app.ts`:
- `Station` (`station.ts`) is the pure, synchronous state machine: queue, current song, playback, listeners, autoplay history. It throws `StationError` for user-facing rejections.
- `StationService` (`service.ts`) wraps it with the side effects: yt-dlp info lookups, downloads through `AudioCache`, autoplay of related songs, and `onChange`/`onActivity` callbacks. `tick()` runs every 250 ms to hand off songs.
- `realtime.ts` maps socket events to service calls. Every action (`queue:add|remove|move`, `player:play|pause|skip|seek`, `station:autoplay`) goes through `action()`, which checks for a join, rate-limits to one per 500 ms, validates against the shared zod schema, and replies `Ack`. Every change broadcasts the whole `state`. Listeners are keyed by a client UUID with a per-tab socket count, and they leave after a 10 s grace period. `time:ping` drives the client clock sync. `hello { webVersion }` makes open pages reload after a deploy.
- `http.ts`: `/api/search` (30/min per IP, using `CLIENT_IP_HEADER` behind Cloudflare), `/audio/<videoId>.m4a` from the cache, and the built web UI when `WEB_DIR` is set.
- `youtube.ts` builds yt-dlp/ffmpeg argument lists and parses their output, and `process.ts` runs them with timeouts and kills the whole process tree. AAC sources are copied as they are, because re-encoding adds clicks. `cache.ts` evicts the oldest files that are not playing or queued, above `CACHE_MAX_GB`. `persist.ts` debounces saves of `station.json` and also saves every 5 s while playing, so a crash loses little.
- Config comes from env vars (`config.ts`): `PORT`, `DATA_DIR`, `WEB_DIR`, `YTDLP_BIN`, `YTDLP_COOKIES`, `CACHE_MAX_GB`, `MAX_DURATION_MIN`, `CLIENT_IP_HEADER`, `SYNC_LOG`.

**Web (`apps/web`)**, React + Tailwind v4, with no router:
- `useStation.ts` is the single hook that owns the socket, the state, toasts, joining (including `startupJoin` to skip the Join screen) and the player.
- `clockSync.ts` estimates the server-clock offset from `time:ping` round trips. `player.ts` (`SyncPlayer`) runs two audio "decks" so the next song preloads. It corrects drift by changing the playback rate and seeks only for large errors. It has many browser-specific workarounds, such as Firefox's jittery `currentTime` and iOS's stall after a seek. iOS gets a fixed rate. Read the comments there before changing any constant.
- `mediaSession.ts` handles media keys: Pause stops this device only, and Next skips for everyone.
- Logic lives in plain `.ts` modules with injected fakes (`AudioLike`, `SessionLike`, `fetchFn`). The `screens/*.tsx` components are thin and untested.

**Desktop (`apps/desktop`)**, Electron, loads the remote station URL. The UI ships with server deploys, so a new installer is only needed for changes to the app itself.
- `preload.ts` exposes `window.desktop` (a `DesktopBridge`) to the remote page. Every bridge function is optional, and the page checks for each before calling it, because page and app versions drift apart. Add new bridge features as optional functions.
- The remote page is untrusted. `main.ts` checks the sender of every IPC message: `desktop:*` comes only from the station page's webContents, and `local:*` only from the app's own `pages/*.html` (`isLocalPage` in `navigation.ts`, where new local pages must be added). `navigationFor` keeps the window on the station's origin and opens other links in the browser.
- The Mac menu-bar card (`pages/card.html`) never talks to the station directly. It asks the main process, which forwards to the station page through `desktop:request`, and the page answers with `desktop:reply`, with a 30 s timeout.
- `trayMenu.ts` holds the pure, tested logic for the menu, the card and parsing. Keep Electron calls in `main.ts`.
- `scripts/cdp.mjs` evaluates JS in a running app over DevTools, for launch tests.

## Conventions

- Design specs and implementation plans are in `docs/superpowers/specs/` and `docs/superpowers/plans/`. When a behaviour change touches the desktop app, update `2026-10-07-desktop-app-design.md` to match, as earlier commits do.
- User-facing text, README and code comments use short, plain sentences that say what happens, not how. Comments explain *why* a non-obvious choice was made. Match that tone.
- Commits are Conventional Commits with a scope, such as `feat(desktop): …` or `fix(desktop): …`, and the subject says what the user gets. Work is committed straight to `main`.
