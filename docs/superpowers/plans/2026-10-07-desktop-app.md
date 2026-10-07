# Music Station Desktop App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Mac and Windows app that opens the station's page in its own window, joins and plays without a click, keeps sync while hidden, and adds a menu-bar/tray menu, media keys, a Change station window and an offline page.

**Architecture:** An Electron shell (`apps/desktop`) loads the station URL from the server; the React UI stays as it is inside the window. The page and the main process talk only through a two-function preload bridge (`window.desktop`). The web app gains a Media Session hook, a desktop-bridge hook, automatic join inside the app, and `SyncPlayer.pauseHere()`. esbuild bundles the main and preload scripts, electron-builder packages them, and GitHub Actions attaches the installers to a draft release.

**Tech Stack:** Electron 44.6.0, electron-builder 26, esbuild 0.28, @resvg/resvg-js 2.6 (icon rendering), TypeScript 5.6, vitest 3, React 19, pnpm 9.6 workspace, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-07-desktop-app-design.md`

## Global Constraints

- Default station `https://music.devxdev.site`, changeable in the app.
- Mac: one universal build (Apple Silicon and Intel), `.dmg`, ad-hoc signed. Windows: x64 NSIS one-click `.exe`, installed per user without admin rights.
- Unsigned: no Apple Developer ID, no Windows certificate, no notarisation.
- No app auto-update. The UI updates with every server deploy.
- Main window: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `backgroundThrottling: false`. Switch `autoplay-policy=no-user-gesture-required`.
- `electron`, `electron-builder` and `esbuild` are devDependencies only. Pin `electron` to exactly `44.6.0`.
- Every bridge function is optional, and the web code checks each one before calling it.
- Media keys: Pause stops this device only, Play rejoins at the shared position, Next skips for everyone.
- Tray labels, exactly: "Nothing playing", "Pause for everyone", "Play for everyone", "Skip for everyone", "Show window", "Change station…", "Quit".
- The "Tap to resume audio" banner is unchanged.
- Release tags are `desktop-v<version>` and must match `apps/desktop/package.json`. Push tags and publish the draft only when the owner asks.
- Tests stay silent: launch the app only with `MUSIC_STATION_MUTED=1`. Never play sound aloud.
- Commit only after the owner agrees in Task 0. Never push, tag or publish.
- Out of scope: signing, notarisation, auto-update, Linux, launch at login, running the server in the app, an offline UI, remembering window size and position, song-change notifications.
- Node ≥ 22, pnpm 9.6.0.

## Review Focus

1. **Pressing the pause key during a song change.** The old song is playing out while the new one waits for its start, and Pause is pressed. Expected: both songs stay silent, and the banner shows once. Tested in Task 1 (spare-deck test).
2. **Messy or hostile station addresses** in Change station or a hand-edited `settings.json`, such as spaces, paths, `javascript:`, `file:`, `ftp:`, ports, `999.1.1.1` or a corrupt file. Expected: a clean origin, or a clear error and the default station; never a crash. Tested in Task 5.
3. **Malformed `nowPlaying` messages from the remote page**, such as wrong types, missing fields, unknown statuses, extra fields, newlines, 500-character titles, emoji, or `&` in a title. Expected: "Nothing playing", or a one-line label that keeps its `&`; never a throw. Tested in Task 7.
4. **Lookalike origins**, such as `music.devxdev.site.evil.example`, `music.devxdev.site@evil.example`, `http://` instead of `https://`, or another port. Expected: they open in the browser and never in the window. Tested in Task 6.
5. **Unknown commands and unsupported actions.** A tray command the page doesn't know (`toString`, `seek`), or a browser that throws for one Media Session action. Expected: the unknown command is ignored, and the other handlers are still set. Tested in Task 2 and Task 3.

## Deviations from the spec (decided while planning)

