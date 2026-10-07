import { useRef, useState, type KeyboardEvent } from 'react'
import type { Listener } from '@music-station/shared'
import { Join } from './screens/Join'
import { Listeners } from './screens/Listeners'
import { NowPlaying } from './screens/NowPlaying'
import { Queue } from './screens/Queue'
import { Search } from './screens/Search'
import { Settings } from './screens/Settings'
import { Toasts } from './screens/Toasts'
import { useDesktopBridge } from './desktop'
import { useMediaSession } from './mediaSession'
import { Avatar, Icon, IconButton, Logo, type IconName } from './ui'
import { useStation } from './useStation'

type Tab = 'queue' | 'listeners'

export function App() {
  const station = useStation()
  useMediaSession(station)
  useDesktopBridge(station)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [tab, setTab] = useState<Tab>('queue')
  const { state } = station

  if (!station.joined || !state) {
    return (
      <>
        {station.autoJoining ? (
          <Joining connected={station.connected} />
        ) : (
          <Join connected={station.connected} onJoin={station.join} />
        )}
        <Toasts toasts={station.toasts} />
      </>
    )
  }

  return (
    <div className="min-h-dvh pb-[max(env(safe-area-inset-bottom),2rem)]">
      <header className="sticky top-0 z-30 border-b border-line/60 bg-canvas/80 pt-[env(safe-area-inset-top)] backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-xl items-center gap-3 px-4 lg:max-w-6xl lg:px-8">
          <Logo />
          <div className="flex min-w-0 flex-1 flex-col">
            <h1 className="truncate font-display text-lg leading-tight font-semibold tracking-tight">Music Station</h1>
            <ConnectionStatus connected={station.connected} listeners={state.listeners.length} />
          </div>
          <button
            type="button"
            onClick={() => setTab('listeners')}
            aria-label={`${state.listeners.length} listening. Show listeners`}
            className="hidden rounded-full p-1 transition-colors hover:bg-raised min-[400px]:flex"
          >
            <AvatarStack listeners={state.listeners} />
          </button>
          <IconButton label="Settings" icon="sliders" onClick={() => setSettingsOpen(true)} />
        </div>
      </header>

      <main className="mx-auto flex max-w-xl flex-col gap-6 px-4 pt-4 lg:grid lg:max-w-6xl lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:items-start lg:gap-10 lg:px-8 lg:pt-8">
        {station.blocked && (
          <button
            type="button"
            onClick={station.resume}
            className="flex animate-rise-in items-center gap-3 rounded-2xl bg-warn p-4 text-left text-zinc-950 shadow-[0_8px_28px_-8px_rgb(251_191_36/0.6)] transition-transform active:scale-[0.99] lg:col-span-2"
          >
            <span className="grid size-10 shrink-0 place-items-center rounded-full bg-zinc-950/10">
              <Icon name="volume" />
            </span>
            <span className="flex flex-col">
              <span className="font-display font-semibold">Tap to resume audio</span>
              <span className="text-sm opacity-80">Your browser paused the sound. The station kept playing.</span>
            </span>
          </button>
        )}

        <div className="lg:sticky lg:top-24">
          <NowPlaying current={state.current} playback={state.playback} serverNow={station.serverNow} send={station.send} />
        </div>

        <div className="flex min-w-0 flex-col gap-6">
          <Search send={station.send} notify={station.notify} />
          <section aria-label="Station" className="flex flex-col gap-3">
            <Tabs
              tab={tab}
              setTab={setTab}
              items={[
                { id: 'queue', label: 'Up next', icon: 'queue', count: state.queue.length },
                { id: 'listeners', label: 'Listeners', icon: 'users', count: state.listeners.length },
              ]}
            />
            <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
              {tab === 'queue' ? (
                <Queue queue={state.queue} autoplay={state.autoplay} send={station.send} />
              ) : (
                <Listeners listeners={state.listeners} me={station.clientId} />
              )}
            </div>
          </section>
        </div>
      </main>

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

/** Shown instead of the Join screen while the app, or a tab that just updated, joins with the saved nickname. */
function Joining({ connected }: { connected: boolean }) {
  return (
    <main className="grid min-h-dvh place-items-center px-6">
      <p role="status" className="flex items-center gap-2 text-muted">
        <Icon name="spinner" />
        {connected ? 'Joining the station…' : 'Connecting to station…'}
      </p>
    </main>
  )
}

function ConnectionStatus({ connected, listeners }: { connected: boolean; listeners: number }) {
  return (
    <p role="status" className="flex items-center gap-1.5 text-xs text-muted">
      <span className="relative flex size-2">
        {connected && (
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-accent opacity-60 motion-reduce:hidden" />
        )}
        <span className={`relative inline-flex size-2 rounded-full ${connected ? 'bg-accent' : 'bg-warn'}`} />
      </span>
      {connected ? (
        <span>
          Live · {listeners} listening
        </span>
      ) : (
        <span className="text-warn">Reconnecting…</span>
      )}
    </p>
  )
}

function AvatarStack({ listeners }: { listeners: Listener[] }) {
  const shown = listeners.slice(0, 3)
  const extra = listeners.length - shown.length
  return (
    <span className="flex -space-x-2">
      {shown.map((l) => (
        <Avatar key={l.id} name={l.nickname} ring className="size-8 text-[11px]" />
      ))}
      {extra > 0 && (
        <span className="grid size-8 place-items-center rounded-full bg-raised font-display text-[11px] font-semibold text-muted ring-2 ring-canvas">
          +{extra}
        </span>
      )}
    </span>
  )
}

interface TabItem {
  id: Tab
  label: string
  icon: IconName
  count: number
}

function Tabs({ tab, setTab, items }: { tab: Tab; setTab(t: Tab): void; items: TabItem[] }) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({})

  // Arrow keys move between tabs, as the ARIA tabs pattern expects.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    const i = items.findIndex((t) => t.id === tab)
    const next = items[(i + (e.key === 'ArrowRight' ? 1 : items.length - 1)) % items.length]!
    setTab(next.id)
    refs.current[next.id]?.focus()
  }

  return (
    <div role="tablist" aria-label="Station" onKeyDown={onKeyDown} className="flex gap-1 rounded-2xl bg-surface p-1 ring-1 ring-line">
      {items.map((t) => {
        const selected = t.id === tab
        return (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[t.id] = el
            }}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={selected}
            aria-controls={`panel-${t.id}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => setTab(t.id)}
            className={`flex h-11 flex-1 items-center justify-center gap-2 rounded-xl text-sm font-medium transition-colors duration-150 ${
              selected ? 'bg-raised text-ink shadow-sm' : 'text-muted hover:text-ink'
            }`}
          >
            <Icon name={t.icon} className="size-[18px]" />
            {t.label}
            <span
              className={`rounded-full px-1.5 py-px text-xs tabular-nums ${selected ? 'bg-accent/15 text-accent' : 'bg-raised text-subtle'}`}
            >
              {t.count}
            </span>
          </button>
        )
      })}
    </div>
  )
}
