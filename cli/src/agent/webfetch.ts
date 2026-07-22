/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Type } from '@earendil-works/pi-ai'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { lookup } from 'node:dns/promises'
import { isPrivateOrInternalAddress, parseIpAddress } from '../../../shared/ip-classification.ts'

const defaultTimeoutMs = 15_000
const defaultMaxResponseBytes = 1_500_000
const defaultMaxTextLength = 100_000
const maxRedirects = 5
const privateAddressError = 'refusing to fetch private or internal address'
const redirectStatuses = new Set([301, 302, 303, 307, 308])
const lineBreakElements: ReadonlySet<string> = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'br',
  'div',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tr',
  'ul',
])
const rawTextElements: ReadonlySet<string> = new Set(['noscript', 'script', 'style', 'svg'])

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
  readonly resolve?: WebFetchResolver
  readonly timeoutMs?: number
  readonly maxResponseBytes?: number
  readonly maxTextLength?: number
}

export type WebFetchResolver = (hostname: string) => Promise<ReadonlyArray<{ readonly address: string }>>

export type WebFetchRequest = (
  input: string | URL,
  init?: {
    readonly headers?: Bun.HeadersInit
    readonly redirect?: 'error' | 'follow' | 'manual'
    readonly signal?: AbortSignal
  },
) => Promise<Response>

type HtmlQuote = "'" | '"'
type HtmlScannerMode = 'comment' | 'rawText' | 'tag' | 'text'
type RawTextElement = 'noscript' | 'script' | 'style' | 'svg'
type TagFrame = { readonly characters: string[]; quote?: HtmlQuote }

/** Resolve, validate, and pin one request hop to its first public IP address. */
const validateAndPin = async (url: URL, resolve: WebFetchResolver): Promise<[pinnedUrl: string, headers: Headers]> => {
  const parsedUrl = new URL(url)
  parsedUrl.username = ''
  parsedUrl.password = ''
  const hostname = parsedUrl.hostname.replace(/^\[|\]$/g, '')
  const literalAddress = parseIpAddress(hostname)
  if (literalAddress) {
    if (isPrivateOrInternalAddress(literalAddress)) throw new Error(privateAddressError)
    return [parsedUrl.toString(), new Headers()]
  }

  const addresses = await resolve(hostname)
  if (addresses.length === 0) throw new Error(`webfetch could not resolve hostname: ${hostname}`)
  const parsedAddresses = addresses.map(({ address }) => parseIpAddress(address))
  if (parsedAddresses.some((address) => !address || isPrivateOrInternalAddress(address))) {
    throw new Error(privateAddressError)
  }

  const pinnedUrl = new URL(parsedUrl)
  const firstAddress = addresses[0].address
  pinnedUrl.hostname = parsedAddresses[0]?.version === 6 ? `[${firstAddress}]` : firstAddress
  const headers = new Headers()
  headers.set('Host', hostname)

  return [pinnedUrl.toString(), headers]
}

/** Follow redirects manually so every network request receives fresh SSRF validation. */
const fetchWithValidatedRedirects = async (
  initialUrl: URL,
  fetch: WebFetchRequest,
  resolve: WebFetchResolver,
  signal: AbortSignal,
): Promise<{ readonly response: Response; readonly url: URL }> => {
  const state = { url: initialUrl, redirectsFollowed: 0 }

  while (true) {
    const [pinnedUrl, headers] = await validateAndPin(state.url, resolve)
    const response = await fetch(pinnedUrl, { headers, redirect: 'manual', signal })
    const location = response.headers.get('location')
    if (!redirectStatuses.has(response.status) || !location) return { response, url: state.url }
    if (state.redirectsFollowed >= maxRedirects) {
      throw new Error(`webfetch redirect limit of ${maxRedirects} exceeded`)
    }

    await response.body?.cancel()
    state.url = parseWebUrl(new URL(location, state.url).href)
    state.redirectsFollowed += 1
  }
}

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

/** Identify characters permitted in an HTML tag name. */
const isTagNameCharacter = (character: string): boolean =>
  (character >= 'a' && character <= 'z') ||
  (character >= 'A' && character <= 'Z') ||
  (character >= '0' && character <= '9') ||
  character === '-' ||
  character === ':'

/** Identify whitespace permitted before a raw-text closing angle bracket. */
const isHtmlWhitespace = (character: string | undefined): boolean =>
  character === ' ' || character === '\t' || character === '\n' || character === '\f' || character === '\r'

/** Narrow a tag name to an element whose content must be discarded. */
const isRawTextElement = (name: string): name is RawTextElement => rawTextElements.has(name)

/** Read a completed tag's normalized name. */
const readTagName = (tag: string): { readonly closing: boolean; readonly name: string } => {
  const closing = tag.startsWith('/')
  const nameStart = closing ? 1 : 0
  const nameEnd = { value: nameStart }
  while (isTagNameCharacter(tag[nameEnd.value] ?? '')) nameEnd.value += 1
  return { closing, name: tag.slice(nameStart, nameEnd.value).toLowerCase() }
}

/** Test whether a completed opening tag closes itself. */
const isSelfClosingTag = (tag: string): boolean => {
  const index = { value: tag.length - 1 }
  while (isHtmlWhitespace(tag[index.value])) index.value -= 1
  return tag[index.value] === '/'
}

