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