1. **Shared types.** `NowPlaying`, `DesktopCommand` and `DesktopBridge` live in `packages/shared/src/desktop.ts`, so the web app and the desktop app use one definition. Their shape matches spec §5. `NowPlaying.status` is `Playback['status']`.
2. **Tray icons** live in `apps/desktop/assets/`, not `build/`, because electron-builder doesn't package `build/` (its buildResources folder). Each icon also gets an `@2x` variant.
3. **Local page actions.** The local pages get three actions: `retry`, `changeStation` (for the offline page's button) and `saveStation`. `retry` first asks the station with a `HEAD` request and loads the page only if the station answers, so the offline page doesn't flash a failed load every 10 s.
4. **5xx means offline.** A main-frame HTTP status of 500 or more also shows the offline page. Cloudflare answers 502 or 530 while the station's computer is off, and that answer isn't a load failure.
5. **No Join-screen flash.** `Station.autoJoining` shows a small "Joining the station…" screen instead of the Join screen while the automatic join runs. This also applies to a browser tab rejoining after an update.
6. **Test switches.** `MUSIC_STATION_PROFILE=<dir>` points the app at a throwaway profile. `STATION_URL` works in the packaged app too. Both are for launch tests.
7. **Menu separators.** `TrayItem` gains a `{ separator: true }` variant.
8. **`&` in menu labels.** Electron reads `&` as a shortcut marker on Mac as well as Windows: `FixUpWindowsStyleLabel` in `electron_menu_controller.mm`. So every label escapes `&` as `&&`.
9. **Windows shutdown.** `query-session-end` lets Windows shut down. Otherwise the close-hides-the-window handler would hold it up.
10. **Launch test target.** The launch test runs the app against the Vite dev server (port 5173, which proxies to the running station), so testing doesn't need a deploy of the public site. The tray-menu screenshot in spec §10 becomes an owner check, because opening a menu-bar menu needs accessibility permission.

## File structure

```
packages/shared/src/desktop.ts        NowPlaying, DesktopCommand, DesktopBridge (types only)          new
packages/shared/src/index.ts          + export * from './desktop'                                      modify
apps/web/src/player.ts                SyncPlayer.pauseHere()                                           modify
apps/web/src/desktop.ts               getDesktop, nowPlayingOf, reportNowPlaying, listenForCommands,   new
                                      useDesktopBridge
apps/web/src/mediaSession.ts          sessionView, applyMediaSession, useMediaSession                  new
apps/web/src/useStation.ts            startupJoin, Station.pauseHere, Station.autoJoining              modify
apps/web/src/App.tsx                  calls the two hooks; Joining screen                              modify
apps/desktop/package.json             scripts, devDependencies                                         new
apps/desktop/tsconfig.json                                                                             new
apps/desktop/electron-builder.yml     packaging                                                        new
apps/desktop/src/settings.ts          DEFAULT_STATION, normaliseStation, loadStation, saveStation      new
apps/desktop/src/navigation.ts        navigationFor, isLocalPage                                       new
apps/desktop/src/trayMenu.ts          trayMenu, songLine, parseNowPlaying, escapeMnemonic              new
apps/desktop/src/preload.ts           window.desktop (+ window.desktopLocal on file: pages)            new
apps/desktop/src/main.ts              lifecycle, windows, tray, IPC, menus                             new
apps/desktop/pages/offline.html       "Can't reach the station"                                        new
apps/desktop/pages/station.html       Change station window                                            new
apps/desktop/build/icon.svg|png       app icon source and 1024 px render                               new
apps/desktop/assets/tray*.png         tray icons (template for Mac, colour for Windows), 1x and 2x     new
apps/desktop/scripts/icons.mjs        renders the PNGs from SVG                                        new
apps/desktop/scripts/cdp.mjs          evaluates JS in the running app over DevTools, for launch tests  new
.github/workflows/desktop.yml         build on tag, draft release                                      new
.gitignore, .dockerignore             release/ output; keep desktop out of the server image            modify
README.md                             "Desktop app" section                                            modify
```

---

### Task 0: Settle the earlier uncommitted work and branch

The working tree already holds finished but uncommitted work from earlier sessions:

- The pop fix: `packages/shared/src/sync.ts` and `sync.test.ts`, plus `apps/web/src/player.ts` and `player.test.ts`.
- The iOS fixed-rate fix: `player.ts`, `player.test.ts` and `apps/web/src/useStation.ts`.
- The Pi deploy script: `scripts/deploy-pi.sh`, plus a one-line note in `README.md`.
- The desktop spec, and this plan.

Tasks 1 and 4 edit `player.ts` and `useStation.ts` again, so settle this first.

- [ ] **Step 1: Confirm the baseline is green**

Run: `pnpm test && pnpm typecheck`
Expected: every package passes.

- [ ] **Step 2: Ask the owner how to commit it**

Ask: "Before the desktop work, may I commit the earlier changes on `main` as three commits, then do the desktop work on a `desktop-app` branch with one commit per task?" The three commits:

1. `fix(web): steadier sync without pops, and fixed-rate mode on iOS`: sync.ts, sync.test.ts, player.ts, player.test.ts, useStation.ts.
2. `chore: deploy script for the Raspberry Pi`: scripts/deploy-pi.sh, README.md.
3. `docs: desktop app design and implementation plan`: the spec and this plan.

Follow the owner's answer exactly. If they decline committing, stop and ask how they want the desktop changes kept apart.

- [ ] **Step 3: Commit (only with the owner's yes) and branch**

```bash
git add packages/shared/src/sync.ts packages/shared/src/sync.test.ts apps/web/src/player.ts apps/web/src/player.test.ts apps/web/src/useStation.ts
git commit -m "fix(web): steadier sync without pops, and fixed-rate mode on iOS" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git add scripts/deploy-pi.sh README.md
git commit -m "chore: deploy script for the Raspberry Pi" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git add docs/superpowers/specs/2026-10-07-desktop-app-design.md docs/superpowers/plans/2026-10-07-desktop-app.md
git commit -m "docs: desktop app design and implementation plan" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git switch -c desktop-app
```

Expected: `git status` is clean on branch `desktop-app`.

---

### Task 1: `SyncPlayer.pauseHere()` and `Station.pauseHere`

The media-key Pause stops this device only, like an outside pause (Ruling R12): the banner appears, and `resume()` rejoins at the shared position.

**Files:**
- Modify: `apps/web/src/player.ts`, adding the method right after `resume()` (around line 194).
- Modify: `apps/web/src/useStation.ts`: the `Station` interface, a new callback, and the return object.
- Test: `apps/web/src/player.test.ts`.

**Interfaces:**
- Consumes: the existing private helpers `clearLead()`, `clearHandoff()`, `stopRetiring()` and `pauseAudio()`, and `deps.onBlocked()`.
- Produces:
  - `SyncPlayer.pauseHere(): void`.
  - `Station.pauseHere(): void`, which Task 3 uses.

- [ ] **Step 1: Write the failing tests**

In `apps/web/src/player.test.ts`, add this block right after the `describe('SyncPlayer resume()', …)` block, before `describe('SyncPlayer settling after a seek', …)`:

```ts
describe('SyncPlayer pauseHere()', () => {
  const playingAt10 = async () => {
    player.update(item(A), playing(0, T0 - 10_000))
    audio.loaded()
    await settle()
    expect(audio.paused).toBe(false)
  }

  it('stops this device and shows the banner once', async () => {
    await playingAt10()
    player.pauseHere()
    player.pauseHere()
    await settle() // the pause event arrives and must not count as a second outside pause
    expect(audio.paused).toBe(true)
    expect(blocked).toBe(1)
  })

  it('stays silent through station updates and realign() until resume() rejoins', async () => {
    await playingAt10()
    player.pauseHere()
    player.update(item(A), playing(20, T0)) // someone seeks to 0:20
    await vi.advanceTimersByTimeAsync(2_000)
    player.realign()
    expect(audio.paused).toBe(true)
    expect(audio.plays).toBe(1)

    player.resume() // the Play key
    expect(audio.plays).toBe(2)
    expect(audio.paused).toBe(false)
    expect(audio.currentTime).toBeCloseTo(22 + player.leadS)
    expect(blocked).toBe(1)
  })

  it('keeps a new song silent after someone skips', async () => {
    await playingAt10()
    player.pauseHere()
    player.update(item(B), playing(0, T0 + 1_000))
    await settle()
    audio.loaded()
    expect(audio.src).toContain(B) // the new song did load
    await vi.advanceTimersByTimeAsync(2_000)
    expect(audio.paused).toBe(true)
    expect(audio.plays).toBe(1)
  })

  it('cancels a pending lead-in', async () => {
    await playingAt10()
    player.update(item(A), playing(30, T0 + 1_000))
    await settle()
    player.pauseHere()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(audio.paused).toBe(true)
    expect(audio.plays).toBe(1)
    expect(blocked).toBe(1)
  })

  it('does nothing while the station is paused', async () => {
    player.update(item(A), paused(42))
    audio.loaded()
    await settle()
    player.pauseHere()
    expect(blocked).toBe(0)
    player.update(item(A), playing(42, T0 + 1_000)) // the station plays again, and so does this device
    await vi.advanceTimersByTimeAsync(1_000)
    expect(audio.paused).toBe(false)
  })
})
```

In the same file, inside `describe('SyncPlayer with a spare deck', …)`, add after the test `'switches to the spare exactly at the boundary, without waiting for the server'` (Review Focus 1):

```ts
  it('pauseHere() during a handoff silences both songs', async () => {
    await playingAWithBNext()
    await vi.advanceTimersByTimeAsync(10_000 - 500) // the handoff: A plays out while B waits for the boundary
    expect(audio.paused).toBe(false)
    player.pauseHere()
    await vi.advanceTimersByTimeAsync(1_000) // past the boundary, where B would have started
    expect(audio.paused).toBe(true)
    expect(spare.paused).toBe(true)
    expect(blocked).toBe(1)
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @music-station/web exec vitest run src/player.test.ts -t "pauseHere"`
Expected: FAIL with `player.pauseHere is not a function`.

- [ ] **Step 3: Implement `pauseHere()`**

In `apps/web/src/player.ts`, insert right after the closing brace of `resume()`:

```ts
  /** Stops this device only, as when something outside pauses it: the "Tap to resume audio" banner appears. */
  pauseHere(): void {
    if (this.blocked || this.playback.status !== 'playing') return
    this.blocked = true
    this.clearLead()
    this.clearHandoff()
    this.stopRetiring() // the old song of a handoff in progress
    this.pauseAudio() // clears wantPlaying first, so onPause ignores this pause
    this.deps.onBlocked()
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @music-station/web exec vitest run src/player.test.ts`
Expected: PASS, all tests in the file.

- [ ] **Step 5: Expose it on `Station`**

In `apps/web/src/useStation.ts`, add to the `Station` interface right after `resume(): void`:

```ts
  /** Stops this device only, as a call or AirPods would; resume() rejoins. */
  pauseHere(): void
```

Add right after the `resume` callback:

```ts
  const pauseHere = useCallback(() => conn.current?.player.pauseHere(), [])
```

Add `pauseHere,` to the returned object right after `resume,`.

- [ ] **Step 6: Typecheck and run the web tests**

Run: `pnpm --filter @music-station/web typecheck && pnpm --filter @music-station/web test`
Expected: no type errors; all tests pass.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/player.ts apps/web/src/player.test.ts apps/web/src/useStation.ts
git commit -m "feat(web): pauseHere() stops this device only, like an outside pause" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Shared desktop types and the web desktop bridge

**Files:**
- Create: `packages/shared/src/desktop.ts`.
- Modify: `packages/shared/src/index.ts`.
- Create: `apps/web/src/desktop.ts`.
- Test: `apps/web/src/desktop.test.ts`.

**Interfaces:**
- Consumes:
  - `Station` and `ActionEvent` from `apps/web/src/useStation.ts` (types only).
  - `StationState` and `Playback` from shared.
- Produces:
  - In shared: `NowPlaying {title: string; channel: string; status: Playback['status']}`, `DesktopCommand = 'play' | 'pause' | 'skip'`, and `DesktopBridge {nowPlaying?(info: NowPlaying | null): void; onCommand?(fn: (command: DesktopCommand) => void): () => void}`.
  - In web:
    - `getDesktop(win?): DesktopBridge | null`, used by Task 4.
    - `nowPlayingOf(state, joined): NowPlaying | null`.
    - `reportNowPlaying(bridge, info): void`.
    - `listenForCommands(bridge, send): (() => void) | null`.
    - `useDesktopBridge(station: Station): void`, used by Task 4.

- [ ] **Step 1: Add the shared types**

Create `packages/shared/src/desktop.ts`:

```ts
import type { Playback } from './types'

/** The song the desktop app's tray menu shows. */
export interface NowPlaying {
  title: string
  channel: string
  status: Playback['status']
}

/** A tray command, which the page sends as the station action of the same name. */
export type DesktopCommand = 'play' | 'pause' | 'skip'

/**
 * What the desktop app's preload puts on window.desktop. Every function is optional and checked before each call,
 * so a page newer than the installed app only misses what that app lacks.
 */
export interface DesktopBridge {
  /** null when nothing is current. */
  nowPlaying?(info: NowPlaying | null): void
  /** Returns a function that stops listening. */
  onCommand?(fn: (command: DesktopCommand) => void): () => void
}
```

In `packages/shared/src/index.ts`, add a last line:

```ts
export * from './desktop'
```

- [ ] **Step 2: Write the failing tests**

Create `apps/web/src/desktop.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import type { DesktopBridge, DesktopCommand, QueueItem, StationState } from '@music-station/shared'
import { getDesktop, listenForCommands, nowPlayingOf, reportNowPlaying } from './desktop'

const song: QueueItem = {
  id: 'item-1',
  videoId: 'aaaaaaaaaaa',
  title: 'Song',
  channel: 'Band',
  duration: 200,
  thumbnail: 'https://i.ytimg.com/vi/aaaaaaaaaaa/hqdefault.jpg',
  addedBy: 'Minh',
  status: 'ready',
}
const stateWith = (current: QueueItem | null, status: StationState['playback']['status'] = 'playing'): StationState => ({
  current,
  queue: [],
  playback: { status, position: 0, at: 0 },
  listeners: [],
  autoplay: false,
})

describe('getDesktop', () => {
  it('returns the bridge inside the app', () => {
    const bridge = { nowPlaying() {} }
    expect(getDesktop({ desktop: bridge })).toBe(bridge)
  })

  it('returns null in a browser, or for anything that is not an object', () => {
    expect(getDesktop({})).toBeNull()
    expect(getDesktop({ desktop: null })).toBeNull()
    expect(getDesktop({ desktop: 'yes' })).toBeNull()
  })
})

describe('nowPlayingOf', () => {
  it('reports the song with each station status while joined', () => {
    for (const status of ['playing', 'paused', 'waiting'] as const) {
      expect(nowPlayingOf(stateWith(song, status), true)).toEqual({ title: 'Song', channel: 'Band', status })
    }
  })

  it('is null before joining, before the first state, and with nothing current', () => {
    expect(nowPlayingOf(stateWith(song), false)).toBeNull()
    expect(nowPlayingOf(null, true)).toBeNull()
    expect(nowPlayingOf(stateWith(null), true)).toBeNull()
  })
})

describe('reportNowPlaying', () => {
  it('sends the song, and null when nothing is current', () => {
    const nowPlaying = vi.fn()
    reportNowPlaying({ nowPlaying }, { title: 'Song', channel: 'Band', status: 'paused' })
    reportNowPlaying({ nowPlaying }, null)
    expect(nowPlaying.mock.calls).toEqual([[{ title: 'Song', channel: 'Band', status: 'paused' }], [null]])
  })

  it('does nothing without a bridge, or with an older bridge that lacks nowPlaying', () => {
    expect(() => reportNowPlaying(null, null)).not.toThrow()
    expect(() => reportNowPlaying({}, null)).not.toThrow()
  })
})

describe('listenForCommands', () => {
  function fakeBridge() {
    let listener: ((command: DesktopCommand) => void) | null = null
    const stop = vi.fn(() => {
      listener = null
    })
    const bridge: DesktopBridge = {
      onCommand: (fn) => {
        listener = fn
        return stop
      },
    }
    // The page is remote, but the app could still send a command this page does not know.
    return { bridge, stop, press: (command: string) => listener?.(command as DesktopCommand) }
  }

  it('sends each tray command as its station action', () => {
    const { bridge, press } = fakeBridge()
    const send = vi.fn()
    listenForCommands(bridge, send)
    press('play')
    press('pause')
    press('skip')
    expect(send.mock.calls).toEqual([['player:play'], ['player:pause'], ['player:skip']])
  })

  it('ignores commands it does not know, including inherited property names', () => {
    const { bridge, press } = fakeBridge()
    const send = vi.fn()
    listenForCommands(bridge, send)
    press('toString')
    press('constructor')
    press('seek')
    expect(send).not.toHaveBeenCalled()
  })

  it('returns the function that stops listening', () => {
    const { bridge, stop, press } = fakeBridge()
    const send = vi.fn()
    const unsubscribe = listenForCommands(bridge, send)
    unsubscribe?.()
    expect(stop).toHaveBeenCalledOnce()
    press('play')
    expect(send).not.toHaveBeenCalled()
  })

  it('returns null without a bridge, or with one that lacks onCommand', () => {
    expect(listenForCommands(null, vi.fn())).toBeNull()
    expect(listenForCommands({}, vi.fn())).toBeNull()
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @music-station/web exec vitest run src/desktop.test.ts`
Expected: FAIL with `Failed to resolve import "./desktop"`.

- [ ] **Step 4: Implement `apps/web/src/desktop.ts`**

```ts
import { useEffect } from 'react'
import type { DesktopBridge, DesktopCommand, NowPlaying, StationState } from '@music-station/shared'
import type { ActionEvent, Station } from './useStation'

/** The bridge inside the desktop app, otherwise null. */
export function getDesktop(win: { desktop?: unknown } = window as unknown as { desktop?: unknown }): DesktopBridge | null {
  const desktop = win.desktop
  return typeof desktop === 'object' && desktop !== null ? (desktop as DesktopBridge) : null
}

/** What the app's tray shows: the song and the station status while joined, otherwise null. */
export function nowPlayingOf(state: StationState | null, joined: boolean): NowPlaying | null {
  const current = state?.current
  if (!joined || !state || !current) return null
  return { title: current.title, channel: current.channel, status: state.playback.status }
}

/** Sends the song to an app whose bridge can take it. */
export function reportNowPlaying(bridge: DesktopBridge | null, info: NowPlaying | null): void {
  if (typeof bridge?.nowPlaying === 'function') bridge.nowPlaying(info)
}

const ACTIONS: Record<DesktopCommand, ActionEvent> = { play: 'player:play', pause: 'player:pause', skip: 'player:skip' }

/** Runs the app's tray commands as station actions. Returns the function that stops listening, or null. */
export function listenForCommands(
  bridge: DesktopBridge | null,
  send: (event: ActionEvent) => unknown,
): (() => void) | null {
  if (typeof bridge?.onCommand !== 'function') return null
  const stop = bridge.onCommand((command) => {
    if (Object.hasOwn(ACTIONS, command)) void send(ACTIONS[command])
  })
  return typeof stop === 'function' ? stop : null
}

/** Reports the song to the desktop app and runs its tray commands as station actions. Does nothing in a browser. */
export function useDesktopBridge(station: Station): void {
  // A string key, so a new state object with the same song and status sends nothing.
  const key = JSON.stringify(nowPlayingOf(station.state, station.joined))
  const { send } = station
  useEffect(() => {
    reportNowPlaying(getDesktop(), JSON.parse(key) as NowPlaying | null)
  }, [key])
  useEffect(() => listenForCommands(getDesktop(), send) ?? undefined, [send])
}
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `pnpm --filter @music-station/web exec vitest run src/desktop.test.ts && pnpm --filter @music-station/web typecheck && pnpm --filter @music-station/shared typecheck`
Expected: PASS; no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/desktop.ts packages/shared/src/index.ts apps/web/src/desktop.ts apps/web/src/desktop.test.ts
git commit -m "feat(web): desktop bridge reports the song and runs tray commands" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Media Session

**Files:**
- Create: `apps/web/src/mediaSession.ts`.
- Test: `apps/web/src/mediaSession.test.ts`.

**Interfaces:**
- Consumes:
  - `Station.resume()`, `Station.pauseHere()` (from Task 1) and `Station.send()`.
  - `StationState` from shared.
- Produces:
  - `SessionView {title; artist; artwork; playing}`.
  - `sessionView(state, joined, blocked): SessionView | null`.
  - `SessionLike`, the part of `navigator.mediaSession` this code uses.
  - `SessionHandlers {play(); pause(); next()}`.
  - `applyMediaSession(session, view, handlers, toMetadata?)`.
  - `useMediaSession(station: Station): void`, used by Task 4.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/mediaSession.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import type { QueueItem, StationState } from '@music-station/shared'
import { applyMediaSession, sessionView, type SessionLike, type SessionView } from './mediaSession'

class FakeSession implements SessionLike {
  metadata: MediaMetadata | null = null
  playbackState: MediaSessionPlaybackState = 'none'
  readonly handlers = new Map<MediaSessionAction, MediaSessionActionHandler | null>()
  constructor(private readonly unsupported: MediaSessionAction[] = []) {}
  setActionHandler(action: MediaSessionAction, handler: MediaSessionActionHandler | null): void {
    if (this.unsupported.includes(action)) throw new TypeError(`The action "${action}" is not supported`)
    this.handlers.set(action, handler)
  }
  /** Presses a media key. */
  press(action: MediaSessionAction): void {
    this.handlers.get(action)?.({ action })
  }
}

// Node has no MediaMetadata; a plain object with the same fields stands in for it.
const toMetadata = (init: MediaMetadataInit) => init as unknown as MediaMetadata
const spies = () => ({ play: vi.fn(), pause: vi.fn(), next: vi.fn() })

const song: QueueItem = {
  id: 'item-1',
  videoId: 'aaaaaaaaaaa',
  title: 'Song',
  channel: 'Band',
  duration: 200,
  thumbnail: 'https://i.ytimg.com/vi/aaaaaaaaaaa/hqdefault.jpg',
  addedBy: 'Minh',
  status: 'ready',
}
const stateWith = (current: QueueItem | null, status: StationState['playback']['status']): StationState => ({
  current,
  queue: [],
  playback: { status, position: 0, at: 0 },
  listeners: [],
  autoplay: false,
})
const view: SessionView = { title: 'Song', artist: 'Band', artwork: song.thumbnail, playing: true }

describe('sessionView', () => {
  it('shows the song while joined, playing only when the station plays and this device is not paused', () => {
    expect(sessionView(stateWith(song, 'playing'), true, false)).toEqual(view)
    expect(sessionView(stateWith(song, 'playing'), true, true)?.playing).toBe(false)
    expect(sessionView(stateWith(song, 'paused'), true, false)?.playing).toBe(false)
    expect(sessionView(stateWith(song, 'waiting'), true, false)?.playing).toBe(false)
  })

  it('is null before joining, before the first state, and with nothing current', () => {
    expect(sessionView(stateWith(song, 'playing'), false, false)).toBeNull()
    expect(sessionView(null, true, false)).toBeNull()
    expect(sessionView(stateWith(null, 'paused'), true, false)).toBeNull()
  })
})

describe('applyMediaSession', () => {
  it('sets the song info and the playback state', () => {
    const session = new FakeSession()
    applyMediaSession(session, view, spies(), toMetadata)
    expect(session.metadata).toEqual({ title: 'Song', artist: 'Band', artwork: [{ src: song.thumbnail }] })
    expect(session.playbackState).toBe('playing')
    applyMediaSession(session, { ...view, playing: false }, spies(), toMetadata)
    expect(session.playbackState).toBe('paused')
  })

  it('leaves the artwork out when the song has no thumbnail', () => {
    const session = new FakeSession()
    applyMediaSession(session, { ...view, artwork: '' }, spies(), toMetadata)
    expect(session.metadata).toEqual({ title: 'Song', artist: 'Band', artwork: [] })
  })

  it('maps Play, Pause and Next to resume, pause here and skip', () => {
    const session = new FakeSession()
    const h = spies()
    applyMediaSession(session, view, h, toMetadata)
    session.press('pause')
    expect(h.pause).toHaveBeenCalledOnce()
    session.press('play')
    expect(h.play).toHaveBeenCalledOnce()
    session.press('nexttrack')
    expect(h.next).toHaveBeenCalledOnce()
  })

  it('clears the song info and the handlers when there is nothing to show', () => {
    const session = new FakeSession()
    applyMediaSession(session, view, spies(), toMetadata)
    applyMediaSession(session, null, spies(), toMetadata)
    expect(session.metadata).toBeNull()
    expect(session.playbackState).toBe('none')
    expect([...session.handlers.values()]).toEqual([null, null, null])
  })

  it('still sets the other handlers when the browser does not support one action', () => {
    const session = new FakeSession(['play'])
    const h = spies()
    expect(() => applyMediaSession(session, view, h, toMetadata)).not.toThrow()
    session.press('pause')
    session.press('nexttrack')
    expect(h.pause).toHaveBeenCalledOnce()
    expect(h.next).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @music-station/web exec vitest run src/mediaSession.test.ts`
Expected: FAIL with `Failed to resolve import "./mediaSession"`.

- [ ] **Step 3: Implement `apps/web/src/mediaSession.ts`**

```ts
import { useEffect } from 'react'
import type { StationState } from '@music-station/shared'
import type { Station } from './useStation'

/** What the system's media controls show. */
export interface SessionView {
  title: string
  artist: string
  artwork: string
  /** The station plays and this device is not paused. */
  playing: boolean
}

export function sessionView(state: StationState | null, joined: boolean, blocked: boolean): SessionView | null {
  const current = state?.current
  if (!joined || !state || !current) return null
  return {
    title: current.title,
    artist: current.channel,
    artwork: current.thumbnail,
    playing: state.playback.status === 'playing' && !blocked,
  }
}

/** The part of navigator.mediaSession this uses, so tests can pass a fake. */
export interface SessionLike {
  metadata: MediaMetadata | null
  playbackState: MediaSessionPlaybackState
  setActionHandler(action: MediaSessionAction, handler: MediaSessionActionHandler | null): void
}

export interface SessionHandlers {
  play(): void
  pause(): void
  next(): void
}

/** Sets the song info and the key handlers for a view, or clears them all for null. */
export function applyMediaSession(
  session: SessionLike,
  view: SessionView | null,
  handlers: SessionHandlers,
  toMetadata: (init: MediaMetadataInit) => MediaMetadata = (init) => new MediaMetadata(init),
): void {
  if (view) {
    session.metadata = toMetadata({
      title: view.title,
      artist: view.artist,
      artwork: view.artwork ? [{ src: view.artwork }] : [],
    })
    session.playbackState = view.playing ? 'playing' : 'paused'
  } else {
    session.metadata = null
    session.playbackState = 'none'
  }
  const run = { play: handlers.play, pause: handlers.pause, nexttrack: handlers.next }
  for (const action of ['play', 'pause', 'nexttrack'] as const) {
    try {
      session.setActionHandler(action, view ? () => run[action]() : null)
    } catch {
      // Some browsers throw for an action they do not support; the others must still be set.
    }
  }
}

/**
 * Sets the song info and media-key handlers while joined, and clears them otherwise.
 * Play → station.resume(), Pause → station.pauseHere(), Next → send('player:skip').
 */
export function useMediaSession(station: Station): void {
  const key = JSON.stringify(sessionView(station.state, station.joined, station.blocked))
  const { resume, pauseHere, send } = station
  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    applyMediaSession(navigator.mediaSession, JSON.parse(key) as SessionView | null, {
      play: resume,
      pause: pauseHere,
      next: () => void send('player:skip'),
    })
  }, [key, resume, pauseHere, send])
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `pnpm --filter @music-station/web exec vitest run src/mediaSession.test.ts && pnpm --filter @music-station/web typecheck`
Expected: PASS; no type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/mediaSession.ts apps/web/src/mediaSession.test.ts
git commit -m "feat(web): media keys and lock-screen info through the Media Session API" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Automatic join in the app, and wiring the hooks into App

**Files:**
- Modify: `apps/web/src/useStation.ts`:
  - imports;
  - replace `rejoinAfterUpdate()` (lines 95–99);
  - the `Station` interface;
  - replace the pending-rejoin block (lines 286–296);
  - the return object.
- Modify: `apps/web/src/App.tsx`.
- Test: `apps/web/src/useStation.test.ts`.

**Interfaces:**
- Consumes:
  - `getDesktop()` from Task 2;
  - `useDesktopBridge(station)` from Task 2;
  - `useMediaSession(station)` from Task 3;
  - `getUpdateReload()`, `getNickname()` and `type UpdateReload` from `./storage`.
- Produces:
  - `startupJoin(reload: UpdateReload, nickname: string, inApp: boolean, now: number): { nickname: string; updated: boolean }`.
  - `Station.autoJoining: boolean`.

- [ ] **Step 1: Write the failing tests**

In `apps/web/src/useStation.test.ts`, change the import line to:

```ts
import { sendAction, startupJoin } from './useStation'
```

Append:

```ts
describe('startupJoin', () => {
  const NOW = 1_000_000
  const never = { at: 0, rejoin: false }
  const none = { nickname: '', updated: false }

  it('keeps the Join screen in a browser, whose Listen tap unlocks audio on iOS', () => {
    expect(startupJoin(never, 'Minh', false, NOW)).toEqual(none)
  })

  it('joins with the saved nickname inside the app, without the update toast', () => {
    expect(startupJoin(never, 'Minh', true, NOW)).toEqual({ nickname: 'Minh', updated: false })
  })

  it('shows the Join screen in the app until a nickname is saved', () => {
    expect(startupJoin(never, '', true, NOW)).toEqual(none)
  })

  it('rejoins a tab that just reloaded itself for a new version, with the update toast', () => {
    const fresh = { at: NOW - 5_000, rejoin: true }
    expect(startupJoin(fresh, 'Minh', false, NOW)).toEqual({ nickname: 'Minh', updated: true })
    expect(startupJoin(fresh, 'Minh', true, NOW)).toEqual({ nickname: 'Minh', updated: true })
  })

  it('ignores an old reload, and one from a tab that had not joined', () => {
    expect(startupJoin({ at: NOW - 60_000, rejoin: true }, 'Minh', false, NOW)).toEqual(none)
    expect(startupJoin({ at: NOW - 5_000, rejoin: false }, 'Minh', false, NOW)).toEqual(none)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @music-station/web exec vitest run src/useStation.test.ts`
Expected: FAIL. `startupJoin` is not exported (`startupJoin is not a function`).

- [ ] **Step 3: Implement `startupJoin` and the automatic join**

In `apps/web/src/useStation.ts`:

Add an import right after `import { ClockSync } from './clockSync'`:

```ts
import { getDesktop } from './desktop'
```

In the `./storage` import list, add `type UpdateReload,` after `saveUpdateReload,`.

Replace the whole `rejoinAfterUpdate()` function and its doc comment with:

```ts
/**
 * Who to join as when the page opens, skipping the Join screen: a tab that reloaded itself for a new version while
 * joined, and the desktop app at every start once a nickname is saved. `updated` asks for the update toast.
 */
export function startupJoin(
  reload: UpdateReload,
  nickname: string,
  inApp: boolean,
  now: number,
): { nickname: string; updated: boolean } {
  const updated = reload.rejoin && now - reload.at < UPDATE_RELOAD_GUARD_MS
  return nickname && (updated || inApp) ? { nickname, updated } : { nickname: '', updated: false }
}
```

In the `Station` interface, add right after `joined: boolean`:

```ts
  /** Joining on its own with the saved nickname; the Join screen waits until this ends. */
  autoJoining: boolean
```

Replace the block from `// After reloading itself for a new version, the tab rejoins on its own.` through the end of its `useEffect` with:

```ts
  // A tab that reloaded itself for a new version rejoins on its own, and so does the desktop app at every start.
  // Without a tap a browser may block the sound; the player then shows the "Tap to resume audio" banner.
  const [startup] = useState(() => startupJoin(getUpdateReload(), getNickname(), getDesktop() !== null, Date.now()))
  const [autoJoining, setAutoJoining] = useState(startup.nickname !== '')
  const startupTried = useRef(false)
  useEffect(() => {
    if (!connected || joined || !startup.nickname || startupTried.current) return
    startupTried.current = true
    void join(startup.nickname).then((res) => {
      setAutoJoining(false)
      if (!res.ok) notify(`Could not join the station: ${res.error}`, 'error')
      else if (startup.updated) notify('Updated to the latest version')
    })
  }, [connected, joined, join, notify, startup])
```

In the returned object, add `autoJoining,` right after `joined,`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @music-station/web exec vitest run src/useStation.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the hooks and the Joining screen into App**

In `apps/web/src/App.tsx`, add imports after `import { Toasts } from './screens/Toasts'`:

```ts
import { useDesktopBridge } from './desktop'
import { useMediaSession } from './mediaSession'
```

Right after `const station = useStation()`, add:

```ts
  useMediaSession(station)
  useDesktopBridge(station)
```

Replace the not-joined branch:

```tsx
  if (!station.joined || !state) {
    return (
      <>
        {station.autoJoining ? (
          <Joining connected={station.connected} />
        ) : (
          <Join connected={station.connected} onJoin={station.join} />
        )}
        <Toasts toasts={station.toasts} />
      </>
    )
  }
```

Add this component right after the `App` function:

```tsx
/** Shown instead of the Join screen while the app, or a tab that just updated, joins with the saved nickname. */
function Joining({ connected }: { connected: boolean }) {
  return (
    <main className="grid min-h-dvh place-items-center px-6">
      <p role="status" className="flex items-center gap-2 text-muted">
        <Icon name="spinner" />
        {connected ? 'Joining the station…' : 'Connecting to station…'}
      </p>
    </main>
  )
}
```

- [ ] **Step 6: Run all web checks**

Run: `pnpm --filter @music-station/web test && pnpm --filter @music-station/web typecheck && pnpm --filter @music-station/web build`
Expected: all tests pass, no type errors, and the Vite build succeeds.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/useStation.ts apps/web/src/useStation.test.ts apps/web/src/App.tsx
git commit -m "feat(web): join automatically inside the desktop app; wire media keys and the bridge" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Desktop package scaffold and station settings

**Files:**
- Create: `apps/desktop/package.json` and `apps/desktop/tsconfig.json`.
- Create: `apps/desktop/src/settings.ts`.
- Test: `apps/desktop/src/settings.test.ts`.
- Modify: `.gitignore` and `.dockerignore`.
- Modify (only if Step 9 fails): `docker/Dockerfile`.

**Interfaces:**
- Produces:
  - `DEFAULT_STATION = 'https://music.devxdev.site'`.
  - `normaliseStation(input: string): string | null`.
  - `loadStation(dir: string): string`.
  - `saveStation(dir: string, url: string): void`.
  - Task 9 uses all of them.

- [ ] **Step 1: Create the package**

Create `apps/desktop/package.json`. Scripts for building and packaging come in Tasks 8–10, so `pnpm build` keeps working in between:

```json
{
  "name": "@music-station/desktop",
  "productName": "Music Station",
  "version": "0.1.0",
  "private": true,
  "description": "Music Station for Mac and Windows",
  "author": "Music Station",
  "main": "dist/main.js",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json"
  },
  "devDependencies": {
    "@music-station/shared": "workspace:*",
    "@resvg/resvg-js": "^2.6.2",
    "@types/node": "^22.9.0",
    "electron": "44.6.0",
    "electron-builder": "^26.15.3",
    "esbuild": "^0.28.2",
    "typescript": "^5.6.3",
    "vitest": "^3.2.4"
  }
}
```

There is deliberately no `"type": "module"`: esbuild emits CommonJS, which Electron's main and sandboxed preload scripts load directly.

Create `apps/desktop/tsconfig.json`. DOM is for `location` in the preload; the shared package is imported for types only.

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2023", "DOM"],
    "types": ["node"]
  },
  "include": ["src"]
}
```

- [ ] **Step 2: Keep build output out of git and the desktop app out of the server image**

Append to `.gitignore`:

```
apps/desktop/release/
```

Append to `.dockerignore`:

```
apps/desktop
```

- [ ] **Step 3: Install**

Run: `pnpm install`
Expected: success, and `pnpm-lock.yaml` gains an `apps/desktop` importer. Electron's postinstall downloads its binary, about 100 MB.

- [ ] **Step 4: Write the failing tests**

Create `apps/desktop/src/settings.test.ts`:

```ts
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_STATION, loadStation, normaliseStation, saveStation } from './settings'

describe('normaliseStation', () => {
  it.each([
    ['https://music.devxdev.site', 'https://music.devxdev.site'],
    ['music.devxdev.site', 'https://music.devxdev.site'],
    ['  music.devxdev.site/  ', 'https://music.devxdev.site'],
    ['HTTPS://Music.Devxdev.Site/queue?x=1#top', 'https://music.devxdev.site'],
    ['https://music.example.com:8443/', 'https://music.example.com:8443'],
    ['https://music.example.com:443', 'https://music.example.com'],
    ['music.example.com:8443', 'https://music.example.com:8443'],
    ['http://music.example.com', 'http://music.example.com'],
    ['localhost', 'http://localhost'],
    ['localhost:3000', 'http://localhost:3000'],
    ['https://localhost:3000', 'https://localhost:3000'],
    ['192.168.1.20:3000', 'http://192.168.1.20:3000'],
    ['raspberrypi.local:3000', 'http://raspberrypi.local:3000'],
    // What a lookalike really points at is what gets saved.
    ['https://music.devxdev.site@evil.example', 'https://evil.example'],
  ])('%s → %s', (input, expected) => {
    expect(normaliseStation(input)).toBe(expected)
  })

  it.each([
    '',
    '   ',
    'my station',
    'javascript:alert(1)',
    'data:text/html,hi',
    'file:///etc/passwd',
    'ftp://music.example.com',
    'http://',
    '999.1.1.1:3000',
  ])('rejects %j', (input) => {
    expect(normaliseStation(input)).toBeNull()
  })
})

describe('loadStation and saveStation', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'music-station-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('uses the default station before anything is saved', () => {
    expect(loadStation(dir)).toBe(DEFAULT_STATION)
  })

  it('reads back what it saved, and leaves no temporary file behind', () => {
    saveStation(dir, 'http://192.168.1.20:3000')
    expect(loadStation(dir)).toBe('http://192.168.1.20:3000')
    expect(readdirSync(dir)).toEqual(['settings.json'])
  })

  it('creates the folder on the first save', () => {
    const nested = join(dir, 'a', 'b')
    saveStation(nested, 'https://music.example.com')
    expect(loadStation(nested)).toBe('https://music.example.com')
  })

  it('normalises a hand-edited address', () => {
    writeFileSync(join(dir, 'settings.json'), '{"station":"music.example.com/queue"}')
    expect(loadStation(dir)).toBe('https://music.example.com')
  })

  it.each(['', 'not json', 'null', '[]', '{}', '{"station":42}', '{"station":"javascript:alert(1)"}'])(
    'falls back to the default for a corrupt file: %j',
    (text) => {
      writeFileSync(join(dir, 'settings.json'), text)
      expect(loadStation(dir)).toBe(DEFAULT_STATION)
    },
  )
})
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `pnpm --filter @music-station/desktop test`
Expected: FAIL with `Failed to resolve import "./settings"`.

