import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Plugin } from 'vite'

/** Serve and emit monero-ts's webpack worker unchanged; it must remain a classic worker. */
export function moneroWorker(): Plugin {
  const workerPath = resolve(process.cwd(), 'node_modules/monero-ts/dist/monero.worker.js')
  return {
    name: 'ncc-monero-classic-worker',
    configureServer(server) {
      server.middlewares.use('/monero.worker.js', (_request, response) => {
        response.setHeader('content-type', 'text/javascript; charset=utf-8')
        response.setHeader('cache-control', 'no-cache')
        response.end(readFileSync(workerPath))
      })
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'monero.worker.js', source: readFileSync(workerPath) })
    }
  }
}
