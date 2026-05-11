import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  outExtension: () => ({ js: '.js' }),
  dts: false,
  sourcemap: true,
  clean: true,
  target: 'node20',
  treeshake: true,
  splitting: false,
})
