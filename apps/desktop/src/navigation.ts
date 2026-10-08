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
 * True for the app's own pages, which alone may retry or change the station and send the menu-bar card's commands. The windows can never navigate to a
 * file: URL (navigationFor refuses them), so the path's ending is enough; an exact path would have to match how
 * Chromium spells drive letters and non-ASCII folder names.
 */
export function isLocalPage(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'file:' && /\/pages\/(offline|station|card)\.html$/.test(u.pathname)
  } catch {
    return false
  }
}

/**
 * Whether a renderer that has gone should give way to the offline page, whose retry brings the station back. A clean
 * exit is the window closing; any other reason (a crash, a kill, or Chromium discarding a hidden page to save memory)
 * would otherwise leave a blank window and silence.
 */
export function offlineAfterRendererGone(reason: string, quitting: boolean): boolean {
  return !quitting && reason !== 'clean-exit'
}
