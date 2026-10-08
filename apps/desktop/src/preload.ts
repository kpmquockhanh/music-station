import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { DesktopBridge, DesktopCommand, DesktopReply, DesktopRequest } from '@music-station/shared'

// The station page gets these functions and nothing else.
const desktop: DesktopBridge = {
  nowPlaying: (info) => ipcRenderer.send('desktop:nowPlaying', info),
  onCommand: (fn) => {
    const listener = (_event: IpcRendererEvent, command: DesktopCommand) => fn(command)
    ipcRenderer.on('desktop:command', listener)
    return () => {
      ipcRenderer.removeListener('desktop:command', listener)
    }
  },
  upNext: (queue) => ipcRenderer.send('desktop:upNext', queue),
  // The card's search box asks the page, and the page answers each request by its number.
  onRequest: (fn) => {
    const listener = (_event: IpcRendererEvent, id: number, request: DesktopRequest) => {
      const failed: DesktopReply = { ok: false, error: 'Something went wrong' }
      Promise.resolve()
        .then(() => fn(request))
        .catch(() => failed)
        .then((reply) => ipcRenderer.send('desktop:reply', id, reply))
    }
    ipcRenderer.on('desktop:request', listener)
    ipcRenderer.send('desktop:answers', true)
    return () => {
      ipcRenderer.removeListener('desktop:request', listener)
      ipcRenderer.send('desktop:answers', false)
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
    // The card under the Mac menu-bar icon.
    onCard: (fn: (view: unknown) => void) => {
      ipcRenderer.on('card:view', (_event, view: unknown) => fn(view))
    },
    command: (command: DesktopCommand) => ipcRenderer.send('local:command', command),
    showWindow: () => ipcRenderer.send('local:showWindow'),
    hideCard: () => ipcRenderer.send('local:hideCard'),
    submit: (text: string): Promise<DesktopReply> => ipcRenderer.invoke('local:submit', text),
    add: (videoId: string): Promise<DesktopReply> => ipcRenderer.invoke('local:add', videoId),
    resizeCard: (height: number) => ipcRenderer.send('local:resizeCard', height),
  })
}
