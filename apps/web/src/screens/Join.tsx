import { useState, type FormEvent } from 'react'
import type { Ack } from '@music-station/shared'
import { getNickname } from '../storage'
import { Icon, Logo } from '../ui'

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
    <main className="relative isolate flex min-h-dvh flex-col overflow-hidden px-6 pt-[max(env(safe-area-inset-top),1.5rem)] pb-[max(env(safe-area-inset-bottom),1.5rem)]">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-40 left-1/2 -z-10 size-[36rem] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,var(--color-glow),transparent)] opacity-30 blur-3xl"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-48 -left-24 -z-10 size-[28rem] rounded-full bg-[radial-gradient(closest-side,var(--color-accent),transparent)] opacity-15 blur-3xl"
      />

      <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-10">
        <header className="flex flex-col items-start gap-6">
          <Logo className="size-14" />
          <div className="flex flex-col gap-2">
            <h1 className="font-display text-4xl font-bold tracking-tight text-balance">Music Station</h1>
            <p className="text-lg text-muted text-pretty">
              One queue, every speaker. Everyone in the room hears the same song at the same moment.
            </p>
          </div>
        </header>

        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <div className="flex flex-col gap-2">
            <label htmlFor="nickname" className="text-sm font-medium text-ink">
              Your nickname
            </label>
            <input
              id="nickname"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              maxLength={24}
              autoFocus
              autoComplete="nickname"
              autoCapitalize="words"
              enterKeyHint="go"
              placeholder="e.g. Alex"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'join-error' : 'join-hint'}
              className="h-14 rounded-2xl bg-surface px-4 text-lg text-ink ring-1 ring-line transition-shadow outline-none placeholder:text-subtle focus:ring-2 focus:ring-accent aria-[invalid=true]:ring-danger"
            />
            {error ? (
              <p id="join-error" role="alert" className="flex items-center gap-1.5 text-sm text-danger">
                <Icon name="alert" className="size-4" />
                {error}
              </p>
            ) : (
              <p id="join-hint" className="text-sm text-subtle">
                Others in the station will see this name.
              </p>
            )}
          </div>

          <button
            type="submit"
            disabled={!connected || busy || name.length === 0}
            className="flex h-14 items-center justify-center gap-2 rounded-2xl bg-accent px-4 font-display text-lg font-semibold text-on-accent transition-[background-color,transform] duration-150 hover:bg-accent-hover active:scale-[0.98] disabled:bg-raised disabled:text-subtle"
          >
            {busy ? (
              <>
                <Icon name="spinner" />
                Joining…
              </>
            ) : connected ? (
              <>
                <Icon name="play" />
                Start listening
              </>
            ) : (
              <>
                <Icon name="spinner" />
                Connecting to station…
              </>
            )}
          </button>
        </form>
      </div>

      <p className="mx-auto mt-8 flex max-w-sm items-center gap-2 text-center text-xs text-subtle">
        <Icon name="volume" className="size-4" />
        Turn your volume up. Sound starts as soon as you join.
      </p>
    </main>
  )
}
