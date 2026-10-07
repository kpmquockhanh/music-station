export interface DownloadOptions {
  /** Tries in all, the first one included. */
  attempts?: number
  /** An attempt that receives no bytes for this long is given up and retried. */
  stallMs?: number
  /** Wait before each retry; the last value repeats. */
  backoffMs?: number[]
  fetch?: typeof fetch
}

const ATTEMPTS = 3
const STALL_MS = 15_000
const BACKOFF_MS = [1_000, 3_000]

/** A failure worth another try: the network, a stall, or the server being briefly unable to answer. */
class Retryable extends Error {}
/** A reply that another try would not change, like 404 for a song the server no longer has. */
class Refused extends Error {}

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => (clearTimeout(timer), reject(signal.reason)), { once: true })
  })

/**
 * Downloads a whole song, retrying on network errors, stalls and 5xx replies. A slow but steady download is
 * left alone however long it takes; only one that stops receiving bytes is cut. Rejects when every attempt
 * failed, so the caller can fall back to streaming, or at once when the signal aborts.
 */
export async function downloadSong(url: string, signal: AbortSignal, opts: DownloadOptions = {}): Promise<Blob> {
  const attempts = opts.attempts ?? ATTEMPTS
  const backoff = opts.backoffMs ?? BACKOFF_MS
  for (let i = 0; ; i++) {
    try {
      return await attempt(url, signal, opts.stallMs ?? STALL_MS, opts.fetch ?? fetch)
    } catch (err) {
      if (signal.aborted || !(err instanceof Retryable) || i + 1 >= attempts) throw err
      await wait(backoff[Math.min(i, backoff.length - 1)] ?? 0, signal)
    }
  }
}

async function attempt(url: string, outer: AbortSignal, stallMs: number, fetchFn: typeof fetch): Promise<Blob> {
  const ctrl = new AbortController()
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  // Aborting the request does not always end a body already being read, so cancel the reader too.
  const stop = (reason?: unknown) => {
    ctrl.abort(reason)
    void reader?.cancel().catch(() => {})
  }
  const onAbort = () => stop(outer.reason)
  outer.addEventListener('abort', onAbort, { once: true })
  let stalled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      stalled = true
      stop()
    }, stallMs)
  }
  try {
    arm()
    const res = await fetchFn(url, { signal: ctrl.signal })
    if (!res.ok) {
      const retry = res.status >= 500 || res.status === 408 || res.status === 429
      throw new (retry ? Retryable : Refused)(`HTTP ${res.status}`)
    }
    const type = res.headers.get('content-type') ?? ''
    if (!res.body) return new Blob([await res.arrayBuffer()], { type })
    const chunks: Uint8Array[] = []
    reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      arm()
    }
    if (ctrl.signal.aborted) throw new Error('Download cut short') // a cancelled reader ends as if done
    return new Blob(chunks as BlobPart[], { type })
  } catch (err) {
    if (outer.aborted) throw outer.reason ?? err
    if (stalled) throw new Retryable(`No data for ${Math.round(stallMs / 1000)}s`)
    if (err instanceof Retryable || err instanceof Refused) throw err
    throw new Retryable(err instanceof Error ? err.message : String(err)) // the network failed
  } finally {
    clearTimeout(timer)
    outer.removeEventListener('abort', onAbort)
  }
}
