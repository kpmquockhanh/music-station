import { describe, expect, it } from 'vitest'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp } from 'node:fs/promises'
import { runProcess } from './process'

const node = process.execPath

describe('runProcess', () => {
  it('resolves with stdout', async () => {
    await expect(runProcess(node, ['-e', 'process.stdout.write("hi")'], 5_000)).resolves.toBe('hi')
  })

  it('passes arguments verbatim, without a shell', async () => {
    const out = await runProcess(node, ['-e', 'process.stdout.write(process.argv[1])', '$(echo pwned); ls'], 5_000)
    expect(out).toBe('$(echo pwned); ls')
  })

  it('rejects with stderr on a non-zero exit', async () => {
    await expect(
      runProcess(node, ['-e', 'console.error("ERROR: bad thing"); process.exit(3)'], 5_000),
    ).rejects.toThrow('ERROR: bad thing')
  })

  it('kills the process and rejects on timeout', async () => {
    const started = Date.now()
    await expect(runProcess(node, ['-e', 'setTimeout(() => {}, 10000)'], 300)).rejects.toThrow(/timed out/)
    expect(Date.now() - started).toBeLessThan(3_000)
  })

  it('rejects on time and kills descendants that hold the pipes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'proc-'))
    const pidFile = join(dir, 'pid')
    const script = `
      const { spawn } = require('node:child_process');
      const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'inherit' });
      require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));
      setTimeout(() => {}, 30000);
    `
    const started = Date.now()
    await expect(runProcess(node, ['-e', script], 500)).rejects.toThrow(/timed out after 1s/)
    expect(Date.now() - started).toBeLessThan(2_000)
    const pid = Number(await readFile(pidFile, 'utf8'))
    const alive = () => { try { process.kill(pid, 0); return true } catch { return false } }
    await expect.poll(alive, { timeout: 2_000 }).toBe(false)
    await rm(dir, { recursive: true, force: true })
  })
})
