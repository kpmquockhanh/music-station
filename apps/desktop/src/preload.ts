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
