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
