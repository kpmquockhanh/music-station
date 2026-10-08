# Music Station Desktop App — Design

**Date:** 2026-10-07
**Status:** Draft, awaiting review

## 1. Goal

A desktop app for Mac and Windows that listens to the station like the web page does, but behaves like a normal app. The server and the web UI stay as they are; the app opens the station's page in its own window and adds what a browser tab cannot do.

**Success criteria**

- The app opens from the Dock or Start menu, joins with the saved nickname, and plays without any click.
- Sync matches Chrome on the same computer, also while the window is hidden or minimised.
- Play, pause and skip work from the menu bar (tray on Windows) and the keyboard media keys.
- Friends install it from a GitHub Release on Mac and Windows without paying for signing.
- A server deploy updates the UI inside every installed app, as it does for browser tabs.

## 2. Key decisions

| Decision | Choice | Rejected alternatives |
|---|---|---|
| Where the UI comes from | The app loads the station's page from the server | Shipping the React build inside the app: needs CORS and base URLs everywhere, and every UI change would need every friend to reinstall, since unsigned apps cannot update themselves |
| UI technology | The existing React web app, unchanged inside the window | Rewriting the UI for Electron: same screens for much more work |
| Which station | `https://music.devxdev.site` by default, changeable in the app | Hard-wired address; asking on first launch |
| Platforms | Mac (one universal build) and Windows x64 | Mac only; adding Linux |
| Signing | Unsigned; the Mac build is ad-hoc signed so Apple Silicon opens it | Apple Developer ID ($99/year) and a Windows certificate |
| App updates | None for the app itself; the UI updates with every deploy | electron-updater, which needs signing on macOS |
| Media keys and lock screen | Pause stops this device only and Play rejoins it, like the existing outside-pause rule (R12). Next skips the song for everyone. | Station-wide pause: taking out AirPods or disconnecting headphones sends the system a pause, which would then stop the music for everyone |
| Menu-bar controls | Station-wide: "Pause for everyone", "Play for everyone", "Skip for everyone" | Local controls, which the window banner already covers |
| Sleep | The computer stops this device only when it goes to sleep, and stays silent after it wakes until someone taps Resume in the card or the tray menu | Playing on at wake: a laptop opened in a meeting or a library would start playing out loud |

## 3. Scope

### Features

