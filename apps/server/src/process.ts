import { spawn } from 'node:child_process'

export type RunFn = (bin: string, args: string[], timeoutMs: number) => Promise<string>

export const runProcess: RunFn = (bin, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d))
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr = (stderr + d).slice(-4_000)))
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) reject(new Error(`yt-dlp timed out after ${Math.round(timeoutMs / 1000)}s`))
      else if (code === 0) resolve(stdout)
      else reject(new Error(stderr.trim() || `process exited with code ${code}`))
    })
  })
