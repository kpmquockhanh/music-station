import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Icon, IconButton } from '../ui'
import type { DebugInfo } from '../useStation'

interface Props {
  delayMs: number
  setDelayMs(ms: number): void
  debug(): DebugInfo
  onClose(): void
}

const MAX_DELAY = 500
const STEP = 10

const ms = (n: number | null) => (n === null || !Number.isFinite(n) ? '–' : `${Math.round(n)} ms`)

function driftHealth(drift: number | null): { label: string; tone: string } {
  if (drift === null || !Number.isFinite(drift)) return { label: 'Waiting for audio', tone: 'text-subtle' }
  const abs = Math.abs(drift)
  if (abs < 60) return { label: 'In sync', tone: 'text-accent' }
  if (abs < 200) return { label: 'Slight drift', tone: 'text-warn' }
  return { label: 'Out of sync', tone: 'text-danger' }
}

export function Settings({ delayMs, setDelayMs, debug, onClose }: Props) {
  const [info, setInfo] = useState(() => debug())
  const closeRef = useRef<HTMLButtonElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    const timer = setInterval(() => setInfo(debug()), 500)
    return () => clearInterval(timer)
  }, [debug])

  // Focus moves into the sheet, Escape closes it, and focus returns to the opener afterwards.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current()
    }
    document.addEventListener('keydown', onKey)
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = overflow
      opener?.focus()
    }
  }, [])

  const health = driftHealth(info.driftMs)

  return (
    <div
      className="fixed inset-0 z-40 flex animate-fade-in items-end justify-center bg-black/70 backdrop-blur-sm sm:items-center sm:p-6"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        className="flex max-h-[90dvh] w-full max-w-lg animate-sheet-in flex-col gap-6 overflow-y-auto rounded-t-3xl bg-surface p-5 pb-[max(env(safe-area-inset-bottom),1.5rem)] ring-1 ring-line sm:animate-rise-in sm:rounded-3xl sm:pb-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div aria-hidden="true" className="mx-auto -mt-2 h-1 w-10 rounded-full bg-overlay sm:hidden" />
        <div className="flex items-center justify-between">
          <h2 id="settings-title" className="font-display text-xl font-semibold">
            Settings
          </h2>
          <IconButton ref={closeRef} label="Close settings" icon="x" variant="solid" onClick={onClose} />
        </div>

        <section className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between gap-3">
            <label htmlFor="speaker-delay" className="font-medium">
              Speaker delay
            </label>
            <output htmlFor="speaker-delay" className="font-display text-lg font-semibold tabular-nums">
              {delayMs} <span className="text-sm font-medium text-muted">ms</span>
            </output>
          </div>
          <div className="flex items-center gap-2">
            <IconButton
              label="Decrease delay"
              icon="minus"
              variant="solid"
              disabled={delayMs <= 0}
              onClick={() => setDelayMs(delayMs - STEP)}
            />
            <input
              id="speaker-delay"
              type="range"
              min={0}
              max={MAX_DELAY}
              step={STEP}
              value={delayMs}
              onChange={(e) => setDelayMs(Number(e.target.value))}
              aria-describedby="speaker-delay-hint"
              style={{ '--fill': `${(delayMs / MAX_DELAY) * 100}%` } as CSSProperties}
              className="range range-accent flex-1"
            />
            <IconButton
              label="Increase delay"
              icon="plus"
              variant="solid"
              disabled={delayMs >= MAX_DELAY}
              onClick={() => setDelayMs(delayMs + STEP)}
            />
          </div>
          <p id="speaker-delay-hint" className="text-sm text-muted">
            Raise this if your speaker sounds behind the other devices, for example over Bluetooth.
          </p>
        </section>

        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h3 className="font-medium">Sync status</h3>
            <span className={`flex items-center gap-1.5 text-sm font-medium ${health.tone}`}>
              <span aria-hidden="true" className="size-2 rounded-full bg-current" />
              {health.label}
            </span>
          </div>
          <dl className="grid grid-cols-3 gap-2">
            <Stat label="Drift" value={ms(info.driftMs)} />
            <Stat label="Clock offset" value={ms(info.offsetMs)} />
            <Stat label="Round trip" value={ms(info.rttMs)} />
          </dl>
          <p className="flex gap-2 text-xs text-subtle">
            <Icon name="alert" className="mt-px size-4" />
            Drift is how far your audio is from the station clock. It corrects itself within a few seconds.
          </p>
        </section>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-2xl bg-canvas p-3 ring-1 ring-line">
      <dt className="text-xs text-subtle">{label}</dt>
      <dd className="font-display text-base font-semibold tabular-nums">{value}</dd>
    </div>
  )
}
