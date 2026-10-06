import { Icon } from '../ui'
import type { Toast } from '../useStation'

export function Toasts({ toasts }: { toasts: Toast[] }) {
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-[max(env(safe-area-inset-bottom),1rem)] z-50 flex flex-col items-center gap-2 px-4"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.kind === 'error' ? 'alert' : undefined}
          className={`flex max-w-md animate-toast-in items-center gap-2.5 rounded-2xl px-4 py-3 text-sm font-medium shadow-2xl shadow-black/50 ring-1 backdrop-blur-md ${
            t.kind === 'error' ? 'bg-danger-strong/95 text-white ring-white/10' : 'bg-overlay/95 text-ink ring-line'
          }`}
        >
          <Icon name={t.kind === 'error' ? 'alert' : 'music'} className="size-4 opacity-80" />
          {t.text}
        </div>
      ))}
    </div>
  )
}
