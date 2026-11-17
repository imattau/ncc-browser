import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import { moneroWorker } from './vite-plugins/monero-worker'

const sharedAlias = { '@shared': resolve(__dirname, 'src/shared') }

export default defineConfig({
  main: {
    // nostr-tools is ESM-only and the main process is bundled as CJS, so it must be
    // inlined rather than externalised.
    plugins: [
      externalizeDepsPlugin({
        exclude: ['nostr-tools', '@nostrify/nostrify', '@scure/btc-signer', 'socks-proxy-agent', 'ws']
      })
    ],
    resolve: { alias: sharedAlias },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: sharedAlias },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          content: resolve(__dirname, 'src/preload/content.ts')
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: { alias: sharedAlias },
    plugins: [react(), tailwindcss(), moneroWorker(), nodePolyfills({ include: ['http', 'https', 'fs', 'stream', 'util', 'path'] })],
    build: {
      commonjsOptions: { transformMixedEsModules: true },
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') }
      }
    }
  }
})
