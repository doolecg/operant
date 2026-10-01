import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(import.meta.dirname, 'shared'),
      '@core': resolve(import.meta.dirname, 'core'),
    },
  },
  test: {
    include: ['core/**/*.test.ts', 'main/**/*.test.ts', 'shared/**/*.test.ts', 'cli/**/*.test.ts'],
    environment: 'node',
  },
})
