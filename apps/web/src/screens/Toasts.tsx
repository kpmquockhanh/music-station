import type { Toast } from '../useStation'

export function Toasts({ toasts }: { toasts: Toast[] }) {
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-4 z-30 flex flex-col items-center gap-2 px-4"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`max-w-md rounded-lg px-4 py-2 text-sm shadow-lg ${
            t.kind === 'error' ? 'bg-red-600 text-white' : 'bg-zinc-800 text-zinc-100'
          }`}
        >
          {t.text}
        </div>
      ))}
    </div>
  )
}