/** Test a case-insensitive substring without allocating a normalized copy. */
const matchesCaseInsensitive = (value: string, index: number, expected: string): boolean => {
  const offset = { value: 0 }
  while (offset.value < expected.length) {
    if (value[index + offset.value]?.toLowerCase() !== expected[offset.value]) return false
    offset.value += 1
  }
  return true
}

/** Return index after a complete raw-text closing tag, or undefined when absent. */
const findRawTextCloseEnd = (html: string, index: number, element: RawTextElement): number | undefined => {
  if (html[index] !== '<' || html[index + 1] !== '/') return undefined
  if (!matchesCaseInsensitive(html, index + 2, element)) return undefined

  const closingIndex = { value: index + element.length + 2 }
  while (isHtmlWhitespace(html[closingIndex.value])) closingIndex.value += 1
  return html[closingIndex.value] === '>' ? closingIndex.value + 1 : undefined
}

/** Restore an unfinished ordinary tag as text for terminal angle-bracket escaping. */
const appendUnfinishedTags = (output: string[], tagFrames: TagFrame[]): void => {
  for (const frame of tagFrames) {
    output.push('<')
    for (const character of frame.characters) output.push(character)
  }
}

/** Strip tags and hidden HTML content with one forward scan. */
const stripHtml = (html: string): string => {
  const output: string[] = []
  const tagFrames: TagFrame[] = []
  const state: { index: number; mode: HtmlScannerMode; rawTextElement?: RawTextElement } = {
    index: 0,
    mode: 'text',
  }

  while (state.index < html.length) {
    if (state.mode === 'text') {
      if (html[state.index] === '<') {
        tagFrames.push({ characters: [] })
        state.mode = 'tag'
      } else {
        output.push(html[state.index] ?? '')
      }
      state.index += 1
      continue
    }

    if (state.mode === 'comment') {
      if (html[state.index] === '-' && html[state.index + 1] === '-' && html[state.index + 2] === '>') {
        state.index += 3
        state.mode = tagFrames.length > 0 ? 'tag' : 'text'
        continue
      }
      state.index += 1
      continue
    }

    if (state.mode === 'rawText') {
      const closeEnd = findRawTextCloseEnd(html, state.index, state.rawTextElement!)
      if (closeEnd !== undefined) {
        state.index = closeEnd
        state.rawTextElement = undefined
        state.mode = tagFrames.length > 0 ? 'tag' : 'text'
        continue
      }
      state.index += 1
      continue
    }

    const frame = tagFrames.at(-1)
    if (!frame) throw new Error('HTML scanner entered tag state without a tag frame')
    const character = html[state.index] ?? ''
    if (frame.quote) {
      frame.characters.push(character)
      if (character === frame.quote) frame.quote = undefined
      state.index += 1
      continue
    }
    if (character === "'" || character === '"') {
      frame.characters.push(character)
      frame.quote = character
      state.index += 1
      continue
    }
    if (character === '<') {
      tagFrames.push({ characters: [] })
      state.index += 1
      continue
    }
    if (character !== '>') {
      frame.characters.push(character)
      state.index += 1
      if (
        frame.characters.length === 3 &&
        frame.characters[0] === '!' &&
        frame.characters[1] === '-' &&
        frame.characters[2] === '-'
      ) {
        tagFrames.pop()
        state.mode = 'comment'
      }
      continue
    }

    const tag = frame.characters.join('')
    const { closing, name } = readTagName(tag)
    const rawTextElement = isRawTextElement(name) ? name : undefined
    tagFrames.pop()
    state.index += 1
    if (rawTextElement && !closing && !isSelfClosingTag(tag)) {
      state.rawTextElement = rawTextElement
      state.mode = 'rawText'
      continue
    }
    if (tagFrames.length > 0) continue
    if (lineBreakElements.has(name)) output.push('\n')
    state.mode = 'text'
  }

  if (state.mode === 'tag') appendUnfinishedTags(output, tagFrames)
  return output.join('')
}

/** Convert HTML into compact readable text while dropping non-content elements. */
export const htmlToText = (html: string): string => {
  return decodeHtmlEntities(stripHtml(html))
    // Terminal defense, applied last so entity decoding cannot reintroduce `<`: any
    // angle bracket preserved as unfinished text (or decoded back into the text) is
    // escaped outright, so no markup sequence can remain in the output.
    .replaceAll('<', '&lt;')
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
  const resolve: WebFetchResolver = dependencies.resolve ?? ((hostname) => lookup(hostname, { all: true }))
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
        const { response, url: finalUrl } = await fetchWithValidatedRedirects(url, fetch, resolve, controller.signal)
        const { bytes, truncated: bodyTruncated } = await readCappedBody(response, maxResponseBytes)
        const contentType = response.headers.get('content-type') ?? ''
        const decoded = new TextDecoder().decode(bytes)
        const readable = contentType.toLowerCase().includes('text/html') ? htmlToText(decoded) : decoded
        const output = capText(readable, maxTextLength, bodyTruncated)
        return {
          content: [{ type: 'text', text: output.text }],
          details: {
            url: response.url || finalUrl.href,
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
