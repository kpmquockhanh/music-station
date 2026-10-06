import { useState } from 'react'
import type { QueueItem } from '@music-station/shared'
import { formatTime } from '../format'
import { Icon, IconButton, type IconName } from '../ui'
import type { Station } from '../useStation'

export function Queue({ queue, send }: { queue: QueueItem[]; send: Station['send'] }) {
  const [open, setOpen] = useState<string | null>(null)

  if (queue.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-line px-6 py-10 text-center">
        <Icon name="queue" className="size-6 text-subtle" />
        <p className="font-medium">The queue is empty</p>
        <p className="text-sm text-muted">Songs you add from search will line up here.</p>
      </div>
    )
  }

  const move = (item: QueueItem, toIndex: number) => void send('queue:move', { itemId: item.id, toIndex })

  return (
    <ol className="flex flex-col gap-1">
      {queue.map((item, i) => {
        const expanded = open === item.id
        const actionsId = `queue-actions-${item.id}`
        return (
          <li
            key={item.id}
            className={`rounded-2xl transition-colors duration-150 ${expanded ? 'bg-surface ring-1 ring-line' : 'hover:bg-surface/60'}`}
          >
            <div className="flex items-center gap-3 p-2">
              <div className="relative shrink-0">
                <img
                  src={item.thumbnail}
                  alt=""
                  loading="lazy"
                  className={`h-12 w-[4.5rem] rounded-lg bg-raised object-cover ${item.status === 'failed' ? 'opacity-40 grayscale' : ''}`}
                />
                <span className="absolute -top-1.5 -left-1.5 grid size-5 place-items-center rounded-full bg-canvas font-display text-[11px] font-semibold tabular-nums text-muted ring-1 ring-line">
                  {i + 1}
                </span>
              </div>
              <div className="min-w-0 flex-1">
                <p className={`truncate text-sm font-medium ${item.status === 'failed' ? 'text-muted line-through' : ''}`}>
                  {item.title}
                </p>
                <p className="flex min-w-0 items-center gap-1.5 text-xs text-subtle">
                  <span className="shrink-0 tabular-nums">{formatTime(item.duration)}</span>
                  <span aria-hidden="true">·</span>
                  <span className="truncate">{item.addedBy}</span>
                  <StatusBadge status={item.status} />
                </p>
              </div>
              <IconButton
                label={expanded ? `Close actions for ${item.title}` : `Actions for ${item.title}`}
                icon={expanded ? 'x' : 'more'}
                aria-expanded={expanded}
                aria-controls={actionsId}
                onClick={() => setOpen(expanded ? null : item.id)}
              />
            </div>
            {expanded && (
              <div id={actionsId} className="grid animate-fade-in grid-cols-4 gap-1 px-2 pb-2">
                <Action icon="play-next" label="Play next" disabled={i === 0} onClick={() => move(item, 0)} />
                <Action icon="chevron-up" label="Up" disabled={i === 0} onClick={() => move(item, i - 1)} />
                <Action
                  icon="chevron-down"
                  label="Down"
                  disabled={i === queue.length - 1}
                  onClick={() => move(item, i + 1)}
                />
                <Action
                  icon="trash"
                  label="Remove"
                  danger
                  onClick={() => {
                    setOpen(null)
                    void send('queue:remove', { itemId: item.id })
                  }}
                />
              </div>
            )}
          </li>
        )
      })}
    </ol>
  )
}

interface ActionProps {
  icon: IconName
  label: string
  disabled?: boolean
  danger?: boolean
  onClick(): void
}

function Action({ icon, label, disabled, danger, onClick }: ActionProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`flex min-h-14 flex-col items-center justify-center gap-1 rounded-xl bg-raised text-xs font-medium transition-colors duration-150 disabled:opacity-35 ${
        danger ? 'text-danger hover:bg-danger/15' : 'text-ink hover:bg-overlay'
      }`}
    >
      <Icon name={icon} className="size-[18px]" />
      {label}
    </button>
  )
}

function StatusBadge({ status }: { status: QueueItem['status'] }) {
  if (status === 'downloading') {
    return (
      <span role="status" className="ml-auto flex shrink-0 items-center gap-1 text-warn">
        <Icon name="spinner" className="size-3" />
        <span className="max-[359px]:sr-only">Downloading</span>
      </span>
    )
  }
  if (status === 'failed') {
    return (
      <span className="ml-auto flex shrink-0 items-center gap-1 font-medium text-danger">
        <Icon name="alert" className="size-3" />
        Failed
      </span>
    )
  }
  return null
}
