import { spawn } from 'node:child_process'
import { basename } from 'node:path'

export type RunFn = (bin: string, args: string[], timeoutMs: number) => Promise<string>

export const runProcess: RunFn = (bin, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    let stdout = ''
    let stderr = ''
    let settled = false

    const settle = (fn: (v: any) => void, value: any) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        fn(value)
      }
    }

    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d))
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr = (stderr + d).slice(-4_000)))
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
      child.stdout.destroy()
      child.stderr.destroy()
      settle(reject, new Error(`${basename(bin)} timed out after ${Math.round(timeoutMs / 1000)}s`))
    }, timeoutMs)
    child.on('error', (err) => {
      settle(reject, err)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) resolve(stdout)
      else reject(new Error(stderr.trim() || `process exited with code ${code}`))
    })
  })