- [ ] **Step 6: Implement `apps/desktop/src/settings.ts`**

```ts
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const DEFAULT_STATION = 'https://music.devxdev.site'

const FILE = 'settings.json'
const SCHEME = /^[a-z][a-z\d+.-]*:\/\//i
// This computer and the local network, which rarely have a certificate.
const LOCAL_HOST = /^(localhost|\d{1,3}(\.\d{1,3}){3}|[^/:?#]+\.local)(:\d+)?([/?#]|$)/i

/**
 * The origin of a typed station address, or null if it is not one.
 * Without a scheme: http:// for localhost, IPv4 addresses and *.local, https:// otherwise.
 * Only http and https are accepted. Any path, query or hash is dropped.
 */
export function normaliseStation(input: string): string | null {
  const text = input.trim()
  if (!text) return null
  const withScheme = SCHEME.test(text) ? text : `${LOCAL_HOST.test(text) ? 'http' : 'https'}://${text}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  return url.origin
}

/** The saved station, or DEFAULT_STATION when the file is missing or invalid. */
export function loadStation(dir: string): string {
  try {
    const saved: unknown = JSON.parse(readFileSync(join(dir, FILE), 'utf8'))
    const station = typeof saved === 'object' && saved !== null ? (saved as { station?: unknown }).station : null
    return (typeof station === 'string' && normaliseStation(station)) || DEFAULT_STATION
  } catch {
    return DEFAULT_STATION
  }
}

