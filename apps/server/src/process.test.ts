import { describe, expect, it } from 'vitest'
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
})
