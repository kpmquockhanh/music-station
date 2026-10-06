import { describe, expect, it, vi } from 'vitest'
import { bestSample, ClockSync, sampleOffset } from './clockSync'

const SERVER_AHEAD_MS = 5_000

/** A fake network: each ping takes `rtts[i]` ms. `outShare` is the fraction of that spent before the server reads its clock. */
function fakeNetwork(rtts: (number | undefined)[], outShare: number[] = rtts.map(() => 0.5)) {
  let local = 1_000
  let i = 0
  const ping = vi.fn(async () => {
    const k = i++
    const rtt = rtts[k]
    if (rtt === undefined) throw new Error('lost')
    local += rtt * outShare[k]!
    const ts = local + SERVER_AHEAD_MS
    local += rtt * (1 - outShare[k]!)
    return ts
  })
  const opts = {
    now: () => local,
    sleep: async (ms: number) => {
      local += ms
    },
  }
  return { ping, opts, local: () => local }
}

describe('sampleOffset', () => {
  it('uses the midpoint of the round trip', () => {
    expect(sampleOffset(1_000, 6_050, 1_100)).toEqual({ offset: 5_000, rtt: 100 })
  })
})

describe('bestSample', () => {
  it('picks the smallest round trip', () => {
    expect(bestSample([{ offset: 1, rtt: 90 }, { offset: 2, rtt: 15 }, { offset: 3, rtt: 40 }])).toEqual({ offset: 2, rtt: 15 })
  })

  it('returns null for no samples', () => {
    expect(bestSample([])).toBeNull()
  })
})

describe('ClockSync', () => {
  it('trusts the fastest ping over slow, lopsided ones', async () => {
    // Ping 0 is slow and lopsided (alone it would give an offset of 4 950); ping 2 is fast and even.
    const net = fakeNetwork([200, 80, 20, 60, 90, 70, 50, 120], [0.25, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5])
    const clock = new ClockSync(net.ping, net.opts)
    await clock.measure()
    expect(net.ping).toHaveBeenCalledTimes(8)
    expect(clock.offset).toBe(SERVER_AHEAD_MS)
    expect(clock.rtt).toBe(20)
    expect(clock.synced).toBe(true)
    expect(clock.serverNow()).toBe(net.local() + SERVER_AHEAD_MS)
  })

  it('waits gapMs between pings', async () => {
    const net = fakeNetwork([10, 10, 10])
    const clock = new ClockSync(net.ping, { ...net.opts, count: 3, gapMs: 100 })
    await clock.measure()
    expect(net.local()).toBe(1_000 + 3 * 10 + 2 * 100)
  })

  it('shares one run between concurrent callers', async () => {
    const net = fakeNetwork([10, 10, 10, 10, 10, 10, 10, 10])
    const clock = new ClockSync(net.ping, net.opts)
    await Promise.all([clock.measure(), clock.measure()])
    expect(net.ping).toHaveBeenCalledTimes(8)
  })

  it('skips lost pings and keeps the old offset when all are lost', async () => {
    const some = fakeNetwork([30, undefined, 30])
    const partial = new ClockSync(some.ping, { ...some.opts, count: 3 })
    await partial.measure()
    expect(partial.offset).toBe(SERVER_AHEAD_MS)

    const none = fakeNetwork([])
    const lost = new ClockSync(none.ping, { ...none.opts, count: 3 })
    await lost.measure()
    expect(lost.synced).toBe(false)
    expect(lost.offset).toBe(0)
  })
})