export function saveStation(dir: string, url: string): void {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, FILE)
  // Written aside and renamed into place, so a crash mid-write cannot leave half a file.
  writeFileSync(`${file}.tmp`, `${JSON.stringify({ station: url }, null, 2)}\n`)
  renameSync(`${file}.tmp`, file)
}
```

- [ ] **Step 7: Run the tests and typecheck**

Run: `pnpm --filter @music-station/desktop test && pnpm --filter @music-station/desktop typecheck`
Expected: PASS; no type errors.

- [ ] **Step 8: Check the whole workspace still builds and tests**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: all pass. The desktop package has no `build` script yet, so `pnpm -r build` skips it.

- [ ] **Step 9: Check the server image still builds**

Run: `docker compose build app`
Expected: the image builds. This only builds; it doesn't restart the running station.

If it fails at `pnpm install --frozen-lockfile` with `ERR_PNPM_OUTDATED_LOCKFILE`, pnpm wants every project in the lockfile present. Apply this fallback and run `docker compose build app` again:

1. In `.dockerignore`, replace the `apps/desktop` line with:
   ```
   apps/desktop/*
   !apps/desktop/package.json
   ```
2. In `docker/Dockerfile`:
   - add `COPY apps/desktop/package.json apps/desktop/` right after `COPY apps/web/package.json apps/web/`;
   - change `RUN pnpm install --frozen-lockfile` to `RUN pnpm install --frozen-lockfile --filter '!@music-station/desktop'`;
   - change `RUN pnpm build` to `RUN pnpm -r --filter '!@music-station/desktop' build`.

- [ ] **Step 10: Commit**

```bash
git add apps/desktop/package.json apps/desktop/tsconfig.json apps/desktop/src/settings.ts apps/desktop/src/settings.test.ts .gitignore .dockerignore pnpm-lock.yaml
git commit -m "feat(desktop): package scaffold and station address settings" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

If Step 9 needed the fallback, add `docker/Dockerfile` to the `git add`.

---

### Task 6: Navigation rules

**Files:**
- Create: `apps/desktop/src/navigation.ts`.
- Test: `apps/desktop/src/navigation.test.ts`.

**Interfaces:**
- Produces:
  - `navigationFor(url: string, station: string): 'allow' | 'external' | 'deny'`.
  - `isLocalPage(url: string): boolean`.
  - Task 9 uses both.

- [ ] **Step 1: Write the failing tests**

Create `apps/desktop/src/navigation.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { isLocalPage, navigationFor } from './navigation'

const STATION = 'https://music.devxdev.site'

describe('navigationFor', () => {
  it.each([
    'https://music.devxdev.site',
    'https://music.devxdev.site/',
    'https://music.devxdev.site/?x=1#y',
    'https://MUSIC.devxdev.site/assets/index.js',
  ])('keeps %s in the window', (url) => {
    expect(navigationFor(url, STATION)).toBe('allow')
  })

  it.each([
    'https://www.youtube.com/watch?v=aaaaaaaaaaa',
    'http://music.devxdev.site/', // http is another origin
    'https://music.devxdev.site:8443/',
    'https://music.devxdev.site.evil.example/',
    'https://music.devxdev.site@evil.example/',
    'https://evil.example/?next=https://music.devxdev.site',
  ])('opens %s in the default browser', (url) => {
    expect(navigationFor(url, STATION)).toBe('external')
  })

  it.each([
    'file:///etc/hosts',
    'javascript:alert(1)',
    'data:text/html,hi',
    'mailto:someone@example.com',
    'about:blank',
    'chrome://gpu',
    'not a url',
    '',
  ])('refuses %j', (url) => {
    expect(navigationFor(url, STATION)).toBe('deny')
  })

  it('treats a station on the local network by its own port', () => {
    expect(navigationFor('http://192.168.1.20:3000/', 'http://192.168.1.20:3000')).toBe('allow')
    expect(navigationFor('http://192.168.1.20:5173/', 'http://192.168.1.20:3000')).toBe('external')
  })
})

describe('isLocalPage', () => {
  it.each([
    'file:///Applications/Music%20Station.app/Contents/Resources/app.asar/pages/offline.html?station=https%3A%2F%2Fmusic.devxdev.site',
    'file:///C:/Users/Minh/AppData/Local/Programs/Music%20Station/resources/app.asar/pages/station.html?station=x',
    'file:///Users/minh/code/music-station/apps/desktop/pages/offline.html',
  ])('accepts the app page %s', (url) => {
    expect(isLocalPage(url)).toBe(true)
  })

  it.each([
    'https://music.devxdev.site/pages/offline.html',
    'https://music.devxdev.site/',
    'file:///Users/minh/Downloads/offline.html',
    'file:///etc/hosts',
    'file:///pages/offline.html.evil',
    '',
  ])('rejects %j', (url) => {
    expect(isLocalPage(url)).toBe(false)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @music-station/desktop exec vitest run src/navigation.test.ts`
Expected: FAIL with `Failed to resolve import "./navigation"`.

- [ ] **Step 3: Implement `apps/desktop/src/navigation.ts`**

```ts
/** What the window does with a URL: stay on the station, open it in the default browser, or refuse it. */
export function navigationFor(url: string, station: string): 'allow' | 'external' | 'deny' {
  let target: URL
  try {
    target = new URL(url)
  } catch {
    return 'deny'
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return 'deny'
  return target.origin === new URL(station).origin ? 'allow' : 'external'
}

/**
 * True for the app's own pages, which alone may retry or change the station. The windows can never navigate to a
 * file: URL (navigationFor refuses them), so the path's ending is enough; an exact path would have to match how
 * Chromium spells drive letters and non-ASCII folder names.
 */
export function isLocalPage(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'file:' && /\/pages\/(offline|station)\.html$/.test(u.pathname)
  } catch {
    return false
  }
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `pnpm --filter @music-station/desktop test && pnpm --filter @music-station/desktop typecheck`
Expected: PASS; no type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/navigation.ts apps/desktop/src/navigation.test.ts
git commit -m "feat(desktop): navigation rules keep the window on the station" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Tray menu template

**Files:**
- Create: `apps/desktop/src/trayMenu.ts`.
- Test: `apps/desktop/src/trayMenu.test.ts`.

**Interfaces:**
- Consumes: `NowPlaying` and `DesktopCommand` from `@music-station/shared` (types only).
- Produces:
  - `TrayCommand = DesktopCommand | 'show' | 'station' | 'quit'`.
  - `TrayItem = { label: string; enabled: boolean; command?: TrayCommand } | { separator: true }`.
  - `trayMenu(info: NowPlaying | null): TrayItem[]`.
  - `songLine(info: NowPlaying | null): string`.
  - `parseNowPlaying(value: unknown): NowPlaying | null`.
  - `escapeMnemonic(label: string): string`.
  - Task 9 uses all of these.

- [ ] **Step 1: Write the failing tests**

Create `apps/desktop/src/trayMenu.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { NowPlaying } from '@music-station/shared'
import { escapeMnemonic, parseNowPlaying, songLine, trayMenu, type TrayItem } from './trayMenu'

const song = (status: NowPlaying['status']): NowPlaying => ({ title: 'Song', channel: 'Band', status })
/** One line per item: the label, "(off)" when disabled, and the command in brackets. */
const lines = (items: TrayItem[]) =>
  items.map((i) =>
    'separator' in i ? '---' : `${i.label}${i.enabled ? '' : ' (off)'}${i.command ? ` [${i.command}]` : ''}`,
  )
const tail = ['---', 'Show window [show]', 'Change station… [station]', 'Quit [quit]']

describe('trayMenu', () => {
  it('offers pause and skip while the station plays', () => {
    expect(lines(trayMenu(song('playing')))).toEqual([
      'Song — Band (off)',
      'Pause for everyone [pause]',
      'Skip for everyone [skip]',
      ...tail,
    ])
  })

  it('offers play while the station is paused', () => {
    expect(lines(trayMenu(song('paused')))).toEqual([
      'Song — Band (off)',
      'Play for everyone [play]',
      'Skip for everyone [skip]',
      ...tail,
    ])
  })

  it('disables play while the song is still downloading, but still allows a skip', () => {
    expect(lines(trayMenu(song('waiting')))).toEqual([
      'Song — Band (off)',
      'Play for everyone (off) [play]',
      'Skip for everyone [skip]',
      ...tail,
    ])
  })

  it('disables the station controls with nothing playing', () => {
    expect(lines(trayMenu(null))).toEqual([
      'Nothing playing (off)',
      'Play for everyone (off) [play]',
      'Skip for everyone (off) [skip]',
      ...tail,
    ])
  })
})

describe('songLine', () => {
  it('folds whitespace and newlines into one line', () => {
    expect(songLine({ title: ' Song\n\tname  ', channel: ' Band ', status: 'playing' })).toBe('Song name — Band')
  })

  it('leaves out an empty channel and names an empty title', () => {
    expect(songLine({ title: 'Song', channel: '  ', status: 'playing' })).toBe('Song')
    expect(songLine({ title: '', channel: 'Band', status: 'playing' })).toBe('Unknown song — Band')
  })

  it('cuts a long line to 60 characters', () => {
    const line = songLine({ title: 'a'.repeat(500), channel: 'Band', status: 'playing' })
    expect(Array.from(line)).toHaveLength(60)
    expect(line.endsWith('…')).toBe(true)
  })

  it('never cuts an emoji in half', () => {
    const line = songLine({ title: '🎵'.repeat(80), channel: '', status: 'playing' })
    const chars = Array.from(line)
    expect(chars).toHaveLength(60)
    expect(chars.slice(0, -1).every((c) => c === '🎵')).toBe(true)
  })
})

describe('parseNowPlaying', () => {
  it('accepts a valid message and drops extra fields', () => {
    expect(parseNowPlaying({ title: 'Song', channel: 'Band', status: 'waiting', evil: 1 })).toEqual({
      title: 'Song',
      channel: 'Band',
      status: 'waiting',
    })
  })

  it.each([
    null,
    undefined,
    'Song',
    42,
    [],
    {},
    { title: 'Song', channel: 'Band' },
    { title: 42, channel: 'Band', status: 'playing' },
    { title: 'Song', channel: null, status: 'playing' },
    { title: 'Song', channel: 'Band', status: 'stopped' },
  ])('treats %j as nothing playing', (value) => {
    expect(parseNowPlaying(value)).toBeNull()
  })
})

describe('escapeMnemonic', () => {
  it('doubles every & so menus show it instead of underlining the next letter', () => {
    expect(escapeMnemonic('Simon & Garfunkel — A&&B')).toBe('Simon && Garfunkel — A&&&&B')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @music-station/desktop exec vitest run src/trayMenu.test.ts`
Expected: FAIL with `Failed to resolve import "./trayMenu"`.

- [ ] **Step 3: Implement `apps/desktop/src/trayMenu.ts`**

```ts
import type { DesktopCommand, NowPlaying } from '@music-station/shared'

export type TrayCommand = DesktopCommand | 'show' | 'station' | 'quit'
export type TrayItem = { label: string; enabled: boolean; command?: TrayCommand } | { separator: true }

const MAX_LINE = 60

/** The menu's first line: the song and its channel on one line, cut to fit. */
export function songLine(info: NowPlaying | null): string {
  if (!info) return 'Nothing playing'
  const fold = (s: string) => s.replace(/\s+/g, ' ').trim()
  const title = fold(info.title) || 'Unknown song'
  const channel = fold(info.channel)
  const chars = Array.from(channel ? `${title} — ${channel}` : title) // code points, so emoji stay whole
  return chars.length > MAX_LINE ? `${chars.slice(0, MAX_LINE - 1).join('').trimEnd()}…` : chars.join('')
}

export function trayMenu(info: NowPlaying | null): TrayItem[] {
  const playing = info?.status === 'playing'
  return [
    { label: songLine(info), enabled: false },
    {
      label: playing ? 'Pause for everyone' : 'Play for everyone',
      // While the song downloads, the server cannot play or pause it yet.
      enabled: info !== null && info.status !== 'waiting',
      command: playing ? 'pause' : 'play',
    },
    { label: 'Skip for everyone', enabled: info !== null, command: 'skip' },
    { separator: true },
    { label: 'Show window', enabled: true, command: 'show' },
    { label: 'Change station…', enabled: true, command: 'station' },
    { label: 'Quit', enabled: true, command: 'quit' },
  ]
}

/** The page's nowPlaying message, or null for nothing current or anything that is not one. The page is a remote site. */
export function parseNowPlaying(value: unknown): NowPlaying | null {
  if (typeof value !== 'object' || value === null) return null
  const { title, channel, status } = value as Record<string, unknown>
  if (typeof title !== 'string' || typeof channel !== 'string') return null
  if (status !== 'playing' && status !== 'paused' && status !== 'waiting') return null
  return { title, channel, status }
}

/** Menus on Mac and Windows read & as a keyboard-shortcut marker; && shows one &. */
export function escapeMnemonic(label: string): string {
  return label.replaceAll('&', '&&')
}
```

The `Array.from(...)` in `songLine` is a slight change from the plain string comparison and keeps the code short: a short line still comes back unchanged.

- [ ] **Step 4: Run the tests and typecheck**

Run: `pnpm --filter @music-station/desktop test && pnpm --filter @music-station/desktop typecheck`
Expected: PASS; no type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/trayMenu.ts apps/desktop/src/trayMenu.test.ts
git commit -m "feat(desktop): tray menu template with station-wide controls" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: App and tray icons

**Files:**
- Create: `apps/desktop/build/icon.svg` and `apps/desktop/scripts/icons.mjs`.
- Generate (and commit):
  - `apps/desktop/build/icon.png`;
  - `apps/desktop/assets/trayTemplate.png` and `trayTemplate@2x.png`;
  - `apps/desktop/assets/tray.png` and `tray@2x.png`.
- Modify: `apps/desktop/package.json` scripts.

**Interfaces:**
- Produces: `build/icon.png`, which Task 10 packages, and the four `assets/` PNGs, which Task 9's tray loads.

- [ ] **Step 1: Write the icon source**

Create `apps/desktop/build/icon.svg`. It is the web app's favicon on Apple's icon grid: an 824 px tile with a 100 px margin.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <svg x="100" y="100" width="824" height="824" viewBox="0 0 32 32">
    <rect width="32" height="32" rx="7.2" fill="#22c55e"/>
    <path d="M9 20v-6M14 23V9M19 20v-8M24 18v-4" stroke="#03140a" stroke-width="2.5" stroke-linecap="round" fill="none"/>
  </svg>
</svg>
```

- [ ] **Step 2: Write the render script**

Create `apps/desktop/scripts/icons.mjs`:

```js
// Renders the app and tray icons. Run after changing build/icon.svg: pnpm --filter @music-station/desktop icons
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { Resvg } from '@resvg/resvg-js'

const BARS = 'M9 20v-6M14 23V9M19 20v-8M24 18v-4'
const file = (path) => new URL(`../${path}`, import.meta.url)
const render = (svg, size, path) => {
  writeFileSync(file(path), new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng())
}

// macOS tints a template image black or white to suit the menu bar, so it holds only the bars, cropped to them.
const template = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="4 4 24 24"><path d="${BARS}" stroke="#000" stroke-width="3" stroke-linecap="round" fill="none"/></svg>`
// Windows shows the tray icon as it is: the favicon.
const colour = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#22c55e"/><path d="${BARS}" stroke="#03140a" stroke-width="2.5" stroke-linecap="round" fill="none"/></svg>`

mkdirSync(file('assets/'), { recursive: true })
render(readFileSync(file('build/icon.svg'), 'utf8'), 1024, 'build/icon.png')
for (const [svg, name] of [
  [template, 'trayTemplate'],
  [colour, 'tray'],
]) {
  render(svg, 16, `assets/${name}.png`)
  render(svg, 32, `assets/${name}@2x.png`) // Electron picks the @2x file on high-density screens
}
```

In `apps/desktop/package.json`, set `scripts` to:

```json
  "scripts": {
    "icons": "node scripts/icons.mjs",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json"
  },
```

- [ ] **Step 3: Render the icons**

Run: `pnpm --filter @music-station/desktop icons && ls -la apps/desktop/build apps/desktop/assets`
Expected:
- `build/icon.png` exists;
- `assets/` holds `tray.png`, `tray@2x.png`, `trayTemplate.png` and `trayTemplate@2x.png`, each a few hundred bytes to a few KB.

- [ ] **Step 4: Look at them**

Open `apps/desktop/build/icon.png` and `apps/desktop/assets/trayTemplate@2x.png` with the Read tool, which shows images. Expected:
- the app icon is a green rounded square with four dark bars and a transparent margin;
- the template icon is four black bars on a transparent background, filling most of the square.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/build apps/desktop/assets apps/desktop/scripts/icons.mjs apps/desktop/package.json
git commit -m "feat(desktop): app and tray icons from the web favicon" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Main process, preload and local pages

**Files:**
- Create: `apps/desktop/src/preload.ts` and `apps/desktop/src/main.ts`.
- Create: `apps/desktop/pages/offline.html` and `apps/desktop/pages/station.html`.
- Create: `apps/desktop/scripts/cdp.mjs`.
- Modify: `apps/desktop/package.json` scripts.

**Interfaces:**
- Consumes:
  - `normaliseStation`, `loadStation` and `saveStation` from Task 5;
  - `navigationFor` and `isLocalPage` from Task 6;
  - `trayMenu`, `parseNowPlaying`, `escapeMnemonic` and `TrayCommand` from Task 7;
  - the `assets/` PNGs from Task 8;
  - `DesktopBridge`, `DesktopCommand` and `NowPlaying` from shared (Task 2).
- Produces:
  - IPC channels:
    - `desktop:nowPlaying` (page → main, send);
    - `desktop:command` (main → page);
    - `local:retry` (invoke → boolean);
    - `local:changeStation` (send);
    - `local:saveStation` (invoke → `{ok: true} | {ok: false; error: string}`).
  - Page globals: `window.desktop` and `window.desktopLocal` (file: pages only).
  - Environment variables: `STATION_URL`, `MUSIC_STATION_MUTED=1` and `MUSIC_STATION_PROFILE`.
  - `dist/main.js` and `dist/preload.js`.

- [ ] **Step 1: Add the build scripts**

In `apps/desktop/package.json`, set `scripts` to:

```json
  "scripts": {
    "build": "esbuild src/main.ts src/preload.ts --bundle --platform=node --format=cjs --target=node22 --external:electron --outdir=dist",
    "dev": "pnpm build && electron .",
    "icons": "node scripts/icons.mjs",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json"
  },
```

- [ ] **Step 2: Write the preload**

Create `apps/desktop/src/preload.ts`:

```ts
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { DesktopBridge, DesktopCommand } from '@music-station/shared'

// The station page gets these two functions and nothing else.
const desktop: DesktopBridge = {
  nowPlaying: (info) => ipcRenderer.send('desktop:nowPlaying', info),
  onCommand: (fn) => {
    const listener = (_event: IpcRendererEvent, command: DesktopCommand) => fn(command)
    ipcRenderer.on('desktop:command', listener)
    return () => {
      ipcRenderer.removeListener('desktop:command', listener)
    }
  },
}
contextBridge.exposeInMainWorld('desktop', desktop)

// The app's own pages also get their actions. The main process checks the sender again.
if (location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('desktopLocal', {
    retry: (): Promise<boolean> => ipcRenderer.invoke('local:retry'),
    changeStation: () => ipcRenderer.send('local:changeStation'),
    saveStation: (address: string): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke('local:saveStation', address),
  })
}
```

- [ ] **Step 3: Write the main process**

Create `apps/desktop/src/main.ts`:

```ts
import { join } from 'node:path'
import type { NowPlaying } from '@music-station/shared'
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  net,
  session,
  shell,
  Tray,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type WebPreferences,
} from 'electron'
import { isLocalPage, navigationFor } from './navigation'
import { loadStation, normaliseStation, saveStation } from './settings'
import { escapeMnemonic, parseNowPlaying, trayMenu, type TrayCommand } from './trayMenu'

