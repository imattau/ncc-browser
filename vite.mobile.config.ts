import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import { moneroWorker } from './vite-plugins/monero-worker'

export default defineConfig({
  root: resolve(__dirname, 'mobile'),
  base: './',
  server: { host: '127.0.0.1', port: 5174, strictPort: true },
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  plugins: [moneroWorker(), nodePolyfills({ include: ['http', 'https', 'fs', 'stream', 'util', 'path'] })],
  build: {
    commonjsOptions: { transformMixedEsModules: true },
    outDir: resolve(__dirname, 'mobile/dist'),
    emptyOutDir: true,
    rollupOptions: { input: resolve(__dirname, 'mobile/index.html') }
  }
})
