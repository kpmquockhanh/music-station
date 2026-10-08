import { join } from 'node:path'
import { VIDEO_ID_RE, type DesktopReply, type DesktopRequest, type NowPlaying, type UpNext } from '@music-station/shared'
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  net,
  screen,
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
import { cardView, escapeMnemonic, menuBarTitle, parseNowPlaying, parseReply, parseUpNext, trayMenu, type TrayCommand } from './trayMenu'

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
let trayContextMenu: Menu | null = null
let nowPlaying: NowPlaying | null = null
let card: BrowserWindow | null = null
let cardHiddenAt = 0
/** The height the card's content asks for. */
let cardHeight = 0
/** The station page's queue, or null when the page cannot answer the card's requests. */
let upNext: UpNext | null = null
let pageAnswers = false
/** The card's requests waiting for the page's answer, by number. */
const waiting = new Map<number, (reply: DesktopReply) => void>()
let lastRequest = 0
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

// On a Mac the window has no title bar: the traffic lights sit in the page's 64 px header, centred on it.
// The station page is a remote site, so the app adds the drag areas and the room for the lights itself.
const MAC_FRAMELESS_CSS = `
  html::before { content: ''; position: fixed; inset: 0 0 auto; height: 4rem; -webkit-app-region: drag; }
  header.sticky { -webkit-app-region: drag; }
  :is(button, a, input, select, textarea, label, [role='button'], [tabindex]) { -webkit-app-region: no-drag; }
  header.sticky > div { padding-left: max(1rem, calc(6rem - max(0px, (100vw - 36rem) / 2))); }
  @media (min-width: 64rem) {
    header.sticky > div { padding-left: max(2rem, calc(6rem - max(0px, (100vw - 72rem) / 2))); }
  }
`