const APP_ID = 'site.devxdev.musicstation'
const isMac = process.platform === 'darwin'
// esbuild bundles this file into dist/main.js; pages/ and assets/ sit next to dist/, also inside app.asar.
const page = (name: string) => join(__dirname, '..', 'pages', name)
const asset = (name: string) => join(__dirname, '..', 'assets', name)

// Test switches: a throwaway profile, and silence for launch tests.
if (process.env.MUSIC_STATION_PROFILE) app.setPath('userData', process.env.MUSIC_STATION_PROFILE)
const muted = process.env.MUSIC_STATION_MUTED === '1'
if (muted) app.commandLine.appendSwitch('mute-audio')
// Like any music player, the app plays without a click first.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
if (process.platform === 'win32') app.setAppUserModelId(APP_ID)

let station = ''
let win: BrowserWindow | null = null
let stationWin: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', showWindow)
  app.on('activate', showWindow) // the Dock icon
  app.on('before-quit', () => {
    quitting = true
  })
  void app.whenReady().then(start)
}

function start(): void {
  station = normaliseStation(process.env.STATION_URL ?? '') ?? loadStation(app.getPath('userData'))
  // The window shows a remote site: refuse the camera, microphone, notifications and everything else it asks for.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  // The Edit menu makes copy and paste work in the search box on a Mac.
  Menu.setApplicationMenu(
    isMac
      ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }])
      : null,
  )
  listenToPages()
  createWindow()
  createTray()
}

