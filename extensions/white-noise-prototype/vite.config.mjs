import { defineConfig } from 'vite'
import { resolve } from 'node:path'

export default defineConfig({
  configFile: false,
  build: {
    target: 'es2022',
    minify: true,
    sourcemap: false,
    lib: {
      entry: resolve(import.meta.dirname, 'marmot-entry.js'),
      formats: ['iife'],
      name: 'MarmotBundle',
      fileName: () => 'marmot.bundle.js'
    },
    outDir: resolve(import.meta.dirname, '.bundle-build'),
    emptyOutDir: true
  }
})
