import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(import.meta.dirname, 'shared'),
      '@core': resolve(import.meta.dirname, 'core'),
      '@': resolve(import.meta.dirname, 'renderer/src'),
    },
  },
  test: {
    include: ['core/**/*.test.ts', 'main/**/*.test.ts', 'shared/**/*.test.ts', 'cli/**/*.test.ts', 'renderer/src/components/settings/**/*.test.ts', 'renderer/src/components/terminal/**/*.test.ts', 'renderer/src/components/chat/**/*.test.ts', 'renderer/src/components/mods/**/*.test.ts', 'renderer/src/lib/**/*.test.ts'],
    environment: 'node',
  },
})
