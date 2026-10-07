// Evaluates JavaScript in a running Music Station window over the DevTools protocol, for launch tests.
// Start the app with --remote-debugging-port=9333, then:
//   node scripts/cdp.mjs 9333 'document.title' [url-part]      prints the result as JSON
//   node scripts/cdp.mjs 9333 --wait 'expression' [url-part]   retries for up to 30 s until the result is truthy
//   node scripts/cdp.mjs 9333 --list                           prints the open windows' URLs
const args = process.argv.slice(2)
const port = args.shift()
let wait = false
if (args[0] === '--wait') {
  wait = true
  args.shift()
}
const [expression, urlPart = ''] = args

async function pages() {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  return targets.filter((t) => t.type === 'page')
}

async function evaluate() {
  const target = (await pages()).find((t) => t.url.includes(urlPart))
  if (!target) throw new Error(`no window matches "${urlPart}"`)
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = () => reject(new Error('could not connect'))
  })
  try {
    const params = { expression, awaitPromise: true, returnByValue: true }
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params }))
    const reply = await new Promise((resolve) => {
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data)
        if (msg.id === 1) resolve(msg)
      }
    })
    const { result, exceptionDetails } = reply.result ?? {}
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text)
    return result?.value
  } finally {
    ws.close()
  }
}

if (expression === '--list') {
  for (const p of await pages()) console.log(p.url)
} else if (!wait) {
  console.log(JSON.stringify(await evaluate()))
} else {
  const deadline = Date.now() + 30_000
  let last
  for (;;) {
    try {
      last = await evaluate()
      if (last) break
    } catch (err) {
      last = String(err) // the app is still starting, or the page is reloading
    }
    if (Date.now() > deadline) {
      console.error(`Timed out; last result: ${JSON.stringify(last)}`)
      process.exit(1)
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  console.log(JSON.stringify(last))
}
