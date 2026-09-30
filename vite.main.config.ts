import { builtinModules } from 'node:module'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import pkg from './package.json' with { type: 'json' }

// Runtime dependencies stay in node_modules: CodeGraph and node-pty load native/per-platform files.
const external = [
  'electron',
  ...Object.keys(pkg.dependencies),
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]

// Main and preload are bundled as CommonJS for Electron; the renderer has its own config.
// The preload is built on its own (--mode preload) because a sandboxed preload can't
// require shared chunks, so it must be a single self-contained file.
export default defineConfig(({ mode }) => {
  const preload = mode === 'preload'
  return {
    resolve: {
      alias: {
        '@shared': resolve(import.meta.dirname, 'shared'),
        '@core': resolve(import.meta.dirname, 'core'),
      },
    },
    build: {
      outDir: resolve(import.meta.dirname, 'out/main'),
      emptyOutDir: !preload,
      target: 'node24',
      minify: false,
      sourcemap: true,
      lib: {
        entry: resolve(import.meta.dirname, preload ? 'main/preload.ts' : 'main/index.ts'),
        formats: ['cjs'],
        fileName: () => (preload ? 'preload.cjs' : 'index.cjs'),
      },
      rollupOptions: { external },
    },
  }
})