function webPreferences(extra: WebPreferences = {}): WebPreferences {
  return {
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    preload: join(__dirname, 'preload.js'),
    ...extra,
  }
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 360,
    minHeight: 560,
    title: 'Music Station',
    backgroundColor: '#09090f',
    // Full-speed timers while hidden, so sync holds with the window closed.
    webPreferences: webPreferences({ backgroundThrottling: false }),
  })
  const contents = win.webContents
  if (muted) contents.setAudioMuted(true)
  // Links to other sites open in the default browser, and the page never opens a second window.
  contents.setWindowOpenHandler(({ url }) => {
    if (navigationFor(url, station) !== 'deny') void shell.openExternal(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (details) => {
    const where = navigationFor(details.url, station)
    if (where === 'allow') return
    details.preventDefault()
    if (where === 'external') void shell.openExternal(details.url)
  })
  contents.on('did-fail-load', (_event, code, _description, url, isMainFrame) => {
    // -3 is ERR_ABORTED: a newer load replaced this one.
    if (isMainFrame && code !== -3 && !isLocalPage(url)) showOffline()
  })
  contents.on('did-navigate', (_event, url, httpCode) => {
    setTray(null) // the new page reports its song once it joins
    // Cloudflare answers 502 or 530 while the station's computer is off.
    if (httpCode >= 500 && !isLocalPage(url)) showOffline()
  })
  win.on('close', (event) => {
    if (quitting) return
    event.preventDefault() // closing hides the window; the music plays on until Quit
    win?.hide()
  })
  // Windows ends a session without before-quit; the hidden window must not hold up a shutdown.
  win.on('query-session-end', () => {
    quitting = true
  })
  loadStationPage()
}

function loadStationPage(): void {
  // A failed load ends in did-fail-load, which shows the offline page.
  win?.loadURL(station).catch(() => {})
}

function showOffline(): void {
  win?.loadFile(page('offline.html'), { query: { station } }).catch(() => {})
}

/** Whether the station answers at all, so the offline page does not flash a failed load on every retry. */
async function reachable(url: string): Promise<boolean> {
  try {
    const res = await net.fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5_000) })
    return res.status < 500
  } catch {
    return false
  }
}

