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
