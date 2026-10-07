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
import { isLocalPage, navigationFor, offlineAfterRendererGone } from './navigation'
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
  contents.on('render-process-gone', (_event, details) => {
    if (!offlineAfterRendererGone(details.reason, quitting) || !win || win.isDestroyed()) return
    setTray(null)
    showOffline()
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