function showWindow(): void {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function createTray(): void {
  // A Mac tints the template image to suit a light or dark menu bar; Windows shows the colour icon as it is.
  const image = nativeImage.createFromPath(asset(isMac ? 'trayTemplate.png' : 'tray.png'))
  if (isMac) image.setTemplateImage(true)
  tray = new Tray(image)
  tray.setToolTip('Music Station')
  // On Windows a click shows the window and a right-click the menu; on a Mac a click shows the menu.
  if (!isMac) tray.on('click', showWindow)
  setTray(null)
}

/** Rebuilds the tray menu; the page calls this through nowPlaying on every change. */
function setTray(info: NowPlaying | null): void {
  if (!tray) return
  const template = trayMenu(info).map((item): MenuItemConstructorOptions => {
    if ('separator' in item) return { type: 'separator' }
    const { command } = item
    return {
      label: escapeMnemonic(item.label),
      enabled: item.enabled,
      click: command ? () => runTray(command) : undefined,
    }
  })
  tray.setContextMenu(Menu.buildFromTemplate(template))
}

function runTray(command: TrayCommand): void {
  if (command === 'show') return showWindow()
  if (command === 'station') return openStationWindow()
  if (command === 'quit') return app.quit()
  win?.webContents.send('desktop:command', command)
}

function listenToPages(): void {
  ipcMain.on('desktop:nowPlaying', (event, info: unknown) => {
    if (win && event.sender === win.webContents) setTray(parseNowPlaying(info))
  })
  // The app's own pages only: the offline page and the Change station window. A station page cannot reach these.
  const fromLocalPage = (event: IpcMainEvent | IpcMainInvokeEvent) => isLocalPage(event.senderFrame?.url ?? '')
  ipcMain.handle('local:retry', async (event) => {
    if (!fromLocalPage(event) || !(await reachable(station))) return false
    loadStationPage()
    return true
  })
  ipcMain.on('local:changeStation', (event) => {
    if (fromLocalPage(event)) openStationWindow()
  })
  ipcMain.handle('local:saveStation', (event, address: unknown) => {
    if (!fromLocalPage(event)) return { ok: false, error: 'Not allowed' }
    const url = typeof address === 'string' ? normaliseStation(address) : null
    if (!url) return { ok: false, error: 'Enter an address such as music.example.com' }
    try {
      saveStation(app.getPath('userData'), url)
    } catch (err) {
      return { ok: false, error: `Could not save the setting: ${err instanceof Error ? err.message : String(err)}` }
    }
    station = url
    loadStationPage()
    showWindow()
    return { ok: true } // the Change station window closes itself
  })
}

function openStationWindow(): void {
  if (stationWin) return stationWin.focus()
  stationWin = new BrowserWindow({
    width: 460,
    height: 230,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'Change station',
    backgroundColor: '#09090f',
    webPreferences: webPreferences(),
  })
  const contents = stationWin.webContents
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-navigate', (details) => details.preventDefault())
  stationWin.on('closed', () => {
    stationWin = null
  })
  stationWin.loadFile(page('station.html'), { query: { station } }).catch(() => {})
}
```

- [ ] **Step 4: Write the offline page**

Create `apps/desktop/pages/offline.html`:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>Music Station</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #09090f; color: #e4e4e7;
         font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 26rem; padding: 2rem; text-align: center; }
  h1 { font-size: 1.4rem; margin: 0 0 .5rem; }
  p { margin: 0 0 1.5rem; color: #a1a1aa; }
  code { color: #e4e4e7; word-break: break-all; }
  .buttons { display: flex; gap: .75rem; justify-content: center; }
  button { font: inherit; font-weight: 600; border: 0; border-radius: .75rem; padding: .7rem 1.2rem; cursor: pointer; }
  .primary { background: #22c55e; color: #03140a; }
  .secondary { background: #1f1f2b; color: #e4e4e7; }
  #status { display: block; margin-top: 1rem; color: #71717a; font-size: .85rem; }
</style>
</head>
<body>
<main>
  <h1>Can't reach the station</h1>
  <p>Music Station could not open <code id="station"></code>. Check your connection, or change the station.</p>
  <div class="buttons">
    <button class="primary" id="retry" type="button">Retry</button>
    <button class="secondary" id="change" type="button">Change station…</button>
  </div>
  <span id="status" role="status">Trying again every 10 seconds.</span>
</main>
<script>
  const status = document.getElementById('status')
  document.getElementById('station').textContent = new URLSearchParams(location.search).get('station') ?? ''
  let busy = false
  async function retry() {
    if (busy) return
    busy = true
    status.textContent = 'Trying…'
    const ok = await window.desktopLocal?.retry()
    busy = false
    if (!ok) status.textContent = "Still can't reach it. Trying again every 10 seconds."
  }
  document.getElementById('retry').addEventListener('click', retry)
  document.getElementById('change').addEventListener('click', () => window.desktopLocal?.changeStation())
  setInterval(retry, 10_000)
</script>
</body>
</html>
```

- [ ] **Step 5: Write the Change station page**

Create `apps/desktop/pages/station.html`:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>Change station</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #09090f; color: #e4e4e7; font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  form { display: flex; flex-direction: column; gap: .5rem; padding: 1.25rem 1.5rem; }
  label { font-weight: 600; }
  input { font: inherit; font-size: 15px; padding: .6rem .8rem; border-radius: .6rem; border: 1px solid #2e2e3a;
          background: #15151f; color: #e4e4e7; outline: none; }
  input:focus { border-color: #22c55e; }
  #error { min-height: 1.3em; margin: 0; color: #f87171; font-size: .85rem; }
  .buttons { display: flex; gap: .6rem; justify-content: flex-end; }
  button { font: inherit; font-weight: 600; border: 0; border-radius: .6rem; padding: .5rem 1rem; cursor: pointer; }
  .primary { background: #22c55e; color: #03140a; }
  .primary:disabled { opacity: .6; }
  .secondary { background: #1f1f2b; color: #e4e4e7; }
</style>
</head>
<body>
<form id="form" novalidate>
  <label for="address">Station address</label>
  <input id="address" type="text" spellcheck="false" autocomplete="off" autofocus aria-describedby="error">
  <p id="error" role="alert"></p>
  <div class="buttons">
    <button class="secondary" id="cancel" type="button">Cancel</button>
    <button class="primary" id="save" type="submit">Save</button>
  </div>
</form>
<script>
  const input = document.getElementById('address')
  const error = document.getElementById('error')
  const save = document.getElementById('save')
  input.value = new URLSearchParams(location.search).get('station') ?? ''
  input.select()
  document.getElementById('form').addEventListener('submit', async (event) => {
    event.preventDefault()
    save.disabled = true
    error.textContent = ''
    const res = await window.desktopLocal.saveStation(input.value)
    save.disabled = false
    if (res.ok) window.close()
    else error.textContent = res.error
  })
  document.getElementById('cancel').addEventListener('click', () => window.close())
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') window.close()
  })
</script>
</body>
</html>
```

- [ ] **Step 6: Write the DevTools helper for launch tests**

Create `apps/desktop/scripts/cdp.mjs`:

```js
// Evaluates JavaScript in a running Music Station window over the DevTools protocol, for launch tests.
// Start the app with --remote-debugging-port=9333, then:
//   node scripts/cdp.mjs 9333 'document.title' [url-part]      prints the result as JSON
//   node scripts/cdp.mjs 9333 --wait 'expression' [url-part]   retries for up to 30 s until the result is truthy
//   node scripts/cdp.mjs 9333 --list                           prints the open windows' URLs
const args = process.argv.slice(2)
const port = args.shift()
let wait = false
if (args[0] === '--wait') {
  wait = true
  args.shift()
}
const [expression, urlPart = ''] = args

async function pages() {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  return targets.filter((t) => t.type === 'page')
}

async function evaluate() {
  const target = (await pages()).find((t) => t.url.includes(urlPart))
  if (!target) throw new Error(`no window matches "${urlPart}"`)
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = () => reject(new Error('could not connect'))
  })
  try {
    const params = { expression, awaitPromise: true, returnByValue: true }
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params }))
    const reply = await new Promise((resolve) => {
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data)
        if (msg.id === 1) resolve(msg)
      }
    })
    const { result, exceptionDetails } = reply.result ?? {}
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text)
    return result?.value
  } finally {
    ws.close()
  }
}

