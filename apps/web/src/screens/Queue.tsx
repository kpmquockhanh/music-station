import type { ReactNode } from 'react'
import type { QueueItem } from '@music-station/shared'
import { formatTime } from '../format'
import type { Station } from '../useStation'

export function Queue({ queue, send }: { queue: QueueItem[]; send: Station['send'] }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="px-1 text-sm font-semibold uppercase tracking-wide text-zinc-400">Up next ({queue.length})</h2>
      {queue.length === 0 && <p className="px-1 text-sm text-zinc-500">The queue is empty.</p>}
      <ul className="flex flex-col gap-2">
        {queue.map((item, i) => (
          <li key={item.id} className="flex items-center gap-3 rounded-xl bg-zinc-900 p-2">
            <img src={item.thumbnail} alt="" className="h-12 w-20 shrink-0 rounded object-cover" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">{item.title}</p>
              <p className="flex items-center gap-1 truncate text-xs text-zinc-500">
                {formatTime(item.duration)} · {item.addedBy}
                <StatusBadge status={item.status} />
              </p>
            </div>
            <div className="flex shrink-0 gap-1">
              <IconButton
                label="Move up"
                disabled={i === 0}
                onClick={() => void send('queue:move', { itemId: item.id, toIndex: i - 1 })}
              >
                ↑
              </IconButton>
              <IconButton
                label="Move down"
                disabled={i === queue.length - 1}
                onClick={() => void send('queue:move', { itemId: item.id, toIndex: i + 1 })}
              >
                ↓
              </IconButton>
              <IconButton label="Remove" onClick={() => void send('queue:remove', { itemId: item.id })}>
                ✕
              </IconButton>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

function StatusBadge({ status }: { status: QueueItem['status'] }) {
  if (status === 'downloading') {
    return (
      <span
        role="status"
        aria-label="Downloading"
        className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-amber-400 border-t-transparent"
      />
    )
  }
  if (status === 'failed') return <span className="font-semibold text-red-400">failed</span>
  return null
}

interface IconButtonProps {
  label: string
  disabled?: boolean
  onClick(): void
  children: ReactNode
}

function IconButton({ label, disabled, onClick, children }: IconButtonProps) {
  return (
    <button
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="h-9 w-9 rounded-lg bg-zinc-800 text-zinc-300 disabled:opacity-30"
    >
      {children}
    </button>
  )
}
