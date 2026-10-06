export interface ClockSample {
  offset: number
  rtt: number
}

export function sampleOffset(t0: number, ts: number, t1: number): ClockSample {
  return { offset: ts - (t0 + t1) / 2, rtt: t1 - t0 }
}

export function bestSample(samples: ClockSample[]): ClockSample | null {
  let best: ClockSample | null = null
  for (const s of samples) if (!best || s.rtt < best.rtt) best = s
  return best
}

export type PingFn = () => Promise<number>

export interface ClockSyncOptions {
  count?: number
  gapMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export class ClockSync {
  offset = 0
  rtt = Number.POSITIVE_INFINITY
  synced = false
  private readonly count: number
  private readonly gapMs: number
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private running: Promise<void> | null = null

  constructor(
    private readonly ping: PingFn,
    opts: ClockSyncOptions = {},
  ) {
    this.count = opts.count ?? 8
    this.gapMs = opts.gapMs ?? 100
    this.now = opts.now ?? (() => performance.timeOrigin + performance.now())
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  }

  serverNow(): number {
    return this.now() + this.offset
  }

  measure(): Promise<void> {
    this.running ??= this.run().finally(() => {
      this.running = null
    })
    return this.running
  }

  private async run(): Promise<void> {
    const samples: ClockSample[] = []
    for (let i = 0; i < this.count; i++) {
      if (i > 0) await this.sleep(this.gapMs)
      const t0 = this.now()
      try {
        const ts = await this.ping()
        samples.push(sampleOffset(t0, ts, this.now()))
      } catch {
        // A lost or timed-out ping is skipped; the others are enough.
      }
    }
    const best = bestSample(samples)
    if (!best) return
    this.offset = best.offset
    this.rtt = best.rtt
    this.synced = true
  }
}