if (expression === '--list') {
  for (const p of await pages()) console.log(p.url)
} else if (!wait) {
  console.log(JSON.stringify(await evaluate()))
} else {
  const deadline = Date.now() + 30_000
  let last
  for (;;) {
    try {
      last = await evaluate()
      if (last) break
    } catch (err) {
      last = String(err) // the app is still starting, or the page is reloading
    }
    if (Date.now() > deadline) {
      console.error(`Timed out; last result: ${JSON.stringify(last)}`)
      process.exit(1)
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  console.log(JSON.stringify(last))
}
```

- [ ] **Step 7: Build and typecheck**

Run: `pnpm --filter @music-station/desktop build && pnpm --filter @music-station/desktop typecheck && pnpm --filter @music-station/desktop test`
Expected:
- `dist/main.js` and `dist/preload.js` are written;
- there are no type errors, and the tests pass;
- `grep -c "require(\"electron\")" apps/desktop/dist/preload.js` prints 1;
- `grep -c zod apps/desktop/dist/main.js` prints 0, which confirms the shared import was types only.

- [ ] **Step 8: Smoke test the offline page (muted)**

Start the app in the background. Run it from `apps/desktop`, and don't wait on it with `sleep`:

```bash
cd apps/desktop && MUSIC_STATION_MUTED=1 MUSIC_STATION_PROFILE="$(mktemp -d)" STATION_URL=http://localhost:3999 pnpm exec electron . --remote-debugging-port=9333
```

Then, from `apps/desktop`, run:

```bash
node scripts/cdp.mjs 9333 --wait "document.querySelector('h1')?.textContent"
node scripts/cdp.mjs 9333 "window.desktopLocal.retry()"
```

Expected:
1. The first prints `"Can't reach the station"`.
2. The second prints `false` after up to 5 s, and the page shows "Still can't reach it…".

Stop the app.

- [ ] **Step 9: Smoke test the station page (muted)**

Start the web dev server in the background with `pnpm --filter @music-station/web dev --port 5173 --strictPort`. It proxies to the station running on port 3000. Wait for it:

`curl --retry 30 --retry-delay 1 --retry-connrefused -sf -o /dev/null http://localhost:5173`

Start the app in the background as in Step 8, but with `STATION_URL=http://localhost:5173` and a new `mktemp -d` profile. Then:

```bash
node scripts/cdp.mjs 9333 --wait "!!document.querySelector('#nickname')"
node scripts/cdp.mjs 9333 "typeof window.desktop.onCommand + ' ' + typeof window.desktopLocal"
```

Expected:
1. The first prints `true`: the Join screen shows, because a fresh profile has no nickname.
2. The second prints `"function undefined"`.

Stop the app; leave the dev server running for Task 13, or stop it.

- [ ] **Step 10: Commit**

```bash
git add apps/desktop/src/main.ts apps/desktop/src/preload.ts apps/desktop/pages apps/desktop/scripts/cdp.mjs apps/desktop/package.json
git commit -m "feat(desktop): window, tray, media-ready bridge, offline and Change station pages" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Packaging with electron-builder

**Files:**
- Create: `apps/desktop/electron-builder.yml`.
- Modify: `apps/desktop/package.json` scripts.

**Interfaces:**
- Consumes: `dist/`, `pages/`, `assets/` and `build/icon.png` from Tasks 8–9.
- Produces:
  - `apps/desktop/release/Music-Station-<version>-mac.dmg`;
  - `apps/desktop/release/mac-universal/Music Station.app`;
  - on Windows, `apps/desktop/release/Music-Station-<version>-windows.exe`;
  - Tasks 11 and 13 use these.

- [ ] **Step 1: Write the builder config**

Create `apps/desktop/electron-builder.yml`:

```yaml
appId: site.devxdev.musicstation
productName: Music Station
directories:
  output: release
  buildResources: build
# esbuild already bundled everything into dist/, so the app needs no node_modules.
files:
  - dist/**
  - pages/**
  - assets/**
  - package.json
npmRebuild: false
mac:
  target:
    - target: dmg
      arch: universal
  category: public.app-category.music
  icon: build/icon.png
  # Ad-hoc signature: free, and enough for Apple Silicon to open the app after "Open Anyway".
  identity: "-"
  hardenedRuntime: false
  gatekeeperAssess: false
  artifactName: Music-Station-${version}-mac.${ext}
win:
  target:
    - target: nsis
      arch: x64
  icon: build/icon.png
  artifactName: Music-Station-${version}-windows.${ext}
nsis:
  oneClick: true
  perMachine: false
```

In `apps/desktop/package.json`, set `scripts` to:

```json
  "scripts": {
    "build": "esbuild src/main.ts src/preload.ts --bundle --platform=node --format=cjs --target=node22 --external:electron --outdir=dist",
    "dev": "pnpm build && electron .",
    "dist": "pnpm build && electron-builder --publish never",
    "icons": "node scripts/icons.mjs",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json"
  },
```

- [ ] **Step 2: Build the Mac installer**

Run: `CSC_IDENTITY_AUTO_DISCOVERY=false pnpm --filter @music-station/desktop dist`
Expected:
- success;
- `apps/desktop/release/Music-Station-0.1.0-mac.dmg` exists;
- so does `apps/desktop/release/mac-universal/Music Station.app`.

The first run downloads the x64 and arm64 Electron zips.

- [ ] **Step 3: Verify the signature and architectures**

```bash
codesign --verify --deep --strict --verbose=2 "apps/desktop/release/mac-universal/Music Station.app"
codesign -dv "apps/desktop/release/mac-universal/Music Station.app" 2>&1 | grep Signature
lipo -archs "apps/desktop/release/mac-universal/Music Station.app/Contents/MacOS/Music Station"
```

Expected:
1. `valid on disk` and `satisfies its Designated Requirement`.
2. `Signature=adhoc`.
3. `x86_64 arm64`.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/electron-builder.yml apps/desktop/package.json
git commit -m "build(desktop): universal ad-hoc signed dmg and per-user Windows installer" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Release workflow

**Files:**
- Create: `.github/workflows/desktop.yml`.

**Interfaces:**
- Consumes: the `test`, `typecheck` and `dist` scripts of `@music-station/desktop`, and the release paths from Task 10.
- Produces: on a pushed tag `desktop-v<version>`, a draft GitHub Release with the `.dmg` and `.exe`.

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/desktop.yml`:

```yaml
name: Desktop app

on:
  push:
    tags: ['desktop-v*']

permissions:
  contents: write

jobs:
  build:
    strategy:
      matrix:
        os: [macos-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    defaults:
      run:
        shell: bash
    env:
      CSC_IDENTITY_AUTO_DISCOVERY: 'false'
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - name: Check the tag matches the app version
        run: |
          version=$(node -p "require('./apps/desktop/package.json').version")
          if [ "$GITHUB_REF_NAME" != "desktop-v$version" ]; then
            echo "::error::Tag $GITHUB_REF_NAME does not match version $version in apps/desktop/package.json"
            exit 1
          fi
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @music-station/desktop test
      - run: pnpm --filter @music-station/desktop typecheck
      - run: pnpm --filter @music-station/desktop dist
      - name: Verify the ad-hoc signature
        if: runner.os == 'macOS'
        run: codesign --verify --deep --strict --verbose=2 "apps/desktop/release/mac-universal/Music Station.app"
      - uses: actions/upload-artifact@v4
        with:
          name: installer-${{ runner.os }}
          path: |
            apps/desktop/release/*.dmg
            apps/desktop/release/*.exe
          if-no-files-found: error

  # One job creates the release after both builds, so the two cannot race to create it.
  release:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v4
        with:
          path: installers
          merge-multiple: true
      - name: Create a draft release
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          gh release create "$GITHUB_REF_NAME" installers/* --repo "$GITHUB_REPOSITORY" --draft \
            --title "Music Station desktop ${GITHUB_REF_NAME#desktop-v}" \
            --notes "Unsigned build. See the README's Desktop app section for the first launch on Mac and Windows."
```

- [ ] **Step 2: Check the file**

If `actionlint` is installed, run `actionlint .github/workflows/desktop.yml`; expected: no output. Otherwise read the file once more and check:
- the tag pattern is `desktop-v*`;
- the matrix is macOS and Windows;
- `shell: bash` is set, so the tag check runs on Windows;
- the codesign path matches Task 10;
- the release job `needs: build` and creates a `--draft`.

Don't push a tag. That's the owner's call.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/desktop.yml
git commit -m "ci(desktop): build installers on desktop-v tags into a draft release" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: README

**Files:**
- Modify: `README.md`, inserting a new section right before `## Development`.

- [ ] **Step 1: Add the Desktop app section**

Insert this text before the `## Development` heading:

~~~markdown
## Desktop app

Music Station also runs as an app on Mac and Windows. It opens the station in its own window, joins with your saved nickname, and keeps playing when you close the window. The menu bar (Mac) or tray (Windows) icon shows the song playing now and has **Pause for everyone**, **Play for everyone** and **Skip for everyone**.

Download the latest installer from the [Releases page](https://github.com/kpmquockhanh/music-station/releases): `Music-Station-<version>-mac.dmg` or `Music-Station-<version>-windows.exe`. The apps are not signed, so the first launch takes one extra step:

- **Mac:** open the `.dmg` and drag Music Station to Applications. Open it once; macOS refuses. Go to **System Settings → Privacy & Security**, scroll down, and click **Open Anyway**.
- **Windows:** run the `.exe`. When SmartScreen warns, click **More info → Run anyway**. It installs for your user only, without admin rights.

The app opens `https://music.devxdev.site`. To use another station, choose **Change station…** in the menu bar or tray menu and type its address, such as `192.168.1.20:3000`.

The keyboard media keys control this computer only. **Pause** stops the sound here while the station keeps playing for everyone else, and **Play** rejoins at the shared position. **Next**, like a headset's next button, skips the song for everyone.

The app's screens update with every server deploy. A new installer is only needed for changes to the app itself.

To publish installers, set `version` in `apps/desktop/package.json`, commit, and push a tag `desktop-v<version>`. GitHub Actions builds both installers and attaches them to a draft release. Publish the draft by hand.
~~~

- [ ] **Step 2: Add the app's commands to the Development table**

In the `## Development` table, add these rows after the `yt-dlp smoke check` row:

```markdown
| Desktop app against the local UI | `STATION_URL=http://localhost:5173 pnpm --filter @music-station/desktop dev` |
| Desktop installer (`.dmg` on a Mac) | `pnpm --filter @music-station/desktop dist` |
```

Without `STATION_URL`, `dev` opens the saved station, which is `https://music.devxdev.site` by default.

- [ ] **Step 3: Check the links and commands**

Run: `grep -n "^## Desktop app\|music-station/desktop" README.md && grep -n "desktop-v" README.md .github/workflows/desktop.yml`
Expected: the heading appears once, both table rows appear, and the README's tag name matches the workflow's `desktop-v*` pattern.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: desktop app download, first launch and media-key rule" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Launch test and owner checks

Everything runs muted (`MUSIC_STATION_MUTED=1` switches on both Chromium's `mute-audio` and `setAudioMuted`). Use a fresh profile per run (`MUSIC_STATION_PROFILE`). Don't wait with a bare `sleep`; use `cdp.mjs --wait`, or `curl --retry` for servers.

**Files:** none changed, unless a check fails. Then stop and report; don't patch blindly.

Run these from the repo root:

```bash
APP="apps/desktop/release/mac-universal/Music Station.app/Contents/MacOS/Music Station"
CDP="node apps/desktop/scripts/cdp.mjs 9333"
```

Shell variables don't survive between separate tool calls, so repeat these lines in each command, or write them out in full.

- [ ] **Step 1: Offline page for an unreachable station**

Start in the background:

```bash
MUSIC_STATION_MUTED=1 MUSIC_STATION_PROFILE="$(mktemp -d)" STATION_URL=http://localhost:3999 "$APP" --remote-debugging-port=9333
```

Then run `$CDP --wait "document.querySelector('h1')?.textContent"`.
Expected: `"Can't reach the station"`.

Stop the app.

- [ ] **Step 2: Offline page for a 5xx answer, as Cloudflare gives while the station is off**

Start in the background: `node -e "require('http').createServer((q, s) => { s.statusCode = 530; s.end('origin down') }).listen(3998)"`

Start the app as in Step 1, with `STATION_URL=http://localhost:3998`. Then run `$CDP --wait "location.protocol === 'file:' && document.querySelector('h1')?.textContent"`.
Expected: `"Can't reach the station"`.

Stop the app and the 530 server.

- [ ] **Step 3: Join screen, bridge and automatic join**

Make sure the web dev server from Task 9 runs on port 5173. Check with `curl --retry 30 --retry-delay 1 --retry-connrefused -sf -o /dev/null http://localhost:5173`.

Create a profile with `PROFILE=$(mktemp -d); echo "$PROFILE"` and reuse that path in Steps 3–7. Start in the background:

```bash
MUSIC_STATION_MUTED=1 MUSIC_STATION_PROFILE=<profile> STATION_URL=http://localhost:5173 "$APP" --remote-debugging-port=9333
```

Run:

```bash
$CDP --wait "!!document.querySelector('#nickname')"
$CDP "typeof window.desktop + ' ' + typeof window.desktopLocal"
$CDP "localStorage.setItem('musicStation.nickname', 'Desktop test'); location.reload(); 'reloading'"
$CDP --wait "!document.querySelector('#nickname') && document.body.innerText.includes('Up next')"
$CDP "document.body.innerText.includes('Updated to the latest version')"
```

Expected:
1. `true`: the Join screen on a fresh profile.
2. `"object undefined"`.
3. `"reloading"`.
4. `true`: the app joined on its own after the reload, with no click.
5. `false`: no update toast.

- [ ] **Step 4: Navigation stays on the station**

```bash
$CDP "location.href = 'file:///etc/hosts'; new Promise((r) => setTimeout(() => r(location.href), 1000))"
$CDP "String(window.open('about:blank'))"
$CDP --list
```

Expected:
1. `"http://localhost:5173/"`.
2. `"null"`.
3. One URL, `http://localhost:5173/`.

These checks open no browser tab. The "open in browser" path is covered by `navigation.test.ts`.

- [ ] **Step 5: Sync keeps reporting while hidden (needs the station playing)**

Check the server logs sync reports: `docker compose exec app printenv SYNC_LOG` should print `1`. If it prints nothing, ask the owner before restarting the station with `SYNC_LOG=1`.

Ask the owner to start a song or confirm one is playing. The app stays muted; other devices on the station play as usual. Then:

```bash
$CDP "window.close(); 'closed'"
$CDP "new Promise((r) => setTimeout(() => r(document.querySelector('#nickname') ? 'left the station' : 'waited'), 30000))"
docker compose logs app --since 30s | grep '\[sync\] Desktop test:'
```

Expected:
- `"closed"`, then `"waited"`. The page still answers 30 s after the close, so closing hid the window instead of quitting.
- At least five log lines, each with `"paused":false` and `"blocked":false`.
- `driftMs` within about ±30 in most lines.

Don't wait for `document.visibilityState === 'hidden'`. With `backgroundThrottling: false`, Electron keeps reporting `visible` for a hidden window; that's how timers keep full speed. Owner check 4 confirms the window really disappears.

If the reports stop or the drift grows while hidden, the app is being throttled. Report this to the owner with the log lines; don't add a power-save blocker without asking, because it would keep laptops awake.

- [ ] **Step 6: A second launch exits and leaves the first one running**

Run this in the foreground, with the same profile, because the lock belongs to the profile:

```bash
MUSIC_STATION_MUTED=1 MUSIC_STATION_PROFILE=<profile> "$APP"; echo "exit $?"
$CDP --list
```

Expected:
1. `exit 0` within a few seconds.
2. One URL, `http://localhost:5173/`: the first app still runs with its one window.

That the hidden window comes back is owner check 4, for the reason given in Step 5.

- [ ] **Step 7: Clean up**

Stop the app (kill its process), the web dev server and any helper servers. Delete the temporary profiles.

- [ ] **Step 8: Hand the owner the manual checks**

Tell the owner these checks need a person. Media keys can't be pressed by a script, and opening the menu-bar menu needs accessibility permission.

1. **Tray menu.** Open the installed or built app.
   - The menu-bar icon fits the light or dark menu bar.
   - Its menu shows `title — channel` for the song playing now.
   - **Pause for everyone**, **Play for everyone** and **Skip for everyone** act on every device.
2. **`&` in titles.** In View → Toggle Developer Tools, run `window.desktop.nowPlaying({ title: 'Simon & Garfunkel', channel: 'A&B', status: 'playing' })`. The menu's first line reads `Simon & Garfunkel — A&B`.
3. **Media keys.**
   - Pause (F8) silences only this Mac; the "Tap to resume audio" banner appears, and other devices keep playing.
   - Play rejoins in sync.
   - Next (F9) skips for everyone.
   - Repeat with the window closed.
4. **Window.**
   - Closing the window keeps the music; the Dock icon brings it back; ⌘Q quits.
   - Opening the app again while it runs (from Applications) brings the hidden window back.
   - Copy and paste work in the search box.
5. **Change station.**
   - `my station` shows "Enter an address such as music.example.com".
   - `localhost:5173` saves, the window reloads it, and the small window closes.
   - Change it back to `music.devxdev.site`.
6. **Windows.** After the first CI run, install the `.exe` on a Windows PC and repeat checks 1, 3 and 4. A tray click shows the window, and a right-click shows the menu.
7. **Before friends use it:**
   - Deploy the web changes to `music.devxdev.site`. Until then the app shows the old UI: the Join screen at every start, and no song in the tray.
   - Make sure friends can see the GitHub Releases page. A private repository hides it.
   - Pushing the `desktop-v0.1.0` tag and publishing the draft release are the owner's steps.
