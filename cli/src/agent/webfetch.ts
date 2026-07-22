/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Type } from '@earendil-works/pi-ai'
import type { AgentTool } from '@earendil-works/pi-agent-core'

const defaultTimeoutMs = 15_000
const defaultMaxResponseBytes = 1_500_000
const defaultMaxTextLength = 100_000

const webFetchSchema = Type.Object({
  url: Type.String({ description: 'HTTP or HTTPS URL to read' }),
})

type WebFetchDetails = {
  readonly url: string
  readonly status: number
  readonly contentType: string
  readonly truncated: boolean
}

export type WebFetchDependencies = {
  readonly fetch?: WebFetchRequest
  readonly timeoutMs?: number
  readonly maxResponseBytes?: number
  readonly maxTextLength?: number
}

export type WebFetchRequest = (
  input: string | URL,
  init?: { readonly redirect?: 'error' | 'follow' | 'manual'; readonly signal?: AbortSignal },
) => Promise<Response>

/** Parse model-provided URL and permit network schemes only. */
const parseWebUrl = (value: string): URL => {
  const url = new URL(value)
  if (url.protocol === 'http:' || url.protocol === 'https:') return url
  throw new Error('webfetch only supports http and https URLs')
}

/** Decode common and numeric HTML entities without pulling in DOM machinery. */
const decodeHtmlEntities = (html: string): string => {
  const namedEntities: Readonly<Record<string, string>> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
  }
  return html.replace(/&(#\d+|#x[\da-f]+|[a-z]+);/gi, (entity, code: string) => {
    if (!code.startsWith('#')) return namedEntities[code.toLowerCase()] ?? entity
    const radix = code[1]?.toLowerCase() === 'x' ? 16 : 10
    const digits = radix === 16 ? code.slice(2) : code.slice(1)
    const value = Number.parseInt(digits, radix)
    if (!Number.isFinite(value) || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return entity
    return String.fromCodePoint(value)
  })
}

/** Convert HTML into compact readable text while dropping non-content elements. */
export const htmlToText = (html: string): string => {
  const withoutHiddenContent = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
  const withLineBreaks = withoutHiddenContent.replace(
    /<\/?(?:address|article|aside|blockquote|br|div|footer|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tr|ul)\b[^>]*>/gi,
    '\n',
  )
  return decodeHtmlEntities(withLineBreaks.replace(/<[^>]*>/g, ''))
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Read at most `maxBytes` from response stream without buffering oversized bodies. */
const readCappedBody = async (
  response: Response,
  maxBytes: number,
): Promise<{ readonly bytes: Uint8Array; readonly truncated: boolean }> => {
  if (!response.body) return { bytes: new Uint8Array(), truncated: false }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  const state = { bytesRead: 0, truncated: false }
  try {
    while (state.bytesRead <= maxBytes) {
      const { value, done } = await reader.read()
      if (done) break
      const remaining = maxBytes - state.bytesRead
      if (value.byteLength <= remaining) {
        chunks.push(value)
        state.bytesRead += value.byteLength
        continue
      }
      if (remaining > 0) chunks.push(value.subarray(0, remaining))
      state.bytesRead = maxBytes
      state.truncated = true
      await reader.cancel()
      break
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(state.bytesRead)
  const offset = { value: 0 }
  for (const chunk of chunks) {
    bytes.set(chunk, offset.value)
    offset.value += chunk.byteLength
  }
  return { bytes, truncated: state.truncated }
}

/** Limit model-visible text and append one explicit truncation marker. */
const capText = (text: string, maxTextLength: number, bodyTruncated: boolean): { text: string; truncated: boolean } => {
  const truncated = bodyTruncated || text.length > maxTextLength
  if (!truncated) return { text, truncated: false }
  return { text: `${text.slice(0, maxTextLength)}\n\n[Content truncated]`, truncated: true }
}

/** Build host-network URL reader used by local CLI and ACP-served harnesses. */
export const createWebFetchTool = (
  dependencies: WebFetchDependencies = {},
): AgentTool<typeof webFetchSchema, WebFetchDetails> => {
  const fetch: WebFetchRequest = dependencies.fetch ?? ((input, init) => globalThis.fetch(input, init))
  const timeoutMs = dependencies.timeoutMs ?? defaultTimeoutMs
  const maxResponseBytes = dependencies.maxResponseBytes ?? defaultMaxResponseBytes
  const maxTextLength = dependencies.maxTextLength ?? defaultMaxTextLength

  return {
    name: 'webfetch',
    label: 'webfetch',
    description:
      'Read a specific HTTP or HTTPS URL from the web and return readable text. Use web_search first when you need to discover URLs.',
    parameters: webFetchSchema,
    execute: async (_toolCallId, { url: inputUrl }, signal) => {
      const url = parseWebUrl(inputUrl)
      const controller = new AbortController()
      const timeoutState = { expired: false }
      const abortFromCaller = () => controller.abort(signal?.reason)
      if (signal?.aborted) abortFromCaller()
      signal?.addEventListener('abort', abortFromCaller, { once: true })
      const timeout = setTimeout(() => {
        timeoutState.expired = true
        controller.abort(new Error(`webfetch timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      try {
        const response = await fetch(url, { redirect: 'follow', signal: controller.signal })
        const { bytes, truncated: bodyTruncated } = await readCappedBody(response, maxResponseBytes)
        const contentType = response.headers.get('content-type') ?? ''
        const decoded = new TextDecoder().decode(bytes)
        const readable = contentType.toLowerCase().includes('text/html') ? htmlToText(decoded) : decoded
        const output = capText(readable, maxTextLength, bodyTruncated)
        return {
          content: [{ type: 'text', text: output.text }],
          details: {
            url: response.url || url.href,
            status: response.status,
            contentType,
            truncated: output.truncated,
          },
        }
      } catch (error) {
        if (timeoutState.expired) throw new Error(`webfetch timed out after ${timeoutMs}ms`, { cause: error })
        throw error
      } finally {
        clearTimeout(timeout)
        signal?.removeEventListener('abort', abortFromCaller)
      }
    },
  }
}
