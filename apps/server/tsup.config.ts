import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/smoke.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  clean: true,
  // The shared package ships TypeScript source, so bundle it instead of importing it at runtime.
  noExternal: [/^@music-station\//],
})
