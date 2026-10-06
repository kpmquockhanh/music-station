import { useEffect, useState } from 'react'
import type { DebugInfo } from '../useStation'

interface Props {
  delayMs: number
  setDelayMs(ms: number): void
  debug(): DebugInfo
  onClose(): void
}

const ms = (n: number | null) => (n === null || !Number.isFinite(n) ? '–' : `${Math.round(n)} ms`)

export function Settings({ delayMs, setDelayMs, debug, onClose }: Props) {
  const [info, setInfo] = useState(() => debug())

  useEffect(() => {
    const timer = setInterval(() => setInfo(debug()), 500)
    return () => clearInterval(timer)
  }, [debug])

  return (
    <div className="fixed inset-0 z-20 flex items-end bg-black/60" onClick={onClose}>
      <div
        role="dialog"
        aria-label="Settings"
        className="mx-auto w-full max-w-xl rounded-t-2xl bg-zinc-900 p-5 pb-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Settings</h2>
          <button onClick={onClose} className="text-zinc-400">
            Close
          </button>
        </div>
        <label className="flex flex-col gap-2">
          <span className="text-sm">
            Speaker delay: <b className="tabular-nums">{delayMs} ms</b>
          </span>
          <input
            type="range"
            min={0}
            max={500}
            step={10}
            value={delayMs}
            onChange={(e) => setDelayMs(Number(e.target.value))}
            className="accent-emerald-500"
          />
          <span className="text-xs text-zinc-500">Raise this if your speaker sounds behind the other devices.</span>
        </label>
        <dl className="mt-6 grid grid-cols-3 gap-2 text-center text-sm">
          <Stat label="Drift" value={ms(info.driftMs)} />
          <Stat label="Clock offset" value={ms(info.offsetMs)} />
          <Stat label="Round trip" value={ms(info.rttMs)} />
        </dl>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-zinc-950 p-2">
      <dt className="text-xs text-zinc-500">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  )
}
