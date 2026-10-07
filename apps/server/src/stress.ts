// Load test with simulated listeners: pnpm --filter @music-station/server stress -- [--url http://localhost:3001] [--clients 50] [--bursts 3]
// Each bot joins over Socket.IO, measures the clock like a phone, sends sync reports, and on every burst
// downloads the whole current song at the same moment, as all phones do when a song changes.
// Run it against a separate station: bots join the queue's listener list and every join is announced.
import { randomUUID } from 'node:crypto'
import { parseArgs } from 'node:util'
import { io, type Socket } from 'socket.io-client'
import type { StationState } from '@music-station/shared'

const { values: args } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'), // pnpm passes the separator through
  options: {
    url: { type: 'string', default: 'http://localhost:3001' },
    clients: { type: 'string', default: '50' },
    bursts: { type: 'string', default: '3' },
  },
})
const url = args.url
const clientCount = Number(args.clients)
const burstCount = Number(args.bursts)

interface Bot {
  socket: Socket
  state: StationState | null
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!
}
const fmt = (xs: number[], unit = 'ms') =>
  xs.length
    ? `p50 ${pct(xs, 50).toFixed(0)}${unit}  p95 ${pct(xs, 95).toFixed(0)}${unit}  max ${Math.max(...xs).toFixed(0)}${unit}  (n=${xs.length})`
    : 'no samples'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function connectBot(i: number): Promise<{ bot: Bot; joinMs: number }> {
  const started = performance.now()
  const socket = io(url, { transports: ['websocket'], reconnection: false, timeout: 10_000 })
  const bot: Bot = { socket, state: null }
  socket.on('state', (s: StationState) => (bot.state = s))
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('connect_error', reject)
  })
  const res = await socket.timeout(10_000).emitWithAck('join', { clientId: randomUUID(), nickname: `bot-${i}` })
  if (!res?.ok) throw new Error(`join failed: ${JSON.stringify(res)}`)
  return { bot, joinMs: performance.now() - started }
}

/** Like ClockSync.measure(): 8 pings, 100 ms apart. */
async function measureClock(bot: Bot): Promise<void> {
  for (let i = 0; i < 8; i++) {
    if (i > 0) await sleep(100)
    await bot.socket.timeout(2_000).emitWithAck('time:ping', Date.now()).catch(() => {})
  }
}

async function download(path: string): Promise<{ ms: number; bytes: number }> {
  const started = performance.now()
  const res = await fetch(new URL(path, url))
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const bytes = (await res.arrayBuffer()).byteLength
  return { ms: performance.now() - started, bytes }
}

// --- connect
console.log(`Stress test: ${clientCount} bots against ${url}\n`)
const bots: Bot[] = []
const joinTimes: number[] = []
let joinErrors = 0
for (let i = 0; i < clientCount; i++) {
  try {
    const { bot, joinMs } = await connectBot(i)
    bots.push(bot)
    joinTimes.push(joinMs)
  } catch (err) {
    joinErrors++
    if (joinErrors <= 3) console.log(`bot-${i}: ${String(err)}`)
  }
  await sleep(20) // people do not all tap Listen in the same millisecond
}
console.log(`joined     ${bots.length}/${clientCount}, ${joinErrors} failed`)
console.log(`join time  ${fmt(joinTimes)}`)
await sleep(500)

const current = bots[0]?.state?.current
if (!current || current.status !== 'ready') {
  console.log('\nThe station has no ready song. Add one and play it, then run again.')
  for (const b of bots) b.socket.disconnect()
  process.exit(1)
}
const songPath = `/audio/${current.videoId}.m4a`

// --- background load: a probe that pings every 100 ms, clock checks every 30 s, sync reports every 5 s
const probeRtts: { at: number; ms: number }[] = []
let probing = true
const probe = (async () => {
  const p = bots[0]!
  while (probing) {
    const t0 = performance.now()
    try {
      await p.socket.timeout(5_000).emitWithAck('time:ping', Date.now())
      probeRtts.push({ at: t0, ms: performance.now() - t0 })
    } catch {
      probeRtts.push({ at: t0, ms: 5_000 })
    }
    await sleep(100)
  }
})()
const timers = bots.map((b, i) => {
  const clock = setInterval(() => void measureClock(b), 30_000)
  const report = setInterval(
    () => b.socket.emit('debug:sync', { driftMs: 0, seeks: 0, rate: 1, bot: i }),
    5_000,
  )
  return () => {
    clearInterval(clock)
    clearInterval(report)
  }
})
await Promise.all(bots.map(measureClock)) // everyone measures on join

const idleStart = performance.now()
await sleep(3_000)
const idleRtts = probeRtts.filter((r) => r.at >= idleStart).map((r) => r.ms)

// --- bursts: every bot downloads the whole song at once, as on a song change
const downloadTimes: number[] = []
const burstRtts: number[] = []
let downloadErrors = 0
for (let n = 1; n <= burstCount; n++) {
  const started = performance.now()
  const results = await Promise.allSettled(bots.map(() => download(songPath)))
  const wall = performance.now() - started
  let bytes = 0
  const times: number[] = []
  for (const r of results) {
    if (r.status === 'fulfilled') {
      bytes += r.value.bytes
      times.push(r.value.ms)
    } else downloadErrors++
  }
  downloadTimes.push(...times)
  burstRtts.push(...probeRtts.filter((r) => r.at >= started && r.at <= started + wall).map((r) => r.ms))
  const late = times.filter((t) => t > 1_000).length
  console.log(
    `burst ${n}    ${(bytes / 1e6).toFixed(0)} MB in ${(wall / 1000).toFixed(2)}s = ${(bytes / 1e6 / (wall / 1000)).toFixed(0)} MB/s, ` +
      `${late}/${times.length} bots past the 1 s start lead`,
  )
  await sleep(3_000)
}

probing = false
await probe
for (const stop of timers) stop()
for (const b of bots) b.socket.disconnect()

console.log(`\ndownload   ${fmt(downloadTimes)}, ${downloadErrors} failed`)
console.log(`ping idle  ${fmt(idleRtts)}`)
console.log(`ping burst ${fmt(burstRtts)}`)
console.log(
  `\nThis measures the server and this machine's network path only. Phones share Wi-Fi airtime, so a burst over Wi-Fi is slower.`,
)
process.exit(0)
