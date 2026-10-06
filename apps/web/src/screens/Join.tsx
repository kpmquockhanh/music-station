import { useState, type FormEvent } from 'react'
import type { Ack } from '@music-station/shared'
import { getNickname } from '../storage'

interface Props {
  connected: boolean
  onJoin(nickname: string): Promise<Ack>
}

export function Join({ connected, onJoin }: Props) {
  const [nickname, setNickname] = useState(() => getNickname())
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const name = nickname.trim()

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const res = await onJoin(name) // onJoin unlocks audio before its first await, inside this tap
    setBusy(false)
    if (!res.ok) setError(res.error)
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 p-6">
      <h1 className="text-3xl font-bold">Music Station</h1>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <label htmlFor="nickname" className="text-sm text-zinc-400">
          Your nickname
        </label>
        <input
          id="nickname"
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
          maxLength={24}
          autoFocus
          autoComplete="nickname"
          className="rounded-lg bg-zinc-900 px-4 py-3 text-lg outline-none ring-1 ring-zinc-800 focus:ring-emerald-500"
        />
        <button
          disabled={!connected || busy || name.length === 0}
          className="rounded-lg bg-emerald-500 px-4 py-3 text-lg font-semibold text-zinc-950 disabled:opacity-40"
        >
          {connected ? 'Listen' : 'Connecting…'}
        </button>
        {error && <p className="text-sm text-red-400">{error}</p>}
      </form>
    </main>
  )
}
