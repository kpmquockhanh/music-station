import { useState } from 'react'
import { Join } from './screens/Join'
import { Listeners } from './screens/Listeners'
import { NowPlaying } from './screens/NowPlaying'
import { Queue } from './screens/Queue'
import { Search } from './screens/Search'
import { Settings } from './screens/Settings'
import { Toasts } from './screens/Toasts'
import { useStation } from './useStation'

export function App() {
  const station = useStation()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const { state } = station

  if (!station.joined || !state) return <Join connected={station.connected} onJoin={station.join} />

  return (
    <div className="mx-auto flex min-h-dvh max-w-xl flex-col gap-5 p-4 pb-24">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Music Station</h1>
        <div className="flex items-center gap-2">
          {!station.connected && (
            <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-xs text-amber-300">Reconnecting…</span>
          )}
          <button onClick={() => setSettingsOpen(true)} className="rounded-lg bg-zinc-900 px-3 py-1.5 text-sm">
            Settings
          </button>
        </div>
      </header>

      {station.blocked && (
        <button onClick={station.resume} className="rounded-xl bg-amber-500 p-3 font-semibold text-zinc-950">
          Tap to resume audio
        </button>
      )}

      <NowPlaying current={state.current} playback={state.playback} serverNow={station.serverNow} send={station.send} />
      <Search send={station.send} notify={station.notify} />
      <Queue queue={state.queue} send={station.send} />
      <Listeners listeners={state.listeners} me={station.clientId} />

      {settingsOpen && (
        <Settings
          delayMs={station.delayMs}
          setDelayMs={station.setDelayMs}
          debug={station.debug}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      <Toasts toasts={station.toasts} />
    </div>
  )
}
