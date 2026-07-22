/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Type } from '@earendil-works/pi-ai'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { lookup } from 'node:dns/promises'

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

type ParsedIpAddress = { readonly version: 4; readonly value: bigint } | { readonly version: 6; readonly value: bigint }

type HtmlQuote = "'" | '"'
type HtmlScannerMode = 'comment' | 'rawText' | 'tag' | 'text'
type RawTextElement = 'noscript' | 'script' | 'style' | 'svg'
type TagFrame = { readonly characters: string[]; quote?: HtmlQuote }

const blockedIpv4Ranges: ReadonlyArray<readonly [network: bigint, prefixLength: number]> = [
  [0x00000000n, 8], // 0.0.0.0/8 — current network and unspecified
  [0x0a000000n, 8], // 10.0.0.0/8 — private
  [0x64400000n, 10], // 100.64.0.0/10 — shared address space
  [0x7f000000n, 8], // 127.0.0.0/8 — loopback
  [0xa9fe0000n, 16], // 169.254.0.0/16 — link-local
  [0xac100000n, 12], // 172.16.0.0/12 — private
  [0xc0000000n, 24], // 192.0.0.0/24 — IETF protocol assignments
  [0xc0000200n, 24], // 192.0.2.0/24 — documentation
  [0xc0586300n, 24], // 192.88.99.0/24 — deprecated 6to4 relay
  [0xc0a80000n, 16], // 192.168.0.0/16 — private
  [0xc6120000n, 15], // 198.18.0.0/15 — benchmarking
  [0xc6336400n, 24], // 198.51.100.0/24 — documentation
  [0xcb007100n, 24], // 203.0.113.0/24 — documentation
  [0xe0000000n, 4], // 224.0.0.0/4 — multicast
  [0xf0000000n, 4], // 240.0.0.0/4 — reserved
]

const blockedIpv6Ranges: ReadonlyArray<readonly [network: bigint, prefixLength: number]> = [
  [0x20010000000000000000000000000000n, 23], // 2001::/23 — IETF protocol assignments
  [0x20010db8000000000000000000000000n, 32], // 2001:db8::/32 — documentation
  [0x20020000000000000000000000000000n, 16], // 2002::/16 — deprecated 6to4
  [0x3fff0000000000000000000000000000n, 20], // 3fff::/20 — documentation
]

/** Parse canonical dotted-decimal IPv4 into a 32-bit integer. */
const parseIpv4 = (address: string): bigint | undefined => {
  const parts = address.split('.')
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return undefined
  const bytes = parts.map(Number)
  if (bytes.some((byte) => byte > 255)) return undefined
  return bytes.reduce((value, byte) => (value << 8n) | BigInt(byte), 0n)
}

/** Parse compressed or full IPv6 into a 128-bit integer. */
const parseIpv6 = (address: string): bigint | undefined => {
  const normalizedAddress = address.replace(/^\[|\]$/g, '').split('%')[0]
  if (!normalizedAddress?.includes(':')) return undefined
  const dottedTail = normalizedAddress.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1]
  const ipv4Tail = dottedTail ? parseIpv4(dottedTail) : undefined
  if (dottedTail && ipv4Tail === undefined) return undefined
  const expandedAddress = dottedTail
    ? normalizedAddress.replace(
        dottedTail,
        `${((ipv4Tail ?? 0n) >> 16n).toString(16)}:${((ipv4Tail ?? 0n) & 0xffffn).toString(16)}`,
      )
    : normalizedAddress
  if ((expandedAddress.match(/::/g) ?? []).length > 1) return undefined

  const [left = '', right] = expandedAddress.split('::')
  const leftGroups = left ? left.split(':') : []
  const rightGroups = right ? right.split(':') : []
  const missingGroups = 8 - leftGroups.length - rightGroups.length
  if ((right === undefined && missingGroups !== 0) || (right !== undefined && missingGroups < 1)) return undefined

  const groups = [...leftGroups, ...Array.from({ length: missingGroups }, () => '0'), ...rightGroups]
  if (groups.length !== 8 || groups.some((group) => !/^[\da-f]{1,4}$/i.test(group))) return undefined
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n)
}

/** Parse IP literals while leaving domain names unresolved. */
const parseIpAddress = (address: string): ParsedIpAddress | undefined => {
  const ipv4 = parseIpv4(address)
  if (ipv4 !== undefined) return { version: 4, value: ipv4 }
  const ipv6 = parseIpv6(address)
  return ipv6 === undefined ? undefined : { version: 6, value: ipv6 }
}

/** Test an integer IP address against a CIDR prefix. */
const isInCidr = (value: bigint, network: bigint, prefixLength: number, addressBits: number): boolean => {
  const shift = BigInt(addressBits - prefixLength)
  return value >> shift === network >> shift
}

/** Reject non-public IPv4 and IPv6 address space, including mapped IPv4. */
const isPrivateOrInternalAddress = (address: ParsedIpAddress): boolean => {
  if (address.version === 4) {
    return blockedIpv4Ranges.some(([network, prefixLength]) => isInCidr(address.value, network, prefixLength, 32))
  }

  const isIpv4Mapped = isInCidr(address.value, 0x00000000000000000000ffff00000000n, 96, 128)
  if (isIpv4Mapped) return isPrivateOrInternalAddress({ version: 4, value: address.value & 0xffffffffn })

  const isGlobalUnicast = isInCidr(address.value, 0x20000000000000000000000000000000n, 3, 128)
  if (!isGlobalUnicast) return true
  return blockedIpv6Ranges.some(([network, prefixLength]) => isInCidr(address.value, network, prefixLength, 128))
}

/**
 * Resolve, validate, and pin one request hop to its first public IP address.
 * Mirrors `backend/src/utils/url-validation.ts#validateAndPin`; keep both implementations in sync.
 */
const validateAndPin = async (
  url: URL,
  resolve: WebFetchResolver,
): Promise<[pinnedUrl: string, headers: Headers]> => {
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