function createWindow(): void {
  win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 360,
    minHeight: 560,
    title: 'Music Station',
    backgroundColor: '#09090f',
    ...(isMac && { titleBarStyle: 'hidden', trafficLightPosition: { x: 20, y: 25 } }),
    // Full-speed timers while hidden, so sync holds with the window closed.
    webPreferences: webPreferences({ backgroundThrottling: false }),
  })
  const contents = win.webContents
  if (muted) contents.setAudioMuted(true)
  if (isMac) contents.on('dom-ready', () => void contents.insertCSS(MAC_FRAMELESS_CSS).catch(() => {}))
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
    forgetPage()
    setTray(null) // the new page reports its song once it joins
    // Cloudflare answers 502 or 530 while the station's computer is off.
    if (httpCode >= 500 && !isLocalPage(url)) showOffline()
  })
  contents.on('render-process-gone', (_event, details) => {
    if (!offlineAfterRendererGone(details.reason, quitting) || !win || win.isDestroyed()) return
    forgetPage()
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
  if (isMac) {
    // On a Mac a click shows the card with the song and its controls, and a right-click the menu.
    tray.setIgnoreDoubleClickEvents(true)
    card = createCard() // loaded ahead, so the first click shows it in place at once
    tray.on('click', toggleCard)
    tray.on('right-click', () => trayContextMenu && tray?.popUpContextMenu(trayContextMenu))
    setInterval(refreshMenuBar, 1_000) // the time left counts down
  } else {
    // On Windows a click shows the window and a right-click the menu.
    tray.on('click', showWindow)
  }
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
  trayContextMenu = Menu.buildFromTemplate(template)
  if (!isMac) tray.setContextMenu(trayContextMenu)
  nowPlaying = info
  refreshMenuBar()
}

/** The time left beside the Mac menu-bar icon, and the card while it shows. */
function refreshMenuBar(): void {
  if (!isMac || !tray) return
  const now = Date.now()
  tray.setTitle(menuBarTitle(nowPlaying, now), { fontType: 'monospacedDigit' })
  if (card?.isVisible()) card.webContents.send('card:view', cardView(nowPlaying, now, timeOfDay, pageAnswers ? upNext : null))
}

/** A new or gone station page has no queue and answers nothing still asked of the old one. */
function forgetPage(): void {
  upNext = null
  pageAnswers = false
  for (const answer of waiting.values()) answer({ ok: false, error: 'The station page reloaded. Try again.' })
  waiting.clear()
}

/** Asks the station page to do what the card asked, since only the page talks to the station. */
function askPage(request: DesktopRequest): Promise<DesktopReply> {
  const contents = win?.webContents
  if (!contents || !pageAnswers) return Promise.resolve({ ok: false, error: 'The station is not ready. Try again in a moment.' })
  const id = ++lastRequest
  return new Promise((resolve) => {
    // A search runs yt-dlp on the station's computer, which can take a while.
    const timer = setTimeout(() => answer({ ok: false, error: 'The station did not answer. Try again.' }), 30_000)
    function answer(reply: DesktopReply) {
      clearTimeout(timer)
      waiting.delete(id)
      resolve(reply)
    }
    waiting.set(id, answer)
    contents.send('desktop:request', id, request)
  })
}

const timeOfDay = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

const CARD_WIDTH = 380
const CARD_MIN_HEIGHT = 174

function toggleCard(): void {
  // Clicking the icon while the card shows first blurs the card, which hides it; that click must not show it again.
  if (!card || card.isVisible() || Date.now() - cardHiddenAt < 300) return hideCard()
  const icon = tray!.getBounds()
  const { workArea } = screen.getDisplayMatching(icon)
  const x = Math.round(icon.x + icon.width / 2 - CARD_WIDTH / 2)
  card.setPosition(
    Math.min(Math.max(x, workArea.x + 8), workArea.x + workArea.width - CARD_WIDTH - 8),
    Math.round(icon.y + icon.height + 6),
  )
  fitCard()
  refreshCard()
  card.show()
  card.focus() // so a click anywhere else blurs the card and hides it
}

/** Sizes the card to its content, growing down from the menu bar and no lower than the screen's bottom. */
function fitCard(): void {
  if (!card) return
  const bounds = card.getBounds()
  const { workArea } = screen.getDisplayMatching(bounds)
  const room = workArea.y + workArea.height - bounds.y - 8
  card.setSize(CARD_WIDTH, Math.max(CARD_MIN_HEIGHT, Math.min(cardHeight, room)))
}

function hideCard(): void {
  if (card?.isVisible()) card.hide()
}

function refreshCard(): void {
  card?.webContents.send('card:view', cardView(nowPlaying, Date.now(), timeOfDay, pageAnswers ? upNext : null))
}

function createCard(): BrowserWindow {
  const made = new BrowserWindow({
    width: CARD_WIDTH,
    height: CARD_MIN_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    acceptFirstMouse: true, // a click on a button works straight away
    type: 'panel', // floats over full-screen apps like a menu, and does not bring the main window forward
    webPreferences: webPreferences(),
  })
  made.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  made.on('blur', () => {
    made.hide()
    cardHiddenAt = Date.now()
  })
  const contents = made.webContents
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-navigate', (details) => details.preventDefault())
  contents.on('did-finish-load', refreshCard)
  made.loadFile(page('card.html')).catch(() => {})
  return made
}

function runTray(command: TrayCommand): void {
  if (command === 'show') return showWindow()
  if (command === 'station') return openStationWindow()
  if (command === 'quit') return app.quit()
  win?.webContents.send('desktop:command', command)
}

function listenToPages(): void {
  const fromStationPage = (event: IpcMainEvent) => win !== null && event.sender === win.webContents
  ipcMain.on('desktop:nowPlaying', (event, info: unknown) => {
    if (fromStationPage(event)) setTray(parseNowPlaying(info))
  })
  ipcMain.on('desktop:upNext', (event, queue: unknown) => {
    if (!fromStationPage(event)) return
    upNext = parseUpNext(queue)
    refreshMenuBar()
  })
  ipcMain.on('desktop:answers', (event, on: unknown) => {
    if (!fromStationPage(event)) return
    pageAnswers = on === true
    refreshMenuBar()
  })
  ipcMain.on('desktop:reply', (event, id: unknown, reply: unknown) => {
    if (fromStationPage(event) && typeof id === 'number') waiting.get(id)?.(parseReply(reply))
  })
  // The app's own pages only: the offline page, the Change station window and the menu-bar card. A station page cannot reach these.
  const fromLocalPage = (event: IpcMainEvent | IpcMainInvokeEvent) => isLocalPage(event.senderFrame?.url ?? '')
  ipcMain.handle('local:retry', async (event) => {
    if (!fromLocalPage(event) || !(await reachable(station))) return false
    loadStationPage()
    return true
  })
  ipcMain.on('local:command', (event, command: unknown) => {
    if (fromLocalPage(event) && (command === 'play' || command === 'pause' || command === 'skip')) {
      win?.webContents.send('desktop:command', command)
    }
  })
  ipcMain.on('local:showWindow', (event) => {
    if (!fromLocalPage(event)) return
    hideCard()
    showWindow()
  })
  // The card only: it loads nothing but card.html and cannot navigate.
  const fromCard = (event: IpcMainEvent | IpcMainInvokeEvent) => card !== null && event.sender === card.webContents
  const notAllowed: DesktopReply = { ok: false, error: 'Not allowed' }
  ipcMain.handle('local:submit', (event, text: unknown) =>
    fromCard(event) && typeof text === 'string' && text.length <= 500 ? askPage({ kind: 'submit', text }) : notAllowed,
  )
  ipcMain.handle('local:add', (event, videoId: unknown) =>
    fromCard(event) && typeof videoId === 'string' && VIDEO_ID_RE.test(videoId) ? askPage({ kind: 'add', videoId }) : notAllowed,
  )
  ipcMain.on('local:resizeCard', (event, height: unknown) => {
    if (!fromCard(event) || typeof height !== 'number' || !Number.isFinite(height)) return
    cardHeight = Math.ceil(height)
    fitCard()
  })
  ipcMain.on('local:hideCard', (event) => {
    if (fromLocalPage(event)) hideCard()
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
