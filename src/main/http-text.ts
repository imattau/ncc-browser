/**
 * Text HTTP(S) requests for the main process.
 *
 * Node's global `fetch` (undici) can abort with `AssertionError: assert(this.paused)`
 * in `Parser.finish` when a TLS server closes a response mid-stream. That crashed the
 * main process while downloading startup filter lists. These requests use `node:http`
 * and `node:https` directly: one connection per request, a hard timeout, a size cap
 * and explicit redirect handling.
 */

import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'

export interface TextResponse {
  status: number
  headers: IncomingMessage['headers']
  text: string
  url: string
}

export interface TextRequestOptions {
  method?: string
  headers?: Record<string, string>
  body?: string | Buffer
  timeoutMs?: number
  maxBytes?: number
  /** Redirects to follow before giving up. */
  redirects?: number
}

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_BYTES = 12_000_000

export async function requestText(
  rawUrl: string,
  options: TextRequestOptions = {}
): Promise<TextResponse> {
  const maxRedirects = options.redirects ?? 3
  let current = options
  let url = rawUrl
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    const result = await requestOnce(url, current)
    const location = result.headers.location
    if (
      location &&
      (result.status === 301 ||
        result.status === 302 ||
        result.status === 303 ||
        result.status === 307 ||
        result.status === 308)
    ) {
      url = new URL(Array.isArray(location) ? location[0] : location, url).toString()
      if (result.status === 303) current = { ...current, method: 'GET', body: undefined }
      continue
    }
    return result
  }
  throw new Error(`Too many redirects for ${rawUrl}`)
}

function requestOnce(url: string, options: TextRequestOptions): Promise<TextResponse> {
  return new Promise((resolve, reject) => {
    let target: URL
    try {
      target = new URL(url)
    } catch {
      reject(new Error(`Invalid URL: ${url}`))
      return
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      reject(new Error(`Only http:// and https:// are supported: ${url}`))
      return
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    const transport = target.protocol === 'https:' ? httpsRequest : httpRequest
    let settled = false
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      reject(error)
    }
    const succeed = (response: TextResponse): void => {
      if (settled) return
      settled = true
      resolve(response)
    }
    const request = transport(
      target,
      {
        method: options.method ?? 'GET',
        headers: options.headers,
        agent: false,
        timeout: timeoutMs
      },
      (response) => {
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > maxBytes) {
            fail(new Error(`Response is larger than ${maxBytes} bytes`))
            response.destroy()
            request.destroy()
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => {
          succeed({
            status: response.statusCode ?? 0,
            headers: response.headers,
            text: Buffer.concat(chunks).toString('utf8'),
            url
          })
        })
        response.on('error', fail)
      }
    )
    request.on('timeout', () => {
      fail(new Error(`Request timed out after ${timeoutMs}ms`))
      request.destroy()
    })
    request.on('error', fail)
    if (options.body !== undefined) request.write(options.body)
    request.end()
  })
}
