import type { ComponentProps, ReactNode } from 'react'

// Lucide outlines (2px stroke). Transport glyphs are filled, the convention for player controls.
const OUTLINE = {
  search: (
    <>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </>
  ),
  x: <path d="M18 6 6 18M6 6l12 12" />,
  plus: <path d="M5 12h14M12 5v14" />,
  minus: <path d="M5 12h14" />,
  check: <path d="M20 6 9 17l-5-5" />,
  sliders: (
    <>
      <path d="M20 7h-9M14 17H5" />
      <circle cx="17" cy="17" r="3" />
      <circle cx="7" cy="7" r="3" />
    </>
  ),
  'chevron-up': <path d="m18 15-6-6-6 6" />,
  'chevron-down': <path d="m6 9 6 6 6-6" />,
  'play-next': <path d="M5 3h14M18 13l-6-6-6 6M12 7v14" />,
  trash: (
    <path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2M10 11v6M14 11v6" />
  ),
  more: (
    <>
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
      <circle cx="5" cy="12" r="1" />
    </>
  ),
  users: (
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </>
  ),
  queue: <path d="M21 15V6M18.5 18a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM12 12H3M16 6H3M12 18H3" />,
  link: (
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
  ),
  volume: (
    <path d="M11 4.7a.7.7 0 0 0-1.2-.5L6.4 7.6a1.4 1.4 0 0 1-1 .4H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.4a1.4 1.4 0 0 1 1 .4l3.4 3.4a.7.7 0 0 0 1.2-.5ZM16 9a5 5 0 0 1 0 6M19.4 18.4a9 9 0 0 0 0-12.8" />
  ),
  alert: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 8v4M12 16h.01" />
    </>
  ),
  music: (
    <>
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </>
  ),
  spinner: <path d="M21 12a9 9 0 1 1-6.22-8.56" />,
} as const

const FILLED = {
  play: <path d="M7 4.6a1 1 0 0 1 1.5-.86l11 7.4a1 1 0 0 1 0 1.72l-11 7.4A1 1 0 0 1 7 19.4z" />,
  pause: (
    <>
      <rect x="6" y="4" width="4" height="16" rx="1.2" />
      <rect x="14" y="4" width="4" height="16" rx="1.2" />
    </>
  ),
  skip: (
    <>
      <path d="M5 5.6a1 1 0 0 1 1.5-.86l9 6.4a1 1 0 0 1 0 1.72l-9 6.4A1 1 0 0 1 5 18.4z" />
      <rect x="17" y="4.5" width="2.6" height="15" rx="1.1" />
    </>
  ),
} as const

export type IconName = keyof typeof OUTLINE | keyof typeof FILLED

export function Icon({ name, className = 'size-5' }: { name: IconName; className?: string }) {
  const filled = name in FILLED
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      className={`${className} shrink-0 ${name === 'spinner' ? 'animate-spin' : ''}`}
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {filled ? FILLED[name as keyof typeof FILLED] : OUTLINE[name as keyof typeof OUTLINE]}
    </svg>
  )
}

interface IconButtonProps extends ComponentProps<'button'> {
  label: string
  icon: IconName
  /** ghost: no fill until hovered; solid: a raised chip. */
  variant?: 'ghost' | 'solid'
}

/** A 44px square icon button with an accessible name. */
export function IconButton({ label, icon, variant = 'ghost', className = '', ...rest }: IconButtonProps) {
  const look =
    variant === 'solid' ? 'bg-raised text-ink hover:bg-overlay' : 'text-muted hover:bg-raised hover:text-ink'
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`grid size-11 shrink-0 place-items-center rounded-xl transition-colors duration-150 active:bg-overlay disabled:pointer-events-none disabled:opacity-35 ${look} ${className}`}
      {...rest}
    >
      <Icon name={icon} />
    </button>
  )
}

/** The station's mark: bouncing bars on a green tile. */
export function Logo({ className = 'size-9' }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`grid shrink-0 place-items-center rounded-xl bg-accent text-on-accent shadow-[0_0_24px_-4px_rgb(34_197_94/0.55)] ${className}`}
    >
      <svg viewBox="0 0 32 32" className="size-[70%]" fill="none" stroke="currentColor" strokeWidth={2.75} strokeLinecap="round">
        <path d="M8 20v-6M13 23V9M18 20v-8M23 18v-4" />
      </svg>
    </span>
  )
}

export function Equalizer({ playing, className = '' }: { playing: boolean; className?: string }) {
  return (
    <span aria-hidden="true" className={`eq ${playing ? '' : 'eq-paused'} ${className}`}>
      <span />
      <span />
      <span />
    </span>
  )
}

const AVATAR_HUES = [152, 199, 262, 330, 28, 48, 286, 174]

function hueFor(name: string): number {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return AVATAR_HUES[h % AVATAR_HUES.length]!
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  const first = [...parts[0]!][0] ?? ''
  const second = parts.length > 1 ? ([...parts[parts.length - 1]!][0] ?? '') : ([...parts[0]!][1] ?? '')
  return (first + second).toUpperCase()
}

/** A colored initials disc. The color is stable per nickname so people are easy to spot. */
export function Avatar({ name, className = 'size-9 text-xs', ring = false }: { name: string; className?: string; ring?: boolean }) {
  const hue = hueFor(name)
  return (
    <span
      aria-hidden="true"
      style={{ backgroundColor: `hsl(${hue} 55% 24%)`, color: `hsl(${hue} 90% 82%)` }}
      className={`grid shrink-0 place-items-center rounded-full font-display font-semibold ${ring ? 'ring-2 ring-canvas' : ''} ${className}`}
    >
      {initials(name)}
    </span>
  )
}

export function SectionTitle({ children, count }: { children: ReactNode; count?: number }) {
  return (
    <h2 className="flex items-center gap-2 font-display text-base font-semibold tracking-tight text-ink">
      {children}
      {count !== undefined && (
        <span className="rounded-full bg-raised px-2 py-0.5 text-xs font-medium tabular-nums text-muted">{count}</span>
      )}
    </h2>
  )
}