1. **App window** that opens the station, plays without a click, and keeps full-speed sync while hidden.
2. **Close keeps playing**: closing hides the window; Quit ends the app.
3. **Automatic join** with the saved nickname; the Join screen appears only on first use.
4. **Menu bar / tray menu** with the song playing now and station-wide play, pause and skip.
5. **Media keys** through the Media Session API (also gives Chrome's toolbar controls and the iPhone lock screen).
6. **Change station** window and a **can't reach the station** page with Retry.
7. **Installers** built by GitHub Actions and attached to a draft GitHub Release.

### Out of scope

Signing and notarisation, app auto-update, Linux, launch at login, running the server inside the app, an offline UI, remembering window size and position, song-change notifications.

## 4. Architecture

```
┌──────────── Music Station.app / .exe ─────────────┐
│ main process (Node)                               │
│  ├─ window ── loads the station URL ──────────────┼──► https://music.devxdev.site
│  │    └─ preload: window.desktop bridge           │     (unchanged server and web UI)
│  ├─ tray menu                                     │
│  ├─ settings.json (station URL, in userData)      │
│  └─ local pages: station.html, offline.html       │
└───────────────────────────────────────────────────┘
```

The page talks to the server exactly as in a browser. The page and the main process talk only through the bridge:

- page → main: the song and the station status, for the tray menu
- main → page: tray commands (`play`, `pause`, `skip`), which the page sends as the usual station actions

## 5. Code layout

```
apps/web/src/
  mediaSession.ts        Media Session: song info and media-key handlers (new)
  desktop.ts             the window.desktop bridge, a no-op in browsers (new)
  useStation.ts          automatic join in the app; pauseHere()
  player.ts              SyncPlayer.pauseHere()
  App.tsx                calls the two new hooks
apps/desktop/
  package.json           electron, electron-builder, esbuild as devDependencies only
  electron-builder.yml
  src/
    main.ts              app lifecycle, window, IPC, menus
    preload.ts           exposes window.desktop
    settings.ts          read, write and normalise the station URL
    navigation.ts        which URLs the window may open
    trayMenu.ts          builds the tray menu template from the song and status
  pages/
    station.html         the Change station window
    offline.html         shown when the station cannot be reached
  build/
    icon.svg             source: the logo from the web app's favicon
    icon.png             1024 px, rendered from icon.svg; electron-builder derives .icns and .ico
    trayTemplate.png     16 px monochrome menu-bar icon (+ @2x); macOS tints it for light and dark mode
    tray.png             colour tray icon for Windows
.github/workflows/desktop.yml
```

esbuild bundles `main.ts` and `preload.ts` into single files, so the packaged app needs no `node_modules`. This also keeps electron-builder clear of pnpm's symlinked dependencies.

### Module contracts

```ts
// apps/web/src/desktop.ts
export interface NowPlaying {
  title: string
  channel: string
  status: 'playing' | 'paused' | 'waiting'
}
export type DesktopCommand = 'play' | 'pause' | 'skip'
export interface DesktopBridge {
  /** null when nothing is current. */
  nowPlaying?(info: NowPlaying | null): void
  /** Returns a function that stops listening. */
  onCommand?(fn: (command: DesktopCommand) => void): () => void
}
/** The bridge inside the desktop app, otherwise null. */
export function getDesktop(): DesktopBridge | null
/** Reports the song to the app and runs its commands as station actions. */
export function useDesktopBridge(station: Station): void
```

Every bridge function is optional, and the web code checks each one before calling it. An old app keeps working with a newer UI and only misses features its bridge lacks.

```ts
// apps/web/src/mediaSession.ts
/**
 * Sets the song info and media-key handlers while joined, and clears them otherwise.
 * play → station.resume(), pause → station.pauseHere(), nexttrack → send('player:skip').
 */
export function useMediaSession(station: Station): void
```

```ts
// apps/web/src/player.ts
/** Stops this device only, as when something outside pauses it: the "Tap to resume audio" banner appears. */
SyncPlayer.pauseHere(): void
```

```ts
// apps/desktop/src/settings.ts
export const DEFAULT_STATION = 'https://music.devxdev.site'
/**
 * The origin of a typed station address, or null if it is not one.
 * Without a scheme: http:// for localhost, IPv4 addresses and *.local, https:// otherwise.
 * Only http and https are accepted. Any path, query or hash is dropped.
 */
export function normaliseStation(input: string): string | null
export function loadStation(dir: string): string   // DEFAULT_STATION when missing or invalid
export function saveStation(dir: string, url: string): void

// apps/desktop/src/navigation.ts
/** What the window does with a URL: stay on the station, open it in the default browser, or refuse it. */
export function navigationFor(url: string, station: string): 'allow' | 'external' | 'deny'

// apps/desktop/src/trayMenu.ts
export interface TrayItem { label: string; enabled: boolean; command?: DesktopCommand | 'show' | 'station' | 'quit' }
export function trayMenu(info: NowPlaying | null): TrayItem[]
```

## 6. Web app changes

**Media Session.** While joined with a current song, `useMediaSession` sets the title, channel and thumbnail. `playbackState` is `playing` when the station plays and this device is not paused, otherwise `paused`. The handlers:

- `pause` calls `station.pauseHere()`, which stops this device only. The existing "Tap to resume audio" banner appears.
- `play` calls `station.resume()`, which rejoins at the shared position.
- `nexttrack` sends `player:skip`, which skips for everyone and is announced as usual.

When not joined, or with nothing current, it clears the metadata and the handlers.

**Desktop bridge.** When `getDesktop()` returns a bridge:

- Whenever the song or status changes, `useDesktopBridge` calls `nowPlaying`.
- Commands from the tray send `player:play`, `player:pause` or `player:skip` through `station.send`.
- At start, `useStation` joins with the saved nickname. The existing rejoin-after-update path does this, now also taking the saved nickname inside the app. The "Updated to the latest version" toast still shows only after an update.

Browsers keep the Join screen and its Listen tap, which iOS needs to unlock audio.

## 7. Desktop app behaviour

**Start.**
- Takes a single-instance lock; a second launch shows the existing window and exits.
- Sets the `autoplay-policy=no-user-gesture-required` switch.
- Creates the window with `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `backgroundThrottling: false` and the preload.
- Loads the station URL from `settings.json`.

**Window.**
- On Mac the window has no title bar. The traffic lights sit in the page's header, and the app injects CSS that makes the header and a top strip drag the window and keeps the logo clear of the lights.
- Closing the window hides it while the music plays on.
- On Mac, the Dock icon shows it again; on Windows, clicking the tray icon does.
- Quit, from the tray, the app menu or ⌘Q, really exits.
- On Mac, the app menu includes the standard Edit menu so copy and paste work in the search box.

**Tray menu.**
- A disabled first line shows `title — channel`, or "Nothing playing".
- Then "Resume on this computer" while this computer is stopped and the station plays on, as after sleep (`stoppedHere` in `nowPlaying`). It sends `resumeHere`.
- Then "Pause for everyone" when the status is `playing`, otherwise "Play for everyone". It is disabled with nothing current, and while the status is `waiting` (the song is still downloading).
- Then "Skip for everyone", disabled with nothing current.
- Then a separator, "Show window", "Change station…", and "Quit".
- On Mac the menu bar shows the time left beside the icon, or "Paused", "Loading", or "Stopped" while this computer is stopped. A right-click opens the menu above. A click opens a card under the icon, like a live activity, with:
  - a "Tap to resume" banner at the top while this computer is stopped and the station plays on, as after sleep. A tap sends `resumeHere`, and the page rejoins at the shared position;
  - the song, the channel and the time left, and the thumbnail;
  - a progress bar that moves smoothly while the song plays;
  - "Ends at" a time on this computer's clock while playing;
  - play or pause and skip buttons, with the same rules as the menu;
  - a box to search for songs or paste a YouTube link. Return adds a link to Up next at once, or searches and lists the results, each with an add button, until Done or Escape;
  - Up next: the first 20 songs in the queue with their length, who added them and whether they are getting ready or failed, then how many more there are.
  A click on the song part of the card shows the window. A click elsewhere or Escape hides it; with a search open, Escape first clears it. The card grows with its list, up to the bottom of the screen. The page sends the song's length and position for this, and the position is on this computer's clock.
- The card cannot reach the station itself. The page sends its queue with `upNext`, and answers the card's searches and adds with `onRequest`. The app checks both, since the page is a remote site, and gives up on an answer after 30 seconds. A station page without `onRequest` gets a card without the search box and the list.
- The station page's header also has play or pause and skip buttons while a song is current, in the app and in browsers.
- The menu is rebuilt on every `nowPlaying` message.

**Sleep.**
- When the computer goes to sleep (`powerMonitor` `suspend`, on Mac and Windows), the app sends the page the `pauseHere` command. The page calls `station.pauseHere()`, the same as the Pause media key, so only this computer stops and the window shows the "Tap to resume audio" banner. Nothing happens while the station is paused.
- The page reports `stoppedHere: true` in `nowPlaying` until it resumes. The tray menu, the menu-bar title and the card show it as above.
- `resumeHere` calls `station.resume()`, which also measures the clock again, since a Mac's page clock stands still during sleep.
- Pages older than these commands ignore them, and apps older than `stoppedHere` drop it.

**Change station.**
- Opens a small window (`station.html`) with one address field filled with the current URL, plus Save and Cancel.
- Save runs `normaliseStation`.
- An invalid address shows an error under the field.
- A valid one is saved, the main window loads it, and the small window closes.

**Can't reach the station.**
- When the main frame fails to load (any error except an aborted navigation), the window shows `offline.html`.
- The page shows the address, a Retry button and "Change station…".
- It also retries every 10 s.

**IPC.** The preload exposes `window.desktop` with `nowPlaying` and `onCommand` only. The local pages need two more actions (`retry`, `saveStation`). The main process runs them only when the sender's URL is one of its own `file://` pages, so a station page cannot change the app's settings.

**Testing switch.** `MUSIC_STATION_MUTED=1` mutes the window's audio, for launch tests that must stay silent.

## 8. Security

The window shows a remote site, so:

- `navigationFor` allows only the station's origin in the main window. The page reloads itself after a deploy, which stays on that origin.
- Links to other http(s) sites, such as YouTube, open in the default browser, through `setWindowOpenHandler` and `will-navigate`.
- Everything else is refused.
- Permission requests (camera, microphone, notifications and the rest) are refused.
- The page gets no Node access; the bridge is two functions.

## 9. Build and release

**Local.** `pnpm --filter @music-station/desktop dev` runs the app against `STATION_URL`, which defaults to the saved station. `pnpm --filter @music-station/desktop dist` builds the Mac `.dmg` on a Mac.

**Mac.**
- Universal `.dmg` (Apple Silicon and Intel), ad-hoc signed.
- Before release, the build is checked with `codesign --verify`.
- Friends approve the first launch in System Settings → Privacy & Security → Open Anyway.

**Windows.**
- NSIS one-click `.exe`, x64, installed per user without admin rights.
- On first launch SmartScreen warns; friends click More info → Run anyway.

**CI.**
- Pushing a tag `desktop-v<version>` runs `.github/workflows/desktop.yml`.
- It builds on `macos-latest` and `windows-latest` and uploads both installers to a draft GitHub Release.
- The job fails if the tag does not match the `version` in `apps/desktop/package.json`.
- Publishing the draft is a manual step.
- Tags are pushed only when the owner asks.

**README.** A new "Desktop app" section covers:
- where to download it;
- the first-launch steps for Mac and Windows;
- changing the station;
- the media-key rule: Pause stops only this computer.

## 10. Testing

- **Web (vitest):**
  - `mediaSession.test.ts` uses a fake `navigator.mediaSession`. It checks the song info, `playbackState`, each handler's action, and the clearing when not joined.
  - `desktop.test.ts` uses a fake `window.desktop`. It checks `nowPlaying` on changes, commands to actions, the unsubscribe on unmount, and that nothing happens without a bridge or with a bridge missing functions.
  - `useStation.test.ts` checks the automatic join only inside the app with a saved nickname, and that no toast shows.
  - `player.test.ts` checks that `pauseHere()` pauses only this device and shows the banner, and that `resume()` rejoins at the shared position.
- **Desktop (vitest, no Electron):**
  - `settings.test.ts` covers schemes, IPs, `.local`, ports, junk input, and missing or corrupt files.
  - `navigation.test.ts` covers the same origin, other http(s) sites, and `file:`/`javascript:`/other schemes.
  - `trayMenu.test.ts` covers labels and enabled states for playing, paused, waiting and nothing current.
- **Launch test.** Run the built app with `MUSIC_STATION_MUTED=1` against the local station, then check:
  - the server's sync log shows the app joining on its own and reporting while hidden;
  - a screenshot shows the menu-bar menu with the song;
  - navigating to another site from DevTools opens nothing in the window.

## 11. Known risks

- **Media keys while hidden** rely on Chromium sending them to the page's Media Session. They can't be pressed in an automated test; the owner checks once by hand.
- **AirPods double-tap or a headset's next button** skips the song for everyone. It is announced to all listeners, like any skip.
- **Gatekeeper and SmartScreen** may get stricter with unsigned apps; signing can be added later without code changes.
- **Old installers** lack newer bridge features; the optional bridge functions keep them working.
