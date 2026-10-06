import type { Listener } from '@music-station/shared'

export function Listeners({ listeners, me }: { listeners: Listener[]; me: string }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="px-1 text-sm font-semibold uppercase tracking-wide text-zinc-400">
        Listening ({listeners.length})
      </h2>
      <ul className="flex flex-wrap gap-2">
        {listeners.map((l) => (
          <li key={l.id} className="rounded-full bg-zinc-900 px-3 py-1 text-sm">
            {l.nickname}
            {l.id === me && <span className="text-zinc-500"> (you)</span>}
          </li>
        ))}
      </ul>
    </section>
  )
}
