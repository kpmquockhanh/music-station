import type { Listener } from '@music-station/shared'
import { Avatar } from '../ui'

export function Listeners({ listeners, me }: { listeners: Listener[]; me: string }) {
  // You first, then everyone else in join order.
  const sorted = [...listeners].sort((a, b) => Number(b.id === me) - Number(a.id === me))
  return (
    <ul className="grid grid-cols-1 gap-1 min-[420px]:grid-cols-2">
      {sorted.map((l) => (
        <li key={l.id} className="flex min-w-0 items-center gap-3 rounded-2xl p-2">
          <Avatar name={l.nickname} />
          <span className="min-w-0 truncate font-medium">{l.nickname}</span>
          {l.id === me && (
            <span className="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-xs font-medium text-accent">You</span>
          )}
        </li>
      ))}
    </ul>
  )
}
