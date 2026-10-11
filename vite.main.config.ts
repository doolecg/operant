import { builtinModules } from 'node:module'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import pkg from './package.json' with { type: 'json' }

// Runtime dependencies stay in node_modules: CodeGraph and node-pty load native/per-platform files.
const external = [
  'electron',
  ...Object.keys(pkg.dependencies),
  /^(@playwright\/mcp|playwright-core|ws)\//,
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]

// Main and preload are bundled as CommonJS for Electron; the renderer has its own config.
// The preload is built on its own (--mode preload) because a sandboxed preload can't
// require shared chunks, so it must be a single self-contained file.
// The agents' `operant` CLI (--mode cli) is one self-contained file run by the app binary as Node.
export default defineConfig(({ mode }) => {
  if (mode === 'cli') {
    return {
      build: {
        outDir: resolve(import.meta.dirname, 'out/cli'),
        emptyOutDir: true,
        target: 'node24',
        minify: false,
        lib: {
          entry: resolve(import.meta.dirname, 'cli/operant.ts'),
          formats: ['cjs'],
          fileName: () => 'operant.cjs',
        },
        rollupOptions: { external },
      },
    }
  }
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
      // dynamicImportInCjs keeps import('@playwright/mcp') a real import() (it is ESM-only).
      rollupOptions: { external, output: { dynamicImportInCjs: true } },
    },
  }
})
